# Slack List ↔ Notion Task Sync

A small, runnable service that **bidirectionally** syncs tasks between a Slack
List ("Project tracker") and a Notion database ("Todos"). It runs as a single
reconcile pass (one-shot), suitable for a cron / GitHub Action schedule.

## What it does

On each run it:

1. **Bootstraps the Notion schema** — idempotently adds the extra properties it
   needs (`Priority`, `Description`, `Slack Item ID`) to the Todos DB without
   disturbing existing properties.
2. **Reads both sides** — all Slack List items and all Notion pages, normalizing
   each into a common `Task` shape.
3. **Reconciles** them keyed by the **Slack Item ID** (stored on each Notion
   page's `Slack Item ID` property):
   - Slack item with no matching Notion page → **create a Notion page**.
   - Notion page with an empty `Slack Item ID` (created natively in Notion) →
     **create a Slack list item**, then **write the new Slack item ID back**
     onto the Notion page.
   - Matched on both sides → compare normalized fields; if they differ, resolve
     per the configured **conflict strategy**.
   - Blank/empty Slack rows (no task name) are skipped.
4. **Logs a summary** of counts: created-in-notion, created-in-slack,
   updated-notion, updated-slack, unchanged, skipped.

## The two-way model

There is one source of truth per record, chosen at conflict time — not a single
master system. New records can originate on **either** side and are propagated
to the other. The cross-system join key is the **Slack Item ID**, persisted on
the Notion page so the link survives across runs.

## Field & status mapping

| Concept     | Slack column | Notion property        | Notes |
|-------------|--------------|------------------------|-------|
| Title       | Task         | Name (title)           | |
| Status      | Status       | Status (status)        | see status table |
| Priority    | Priority     | Priority (number)      | added to Notion |
| Description | Description  | Description (rich_text)| added to Notion |
| Assignee    | Assignee     | Assign (people)        | read-only into Notion (see Limitations) |
| Due date    | Due date     | Due Date (date)        | ISO `YYYY-MM-DD` |
| Completed   | Completed    | (derived from Status)  | `Completed=true` ⇔ Status `Done` |

### Status mapping

| Normalized   | Slack       | Notion          |
|--------------|-------------|-----------------|
| Not started  | Not started | Not started     |
| In progress  | In progress | In progress     |
| Blocked      | Blocked     | **Wait on answer** |
| Done         | Done        | Done            |

Slack's `Completed` checkbox is treated as authoritative for "done-ness":
`Completed = true` maps to Notion `Done`, and Notion `Done` maps back to
`Completed = true` on the Slack side.

## Conflict resolution

Set via `CONFLICT_STRATEGY`:

- **`last-edited-wins`** (default) — compares the Slack item's last-updated
  timestamp against the Notion page's `last_edited_time` (record-level) and
  applies the **newer** side's values to the older side. A known timestamp beats
  an unknown one; ties favor Notion deterministically.
- **`slack-wins`** — Slack values always overwrite Notion on conflict.
- **`notion-wins`** — Notion values always overwrite Slack on conflict.

Resolution is **record-level**, not field-level (see Limitations).

## Setup

### Slack

Create/Use a token (`xoxp` user token or `xoxb` bot token) with the Lists
scopes, e.g. `lists:read` and `lists:write` (exact scope names depend on your
workspace's Lists rollout). The token must be able to read and modify the
"Project tracker" list (`F0BCT37CJ8N`).

### Notion

1. Create an internal integration at <https://www.notion.so/my-integrations> and
   copy its token (`secret_...`).
2. **Share the Todos database with the integration** (Notion DB → ••• →
   Connections → add your integration). Without this the API returns
   `object_not_found`.

### GitHub secrets

In the repository: Settings → Secrets and variables → Actions → New repository
secret. Add:

- `SLACK_TOKEN`
- `NOTION_TOKEN`

Other config is provided via workflow `env` with the documented defaults.

## Configuration (env vars)

| Var | Required | Default |
|-----|----------|---------|
| `SLACK_TOKEN` | yes | — |
| `NOTION_TOKEN` | yes | — |
| `SLACK_LIST_ID` | no | `F0BCT37CJ8N` |
| `NOTION_DATABASE_ID` | no | `a53be6ba-4973-824d-ae3f-014a7e3c9c46` |
| `NOTION_DATA_SOURCE_ID` | no | `25dbe6ba-4973-8217-b64e-071cd79ef4ce` |
| `CONFLICT_STRATEGY` | no | `last-edited-wins` |
| `DRY_RUN` | no | `false` |

See `.env.example`.

## Running locally

```bash
npm install
cp .env.example .env      # fill in SLACK_TOKEN and NOTION_TOKEN
npm run build
npm start
```

Dry run (plans + logs every create/update with before→after, makes no writes):

```bash
DRY_RUN=true npm start
# or, with the dev runner:
DRY_RUN=true npm run dev
```

### Scripts

- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the compiled sync (`dist/index.js`).
- `npm run dev` — run from source via `tsx`.
- `npm test` — run the unit tests (vitest).
- `npm run typecheck` — type-check without emitting.

## GitHub Action

`.github/workflows/sync.yml` runs the sync every 10 minutes
(`*/10 * * * *`) and also supports manual `workflow_dispatch` with a `dry_run`
boolean input wired to `DRY_RUN`. Steps: checkout → setup-node 20 → `npm ci` →
`npm run build` → `npm start`.

## Limitations

1. **Slack Lists Web API** — this requires a Slack plan/token that supports the
   Lists Web API. The Lists methods (`slackLists.info`,
   `slackLists.items.list/create/update`) are not first-class in
   `@slack/web-api`, so they are called via `WebClient.apiCall(...)`. All
   endpoint names and request/response **shape assumptions** are isolated in
   `src/slack.ts` and annotated; **they may need verifying/adjusting against
   your workspace's actual list schema** (column IDs, cell value keys such as
   `text`/`number`/`checked`/`date`, pagination, and update payload shape).
2. **No hard-delete handling (v1)** — deleting a task on one side does **not**
   delete it on the other. Deletions/archival are out of scope for v1.
3. **Record-level conflict resolution** — when both sides changed, one side
   wins wholesale; we do not merge field-by-field.
4. **Assignee is read-only into Notion** — the normalized `Task` carries only an
   email. Writing Notion's `Assign` (people) property requires resolving an
   email to a Notion user id (a separate lookup), so assignee is not written to
   Notion. Slack receives the email as best-effort text.
```
