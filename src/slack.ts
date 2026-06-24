import { WebClient } from "@slack/web-api";
import type { Task } from "./types.js";
import {
  resolveStatus,
  statusNotionToSlack,
  statusSlackToNotion,
  statusToCompleted,
} from "./mapping.js";

/**
 * Slack Lists integration module.
 *
 * IMPORTANT: Slack Lists are a newer surface and the relevant Web API methods
 * are NOT first-class methods on @slack/web-api yet, so we drive them through
 * `WebClient.apiCall(<method>, <args>)`. All endpoint names and response-shape
 * assumptions live in THIS file so they are easy to adjust to match a given
 * workspace. Each is annotated with a comment.
 *
 * Targets Slack's Lists Web API (https://api.slack.com/methods — slackLists.*).
 * The exact field/cell shapes returned by your workspace may differ; adjust the
 * extraction helpers below if so.
 */

/** Human-readable column names used by the "Project tracker" list. */
export const SLACK_COLUMNS = [
  "Task",
  "Status",
  "Priority",
  "Description",
  "Assignee",
  "Due date",
  "Completed",
] as const;
export type SlackColumnName = (typeof SLACK_COLUMNS)[number];

/** Maps a human column name to the workspace-specific column ID. */
export type SlackColumnMap = Record<SlackColumnName, string>;

/** A raw-ish Slack list item normalized to a flat field map keyed by name. */
export interface SlackListItem {
  /** Stable per-item ID. */
  id: string;
  /** ISO timestamp of the last update, if the API surfaces one. */
  updatedAt: string | undefined;
  /** Field values keyed by human column name. */
  fields: Partial<Record<SlackColumnName, unknown>>;
}

export class SlackClient {
  private readonly web: WebClient;
  private readonly listId: string;
  private columnMapCache: SlackColumnMap | undefined;

  constructor(token: string, listId: string) {
    this.web = new WebClient(token);
    this.listId = listId;
  }

  /**
   * (a) Fetch the list's column schema and build a name -> column-ID map.
   *
   * Slack Lists Web API: `slackLists.info` returns the list definition,
   * including its schema/columns. Each column typically has `id`, `name`,
   * and `type`. We match on the human `name`. Adjust the path to columns
   * (`list.schema` vs `list.columns`) if your workspace differs.
   */
  async getColumnMap(): Promise<SlackColumnMap> {
    if (this.columnMapCache) return this.columnMapCache;

    // ENDPOINT: slackLists.info — Slack Lists Web API. Shape may vary.
    const res = (await this.web.apiCall("slackLists.info", {
      list_id: this.listId,
    })) as unknown as Record<string, unknown>;

    const list = (res.list ?? res) as Record<string, unknown>;
    // Columns may live under `schema`, `columns`, or `list.schema`.
    const columns = (
      (list.schema as unknown[] | undefined) ??
      (list.columns as unknown[] | undefined) ??
      []
    ) as Array<Record<string, unknown>>;

    const map: Partial<SlackColumnMap> = {};
    for (const col of columns) {
      const name = String(col.name ?? col.title ?? "");
      const id = String(col.id ?? col.key ?? "");
      if (!name || !id) continue;
      const match = SLACK_COLUMNS.find(
        (c) => c.toLowerCase() === name.toLowerCase()
      );
      if (match) map[match] = id;
    }

    // Fall back to using the human names as their own IDs so that, in
    // workspaces where cells are keyed by name, the rest of the pipeline still
    // works. This keeps the module resilient to schema-shape differences.
    for (const c of SLACK_COLUMNS) {
      if (!map[c]) map[c] = c;
    }

    this.columnMapCache = map as SlackColumnMap;
    return this.columnMapCache;
  }

  /**
   * (b) List all items with their fields + a stable per-item ID + last-updated
   * timestamp.
   *
   * Slack Lists Web API: `slackLists.items.list`. Returns `items`, each with
   * an `id` and a set of cells/fields. Cell shape varies; `extractCells`
   * normalizes it.
   */
  async listItems(): Promise<SlackListItem[]> {
    const columnMap = await this.getColumnMap();
    const items: SlackListItem[] = [];
    let cursor: string | undefined;

    do {
      // ENDPOINT: slackLists.items.list — Slack Lists Web API. Shape may vary.
      const res = (await this.web.apiCall("slackLists.items.list", {
        list_id: this.listId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })) as unknown as Record<string, unknown>;

      const rawItems = (res.items as unknown[] | undefined) ?? [];
      for (const raw of rawItems as Array<Record<string, unknown>>) {
        items.push(this.normalizeItem(raw, columnMap));
      }

      // Standard Slack cursor pagination.
      const meta = res.response_metadata as
        | { next_cursor?: string }
        | undefined;
      cursor = meta?.next_cursor || undefined;
    } while (cursor);

    return items;
  }

  /**
   * (c) Create an item from a normalized Task. Returns the new Slack item ID.
   *
   * Slack Lists Web API: `slackLists.items.create`. Accepts the list ID and a
   * set of initial cell values keyed by column ID.
   */
  async createItem(task: Task): Promise<string> {
    const columnMap = await this.getColumnMap();
    const cells = this.taskToCells(task, columnMap);

    // ENDPOINT: slackLists.items.create — Slack Lists Web API. Shape may vary.
    const res = (await this.web.apiCall("slackLists.items.create", {
      list_id: this.listId,
      // Some workspaces expect `initial_fields`/`cells`; we send `cells`.
      cells,
    })) as unknown as Record<string, unknown>;

    const item = (res.item ?? res) as Record<string, unknown>;
    const id = String(item.id ?? "");
    if (!id) throw new Error("slackLists.items.create returned no item id");
    return id;
  }

