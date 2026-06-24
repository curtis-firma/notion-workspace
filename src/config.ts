import { z } from "zod";

/**
 * Coerce common string representations of booleans into a real boolean.
 * Accepts: true/false, 1/0, yes/no (case-insensitive). Empty/undefined => false.
 */
const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return false;
    return ["1", "true", "yes", "y", "on"].includes(v.trim().toLowerCase());
  });

const ConfigSchema = z.object({
  SLACK_TOKEN: z.string().min(1, "SLACK_TOKEN is required"),
  NOTION_TOKEN: z.string().min(1, "NOTION_TOKEN is required"),
  SLACK_LIST_ID: z.string().min(1).default("F0BCT37CJ8N"),
  NOTION_DATABASE_ID: z
    .string()
    .min(1)
    .default("a53be6ba-4973-824d-ae3f-014a7e3c9c46"),
  NOTION_DATA_SOURCE_ID: z
    .string()
    .min(1)
    .default("25dbe6ba-4973-8217-b64e-071cd79ef4ce"),
  CONFLICT_STRATEGY: z
    .enum(["last-edited-wins", "slack-wins", "notion-wins"])
    .default("last-edited-wins"),
  DRY_RUN: booleanFromEnv,
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Read and validate configuration from the given environment (defaults to
 * process.env). Throws a readable error if required vars are missing/invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse({
    SLACK_TOKEN: env.SLACK_TOKEN,
    NOTION_TOKEN: env.NOTION_TOKEN,
    SLACK_LIST_ID: env.SLACK_LIST_ID,
    NOTION_DATABASE_ID: env.NOTION_DATABASE_ID,
    NOTION_DATA_SOURCE_ID: env.NOTION_DATA_SOURCE_ID,
    CONFLICT_STRATEGY: env.CONFLICT_STRATEGY,
    DRY_RUN: env.DRY_RUN,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  return parsed.data;
}
