import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  array,
  literal,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import { PlanningError } from "./snapshot";

// This is a closed migration surface, not an arbitrary table restore facility.
export const executionTables = [
  { name: "agents", scope: "org" },
  { name: "org_metadata", scope: "org" },
  { name: "org_members_cache", scope: "org" },
  { name: "workflows", scope: "org" },
  { name: "instructions", scope: "org" },
  { name: "projects", scope: "org" },
  { name: "chat_threads", scope: "chat" },
  { name: "workflow_automations", scope: "org" },
  { name: "workflow_user_automation_threads", scope: "org" },
  { name: "agent_runs", scope: "run" },
  { name: "official_workflow_automation_identities", scope: "workflow" },
  { name: "workflow_schedule_skips", scope: "automation" },
  { name: "workflow_webhook_automations", scope: "automation" },
  { name: "workflow_webhook_deliveries", scope: "automation" },
  { name: "workflow_github_processed_events", scope: "automation" },
  { name: "gmail_processed_events", scope: "automation" },
  { name: "google_calendar_processed_events", scope: "automation" },
  { name: "google_forms_automation_cursors", scope: "automation" },
  { name: "google_forms_processed_events", scope: "automation" },
  { name: "google_workspace_processed_events", scope: "automation" },
  { name: "notion_workflow_pending_events", scope: "automation" },
  { name: "morning_brief_schedule_claims", scope: "automation" },
] as const;

export type ExecutionTable = (typeof executionTables)[number];
const name = zEnum(
  executionTables.map((table) => {
    return table.name;
  }),
);
const digest = string().regex(/^[a-f0-9]{64}$/u);
const identifier = string().regex(/^[a-z][a-z0-9_]*$/u);
export const rowImageSchema = object({
  key: string(),
  // Keep PostgreSQL's JSON text intact: JSON.parse would round wide numeric values.
  before: string().nullable(),
  after: string().nullable(),
  revision: string().nullable(),
}).strict();
export type RowImage = zInfer<typeof rowImageSchema>;
export const tableImageSchema = object({
  name,
  columns: array(identifier).nonempty(),
  keys: array(identifier).nonempty(),
  schema: string(),
  rows: array(rowImageSchema),
}).strict();
export type TableImage = zInfer<typeof tableImageSchema>;
export const executionImageSchema = object({
  format: literal("single-agent-execution-v1"),
  purpose: literal("isolated-copy-rehearsal"),
  scope: object({
    orgId: string().min(1),
    target: string().min(1),
    database: string().min(1),
    databaseEndpoint: string().min(1),
    bucket: string().min(1),
    endpoint: string().min(1),
  }).strict(),
  inventorySha256: digest,
  planSha256: digest,
  inventoryBytes: string(),
  planBytes: string(),
  automationIds: array(string()),
  runIds: array(string()),
  capturedAt: string(),
  tables: array(tableImageSchema),
  bundles: array(contentBundleSchema),
}).strict();
export type ExecutionImage = zInfer<typeof executionImageSchema>;

export function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function databaseIdentity(connection: string) {
  const url = new URL(connection);
  // Incomplete URLs must not select the driver's ambient PG* defaults.
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length <= 1 ||
    url.searchParams.has("host") ||
    url.searchParams.has("port")
  )
    throw new PlanningError("ExplicitDatabaseEndpointRequired");
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

export function quoteIdentifier(value: string) {
  if (!identifier.safeParse(value).success)
    throw new PlanningError("InvalidExecutionIdentifier");
  return `"${value}"`;
}

export function tableScope(table: ExecutionTable, runIdsParameter = "$3") {
  switch (table.scope) {
    case "org":
      return "t.org_id = $1";
    case "chat":
      return "t.agent_id IN (SELECT id FROM agents WHERE org_id = $1)";
    case "run":
      return `t.org_id = $1 AND (t.workflow_automation_id = ANY($2::uuid[]) OR t.id = ANY(${runIdsParameter}::uuid[]))`;
    case "automation":
      return "t.automation_id = ANY($2::uuid[])";
    case "workflow":
      return "t.workflow_id IN (SELECT id FROM workflows WHERE org_id = $1)";
  }
}

/** Exclusive private files are flushed before they can authorize a write. */
export async function writePrivate(path: string, bytes: string | Uint8Array) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readPrivate(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
      throw new PlanningError("OwnerOnlyExecutionFileRequired");
    if (metadata.size > 256 * 1024 * 1024)
      throw new PlanningError("ExecutionFileTooLarge");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

export async function requirePrivateDirectory(path: string) {
  const metadata = await stat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
    throw new PlanningError("OwnerOnlyExecutionDirectoryRequired");
}
