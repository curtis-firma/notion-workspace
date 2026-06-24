import type { Task, TaskStatus } from "./types.js";

/**
 * PURE mapping functions between the Slack and Notion representations and the
 * normalized {@link Task} shape. No I/O here — everything in this file is
 * deterministic and unit-tested.
 */

/** Notion "Status" select option values present on the Todos DB. */
export type NotionStatus =
  | "Not started"
  | "Wait on answer"
  | "In progress"
  | "Done";

/**
 * Map a Slack status string to the normalized {@link TaskStatus}.
 * Slack column values: "Not started" / "In progress" / "Blocked" / "Done".
 * Unknown/empty values default to "Not started".
 */
export function statusSlackToNotion(slackStatus: string | undefined): TaskStatus {
  switch ((slackStatus ?? "").trim().toLowerCase()) {
    case "in progress":
      return "In progress";
    case "blocked":
      return "Blocked";
    case "done":
    case "complete":
    case "completed":
      return "Done";
    case "not started":
    case "":
      return "Not started";
    default:
      return "Not started";
  }
}

/**
 * Map a normalized {@link TaskStatus} to the Notion "Status" option value.
 * Note the only non-identity mapping: Blocked -> "Wait on answer".
 */
export function normalizedStatusToNotion(status: TaskStatus): NotionStatus {
  switch (status) {
    case "In progress":
      return "In progress";
    case "Blocked":
      return "Wait on answer";
    case "Done":
      return "Done";
    case "Not started":
    default:
      return "Not started";
  }
}

/**
 * Map a Notion "Status" option value to the normalized {@link TaskStatus}.
 * "Wait on answer" -> "Blocked"; others are identity.
 */
export function statusNotionToNormalized(
  notionStatus: string | undefined
): TaskStatus {
  switch ((notionStatus ?? "").trim().toLowerCase()) {
    case "in progress":
      return "In progress";
    case "wait on answer":
      return "Blocked";
    case "done":
      return "Done";
    case "not started":
    case "":
      return "Not started";
    default:
      return "Not started";
  }
}

/**
 * Map a normalized {@link TaskStatus} to the Slack "Status" column string.
 * Identity for all four states (Slack uses "Blocked" natively).
 */
export function statusNotionToSlack(status: TaskStatus): string {
  return status;
}

/** Derive the boolean "Completed" value from a normalized status. */
export function statusToCompleted(status: TaskStatus): boolean {
  return status === "Done";
}

/**
 * Reconcile a status with a completed flag. Slack carries both a "Status"
 * column and a "Completed" checkbox; if Completed is true we treat the task as
 * Done regardless of the Status column, and vice-versa Done implies completed.
 */
export function resolveStatus(
  status: TaskStatus,
  completed: boolean | undefined
): TaskStatus {
  if (completed === true) return "Done";
  return status;
}

/**
 * Whether two normalized tasks have equivalent *content* (ignoring keys and
 * timestamps). Used by the reconcile engine to decide if an update is needed.
 */
export function tasksContentEqual(a: Task, b: Task): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.status === b.status &&
    (a.priority ?? null) === (b.priority ?? null) &&
    a.description.trim() === b.description.trim() &&
    (a.dueDate ?? null) === (b.dueDate ?? null) &&
    (a.assigneeEmail ?? null) === (b.assigneeEmail ?? null) &&
    a.completed === b.completed
  );
}
