import { Client } from "@notionhq/client";
import type { CreatePageParameters } from "@notionhq/client/build/src/api-endpoints.js";
import type { Task } from "./types.js";
import {
  normalizedStatusToNotion,
  statusNotionToNormalized,
  statusToCompleted,
} from "./mapping.js";

/**
 * Notion integration module: schema bootstrap, reads, and writes against the
 * Todos database.
 *
 * Property names we rely on (existing + bootstrapped):
 *  - Name (title), Status (status), Assign (people), Due Date (date)  [existing]
 *  - Priority (number), Description (rich_text), Slack Item ID (rich_text) [added]
 */

export const NOTION_PROP = {
  name: "Name",
  status: "Status",
  assign: "Assign",
  dueDate: "Due Date",
  priority: "Priority",
  description: "Description",
  slackItemId: "Slack Item ID",
} as const;

/** A Notion page normalized for the sync engine, plus the raw page id. */
export interface NotionTaskRecord {
  pageId: string;
  task: Task;
}

export class NotionService {
  private readonly client: Client;
  private readonly databaseId: string;

  constructor(token: string, databaseId: string) {
    this.client = new Client({ auth: token });
    this.databaseId = databaseId;
  }

  /**
   * Ensure the Todos DB has the extra properties we need. Idempotent: only
   * adds properties that are missing; never disturbs existing ones.
   */
  async ensureSchema(dryRun: boolean): Promise<string[]> {
    const db = await this.client.databases.retrieve({
      database_id: this.databaseId,
    });
    const existing = db.properties as Record<string, unknown>;

    const toAdd: Record<string, object> = {};
    if (!(NOTION_PROP.priority in existing)) {
      toAdd[NOTION_PROP.priority] = { number: {} };
    }
    if (!(NOTION_PROP.description in existing)) {
      toAdd[NOTION_PROP.description] = { rich_text: {} };
    }
    if (!(NOTION_PROP.slackItemId in existing)) {
      toAdd[NOTION_PROP.slackItemId] = { rich_text: {} };
    }

    const added = Object.keys(toAdd);
    if (added.length === 0) return [];

    if (dryRun) {
      return added;
    }

    await this.client.databases.update({
      database_id: this.databaseId,
      // @ts-expect-error Notion SDK property-create typings are strict; runtime
      // accepts a partial map of new property definitions.
      properties: toAdd,
    });
    return added;
  }

  /** Read all pages in the DB and normalize them to tasks. */
  async listPages(): Promise<NotionTaskRecord[]> {
    const records: NotionTaskRecord[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.client.databases.query({
        database_id: this.databaseId,
        start_cursor: cursor,
        page_size: 100,
      });
      for (const page of res.results) {
        if (!("properties" in page)) continue;
        records.push(this.pageToRecord(page));
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return records;
  }

  /** Create a page from a normalized task. Returns the new page id. */
  async createPage(task: Task, dryRun: boolean): Promise<string> {
    if (dryRun) return "(dry-run-page-id)";
    const res = await this.client.pages.create({
      parent: { database_id: this.databaseId },
      properties: this.taskToProperties(task),
    });
    return res.id;
  }

  /** Update an existing page from a normalized task. */
  async updatePage(pageId: string, task: Task, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    await this.client.pages.update({
      page_id: pageId,
      properties: this.taskToProperties(task),
    });
  }

  /** Write the Slack item ID back onto an existing page. */
  async writeSlackItemId(
    pageId: string,
    slackItemId: string,
    dryRun: boolean
  ): Promise<void> {
    if (dryRun) return;
    await this.client.pages.update({
      page_id: pageId,
      properties: {
        [NOTION_PROP.slackItemId]: {
          rich_text: [{ type: "text", text: { content: slackItemId } }],
        },
      },
    });
  }

  // --- normalization helpers ---

  private pageToRecord(page: {
    id: string;
    last_edited_time?: string;
    properties: Record<string, unknown>;
  }): NotionTaskRecord {
    const p = page.properties;

    const name = readTitle(p[NOTION_PROP.name]);
    const statusRaw = readStatus(p[NOTION_PROP.status]);
    const status = statusNotionToNormalized(statusRaw);
    const priority = readNumber(p[NOTION_PROP.priority]);
    const description = readRichText(p[NOTION_PROP.description]);
    const dueDate = readDate(p[NOTION_PROP.dueDate]);
    const assigneeEmail = readPersonEmail(p[NOTION_PROP.assign]);
    const key = readRichText(p[NOTION_PROP.slackItemId]).trim() || undefined;

    const task: Task = {
      key,
      name,
      status,
      priority,
      description,
      dueDate,
      assigneeEmail,
      completed: status === "Done",
      slackUpdatedAt: undefined,
      notionUpdatedAt: page.last_edited_time,
    };

    return { pageId: page.id, task };
  }

  /**
   * Build a Notion properties payload from a normalized task. Note: we do not
   * write the `Assign` (people) property because we only carry an email in the
   * normalized Task and resolving email -> Notion user id requires a separate
   * lookup; documented as a limitation. We also do not write Slack Item ID here
   * (handled by {@link writeSlackItemId}) unless present on the task.
   */
  private taskToProperties(task: Task): CreatePageParameters["properties"] {
    const props: Record<string, object> = {
      [NOTION_PROP.name]: {
        title: [{ type: "text", text: { content: task.name } }],
      },
      [NOTION_PROP.status]: {
        status: { name: normalizedStatusToNotion(task.status) },
      },
      [NOTION_PROP.description]: {
        rich_text: task.description
          ? [{ type: "text", text: { content: task.description } }]
          : [],
      },
    };

    if (task.priority !== undefined) {
      props[NOTION_PROP.priority] = { number: task.priority };
    }
    if (task.dueDate) {
      props[NOTION_PROP.dueDate] = { date: { start: task.dueDate } };
    }
    if (task.key) {
      props[NOTION_PROP.slackItemId] = {
        rich_text: [{ type: "text", text: { content: task.key } }],
      };
    }

    // statusToCompleted kept for parity with Slack side; Notion has no separate
    // completed checkbox (Done status carries it).
    void statusToCompleted;

    return props as CreatePageParameters["properties"];
  }
}

// --- pure Notion property readers ---

function readTitle(prop: unknown): string {
  const arr = (prop as { title?: Array<{ plain_text?: string }> })?.title;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text ?? "").join("");
}

function readRichText(prop: unknown): string {
  const arr = (prop as { rich_text?: Array<{ plain_text?: string }> })
    ?.rich_text;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text ?? "").join("");
}

function readStatus(prop: unknown): string | undefined {
  return (prop as { status?: { name?: string } })?.status?.name;
}

function readNumber(prop: unknown): number | undefined {
  const n = (prop as { number?: number | null })?.number;
  return n === null || n === undefined ? undefined : n;
}

function readDate(prop: unknown): string | undefined {
  const start = (prop as { date?: { start?: string } | null })?.date?.start;
  return start ?? undefined;
}

function readPersonEmail(prop: unknown): string | undefined {
  const people = (prop as {
    people?: Array<{ person?: { email?: string } }>;
  })?.people;
  if (!Array.isArray(people) || people.length === 0) return undefined;
  return people[0]?.person?.email ?? undefined;
}
