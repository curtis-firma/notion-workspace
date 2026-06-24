import { describe, it, expect } from "vitest";
import {
  statusSlackToNotion,
  statusNotionToNormalized,
  normalizedStatusToNotion,
  statusNotionToSlack,
  statusToCompleted,
  resolveStatus,
  tasksContentEqual,
} from "../src/mapping.js";
import type { Task } from "../src/types.js";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    key: "Rec1",
    name: "Do the thing",
    status: "Not started",
    priority: 1,
    description: "desc",
    dueDate: "2026-07-01",
    assigneeEmail: "a@b.com",
    completed: false,
    slackUpdatedAt: undefined,
    notionUpdatedAt: undefined,
    ...overrides,
  };
}

describe("status mapping Slack -> normalized", () => {
  it("maps the four states", () => {
    expect(statusSlackToNotion("Not started")).toBe("Not started");
    expect(statusSlackToNotion("In progress")).toBe("In progress");
    expect(statusSlackToNotion("Blocked")).toBe("Blocked");
    expect(statusSlackToNotion("Done")).toBe("Done");
  });
  it("treats Completed/Complete as Done", () => {
    expect(statusSlackToNotion("Completed")).toBe("Done");
    expect(statusSlackToNotion("complete")).toBe("Done");
  });
  it("defaults unknown/empty to Not started", () => {
    expect(statusSlackToNotion("")).toBe("Not started");
    expect(statusSlackToNotion(undefined)).toBe("Not started");
    expect(statusSlackToNotion("Whatever")).toBe("Not started");
  });
});

describe("status mapping Notion -> normalized (Blocked <-> Wait on answer)", () => {
  it("maps Wait on answer to Blocked", () => {
    expect(statusNotionToNormalized("Wait on answer")).toBe("Blocked");
  });
  it("maps the rest identity", () => {
    expect(statusNotionToNormalized("Not started")).toBe("Not started");
    expect(statusNotionToNormalized("In progress")).toBe("In progress");
    expect(statusNotionToNormalized("Done")).toBe("Done");
  });
  it("defaults unknown/empty to Not started", () => {
    expect(statusNotionToNormalized(undefined)).toBe("Not started");
    expect(statusNotionToNormalized("nonsense")).toBe("Not started");
  });
});

describe("normalized -> Notion (Blocked -> Wait on answer)", () => {
  it("maps Blocked to Wait on answer", () => {
    expect(normalizedStatusToNotion("Blocked")).toBe("Wait on answer");
  });
  it("maps the rest identity", () => {
    expect(normalizedStatusToNotion("Not started")).toBe("Not started");
    expect(normalizedStatusToNotion("In progress")).toBe("In progress");
    expect(normalizedStatusToNotion("Done")).toBe("Done");
  });
});

describe("normalized -> Slack", () => {
  it("is identity (Slack uses Blocked natively)", () => {
    expect(statusNotionToSlack("Blocked")).toBe("Blocked");
    expect(statusNotionToSlack("Done")).toBe("Done");
    expect(statusNotionToSlack("Not started")).toBe("Not started");
    expect(statusNotionToSlack("In progress")).toBe("In progress");
  });
});

describe("Done <-> Completed", () => {
  it("statusToCompleted is true only for Done", () => {
    expect(statusToCompleted("Done")).toBe(true);
    expect(statusToCompleted("In progress")).toBe(false);
    expect(statusToCompleted("Blocked")).toBe(false);
    expect(statusToCompleted("Not started")).toBe(false);
  });
  it("resolveStatus: Completed=true forces Done", () => {
    expect(resolveStatus("In progress", true)).toBe("Done");
    expect(resolveStatus("Not started", true)).toBe("Done");
  });
  it("resolveStatus: Completed=false/undefined keeps the status", () => {
    expect(resolveStatus("In progress", false)).toBe("In progress");
    expect(resolveStatus("Blocked", undefined)).toBe("Blocked");
    expect(resolveStatus("Done", false)).toBe("Done");
  });
});

describe("round-trip status", () => {
  it("Blocked survives normalized -> Notion -> normalized", () => {
    const notion = normalizedStatusToNotion("Blocked");
    expect(statusNotionToNormalized(notion)).toBe("Blocked");
  });
});

describe("tasksContentEqual", () => {
  it("true for identical content ignoring keys/timestamps", () => {
    const a = baseTask({ slackUpdatedAt: "2026-01-01T00:00:00Z" });
    const b = baseTask({ key: "different", notionUpdatedAt: "2026-02-01T00:00:00Z" });
    expect(tasksContentEqual(a, b)).toBe(true);
  });
  it("false when a field differs", () => {
    expect(tasksContentEqual(baseTask(), baseTask({ priority: 9 }))).toBe(false);
    expect(tasksContentEqual(baseTask(), baseTask({ status: "Done", completed: true }))).toBe(false);
    expect(tasksContentEqual(baseTask(), baseTask({ name: "other" }))).toBe(false);
  });
});
