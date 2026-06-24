import type { ConflictStrategy, Task } from "./types.js";
import { tasksContentEqual } from "./mapping.js";

/**
 * Reconcile engine.
 *
 * The core *decision* logic in this file is PURE and unit-tested: given the
 * normalized tasks from each side it produces a list of {@link SyncAction}s.
 * Executing those actions (the actual network writes) is a thin, separate layer
 * (see executePlan / runSync in index.ts) so that the hard logic is testable
 * without any I/O.
 */

export interface SyncSummary {
  createdInNotion: number;
  createdInSlack: number;
  updatedNotion: number;
  updatedSlack: number;
  unchanged: number;
  skipped: number;
}

export type SyncAction =
  | { type: "create-notion"; task: Task; reason: string }
  | { type: "create-slack"; task: Task; notionPageId: string; reason: string }
  | {
      type: "update-notion";
      notionPageId: string;
      before: Task;
      after: Task;
      reason: string;
    }
  | {
      type: "update-slack";
      slackItemId: string;
      before: Task;
      after: Task;
      reason: string;
    }
  | { type: "unchanged"; key: string }
  | { type: "skip"; reason: string };

/** A Slack-side input row: the normalized task (key = slack item id). */
export interface SlackSide {
  task: Task;
}

/** A Notion-side input row: the normalized task plus its page id. */
export interface NotionSide {
  pageId: string;
  task: Task;
}

/**
 * Decide which side "wins" a content conflict for a matched pair.
 * Returns "slack" or "notion".
 */
export function resolveConflictWinner(
  slack: Task,
  notion: Task,
  strategy: ConflictStrategy
): "slack" | "notion" {
  switch (strategy) {
    case "slack-wins":
      return "slack";
    case "notion-wins":
      return "notion";
    case "last-edited-wins":
    default: {
      const s = toTime(slack.slackUpdatedAt);
      const n = toTime(notion.notionUpdatedAt);
      // Newer timestamp wins. Ties (or both unknown) favor Notion to be
      // deterministic; unknown side never beats a known timestamp.
      if (s === undefined && n === undefined) return "notion";
      if (s === undefined) return "notion";
      if (n === undefined) return "slack";
      return s > n ? "slack" : "notion";
    }
  }
}

/**
 * Pure planner. Builds the full set of actions for one reconcile pass.
 *
 * Join key: Slack Item ID. On the Notion side this is `task.key` (read from the
 * "Slack Item ID" property). On the Slack side it is the item's own id (also
 * `task.key`).
 */
export function planSync(
  slackSide: SlackSide[],
  notionSide: NotionSide[],
  strategy: ConflictStrategy
): SyncAction[] {
  const actions: SyncAction[] = [];

  // Index Notion pages that already carry a Slack Item ID.
  const notionByKey = new Map<string, NotionSide>();
  const notionUnlinked: NotionSide[] = [];
  for (const n of notionSide) {
    const key = n.task.key?.trim();
    if (key) notionByKey.set(key, n);
    else notionUnlinked.push(n);
  }

  const matchedSlackKeys = new Set<string>();

  // 1) Walk Slack items.
  for (const s of slackSide) {
    const name = s.task.name.trim();
    if (!name) {
      // Skip blank/empty Slack rows (no task name).
      actions.push({ type: "skip", reason: "blank Slack row (no name)" });
      continue;
    }
    const key = s.task.key?.trim();
    if (!key) {
      // Defensive: a Slack item with no id can't be a join key.
      actions.push({ type: "skip", reason: "Slack item missing id" });
      continue;
    }

    const matched = notionByKey.get(key);
    if (!matched) {
      // Slack item with no matching Notion page -> create Notion page.
      actions.push({
        type: "create-notion",
        task: s.task,
        reason: "Slack item has no matching Notion page",
      });
      continue;
    }

    matchedSlackKeys.add(key);

    // Matched on both sides -> compare content.
    if (tasksContentEqual(s.task, matched.task)) {
      actions.push({ type: "unchanged", key });
      continue;
    }

    const winner = resolveConflictWinner(s.task, matched.task, strategy);
    if (winner === "slack") {
      // Apply Slack values to the older Notion side.
      actions.push({
        type: "update-notion",
        notionPageId: matched.pageId,
        before: matched.task,
        after: mergeKeepKey(s.task, key),
        reason: `conflict resolved (${strategy}) -> Slack wins`,
      });
    } else {
      // Apply Notion values to the Slack side.
      actions.push({
        type: "update-slack",
        slackItemId: key,
        before: s.task,
        after: mergeKeepKey(matched.task, key),
        reason: `conflict resolved (${strategy}) -> Notion wins`,
      });
    }
  }

  // 2) Notion pages with empty Slack Item ID -> create Slack item, then write
  //    the new Slack item id back onto the Notion page (done at execution time).
  for (const n of notionUnlinked) {
    if (!n.task.name.trim()) {
      actions.push({ type: "skip", reason: "blank Notion page (no name)" });
      continue;
    }
    actions.push({
      type: "create-slack",
      task: n.task,
      notionPageId: n.pageId,
      reason: "Notion page has no Slack Item ID",
    });
  }

  return actions;
}

/** Roll a list of actions up into a {@link SyncSummary}. */
export function summarize(actions: SyncAction[]): SyncSummary {
  const summary: SyncSummary = {
    createdInNotion: 0,
    createdInSlack: 0,
    updatedNotion: 0,
    updatedSlack: 0,
    unchanged: 0,
    skipped: 0,
  };
  for (const a of actions) {
    switch (a.type) {
      case "create-notion":
        summary.createdInNotion++;
        break;
      case "create-slack":
        summary.createdInSlack++;
        break;
      case "update-notion":
        summary.updatedNotion++;
        break;
      case "update-slack":
        summary.updatedSlack++;
        break;
      case "unchanged":
        summary.unchanged++;
        break;
      case "skip":
        summary.skipped++;
        break;
    }
  }
  return summary;
}

function mergeKeepKey(source: Task, key: string): Task {
  return { ...source, key };
}

function toTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
}