  /**
   * (d) Update an existing item from a normalized Task.
   *
   * Slack Lists Web API: `slackLists.items.update`. Accepts the list ID, the
   * item ID, and the cell values to set.
   */
  async updateItem(itemId: string, task: Task): Promise<void> {
    const columnMap = await this.getColumnMap();
    const cells = this.taskToCells(task, columnMap);

    // ENDPOINT: slackLists.items.update — Slack Lists Web API. Shape may vary.
    await this.web.apiCall("slackLists.items.update", {
      list_id: this.listId,
      id: itemId,
      cells,
    });
  }

  // --- normalization helpers (shape assumptions isolated here) ---

  /**
   * Normalize a raw Slack list item into {@link SlackListItem}.
   * Cells may be returned as an array of {column_id, ...value} objects or as a
   * map keyed by column id. We handle both.
   */
  private normalizeItem(
    raw: Record<string, unknown>,
    columnMap: SlackColumnMap
  ): SlackListItem {
    const id = String(raw.id ?? raw.item_id ?? "");
    const updatedAt =
      toIso(raw.updated_timestamp) ??
      toIso(raw.date_updated) ??
      toIso((raw.updated as Record<string, unknown> | undefined)?.ts) ??
      undefined;

    // Build a column-id -> value lookup from whatever shape we got.
    const byColumnId: Record<string, unknown> = {};
    const cells = raw.cells ?? raw.fields;
    if (Array.isArray(cells)) {
      for (const cell of cells as Array<Record<string, unknown>>) {
        const colId = String(cell.column_id ?? cell.column ?? cell.key ?? "");
        if (colId) byColumnId[colId] = extractCellValue(cell);
      }
    } else if (cells && typeof cells === "object") {
      for (const [k, v] of Object.entries(cells as Record<string, unknown>)) {
        byColumnId[k] = extractCellValue(v);
      }
    }

    const fields: Partial<Record<SlackColumnName, unknown>> = {};
    for (const name of SLACK_COLUMNS) {
      const colId = columnMap[name];
      if (colId in byColumnId) fields[name] = byColumnId[colId];
      else if (name in byColumnId) fields[name] = byColumnId[name];
    }

    return { id, updatedAt, fields };
  }

  /**
   * Convert a normalized Task into Slack cell values keyed by column ID.
   * Sent on create/update. Slack expects, per cell, an object such as
   * `{ column_id, text }` / `{ column_id, number }` / `{ column_id, checked }`.
   * The exact key per type may need adjustment for your workspace.
   */
  private taskToCells(
    task: Task,
    columnMap: SlackColumnMap
  ): Array<Record<string, unknown>> {
    const cells: Array<Record<string, unknown>> = [];

    cells.push({ column_id: columnMap.Task, text: task.name });
    cells.push({
      column_id: columnMap.Status,
      text: statusNotionToSlack(task.status),
    });
    if (task.priority !== undefined) {
      cells.push({ column_id: columnMap.Priority, number: task.priority });
    }
    cells.push({ column_id: columnMap.Description, text: task.description });
    if (task.assigneeEmail) {
      // Slack people cells usually expect user IDs; we pass email as text as a
      // best-effort fallback since we only carry email in the normalized Task.
      cells.push({ column_id: columnMap.Assignee, text: task.assigneeEmail });
    }
    if (task.dueDate) {
      cells.push({ column_id: columnMap["Due date"], date: task.dueDate });
    }
    cells.push({
      column_id: columnMap.Completed,
      checked: statusToCompleted(task.status),
    });

    return cells;
  }
}

/**
 * Convert a raw Slack list item (already normalized to a field map) into a
 * normalized {@link Task}. Exported and PURE so it can be unit-tested without
 * touching the network.
 */
export function slackItemToTask(item: SlackListItem): Task {
  const name = asString(item.fields.Task).trim();
  const status = statusSlackToNotion(asString(item.fields.Status));
  const completed = asBoolean(item.fields.Completed);
  const resolved = resolveStatus(status, completed);
  const priority = asNumber(item.fields.Priority);
  const description = asString(item.fields.Description);
  const dueDate = asString(item.fields["Due date"]).trim() || undefined;
  const assigneeEmail = asString(item.fields.Assignee).trim() || undefined;

  return {
    key: item.id || undefined,
    name,
    status: resolved,
    priority,
    description,
    dueDate,
    assigneeEmail,
    completed: resolved === "Done",
    slackUpdatedAt: item.updatedAt,
    notionUpdatedAt: undefined,
  };
}

// --- small value coercion helpers (pure) ---

function extractCellValue(cell: unknown): unknown {
  if (cell === null || cell === undefined) return cell;
  if (typeof cell !== "object") return cell;
  const c = cell as Record<string, unknown>;
  // Common Slack cell value keys, in priority order.
  for (const k of ["text", "number", "checked", "date", "value", "rich_text"]) {
    if (k in c && c[k] !== undefined) return c[k];
  }
  return c;
}

function toIso(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") {
    // Slack ts may be seconds (possibly fractional).
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string") {
    const num = Number(v);
    if (!Number.isNaN(num) && /^\d+(\.\d+)?$/.test(v)) {
      const ms = num < 1e12 ? num * 1000 : num;
      return new Date(ms).toISOString();
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function asBoolean(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string")
    return ["1", "true", "yes", "checked", "y"].includes(v.toLowerCase());
  return undefined;
}
