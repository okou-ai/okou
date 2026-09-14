/**
 * Migration 1117 adoption rule (#33766).
 *
 * `morning_brief_enrollments.workflow_id` records the one Morning Brief
 * installation the preference surface manages. The backfill decides that for
 * every pre-existing row, and a wrong choice is persisted rather than
 * self-healing, because the runtime resolver honours a recorded owner ahead of
 * the adoption rule. This replays the migration against seeded pre-migration
 * rows and pins the rule: prefer the installation on the org's current default
 * Agent, otherwise the oldest, never overwrite an enrollment that already owns
 * one, and leave every other member's installation alone.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `morning_brief_ownership_${randomUUID().replaceAll("-", "")}`;

async function statementsOf(name: string): Promise<readonly string[]> {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  return sql.split("--> statement-breakpoint");
}

async function migrate(name: string): Promise<void> {
  for (const statement of await statementsOf(name)) {
    await client.query(statement);
  }
}

function agentId(suffix: string): string {
  return `00000000-0000-4000-8000-0000000000${suffix}`;
}

function workflowId(suffix: string): string {
  return `00000000-0000-4000-9000-0000000000${suffix}`;
}

async function ownedWorkflowIds(): Promise<
  readonly { readonly user_id: string; readonly workflow_id: string | null }[]
> {
  const result = await client.query<{
    user_id: string;
    workflow_id: string | null;
  }>(
    "SELECT user_id, workflow_id FROM morning_brief_enrollments ORDER BY user_id",
  );
  return result.rows;
}

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(`
    CREATE TABLE org_metadata (
      org_id text PRIMARY KEY,
      default_agent_id uuid
    );
    CREATE TABLE workflows (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      name varchar(64) NOT NULL,
      visibility varchar(16) NOT NULL,
      owner_user_id text NOT NULL,
      agent_id uuid NOT NULL,
      official_definition_name varchar(64),
      created_at timestamp NOT NULL
    );
  `);
  await migrate("1112_morning_brief_enrollment");

  // Pre-migration state: enrollments assert one brief per member but cannot say
  // which installation is theirs.
  await client.query(`
    INSERT INTO org_metadata (org_id, default_agent_id) VALUES
      ('org-default', '${agentId("01")}'),
      ('org-no-default-brief', '${agentId("10")}'),
      ('org-owned', '${agentId("20")}');
    INSERT INTO workflows (id, org_id, name, visibility, owner_user_id, agent_id, official_definition_name, created_at) VALUES
      ('${workflowId("01")}', 'org-default', 'morning-brief', 'private', 'user-default-agent', '${agentId("01")}', 'morning-brief', '2026-09-12 00:00:00'),
      ('${workflowId("02")}', 'org-default', 'morning-brief', 'private', 'user-default-agent', '${agentId("02")}', 'morning-brief', '2026-09-11 00:00:00'),
      ('${workflowId("03")}', 'org-default', 'morning-brief', 'private', 'user-other-member', '${agentId("01")}', 'morning-brief', '2026-09-12 00:00:00'),
      ('${workflowId("11")}', 'org-no-default-brief', 'morning-brief', 'private', 'user-oldest', '${agentId("11")}', 'morning-brief', '2026-09-12 00:00:00'),
      ('${workflowId("12")}', 'org-no-default-brief', 'morning-brief', 'private', 'user-oldest', '${agentId("12")}', 'morning-brief', '2026-09-10 00:00:00'),
      ('${workflowId("21")}', 'org-missing-metadata', 'morning-brief', 'private', 'user-no-org-metadata', '${agentId("21")}', 'morning-brief', '2026-09-12 00:00:00'),
      ('${workflowId("22")}', 'org-missing-metadata', 'morning-brief', 'private', 'user-no-org-metadata', '${agentId("22")}', 'morning-brief', '2026-09-09 00:00:00'),
      ('${workflowId("31")}', 'org-owned', 'morning-brief', 'private', 'user-already-owns', '${agentId("20")}', 'morning-brief', '2026-09-12 00:00:00'),
      ('${workflowId("32")}', 'org-owned', 'morning-brief', 'private', 'user-already-owns', '${agentId("30")}', 'morning-brief', '2026-09-11 00:00:00'),
      ('${workflowId("41")}', 'org-default', 'team-digest', 'private', 'user-other-shapes', '${agentId("01")}', 'team-digest', '2026-09-08 00:00:00'),
      ('${workflowId("42")}', 'org-default', 'morning-brief', 'public', 'user-other-shapes', '${agentId("01")}', NULL, '2026-09-08 00:00:00');
    INSERT INTO morning_brief_enrollments (org_id, user_id, state) VALUES
      ('org-default', 'user-default-agent', 'pending'),
      ('org-no-default-brief', 'user-oldest', 'completed'),
      ('org-missing-metadata', 'user-no-org-metadata', 'pending'),
      ('org-owned', 'user-already-owns', 'completed'),
      ('org-default', 'user-other-shapes', 'pending'),
      ('org-default', 'user-without-installation', 'pending');
  `);

  await migrate("1117_morning_brief_enrollment_installation");

  assert.deepEqual(await ownedWorkflowIds(), [
    // The default Agent wins over an installation created earlier.
    { user_id: "user-already-owns", workflow_id: workflowId("31") },
    { user_id: "user-default-agent", workflow_id: workflowId("01") },
    // No installation on the default Agent: the oldest is adopted.
    { user_id: "user-no-org-metadata", workflow_id: workflowId("22") },
    { user_id: "user-oldest", workflow_id: workflowId("12") },
    // A private non-Morning-Brief workflow and a public one are not brief
    // installations.
    { user_id: "user-other-shapes", workflow_id: null },
    // An enrollment with no installation keeps no owner.
    { user_id: "user-without-installation", workflow_id: null },
  ]);
  // `user-other-member` owns an installation in the same org but has no
  // enrollment row. The backfill neither creates one nor lets another member
  // adopt that installation.
  assert.deepEqual(
    (
      await client.query(
        `SELECT count(*)::int AS count FROM morning_brief_enrollments
         WHERE workflow_id = '${workflowId("03")}' OR user_id = 'user-other-member'`,
      )
    ).rows,
    [{ count: 0 }],
  );

  // An enrollment that already owns an installation keeps it, even when another
  // installation sits on the org's default Agent.
  await client.query(
    `UPDATE morning_brief_enrollments SET workflow_id = '${workflowId("32")}' WHERE user_id = 'user-already-owns'`,
  );
  const [, backfill] = await statementsOf(
    "1117_morning_brief_enrollment_installation",
  );
  assert.ok(backfill, "Expected the 1117 backfill statement");
  const rerun = await client.query(backfill);
  assert.equal(rerun.rowCount, 0, "Expected the backfill to be idempotent");
  assert.deepEqual(
    (
      await client.query(
        "SELECT workflow_id FROM morning_brief_enrollments WHERE user_id = 'user-already-owns'",
      )
    ).rows,
    [{ workflow_id: workflowId("32") }],
  );

  console.log("Morning Brief enrollment installation adoption rule passed");
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
