/**
 * Shared, system-neutral domain types used across mapping and sync logic.
 */

/** Normalized status that both Slack and Notion are mapped to/from. */
export type TaskStatus = "Not started" | "In progress" | "Blocked" | "Done";

/**
 * The normalized task shape. This is the lingua franca between Slack and
 * Notion. `key` is the Slack Item ID, which is the cross-system match key
 * (stored on the Notion page's "Slack Item ID" property).
 */
export interface Task {
  /** Slack Item ID — the cross-system match key. May be undefined for a
   * Notion-native page that has not yet been pushed to Slack. */
  key: string | undefined;
  name: string;
  status: TaskStatus;
  priority: number | undefined;
  description: string;
  dueDate: string | undefined; // ISO date (YYYY-MM-DD) or undefined
  assigneeEmail?: string;
  completed: boolean;
  /** ISO timestamp of the last edit on the Slack side, if known. */
  slackUpdatedAt: string | undefined;
  /** ISO timestamp of the last edit on the Notion side, if known. */
  notionUpdatedAt: string | undefined;
}

export type ConflictStrategy = "last-edited-wins" | "slack-wins" | "notion-wins";
