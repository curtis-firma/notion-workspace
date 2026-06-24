import { describe, it, expect } from "vitest";
import {
  planSync,
  summarize,
  resolveConflictWinner,
  type NotionSide,
  type SlackSide,
} from "../src/sync.js";
import type { Task } from "../src/types.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    key: "Rec1",
    name: "Task A",
    status: "Not started",
    priority: 1,
    description: "d",
    dueDate: undefined,
    assigneeEmail: undefined,
    completed: false,
    slackUpdatedAt: undefined,
    notionUpdatedAt: undefined,
    ...overrides,
  };
}

describe("planSync: create-in-notion branch", () => {
  it("creates a Notion page for a Slack item with no match", () => {
    const slack: SlackSide[] = [{ task: task({ key: "S1", name: "Only in Slack" }) }];
    const notion: NotionSide[] = [];
    const actions = planSync(slack, notion, "last-edited-wins");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "create-notion" });
    const s = summarize(actions);
    expect(s.createdInNotion).toBe(1);
  });
});

describe("planSync: create-in-slack branch", () => {
  it("creates a Slack item for a Notion page with empty Slack Item ID", () => {
    const slack: SlackSide[] = [];
    const notion: NotionSide[] = [
      { pageId: "page1", task: task({ key: undefined, name: "Only in Notion" }) },
    ];
    const actions = planSync(slack, notion, "last-edited-wins");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "create-slack", notionPageId: "page1" });
    const s = summarize(actions);
    expect(s.createdInSlack).toBe(1);
  });
});

describe("planSync: branch selection together", () => {
  it("routes unmatched Slack -> create-notion and unlinked Notion -> create-slack", () => {
    const slack: SlackSide[] = [{ task: task({ key: "S1", name: "From Slack" }) }];
    const notion: NotionSide[] = [
      { pageId: "p1", task: task({ key: undefined, name: "From Notion" }) },
    ];
    const actions = planSync(slack, notion, "last-edited-wins");
    const types = actions.map((a) => a.type).sort();
    expect(types).toEqual(["create-notion", "create-slack"]);
  });
});

describe("planSync: skip blank rows", () => {
  it("skips a Slack row with no name", () => {
    const slack: SlackSide[] = [{ task: task({ key: "S1", name: "  " }) }];
    const actions = planSync(slack, [], "last-edited-wins");
    expect(actions[0]).toMatchObject({ type: "skip" });
    expect(summarize(actions).skipped).toBe(1);
  });
  it("skips a Slack item with no id", () => {
    const slack: SlackSide[] = [{ task: task({ key: undefined, name: "Named" }) }];
    const actions = planSync(slack, [], "last-edited-wins");
    expect(actions[0]).toMatchObject({ type: "skip" });
  });
});

describe("planSync: matched identical -> unchanged", () => {
  it("emits unchanged when content matches", () => {
    const t = task({ key: "K1", name: "Same", priority: 2 });
    const slack: SlackSide[] = [{ task: { ...t } }];
    const notion: NotionSide[] = [{ pageId: "p", task: { ...t } }];
    const actions = planSync(slack, notion, "last-edited-wins");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "unchanged", key: "K1" });
    expect(summarize(actions).unchanged).toBe(1);
  });
});

describe("conflict strategies on a matched, differing pair", () => {
  const matchedKey = "K1";
  const slackTask = task({
    key: matchedKey,
    name: "Title",
    priority: 5,
    slackUpdatedAt: "2026-06-01T00:00:00Z",
  });
  const notionTask = task({
    key: matchedKey,
    name: "Title",
    priority: 9,
    notionUpdatedAt: "2026-06-10T00:00:00Z",
  });

  it("slack-wins -> update Notion with Slack values", () => {
    const actions = planSync(
      [{ task: { ...slackTask } }],
      [{ pageId: "p", task: { ...notionTask } }],
      "slack-wins"
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "update-notion", notionPageId: "p" });
    if (actions[0].type === "update-notion") {
      expect(actions[0].after.priority).toBe(5);
      expect(actions[0].after.key).toBe(matchedKey);
    }
    expect(summarize(actions).updatedNotion).toBe(1);
  });

  it("notion-wins -> update Slack with Notion values", () => {
    const actions = planSync(
      [{ task: { ...slackTask } }],
      [{ pageId: "p", task: { ...notionTask } }],
      "notion-wins"
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "update-slack", slackItemId: matchedKey });
    if (actions[0].type === "update-slack") {
      expect(actions[0].after.priority).toBe(9);
    }
    expect(summarize(actions).updatedSlack).toBe(1);
  });

  it("last-edited-wins -> newer side (Notion here) wins -> update Slack", () => {
    const actions = planSync(
      [{ task: { ...slackTask } }],
      [{ pageId: "p", task: { ...notionTask } }],
      "last-edited-wins"
    );
    expect(actions[0]).toMatchObject({ type: "update-slack" });
    if (actions[0].type === "update-slack") {
      expect(actions[0].after.priority).toBe(9);
    }
  });

  it("last-edited-wins -> newer Slack wins -> update Notion", () => {
    const newerSlack = { ...slackTask, slackUpdatedAt: "2026-06-20T00:00:00Z" };
    const actions = planSync(
      [{ task: newerSlack }],
      [{ pageId: "p", task: { ...notionTask } }],
      "last-edited-wins"
    );
    expect(actions[0]).toMatchObject({ type: "update-notion" });
    if (actions[0].type === "update-notion") {
      expect(actions[0].after.priority).toBe(5);
    }
  });
});

describe("resolveConflictWinner direct", () => {
  it("respects forced strategies regardless of timestamps", () => {
    const s = task({ slackUpdatedAt: "2020-01-01T00:00:00Z" });
    const n = task({ notionUpdatedAt: "2030-01-01T00:00:00Z" });
    expect(resolveConflictWinner(s, n, "slack-wins")).toBe("slack");
    expect(resolveConflictWinner(s, n, "notion-wins")).toBe("notion");
  });
  it("last-edited-wins picks the newer timestamp", () => {
    const s = task({ slackUpdatedAt: "2026-06-20T00:00:00Z" });
    const n = task({ notionUpdatedAt: "2026-06-10T00:00:00Z" });
    expect(resolveConflictWinner(s, n, "last-edited-wins")).toBe("slack");
    expect(resolveConflictWinner({ ...s, slackUpdatedAt: "2026-06-01T00:00:00Z" }, n, "last-edited-wins")).toBe("notion");
  });
  it("last-edited-wins: a known timestamp beats an unknown one", () => {
    const s = task({ slackUpdatedAt: "2026-06-01T00:00:00Z" });
    const n = task({ notionUpdatedAt: undefined });
    expect(resolveConflictWinner(s, n, "last-edited-wins")).toBe("slack");
    expect(resolveConflictWinner(task({ slackUpdatedAt: undefined }), n, "last-edited-wins")).toBe("notion");
  });
});
