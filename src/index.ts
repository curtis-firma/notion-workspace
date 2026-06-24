import { loadConfig } from "./config.js";
import type { Task } from "./types.js";
import { NotionService } from "./notion.js";
import { SlackClient, slackItemToTask } from "./slack.js";
import {
  planSync,
  summarize,
  type NotionSide,
  type SlackSide,
  type SyncAction,
  type SyncSummary,
} from "./sync.js";

/**
 * Entrypoint: load config, run one full reconcile pass, log a summary, and exit
 * non-zero on fatal error.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const dry = config.DRY_RUN;
  log(`Starting Slack <-> Notion task sync${dry ? " (DRY RUN)" : ""}`);
  log(`Conflict strategy: ${config.CONFLICT_STRATEGY}`);

  const notion = new NotionService(config.NOTION_TOKEN, config.NOTION_DATABASE_ID);
  const slack = new SlackClient(config.SLACK_TOKEN, config.SLACK_LIST_ID);

  // 1) Bootstrap Notion schema (idempotent).
  const added = await notion.ensureSchema(dry);
  if (added.length > 0) {
    log(
      `${dry ? "[DRY RUN] would add" : "Added"} Notion properties: ${added.join(", ")}`
    );
  } else {
    log("Notion schema already has all required properties.");
  }

  // 2) Read both sides.
  const slackItems = await slack.listItems();
  const notionPages = await notion.listPages();
  log(`Fetched ${slackItems.length} Slack items, ${notionPages.length} Notion pages.`);

  const slackSide: SlackSide[] = slackItems.map((i) => ({
    task: slackItemToTask(i),
  }));
  const notionSide: NotionSide[] = notionPages.map((r) => ({
    pageId: r.pageId,
    task: r.task,
  }));

  // 3) Plan (pure).
  const actions = planSync(slackSide, notionSide, config.CONFLICT_STRATEGY);

  // 4) Execute.
  await executePlan(actions, slack, notion, dry);

  // 5) Summary.
  const summary = summarize(actions);
  logSummary(summary, dry);
}

async function executePlan(
  actions: SyncAction[],
  slack: SlackClient,
  notion: NotionService,
  dry: boolean
): Promise<void> {
  for (const action of actions) {
    switch (action.type) {
      case "create-notion": {
        log(
          `${tag(dry)} create-notion: "${action.task.name}" (${action.reason})`
        );
        await notion.createPage(action.task, dry);
        break;
      }
      case "create-slack": {
        log(
          `${tag(dry)} create-slack: "${action.task.name}" (${action.reason})`
        );
        if (!dry) {
          const newId = await slack.createItem(action.task);
          await notion.writeSlackItemId(action.notionPageId, newId, dry);
          log(`  -> created Slack item ${newId}, linked to Notion page.`);
        }
        break;
      }
      case "update-notion": {
        log(
          `${tag(dry)} update-notion page ${action.notionPageId} (${action.reason})`
        );
        logDiff(action.before, action.after);
        await notion.updatePage(action.notionPageId, action.after, dry);
        break;
      }
      case "update-slack": {
        log(
          `${tag(dry)} update-slack item ${action.slackItemId} (${action.reason})`
        );
        logDiff(action.before, action.after);
        await slack.updateItem(action.slackItemId, action.after);
        break;
      }
      case "unchanged":
        // Quiet by default; uncomment for verbose runs.
        break;
      case "skip":
        log(`skip: ${action.reason}`);
        break;
    }
  }
}

function logDiff(before: Task, after: Task): void {
  const keys: Array<keyof Task> = [
    "name",
    "status",
    "priority",
    "description",
    "dueDate",
    "assigneeEmail",
    "completed",
  ];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      log(`  ${k}: ${JSON.stringify(before[k])} -> ${JSON.stringify(after[k])}`);
    }
  }
}

function logSummary(summary: SyncSummary, dry: boolean): void {
  log("---");
  log(`${dry ? "[DRY RUN] " : ""}Sync complete:`);
  log(`  created in Notion: ${summary.createdInNotion}`);
  log(`  created in Slack:  ${summary.createdInSlack}`);
  log(`  updated Notion:    ${summary.updatedNotion}`);
  log(`  updated Slack:     ${summary.updatedSlack}`);
  log(`  unchanged:         ${summary.unchanged}`);
  log(`  skipped:           ${summary.skipped}`);
}

function tag(dry: boolean): string {
  return dry ? "[DRY RUN] would" : "[apply]";
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[sync] ${msg}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[sync] FATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
