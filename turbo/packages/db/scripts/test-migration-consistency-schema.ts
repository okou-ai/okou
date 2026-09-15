#!/usr/bin/env tsx
/**
 * Migration Consistency Test - Schema Comparison
 *
 * This script verifies that all migration files match the schema definitions
 * by comparing the final database state using normalized comparison.
 *
 * Steps:
 * 1. Create test database and run existing migrations
 * 2. Create test database, regenerate migrations from schema and run them
 * 3. Compare schemas using normalized comparison (ignores benign differences)
 *
 * Note: Uses pg library for all database operations (no pg_dump/psql required)
 *
 * IMPORTANT: Migration Best Practices
 * ===================================
 *
 * ❌ NEVER manually write migration files!
 * ❌ NEVER edit existing migration files!
 * ❌ NEVER manually create snapshot files!
 *
 * ✅ ALWAYS use `pnpm -F @okouai/db db:generate` to auto-generate migrations
 * ✅ ALWAYS let Drizzle Kit manage the snapshot system
 * ✅ ALWAYS test with `pnpm test:migration-consistency` before merging
 *
 * Manual migrations break the snapshot chain and cause this test to fail.
 * If this test fails, follow the fix instructions in the error message.
 */

import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { validateAgentRunLaunchSnapshotSchema } from "./test-agent-run-launch-snapshot";
import { validateAgentRunOfficialWorkflowProvenanceSchema } from "./test-agent-run-official-workflow-provenance";
import { validateOfficialAutomationResultEmailSchema } from "./test-official-automation-result-email-schema";
import { validatePermanentBuiltInModelCooldownState } from "./test-built-in-model-cooldown-permanent";
import { validatePermanentBuiltInModelKeyState } from "./test-built-in-model-keys-permanent";
import { validatePermanentMarketingPrivacyState } from "./test-marketing-privacy-permanent";
import { validatePermanentSlackPublicBrandState } from "./test-slack-public-brand-permanent";
import { validatePermanentOrgPlanEntitlementState } from "./test-org-plan-entitlement-permanent";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(dirname, "..");
const MIGRATIONS_DIR = path.join(PACKAGE_DIR, "src/migrations");
const BACKUP_DIR = path.join(dirname, "../.migrations-backup");
const RESTORE_DIR = path.join(dirname, "../.migrations-restore");

// Parse DATABASE_URL to get connection details
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is required");
}
const dbUrl = new URL(DATABASE_URL);
const DB_HOST = dbUrl.hostname;
const DB_PORT = dbUrl.port;
const DB_USER = dbUrl.username;
const DB_PASSWORD = dbUrl.password;

function createTestDbUrl(dbName: string): string {
  const auth = DB_PASSWORD ? `${DB_USER}:${DB_PASSWORD}` : DB_USER;
  return `postgresql://${auth}@${DB_HOST}:${DB_PORT}/${dbName}`;
}

function execCommand(
  cmd: string,
  options?: { env?: Record<string, string>; cwd?: string },
): string {
  return execSync(cmd, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env },
  });
}

async function executeOnPostgres(sql: string): Promise<void> {
  const client = new Client({
    host: DB_HOST,
    port: parseInt(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: "postgres", // Connect to default postgres database
  });

  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function createDatabase(dbName: string): Promise<void> {
  console.log(`📦 Creating database: ${dbName}`);
  try {
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  } catch {
    // Database might already exist, try to drop and recreate
    console.log(`   Database exists, dropping and recreating...`);
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
    await executeOnPostgres(`CREATE DATABASE ${dbName}`);
  }
}

async function dropDatabase(dbName: string): Promise<void> {
  console.log(`🗑️  Dropping database: ${dbName}`);
  try {
    await executeOnPostgres(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch {
    console.warn(`   Warning: Failed to drop database ${dbName}`);
  }
}

async function runMigrations(dbUrl: string): Promise<void> {
  console.log(`🔨 Running migrations...`);
  execCommand(`tsx ${path.join(dirname, "migrate.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function resetDatabase(dbUrl: string): Promise<void> {
  console.log(`♻️  Resetting database...`);
  execCommand(`tsx ${path.join(dirname, "reset-db.ts")}`, {
    env: { DATABASE_URL: dbUrl },
    cwd: PACKAGE_DIR,
  });
}

async function validateExpandedBrowserSchema(dbUrl: string): Promise<void> {
  console.log("=== Phase 2.4: Validate expanded browser schema ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const tables = await client.query<{
      browserProfiles: string | null;
      tabSnapshots: string | null;
    }>(
      `
        SELECT
          to_regclass('public.browser_profiles')::text AS "browserProfiles",
          to_regclass('public.browser_session_tab_snapshots')::text
            AS "tabSnapshots"
      `,
    );
    // The retired browser table stays until the pre-cleanup API drains; the
    // follow-up contraction release drops it together with its declaration.
    assert.deepEqual(tables.rows, [
      {
        browserProfiles: "browser_profiles",
        tabSnapshots: "browser_session_tab_snapshots",
      },
    ]);

    const retiredColumns = await client.query<{ count: number }>(
      `
        SELECT count(*)::integer AS "count"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('browser_sessions', 'id'),
            ('browser_sessions', 'browser_profile_id'),
            ('browser_session_instances', 'browser_session_id'),
            ('browser_thread_profiles', 'id')
          )
      `,
    );
    // Same two-release contract: the declarations and physical columns are
    // dropped together only after this release has drained.
    assert.deepEqual(retiredColumns.rows, [{ count: 4 }]);

    const primaryKeys = await client.query<{
      columnName: string;
      tableName: string;
    }>(
      `
        SELECT
          "tc"."table_name" AS "tableName",
          "kcu"."column_name" AS "columnName"
        FROM "information_schema"."table_constraints" AS "tc"
        INNER JOIN "information_schema"."key_column_usage" AS "kcu"
          ON "tc"."constraint_name" = "kcu"."constraint_name"
          AND "tc"."table_schema" = "kcu"."table_schema"
        WHERE "tc"."table_schema" = 'public'
          AND "tc"."constraint_type" = 'PRIMARY KEY'
          AND "tc"."table_name" IN (
            'browser_sessions',
            'browser_thread_profiles'
          )
        ORDER BY "tc"."table_name", "kcu"."ordinal_position"
      `,
    );
    // Current code keys every lookup by chat_thread_id, but the physical
    // primary key stays on the retired identity column for this release.
    assert.deepEqual(primaryKeys.rows, [
      { tableName: "browser_sessions", columnName: "id" },
      { tableName: "browser_thread_profiles", columnName: "id" },
    ]);

    const lifecycleConstraint = await client.query<{ definition: string }>(
      `
        SELECT pg_get_constraintdef("oid") AS "definition"
        FROM "pg_constraint"
        WHERE "conname" = 'chat_events_event_type_check'
      `,
    );
    assert.equal(lifecycleConstraint.rows.length, 1);
    const lifecycleDefinition = lifecycleConstraint.rows[0]?.definition ?? "";
    // Only the canonical lifecycle values remain after the old API drain.
    assert.match(lifecycleDefinition, /browser\.open/u);
    assert.match(lifecycleDefinition, /browser\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.started/u);
    assert.doesNotMatch(lifecycleDefinition, /browser\.stopped/u);
    assert.match(lifecycleDefinition, /goal\.open/u);
    assert.match(lifecycleDefinition, /goal\.close/u);
    assert.doesNotMatch(lifecycleDefinition, /goal\.changed/u);
    console.log(
      "   ✅ retired browser tables and identity columns still exist",
    );
    console.log(
      "   ✅ browser lifecycle and goal event constraints are canonical\n",
    );
  } finally {
    await client.end();
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function expectAppendOnlyUpdateRejected(
  client: Client,
  args: {
    readonly tableName: "chat_events" | "chat_messages" | "chat_thread_events";
    readonly query: string;
    readonly rowId: string;
  },
): Promise<void> {
  try {
    await client.query(args.query, [args.rowId]);
  } catch (error) {
    const expectedMessage = `${args.tableName} is append-only; UPDATE is not allowed`;
    if (
      databaseErrorCode(error) === "P0001" &&
      error instanceof Error &&
      error.message.includes(expectedMessage)
    ) {
      return;
    }
    throw error;
  }

  throw new Error(`${args.tableName} accepted an UPDATE`);
}

async function validateCanonicalChatMessageStorage(
  client: Client,
  threadId: string,
): Promise<string> {
  const sequenceReservation = await client.query<{ lastSeqId: string }>(
    `
      UPDATE "chat_threads"
      SET "last_chat_event_seq_id" = "last_chat_event_seq_id" + 2
      WHERE "id" = $1
      RETURNING "last_chat_event_seq_id" AS "lastSeqId"
    `,
    [threadId],
  );
  const lastSeqId = Number(sequenceReservation.rows[0]?.lastSeqId);
  assert.ok(Number.isSafeInteger(lastSeqId));
  const firstSeqId = lastSeqId - 1;
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API migration test" }],
  };
  const message = await client.query<{
    contextType: string | null;
    id: string;
    payload: unknown;
    seqId: string;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "context_type",
        "event_type",
        "payload",
        "seq_id"
      )
      VALUES (
        $1,
        'web',
        'input.prompt',
        $3::jsonb,
        $2
      )
      RETURNING
        "id",
        "seq_id" AS "seqId",
        "context_type" AS "contextType",
        "payload"
    `,
    [threadId, firstSeqId, JSON.stringify({ userMessage })],
  );
  const messageRow = message.rows[0];
  if (!messageRow) {
    throw new Error("Failed to create append-only chat message fixture");
  }
  assert.equal(messageRow.seqId, String(firstSeqId));
  assert.equal(messageRow.contextType, "web");
  assert.deepEqual(messageRow.payload, { userMessage });

  const nextMessage = await client.query<{
    payload: unknown;
    seqId: string;
  }>(
    `
      INSERT INTO "chat_events" (
        "chat_thread_id",
        "event_type",
        "payload",
        "seq_id"
      )
      VALUES (
        $1,
        'output.message',
        '{"content":"second typed API migration test"}'::jsonb,
        $2
      )
      RETURNING
        "seq_id" AS "seqId",
        "payload"
    `,
    [threadId, lastSeqId],
  );
  assert.equal(nextMessage.rows[0]?.seqId, String(lastSeqId));
  assert.deepEqual(nextMessage.rows[0]?.payload, {
    content: "second typed API migration test",
  });

  const sequenceState = await client.query<{ lastSeqId: string }>(
    `
      SELECT "last_chat_event_seq_id" AS "lastSeqId"
      FROM "chat_threads"
      WHERE "id" = $1
    `,
    [threadId],
  );
  assert.equal(sequenceState.rows[0]?.lastSeqId, String(lastSeqId));

  return messageRow.id;
}

async function validateCanonicalDraftStorage(
  client: Client,
  threadId: string,
): Promise<void> {
  const draftUserMessage = {
    version: 1,
    parts: [{ type: "text", text: "canonical API draft" }],
  };
  const canonicalDraft = await client.query<{
    draftUserMessage: unknown;
  }>(
    `
      UPDATE "chat_threads"
      SET "draft_user_message" = $2::jsonb
      WHERE "id" = $1
      RETURNING
        "draft_user_message" AS "draftUserMessage"
    `,
    [threadId, JSON.stringify(draftUserMessage)],
  );
  assert.deepEqual(canonicalDraft.rows[0]?.draftUserMessage, draftUserMessage);
}

async function validateChatEventSourcesAreAppendOnly(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate append-only chat event sources ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const agentId = "00000000-0000-4000-8000-000000074401";
  let threadId: string | undefined;
  let messageId: string | undefined;

  try {
    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, 'append-only-test-org', 'append-only-test-user',
         'append-only-migration-test')`,
      [agentId],
    );

    const thread = await client.query<{ id: string }>(
      `
        INSERT INTO "chat_threads" (
          "user_id",
          "agent_id",
          "title"
        )
        VALUES ('append-only-test-user', $1, 'append-only migration test')
        RETURNING "id"
      `,
      [agentId],
    );
    threadId = thread.rows[0]?.id;
    if (!threadId) {
      throw new Error("Failed to create append-only chat thread fixture");
    }

    // Insert through the canonical table with application-reserved seq_ids.
    messageId = await validateCanonicalChatMessageStorage(client, threadId);
    await validateCanonicalDraftStorage(client, threadId);

    const event = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'created',
          $2,
          'append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentId],
    );
    const eventId = event.rows[0]?.id;
    if (!eventId) {
      throw new Error("Failed to create append-only chat thread event fixture");
    }
    assert.equal(event.rows[0]?.seqId, "1");
    const threadEventSequenceState = await client.query<{
      lastSeqId: string;
    }>(
      `
        SELECT "last_seq_id" AS "lastSeqId"
        FROM "chat_thread_event_sequences"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    assert.equal(threadEventSequenceState.rows[0]?.lastSeqId, "1");

    const nextEvent = await client.query<{ id: string; seqId: string }>(
      `
        INSERT INTO "chat_thread_events" (
          "user_id",
          "org_id",
          "chat_thread_id",
          "kind",
          "agent_id",
          "title"
        )
        VALUES (
          'append-only-test-user',
          'append-only-test-org',
          $1,
          'renamed',
          $2,
          'advanced append-only migration test'
        )
        RETURNING "id", "seq_id" AS "seqId"
      `,
      [threadId, agentId],
    );
    const nextEventId = nextEvent.rows[0]?.id;
    if (!nextEventId) {
      throw new Error("Failed to create second chat thread event fixture");
    }
    assert.equal(nextEvent.rows[0]?.seqId, "2");

    const snapshot = await client.query<{ latestSeqId: string }>(
      `
        INSERT INTO "chat_thread_snapshots" (
          "user_id",
          "org_id",
          "latest_event_id"
        )
        VALUES ('append-only-test-user', 'append-only-test-org', $1)
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [eventId],
    );
    assert.equal(snapshot.rows[0]?.latestSeqId, "1");

    const advancedSnapshot = await client.query<{ latestSeqId: string }>(
      `
        UPDATE "chat_thread_snapshots"
        SET "latest_event_id" = $1
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
        RETURNING "latest_event_seq_id" AS "latestSeqId"
      `,
      [nextEventId],
    );
    assert.equal(advancedSnapshot.rows[0]?.latestSeqId, "2");

    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_events",
      query: `UPDATE "chat_events" SET "event_type" = "event_type" WHERE "id" = $1`,
      rowId: messageId,
    });
    await expectAppendOnlyUpdateRejected(client, {
      tableName: "chat_thread_events",
      query: `UPDATE "chat_thread_events" SET "title" = 'mutated' WHERE "id" = $1`,
      rowId: eventId,
    });

    console.log("   ✅ chat_events rejects UPDATE");
    console.log("   ✅ chat_thread_events rejects UPDATE\n");
    console.log("   ✅ chat event writes use application-reserved seq_ids\n");
  } finally {
    await client.query(
      `
        DELETE FROM "chat_thread_snapshots"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    await client.query(
      `
        DELETE FROM "chat_thread_events"
        WHERE "user_id" = 'append-only-test-user'
          AND "org_id" = 'append-only-test-org'
      `,
    );
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
    await client.end();
  }
}

async function validateChatEventContextPointerConstraints(
  dbUrl: string,
): Promise<void> {
  console.log("=== Phase 2.5: Validate chat event context pointer ===\n");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const agentId = "00000000-0000-4000-8000-000000074501";
  const threadId = "00000000-0000-4000-8000-000000074502";

  try {
    await client.query(
      `
        INSERT INTO "agents" ("id", "org_id", "owner", "name")
        VALUES ($1, 'context-pointer-test-org', 'context-pointer-test-user',
          'context-pointer-test')
      `,
      [agentId],
    );
    await client.query(
      `
        INSERT INTO "chat_threads" (
          "id",
          "user_id",
          "agent_id",
          "last_chat_event_seq_id",
          "title"
        )
        VALUES (
          $1,
          'context-pointer-test-user',
          $2,
          2,
          'context pointer test'
        )
      `,
      [threadId, agentId],
    );

    const accepted = await client.query<{
      contextId: string | null;
      contextType: string | null;
    }>(
      `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "payload",
          "seq_id"
        )
        VALUES
          (
            '00000000-0000-4000-8000-000000074510',
            $1,
            'output.message',
            NULL,
            NULL,
            NULL,
            1
          ),
          (
            '00000000-0000-4000-8000-000000074511',
            $1,
            'output.message',
            'slack',
            '00000000-0000-4000-8000-000000074503',
            NULL,
            2
          ),
          (
            '00000000-0000-4000-8000-000000074512',
            $1,
            'input.prompt',
            'web',
            NULL,
            '{"userMessage":{"version":1,"parts":[{"type":"text","text":"web discriminator"}]}}'::jsonb,
            3
          ),
          (
            '00000000-0000-4000-8000-000000074515',
            $1,
            'input.rejected',
            NULL,
            NULL,
            '{"userMessage":{"version":1,"parts":[{"type":"text","text":"rejected input"}]}}'::jsonb,
            4
          )
        RETURNING
          "context_type" AS "contextType",
          "context_id" AS "contextId"
      `,
      [threadId],
    );
    assert.deepEqual(accepted.rows, [
      { contextId: null, contextType: null },
      {
        contextId: "00000000-0000-4000-8000-000000074503",
        contextType: "slack",
      },
      { contextId: null, contextType: "web" },
      { contextId: null, contextType: null },
    ]);

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_pair_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074513',
          $1,
          'output.message',
          '00000000-0000-4000-8000-000000074504',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074514',
          $1,
          'output.message',
          'discord',
          '00000000-0000-4000-8000-000000074505',
          3
        )
      `,
      values: [threadId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chat_events_input_context_type_check",
      query: `
        INSERT INTO "chat_events" (
          "id",
          "chat_thread_id",
          "event_type",
          "context_type",
          "context_id",
          "payload",
          "seq_id"
        )
        VALUES (
          '00000000-0000-4000-8000-000000074516',
          $1,
          'input.prompt',
          NULL,
          NULL,
          '{"userMessage":{"version":1,"parts":[{"type":"text","text":"missing discriminator"}]}}'::jsonb,
          5
        )
      `,
      values: [threadId],
    });

    console.log(
      "   ✅ Chat event contexts require input discriminators while allowing context-less rejected inputs\n",
    );
  } finally {
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [agentId]);
    await client.end();
  }
}

async function runNormalizedComparison(
  dbUrl1: string,
  dbUrl2: string,
): Promise<boolean> {
  console.log(`📸 Running normalized schema comparison...`);
  try {
    execCommand(
      `tsx ${path.join(dirname, "compare-schemas-normalized.ts")} "${dbUrl1}" "${dbUrl2}"`,
      { cwd: PACKAGE_DIR },
    );
    return true;
  } catch {
    return false;
  }
}

async function backupMigrations(): Promise<void> {
  console.log("📦 Backing up current migrations...");
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
  await fs.cp(MIGRATIONS_DIR, BACKUP_DIR, { recursive: true });
}

async function restoreMigrations(): Promise<void> {
  console.log("♻️  Restoring original migrations...");
  await fs.access(BACKUP_DIR);
  await fs.rm(RESTORE_DIR, { recursive: true, force: true });
  await fs.cp(BACKUP_DIR, RESTORE_DIR, { recursive: true });
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.rename(RESTORE_DIR, MIGRATIONS_DIR);
  await fs.rm(BACKUP_DIR, { recursive: true, force: true });
}

async function addPgVectorExtensionPreludeToGeneratedMigrations(): Promise<void> {
  const sqlFiles = (await fs.readdir(MIGRATIONS_DIR))
    .filter((file) => {
      return file.endsWith(".sql");
    })
    .sort();

  const sqlByFile = await Promise.all(
    sqlFiles.map(async (file) => {
      return {
        file,
        sql: await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8"),
      };
    }),
  );

  const usesPgVector = sqlByFile.some(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!usesPgVector) {
    return;
  }

  const hasPgVectorExtension = sqlByFile.some(({ sql }) => {
    return /CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?vector"?/i.test(sql);
  });
  if (hasPgVectorExtension) {
    return;
  }

  const firstPgVectorMigration = sqlByFile.find(({ sql }) => {
    return (
      /\bvector\s*\(/i.test(sql) ||
      /\bvector_cosine_ops\b/i.test(sql) ||
      /\bUSING\s+hnsw\b/i.test(sql)
    );
  });
  if (!firstPgVectorMigration) {
    return;
  }

  const migrationPath = path.join(MIGRATIONS_DIR, firstPgVectorMigration.file);
  await fs.writeFile(
    migrationPath,
    `CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint\n${firstPgVectorMigration.sql}`,
  );
  console.log(
    `   Added pgvector extension prelude to generated migration ${firstPgVectorMigration.file}`,
  );
}

async function generateFreshMigrations(): Promise<void> {
  console.log("🔨 Generating fresh migrations from schema...");

  // Delete existing migrations
  await fs.rm(MIGRATIONS_DIR, { recursive: true, force: true });
  await fs.mkdir(MIGRATIONS_DIR, { recursive: true });

  // Generate new migrations (non-interactive)
  execCommand("pnpm drizzle-kit generate", { cwd: PACKAGE_DIR });
  await addPgVectorExtensionPreludeToGeneratedMigrations();
}

async function validateSnapshotFiles(): Promise<void> {
  console.log("=== Phase 0: Validate Snapshot Files ===\n");

  // Count SQL files
  const files = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = files
    .filter((f) => {
      return f.endsWith(".sql");
    })
    .sort();

  // Count snapshot files
  const metaFiles = await fs.readdir(path.join(MIGRATIONS_DIR, "meta"));
  const snapshotFiles = metaFiles
    .filter((f) => {
      return f.endsWith("_snapshot.json");
    })
    .sort();

  console.log(`   SQL migrations: ${sqlFiles.length}`);
  console.log(`   Snapshot files: ${snapshotFiles.length}`);

  // Check if counts match
  if (sqlFiles.length !== snapshotFiles.length) {
    console.error(
      `   ❌ Mismatch: ${sqlFiles.length} SQL files but ${snapshotFiles.length} snapshots`,
    );
    throw new Error("Migration count mismatch");
  }

  // Check each migration has a snapshot
  const missingSnapshots: string[] = [];
  for (const sqlFile of sqlFiles) {
    const match = sqlFile.match(/^(\d{4})_/);
    if (!match) continue;

    const idx = match[1];
    const snapshotFile = `${idx}_snapshot.json`;

    if (!snapshotFiles.includes(snapshotFile)) {
      missingSnapshots.push(sqlFile);
    }
  }

  if (missingSnapshots.length > 0) {
    console.error(
      `   ❌ Missing snapshots for migrations: ${missingSnapshots.join(", ")}`,
    );
    throw new Error("Missing snapshot files");
  }

  // Validate snapshot chain integrity
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  let prevId: string | undefined;
  let chainBroken = false;
  for (const [position, entry] of entries.entries()) {
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf-8"));

    if (position > 0 && snapshot.prevId !== prevId) {
      console.error(`   ❌ Snapshot ${entry.idx} prevId mismatch:`);
      console.error(`      Expected: ${prevId}`);
      console.error(`      Got: ${snapshot.prevId}`);
      chainBroken = true;
      break;
    }

    prevId = snapshot.id;
  }

  if (chainBroken) {
    console.error(`\n❌ SNAPSHOT CHAIN BROKEN`);
    console.error(
      `\n   This means the snapshot system is corrupted and needs to be rebuilt.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(`      1. Reset database: pnpm -F @okouai/db db:reset`);
    console.error(`      2. Delete your manual migration file (if any)`);
    console.error(`      3. Remove migration entry from meta/_journal.json`);
    console.error(
      `      4. Generate migration: pnpm -F @okouai/db db:generate`,
    );
    console.error(`      5. Apply migration: pnpm -F @okouai/db db:migrate`);
    console.error(`\n   ⚠️  IMPORTANT: Never manually write migration files!`);
    console.error(
      `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
    );
    console.error(`      Manual migrations break the snapshot chain.\n`);
    throw new Error("Snapshot chain broken");
  }

  console.log(`   ✅ All ${sqlFiles.length} migrations have snapshots`);
  console.log(`   ✅ Snapshot chain validated (id/prevId references intact)`);
  console.log();
}

async function expectDatabaseError(
  client: Client,
  args: {
    readonly code: string;
    readonly messageIncludes?: string;
    readonly query: string;
    readonly values?: readonly (string | number | null)[];
  },
): Promise<void> {
  try {
    await client.query(args.query, args.values ? [...args.values] : undefined);
  } catch (error) {
    assert.equal(databaseErrorCode(error), args.code);
    if (args.messageIncludes !== undefined) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(args.messageIncludes));
    }
    return;
  }
  throw new Error(`Expected database error ${args.code}`);
}

const INTEGRATION_USER_ID_TABLES = [
  "agentphone_user_agent_preferences",
  "agentphone_user_links",
  "feishu_org_connections",
  "feishu_user_agent_preferences",
  "github_user_links",
  "slack_org_connections",
  "slack_user_agent_preferences",
  "teams_org_connections",
  "teams_user_agent_preferences",
  "telegram_official_user_links",
  "telegram_user_agent_preferences",
  "telegram_user_links",
] as const;

const INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS = [
  {
    constraintName: "agentphone_user_agent_preferences_user_id_org_id_pk",
    tableName: "agentphone_user_agent_preferences",
  },
  {
    constraintName: "feishu_user_agent_preferences_user_id_org_id_pk",
    tableName: "feishu_user_agent_preferences",
  },
  {
    constraintName: "slack_user_agent_preferences_user_id_org_id_pk",
    tableName: "slack_user_agent_preferences",
  },
  {
    constraintName: "teams_user_agent_preferences_user_id_org_id_pk",
    tableName: "teams_user_agent_preferences",
  },
  {
    constraintName: "telegram_user_agent_preferences_user_id_org_id_pk",
    tableName: "telegram_user_agent_preferences",
  },
] as const;

const INTEGRATION_USER_ID_CANONICAL_INDEXES = [
  {
    definition:
      "CREATE UNIQUE INDEX agentphone_user_agent_preferences_user_id_org_id_pk ON public.agentphone_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "agentphone_user_agent_preferences_user_id_org_id_pk",
    tableName: "agentphone_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_agentphone_user_links_user_org ON public.agentphone_user_links USING btree (user_id, org_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_agentphone_user_links_user_org",
    tableName: "agentphone_user_links",
  },
  {
    definition:
      "CREATE INDEX idx_feishu_org_connections_user_id_installation ON public.feishu_org_connections USING btree (user_id, installation_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_feishu_org_connections_user_id_installation",
    tableName: "feishu_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX feishu_user_agent_preferences_user_id_org_id_pk ON public.feishu_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "feishu_user_agent_preferences_user_id_org_id_pk",
    tableName: "feishu_user_agent_preferences",
  },
  {
    definition:
      "CREATE INDEX idx_slack_org_connections_user_id_workspace ON public.slack_org_connections USING btree (user_id, slack_workspace_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_slack_org_connections_user_id_workspace",
    tableName: "slack_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX slack_user_agent_preferences_user_id_org_id_pk ON public.slack_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "slack_user_agent_preferences_user_id_org_id_pk",
    tableName: "slack_user_agent_preferences",
  },
  {
    definition:
      "CREATE INDEX idx_teams_org_connections_user_id_tenant ON public.teams_org_connections USING btree (user_id, teams_tenant_id)",
    isPrimary: false,
    isUnique: false,
    name: "idx_teams_org_connections_user_id_tenant",
    tableName: "teams_org_connections",
  },
  {
    definition:
      "CREATE UNIQUE INDEX teams_user_agent_preferences_user_id_org_id_pk ON public.teams_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "teams_user_agent_preferences_user_id_org_id_pk",
    tableName: "teams_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_telegram_official_user_links_user_org ON public.telegram_official_user_links USING btree (user_id, org_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_telegram_official_user_links_user_org",
    tableName: "telegram_official_user_links",
  },
  {
    definition:
      "CREATE UNIQUE INDEX telegram_user_agent_preferences_user_id_org_id_pk ON public.telegram_user_agent_preferences USING btree (user_id, org_id)",
    isPrimary: true,
    isUnique: true,
    name: "telegram_user_agent_preferences_user_id_org_id_pk",
    tableName: "telegram_user_agent_preferences",
  },
  {
    definition:
      "CREATE UNIQUE INDEX idx_telegram_user_links_user_id_installation ON public.telegram_user_links USING btree (user_id, installation_id)",
    isPrimary: false,
    isUnique: true,
    name: "idx_telegram_user_links_user_id_installation",
    tableName: "telegram_user_links",
  },
] as const;

async function assertCanonicalIntegrationIdentitySchema(
  client: Client,
): Promise<void> {
  const tableNames = [...INTEGRATION_USER_ID_TABLES];
  const columns = await client.query<{
    columnName: string;
    isNullable: "NO" | "YES";
    tableName: string;
  }>(
    [
      'SELECT "table_name" AS "tableName",',
      '  "column_name" AS "columnName",',
      '  "is_nullable" AS "isNullable"',
      'FROM "information_schema"."columns"',
      "WHERE \"table_schema\" = 'public'",
      '  AND "table_name" = ANY($1::text[])',
      '  AND "column_name" = ANY($2::text[])',
      'ORDER BY "table_name", "column_name"',
    ].join("\n"),
    [tableNames, ["user_id"]],
  );
  assert.deepEqual(
    columns.rows,
    INTEGRATION_USER_ID_TABLES.map((tableName) => {
      return { columnName: "user_id", isNullable: "NO", tableName };
    }),
  );

  const primaryKeys = await client.query<{
    constraintName: string;
    definition: string;
    tableName: string;
  }>(
    [
      'SELECT "relation"."relname" AS "tableName",',
      '  "constraint"."conname" AS "constraintName",',
      '  pg_get_constraintdef("constraint"."oid", false) AS "definition"',
      'FROM "pg_constraint" AS "constraint"',
      'INNER JOIN "pg_class" AS "relation"',
      '  ON "relation"."oid" = "constraint"."conrelid"',
      'INNER JOIN "pg_namespace" AS "namespace"',
      '  ON "namespace"."oid" = "relation"."relnamespace"',
      'WHERE "namespace"."nspname" = \'public\'',
      '  AND "constraint"."contype" = \'p\'',
      '  AND "relation"."relname" = ANY($1::text[])',
      'ORDER BY "relation"."relname"',
    ].join("\n"),
    [
      INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS.map(({ tableName }) => {
        return tableName;
      }),
    ],
  );
  assert.deepEqual(
    primaryKeys.rows,
    INTEGRATION_USER_ID_PREFERENCE_PRIMARY_KEYS.map(
      ({ constraintName, tableName }) => {
        return {
          constraintName,
          definition: "PRIMARY KEY (user_id, org_id)",
          tableName,
        };
      },
    ),
  );

  await client.query("SET search_path TO public, pg_catalog");
  const indexes = await client.query<{
    definition: string;
    isPrimary: boolean;
    isUnique: boolean;
    name: string;
    tableName: string;
  }>(
    [
      'SELECT "table"."relname" AS "tableName",',
      '  "index_class"."relname" AS "name",',
      '  "index"."indisprimary" AS "isPrimary",',
      '  "index"."indisunique" AS "isUnique",',
      '  pg_get_indexdef("index"."indexrelid") AS "definition"',
      'FROM "pg_index" AS "index"',
      'INNER JOIN "pg_class" AS "index_class"',
      '  ON "index_class"."oid" = "index"."indexrelid"',
      'INNER JOIN "pg_class" AS "table"',
      '  ON "table"."oid" = "index"."indrelid"',
      'WHERE "index_class"."relname" = ANY($1::text[])',
      'ORDER BY "table"."relname"',
    ].join("\n"),
    [
      INTEGRATION_USER_ID_CANONICAL_INDEXES.map(({ name }) => {
        return name;
      }),
    ],
  );
  assert.deepEqual(indexes.rows, INTEGRATION_USER_ID_CANONICAL_INDEXES);
}

async function validateCanonicalIntegrationIdentitySchema(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.2: Validate canonical integration identity schema ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await assertCanonicalIntegrationIdentitySchema(client);
    console.log(
      "   ✅ Canonical integration identity columns, keys, and indexes match\n",
    );
  } finally {
    await client.end();
  }
}
type PermanentTrigger = {
  readonly definition: string;
  readonly schemaName: string;
  readonly tableName: string;
  readonly triggerName: string;
};

type PermanentFunction = {
  readonly bodyHash: string;
  readonly functionName: string;
  readonly identityArguments: string;
  readonly kind: string;
  readonly schemaName: string;
};

// Exported from a database built by the existing migration chain. Extension-owned
// pgcrypto and vector functions are deliberately absent from the function list.
const EXPECTED_PERMANENT_TRIGGERS = [
  {
    definition:
      "CREATE TRIGGER capture_billing_run_attribution BEFORE INSERT ON public.agent_runs FOR EACH ROW EXECUTE FUNCTION capture_billing_run_attribution()",
    schemaName: "public",
    tableName: "agent_runs",
    triggerName: "capture_billing_run_attribution",
  },
  {
    definition:
      "CREATE TRIGGER billing_run_attribution_immutable BEFORE UPDATE ON public.billing_run_attribution FOR EACH ROW EXECUTE FUNCTION reject_billing_attribution_update()",
    schemaName: "public",
    tableName: "billing_run_attribution",
    triggerName: "billing_run_attribution_immutable",
  },
  {
    definition:
      "CREATE TRIGGER capture_usage_billing_attribution BEFORE INSERT OR UPDATE OF billing_run_id, billing_anchor_at, billing_context, org_id, user_id ON public.usage_event FOR EACH ROW EXECUTE FUNCTION capture_usage_billing_attribution()",
    schemaName: "public",
    tableName: "usage_event",
    triggerName: "capture_usage_billing_attribution",
  },
  {
    definition:
      "CREATE TRIGGER capture_hourly_billing_attribution BEFORE INSERT OR UPDATE OF billing_run_id, billing_anchor_at, billing_context, org_id, user_id ON public.usage_event_hourly_rollup FOR EACH ROW EXECUTE FUNCTION capture_usage_billing_attribution()",
    schemaName: "public",
    tableName: "usage_event_hourly_rollup",
    triggerName: "capture_hourly_billing_attribution",
  },
  {
    definition:
      "CREATE TRIGGER capture_generation_billing_identity BEFORE INSERT OR UPDATE OF billing_run_id, billing_context ON public.built_in_generation_jobs FOR EACH ROW EXECUTE FUNCTION capture_generation_billing_identity()",
    schemaName: "public",
    tableName: "built_in_generation_jobs",
    triggerName: "capture_generation_billing_identity",
  },
  {
    definition:
      "CREATE TRIGGER mark_raw_billing_usage_observed AFTER INSERT OR UPDATE OF billing_run_id, billing_context ON public.usage_event FOR EACH ROW EXECUTE FUNCTION mark_billing_usage_observed()",
    schemaName: "public",
    tableName: "usage_event",
    triggerName: "mark_raw_billing_usage_observed",
  },
  {
    definition:
      "CREATE TRIGGER mark_hourly_billing_usage_observed AFTER INSERT OR UPDATE OF billing_run_id, billing_context ON public.usage_event_hourly_rollup FOR EACH ROW EXECUTE FUNCTION mark_billing_usage_observed()",
    schemaName: "public",
    tableName: "usage_event_hourly_rollup",
    triggerName: "mark_hourly_billing_usage_observed",
  },
  {
    definition:
      "CREATE TRIGGER marketing_privacy_withdrawal BEFORE UPDATE ON public.privacy_choices FOR EACH ROW EXECUTE FUNCTION invalidate_marketing_privacy_epochs()",
    schemaName: "public",
    tableName: "privacy_choices",
    triggerName: "marketing_privacy_withdrawal",
  },
  {
    definition:
      "CREATE TRIGGER chat_events_reject_update BEFORE UPDATE ON public.chat_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_events",
    triggerName: "chat_events_reject_update",
  },
  {
    definition:
      "CREATE TRIGGER allocate_legacy_chat_thread_event_seq_id BEFORE INSERT ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION allocate_legacy_chat_thread_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "allocate_legacy_chat_thread_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_thread_events_reject_update BEFORE UPDATE ON public.chat_thread_events FOR EACH ROW EXECUTE FUNCTION reject_chat_event_source_update()",
    schemaName: "public",
    tableName: "chat_thread_events",
    triggerName: "chat_thread_events_reject_update",
  },
  {
    definition:
      "CREATE TRIGGER fill_legacy_chat_thread_snapshot_event_seq_id BEFORE INSERT OR UPDATE ON public.chat_thread_snapshots FOR EACH ROW EXECUTE FUNCTION fill_legacy_chat_thread_snapshot_event_seq_id()",
    schemaName: "public",
    tableName: "chat_thread_snapshots",
    triggerName: "fill_legacy_chat_thread_snapshot_event_seq_id",
  },
  {
    definition:
      "CREATE TRIGGER chat_threads_normalize_computer_access BEFORE INSERT OR UPDATE OF computer_use_host_id, cloud_browser_enabled ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION chat_threads_normalize_computer_access()",
    schemaName: "public",
    tableName: "chat_threads",
    triggerName: "chat_threads_normalize_computer_access",
  },
  {
    definition:
      "CREATE TRIGGER hosted_sites_delete_artifact_registry AFTER DELETE ON public.hosted_sites FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('hosted-site')",
    schemaName: "public",
    tableName: "hosted_sites",
    triggerName: "hosted_sites_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER image_artifacts_delete_artifact_registry AFTER DELETE ON public.image_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('image')",
    schemaName: "public",
    tableName: "image_artifacts",
    triggerName: "image_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER presentation_artifacts_delete_artifact_registry AFTER DELETE ON public.presentation_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('presentation')",
    schemaName: "public",
    tableName: "presentation_artifacts",
    triggerName: "presentation_artifacts_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_delete_artifact_registry AFTER DELETE ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('file')",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_delete_artifact_registry",
  },
  {
    definition:
      "CREATE TRIGGER run_uploaded_files_queue_artifact_catalog AFTER INSERT OR UPDATE OF run_id, chat_thread_id, user_id, org_id, external_id, filename, content_type, url, preview_image_url, metadata ON public.run_uploaded_files FOR EACH ROW EXECUTE FUNCTION queue_artifact_catalog_file()",
    schemaName: "public",
    tableName: "run_uploaded_files",
    triggerName: "run_uploaded_files_queue_artifact_catalog",
  },
  {
    definition:
      "CREATE TRIGGER video_artifacts_delete_artifact_registry AFTER DELETE ON public.video_artifacts FOR EACH ROW EXECUTE FUNCTION delete_artifact_registry_entity('video')",
    schemaName: "public",
    tableName: "video_artifacts",
    triggerName: "video_artifacts_delete_artifact_registry",
  },
] as const satisfies readonly PermanentTrigger[];

const EXPECTED_PERMANENT_FUNCTIONS = [
  {
    bodyHash: "8838fc6fbf2d02e7ca8294efda788e90",
    functionName: "billing_usage_source",
    identityArguments: "trigger_source text",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "2fdb21cba7d0146b70a3baf574368720",
    functionName: "ensure_billing_run_attribution",
    identityArguments:
      "billing_id uuid, billed_org text, billed_user text, original_start timestamp without time zone, billing_source text",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "dcd72e07d81d076359c048ef76eaa48f",
    functionName: "capture_billing_run_attribution",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "a3491f2fc3ed69bebd63f083c88d4b7f",
    functionName: "reject_billing_attribution_update",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7fa1f4813c3bcfb4d16269639d9640a3",
    functionName: "capture_usage_billing_attribution",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "81ad11f2d8edaa5b6d708e02e21b792a",
    functionName: "capture_generation_billing_identity",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "edb73467bdfa0f1f58e388f2df908b89",
    functionName: "mark_billing_usage_observed",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "9d5c181a9f7d32a4a02430ee95af739c",
    functionName: "purge_quiescent_provisional_billing_attribution",
    identityArguments:
      "billed_org text, billed_user text, quiescent_run_ids uuid[]",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7c040af77f50f9b85eb592fc30da7fcb",
    functionName: "invalidate_marketing_privacy_epochs",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "6b1b5ad47ec35bcbaad3fa95d86ef027",
    functionName: "allocate_legacy_chat_thread_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7f12cb6026b4e6d6638aaa22e0a93514",
    functionName: "chat_threads_normalize_computer_access",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "3879e0228971b9f64e4bf8439ec5df4b",
    functionName: "delete_artifact_registry_entity",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "7740cf65befb5e06a73e1f21bcfdd5cc",
    functionName: "fill_legacy_chat_thread_snapshot_event_seq_id",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "6e1e9c59353aa29b1e0ba58f1406e875",
    functionName: "queue_artifact_catalog_file",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "519c7504c787a49c4c6bea8a588711fc",
    functionName: "reject_chat_event_source_update",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
] as const satisfies readonly PermanentFunction[];

function assertPermanentInventory(args: {
  readonly actual: readonly string[];
  readonly expected: readonly string[];
  readonly label: string;
}): void {
  const actual = new Set(args.actual);
  const expected = new Set(args.expected);
  const missing = args.expected.filter((object) => {
    return !actual.has(object);
  });
  const unexpected = args.actual.filter((object) => {
    return !expected.has(object);
  });

  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        `Permanent ${args.label} inventory mismatch`,
        `Missing ${args.label}: ${missing.join(", ") || "none"}`,
        `Unexpected ${args.label}: ${unexpected.join(", ") || "none"}`,
      ].join("\n"),
    );
  }
}

async function validatePermanentTriggerAndFunctionInventory(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1: Validate permanent trigger and function inventory ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // pg_get_triggerdef output depends on search_path.
    await client.query(`SET search_path TO public, pg_catalog`);
    const triggers = await client.query<PermanentTrigger>(`
      SELECT
        namespace."nspname" AS "schemaName",
        relation."relname" AS "tableName",
        catalog_trigger."tgname" AS "triggerName",
        pg_catalog.pg_get_triggerdef(catalog_trigger."oid") AS "definition"
      FROM pg_catalog."pg_trigger" AS catalog_trigger
      INNER JOIN pg_catalog."pg_class" AS relation
        ON relation."oid" = catalog_trigger."tgrelid"
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = relation."relnamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT catalog_trigger."tgisinternal"
      ORDER BY
        namespace."nspname",
        relation."relname",
        catalog_trigger."tgname"
    `);
    const functions = await client.query<PermanentFunction>(`
      SELECT
        namespace."nspname" AS "schemaName",
        catalog_function."proname" AS "functionName",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
          AS "identityArguments",
        catalog_function."prokind"::text AS "kind",
        pg_catalog.md5(catalog_function."prosrc") AS "bodyHash"
      FROM pg_catalog."pg_proc" AS catalog_function
      INNER JOIN pg_catalog."pg_namespace" AS namespace
        ON namespace."oid" = catalog_function."pronamespace"
      WHERE namespace."nspname" = current_schema()
        AND namespace."nspname" NOT LIKE 'pg_temp_%'
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog."pg_depend" AS dependency
          WHERE dependency."classid" = 'pg_catalog.pg_proc'::regclass
            AND dependency."objid" = catalog_function."oid"
            AND dependency."refclassid" = 'pg_catalog.pg_extension'::regclass
            AND dependency."deptype" = 'e'
        )
      ORDER BY
        namespace."nspname",
        catalog_function."proname",
        pg_catalog.pg_get_function_identity_arguments(catalog_function."oid")
    `);

    const triggerKey = (trigger: PermanentTrigger): string => {
      return `${trigger.schemaName}.${trigger.tableName}.${trigger.triggerName} [${trigger.definition}]`;
    };
    const functionKey = (catalogFunction: PermanentFunction): string => {
      return `${catalogFunction.schemaName}.${catalogFunction.functionName}(${catalogFunction.identityArguments}) [${catalogFunction.kind}] [body md5=${catalogFunction.bodyHash}]`;
    };

    assertPermanentInventory({
      actual: triggers.rows.map(triggerKey),
      expected: EXPECTED_PERMANENT_TRIGGERS.map(triggerKey),
      label: "triggers",
    });
    assertPermanentInventory({
      actual: functions.rows.map(functionKey),
      expected: EXPECTED_PERMANENT_FUNCTIONS.map(functionKey),
      label: "functions",
    });

    console.log("   ✅ Permanent trigger and function inventories match\n");
  } finally {
    await client.end();
  }
}

async function validatePermanentArtifactTriggerBehavior(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.2: Validate permanent artifact trigger behavior ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const fixture = {
    agentId: "00000000-0000-4000-8000-000000246701",
    sessionId: "00000000-0000-4000-8000-000000246702",
    firstRunId: "00000000-0000-4000-8000-000000246703",
    secondRunId: "00000000-0000-4000-8000-000000246704",
    firstThreadId: "00000000-0000-4000-8000-000000246705",
    secondThreadId: "00000000-0000-4000-8000-000000246706",
    hostedSiteId: "00000000-0000-4000-8000-000000246707",
    presentationSiteId: "00000000-0000-4000-8000-000000246708",
    scopedSiteId: "00000000-0000-4000-8000-000000246709",
    directFileId: "00000000-0000-4000-8000-000000246710",
    queuedFileId: "00000000-0000-4000-8000-000000246711",
    imageFileId: "00000000-0000-4000-8000-000000246712",
    videoFileId: "00000000-0000-4000-8000-000000246713",
    imageId: "00000000-0000-4000-8000-000000246714",
    presentationId: "00000000-0000-4000-8000-000000246715",
    videoId: "00000000-0000-4000-8000-000000246716",
    orgId: "permanent-artifact-trigger-org",
    otherUserId: "permanent-artifact-trigger-other-user",
    userId: "permanent-artifact-trigger-user",
  } as const;
  const registryIds = [
    "00000000-0000-4000-8000-000000246721",
    "00000000-0000-4000-8000-000000246722",
    "00000000-0000-4000-8000-000000246723",
    "00000000-0000-4000-8000-000000246724",
    "00000000-0000-4000-8000-000000246725",
  ] as const;

  try {
    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, $2, $3, 'permanent-artifact-trigger-test')`,
      [fixture.agentId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "agent_sessions" (
         "id", "user_id", "org_id", "agent_id"
       )
       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.userId, fixture.orgId, fixture.agentId],
    );
    await client.query(
      `INSERT INTO "agent_runs" (
         "id", "user_id", "session_id", "status", "prompt", "org_id"
       )
       VALUES
         ($1, $3, $4, 'running', 'first scoped deployment', $5),
         ($2, $3, $4, 'running', 'second scoped deployment', $5)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    );
    await client.query(
      `INSERT INTO "chat_threads" (
         "id", "user_id", "agent_id", "title"
       )
       VALUES
         ($1, $3, $4, 'First permanent artifact trigger chat'),
         ($2, $5, $4, 'Second permanent artifact trigger chat')`,
      [
        fixture.firstThreadId,
        fixture.secondThreadId,
        fixture.userId,
        fixture.agentId,
        fixture.otherUserId,
      ],
    );
    await client.query(
      `UPDATE "agent_runs"
       SET
         "trigger_source" = 'chat',
         "autonomy_budget" = 10,
         "chat_thread_id" = CASE
           WHEN "id" = $1 THEN $3::uuid
           ELSE $4::uuid
         END
       WHERE "id" IN ($1, $2)`,
      [
        fixture.firstRunId,
        fixture.secondRunId,
        fixture.firstThreadId,
        fixture.secondThreadId,
      ],
    );
    await client.query(
      `INSERT INTO "run_uploaded_files" (
         "id", "source", "external_id", "user_id", "org_id", "url",
         "run_id"
       )
       VALUES
         ($1, 'web', 'direct-file', $5, NULL, NULL, NULL),
         ($2, 'web', 'queued-file', $5, $6,
          'https://example.invalid/queued-file', $7),
         ($3, 'web', 'image-file', $5, NULL, NULL, NULL),
         ($4, 'web', 'video-file', $5, NULL, NULL, NULL)`,
      [
        fixture.directFileId,
        fixture.queuedFileId,
        fixture.imageFileId,
        fixture.videoFileId,
        fixture.userId,
        fixture.orgId,
        fixture.firstRunId,
      ],
    );
    const queuedFile = await client.query<{
      authorUserId: string;
      orgId: string;
    }>(
      `SELECT
         "author_user_id" AS "authorUserId",
         "org_id" AS "orgId"
       FROM "artifact_catalog_pending_files"
       WHERE "file_id" = $1`,
      [fixture.queuedFileId],
    );
    assert.deepEqual(queuedFile.rows, [
      { authorUserId: fixture.userId, orgId: fixture.orgId },
    ]);

    await client.query(
      `INSERT INTO "hosted_sites" (
         "id", "org_id", "user_id", "slug", "public_slug",
         "requested_slug", "chat_thread_id", "created_from_run_id",
         "public_brand"
       )
       VALUES
         ($1, $4, $5, 'permanent-hosted-site', 'permanent-hosted-site',
          'permanent-hosted-site', $6, $7, 'vm0'),
         ($2, $4, $5, 'permanent-presentation', 'permanent-presentation',
          'permanent-presentation', NULL, NULL, 'vm0'),
         ($3, $4, $5, 'permanent-scoped-site', 'permanent-scoped-site',
          'permanent-scoped-site', $6, NULL, 'vm0')`,
      [
        fixture.hostedSiteId,
        fixture.presentationSiteId,
        fixture.scopedSiteId,
        fixture.orgId,
        fixture.userId,
        fixture.firstThreadId,
        fixture.firstRunId,
      ],
    );
    await client.query(
      `INSERT INTO "image_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.imageId, fixture.imageFileId],
    );
    await client.query(
      `INSERT INTO "presentation_artifacts" ("id", "hosted_site_id")
       VALUES ($1, $2)`,
      [fixture.presentationId, fixture.presentationSiteId],
    );
    await client.query(
      `INSERT INTO "video_artifacts" ("id", "file_id") VALUES ($1, $2)`,
      [fixture.videoId, fixture.videoFileId],
    );
    await client.query(
      `INSERT INTO "artifacts" (
         "id", "org_id", "author_user_id", "kind", "entity_id",
         "logical_key", "projection_file_id", "projection_created_at", "title"
       )
       VALUES
         ($1, $6, $7, 'hosted-site', $8, 'permanent-hosted-site', $9, now(), 'Hosted site'),
         ($2, $6, $7, 'image', $10, 'permanent-image', $11, now(), 'Image'),
         ($3, $6, $7, 'presentation', $12, 'permanent-presentation', $13, now(), 'Presentation'),
         ($4, $6, $7, 'video', $14, 'permanent-video', $15, now(), 'Video'),
         ($5, $6, $7, 'file', $16, 'permanent-file', $16, now(), 'File')`,
      [
        ...registryIds,
        fixture.orgId,
        fixture.userId,
        fixture.hostedSiteId,
        fixture.directFileId,
        fixture.imageId,
        fixture.imageFileId,
        fixture.presentationId,
        fixture.queuedFileId,
        fixture.videoId,
        fixture.videoFileId,
        fixture.directFileId,
      ],
    );

    await client.query(`DELETE FROM "hosted_sites" WHERE "id" = $1`, [
      fixture.hostedSiteId,
    ]);
    await client.query(`DELETE FROM "image_artifacts" WHERE "id" = $1`, [
      fixture.imageId,
    ]);
    await client.query(`DELETE FROM "presentation_artifacts" WHERE "id" = $1`, [
      fixture.presentationId,
    ]);
    await client.query(`DELETE FROM "video_artifacts" WHERE "id" = $1`, [
      fixture.videoId,
    ]);
    await client.query(`DELETE FROM "run_uploaded_files" WHERE "id" = $1`, [
      fixture.directFileId,
    ]);

    const remainingRegistryRows = await client.query<{ kind: string }>(
      `SELECT "kind"
       FROM "artifacts"
       WHERE "id" = ANY($1::uuid[])
       ORDER BY "kind"`,
      [[...registryIds]],
    );
    assert.deepEqual(remainingRegistryRows.rows, []);

    console.log("   ✅ Artifact registry cascades and catalog queueing work\n");
  } finally {
    await client.query(`DELETE FROM "artifacts" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_deployments" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(`DELETE FROM "hosted_sites" WHERE "org_id" = $1`, [
      fixture.orgId,
    ]);
    await client.query(
      `DELETE FROM "run_uploaded_files" WHERE "user_id" = $1`,
      [fixture.userId],
    );
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [
      fixture.agentId,
    ]);
    await client.end();
  }
}

async function validatePermanentAgentRunMetadataState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.3: Validate permanent agent-run metadata state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000270951",
    lifecycleRunId: "00000000-0000-4000-8000-000000270953",
    outOfRangeRunId: "00000000-0000-4000-8000-000000270955",
    partialRunId: "00000000-0000-4000-8000-000000270954",
    productRunId: "00000000-0000-4000-8000-000000270952",
    sessionId: "00000000-0000-4000-8000-000000270950",
    orgId: "permanent-agent-run-metadata-org",
    userId: "permanent-agent-run-metadata-user",
  } as const;

  try {
    const constraints = await client.query<{
      definition: string;
      name: string;
      validated: boolean;
    }>(`
      SELECT
        "conname" AS "name",
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" IN (
          'agent_runs_autonomy_budget_check',
          'agent_runs_metadata_presence_check'
        )
      ORDER BY "conname"
    `);
    assert.deepEqual(
      constraints.rows.map((constraint) => {
        return { name: constraint.name, validated: constraint.validated };
      }),
      [
        { name: "agent_runs_autonomy_budget_check", validated: true },
        { name: "agent_runs_metadata_presence_check", validated: true },
      ],
    );
    const metadataPresence = constraints.rows.find((constraint) => {
      return constraint.name === "agent_runs_metadata_presence_check";
    });
    assert.ok(metadataPresence);
    const metadataColumns = [
      "trigger_source",
      "autonomy_budget",
      "workflow_automation_id",
      "model_provider",
      "model_provider_id",
      "model_provider_credential_scope",
      "selected_model",
      "model_runtime_provider",
      "model_runtime_model",
      "built_in_model_key_id",
      "codex_service_tier",
      "selected_video_model",
      "selected_image_model",
      "chat_thread_id",
      "api_started_at",
      "first_assistant_event_acknowledged_at",
      "summary",
      "trigger_brief",
    ] as const;
    for (const column of metadataColumns) {
      assert.ok(metadataPresence.definition.includes(`${column} IS NULL`));
    }
    assert.ok(
      metadataPresence.definition.includes("trigger_source IS NOT NULL"),
    );
    assert.ok(
      metadataPresence.definition.includes("autonomy_budget IS NOT NULL"),
    );

    assert.equal(metadataPresence.definition.match(/ IS NULL/gu)?.length, 18);
    assert.equal(
      metadataPresence.definition.match(/ IS NOT NULL/gu)?.length,
      2,
    );
    const goalObjects = await client.query(`SELECT
      to_regclass('public.thread_goals') IS NULL AS table_absent,
      to_regclass('public.idx_agent_runs_goal') IS NULL AS index_absent,
      NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'agent_runs'::regclass
        AND attname = 'goal_id' AND NOT attisdropped) AS column_absent,
      NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN (
        'agent_runs_goal_id_thread_goals_id_fk', 'agent_runs_metadata_without_goal_check')) AS transitional_constraints_absent`);
    assert.deepEqual(goalObjects.rows, [
      {
        table_absent: true,
        index_absent: true,
        column_absent: true,
        transitional_constraints_absent: true,
      },
    ]);

    const discriminators = await client.query<{
      columnDefault: string | null;
      columnName: string;
      isNullable: string;
    }>(`
      SELECT
        "column_name" AS "columnName",
        "is_nullable" AS "isNullable",
        "column_default" AS "columnDefault"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'agent_runs'
        AND "column_name" IN ('trigger_source', 'autonomy_budget')
      ORDER BY "column_name"
    `);
    assert.deepEqual(discriminators.rows, [
      {
        columnDefault: null,
        columnName: "autonomy_budget",
        isNullable: "YES",
      },
      {
        columnDefault: null,
        columnName: "trigger_source",
        isNullable: "YES",
      },
    ]);

    const retiredPhysicalState = await client.query<{
      constraintCount: number;
      physicalRelationCount: number;
      rewriteReferenceCount: number;
      routineReferenceCount: number;
      tableAbsent: boolean;
      transitionRoutineCount: number;
      transitionTriggerCount: number;
    }>(`
      SELECT
        to_regclass('public.zero_runs') IS NULL AS "tableAbsent",
        (
          SELECT count(*)::integer
          FROM "pg_class" AS "relation_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "relation_row"."relnamespace"
          WHERE "namespace_row"."nspname" = 'public'
            AND "relation_row"."relname" IN (
              'zero_runs',
              'zero_runs_pkey',
              'idx_zero_runs_chat_thread_id',
              'idx_zero_runs_workflow_automation',
              'idx_zero_runs_goal'
            )
        ) AS "physicalRelationCount",
        (
          SELECT count(*)::integer
          FROM "pg_constraint"
          WHERE "conname" LIKE 'zero_runs_%'
        ) AS "constraintCount",
        (
          SELECT count(*)::integer
          FROM "pg_trigger"
          WHERE "tgname" = 'sync_zero_run_metadata_to_agent_runs'
            AND NOT "tgisinternal"
        ) AS "transitionTriggerCount",
        (
          SELECT count(*)::integer
          FROM "pg_proc" AS "routine_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "routine_row"."pronamespace"
          WHERE "namespace_row"."nspname" = 'public'
            AND "routine_row"."proname" IN (
              'sync_zero_run_metadata_to_agent_runs',
              'backfill_agent_run_metadata_stage2'
            )
        ) AS "transitionRoutineCount",
        (
          SELECT count(*)::integer
          FROM "pg_proc" AS "routine_row"
          INNER JOIN "pg_namespace" AS "namespace_row"
            ON "namespace_row"."oid" = "routine_row"."pronamespace"
          WHERE "routine_row"."prokind" IN ('f', 'p')
            AND "namespace_row"."nspname" NOT IN (
              'pg_catalog',
              'information_schema'
            )
            AND pg_get_functiondef("routine_row"."oid") ILIKE '%zero_runs%'
        ) AS "routineReferenceCount",
        (
          SELECT count(*)::integer
          FROM "pg_rewrite" AS "rewrite_row"
          WHERE pg_get_ruledef("rewrite_row"."oid") ILIKE '%zero_runs%'
        ) AS "rewriteReferenceCount"
    `);
    assert.deepEqual(retiredPhysicalState.rows, [
      {
        constraintCount: 0,
        physicalRelationCount: 0,
        rewriteReferenceCount: 0,
        routineReferenceCount: 0,
        tableAbsent: true,
        transitionRoutineCount: 0,
        transitionTriggerCount: 0,
      },
    ]);

    const metadataReaders = await client.query<{
      body: string;
      name: string;
    }>(`
      SELECT "proname" AS "name", "prosrc" AS "body"
      FROM "pg_proc"
      WHERE "pronamespace" = 'public'::regnamespace
        AND "proname" IN (
          'queue_artifact_catalog_file'
        )
      ORDER BY "proname"
    `);
    assert.equal(metadataReaders.rows.length, 1);
    for (const reader of metadataReaders.rows) {
      assert.ok(reader.body.includes('FROM "agent_runs"'));
      assert.ok(reader.body.includes('"trigger_source" IS NOT NULL'));
      assert.ok(!reader.body.includes('"zero_runs"'));
    }

    await client.query(
      `INSERT INTO "agents" ("id", "org_id", "owner", "name")
       VALUES ($1, $2, $3, 'permanent-agent-run-metadata')`,
      [fixture.agentId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "agent_sessions" (
         "id", "user_id", "org_id", "agent_id"
       ) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.userId, fixture.orgId, fixture.agentId],
    );
    await client.query(
      `INSERT INTO "agent_runs" (
         "id", "user_id", "session_id", "status", "prompt", "org_id"
       ) VALUES
         ($1, $3, $4, 'failed', 'durable lifecycle-only history', $5),
         ($2, $3, $4, 'completed', 'valid product run', $5)`,
      [
        fixture.lifecycleRunId,
        fixture.productRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    );
    await client.query(
      `UPDATE "agent_runs"
       SET "trigger_source" = 'chat', "autonomy_budget" = 10
       WHERE "id" = $1`,
      [fixture.productRunId],
    );
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_metadata_presence_check",
      query: `INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source"
      ) VALUES ($1, $2, $3, 'failed', 'partial metadata', $4, 'chat')`,
      values: [
        fixture.partialRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_metadata_presence_check",
      query: `UPDATE "agent_runs" SET "summary" = 'invented provenance'
        WHERE "id" = $1`,
      values: [fixture.lifecycleRunId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "agent_runs_autonomy_budget_check",
      query: `INSERT INTO "agent_runs" (
        "id", "user_id", "session_id", "status", "prompt", "org_id",
        "trigger_source", "autonomy_budget"
      ) VALUES ($1, $2, $3, 'failed', 'invalid budget', $4, 'chat', 11)`,
      values: [
        fixture.outOfRangeRunId,
        fixture.userId,
        fixture.sessionId,
        fixture.orgId,
      ],
    });

    // Every remaining optional metadata term must reject partial SQL writes.
    // Valid values for each type ensure the constraint, not a cast, rejects it.
    const metadataValues = {
      trigger_source: "'chat'",
      autonomy_budget: "1",
      workflow_automation_id: "gen_random_uuid()",
      model_provider: "'fixture'",
      model_provider_id: "gen_random_uuid()",
      model_provider_credential_scope: "'user'",
      selected_model: "'fixture'",
      model_runtime_provider: "'fixture'",
      model_runtime_model: "'fixture'",
      built_in_model_key_id: "gen_random_uuid()",
      codex_service_tier: "'priority'",
      selected_video_model: "'fixture'",
      selected_image_model: "'fixture'",
      chat_thread_id: "gen_random_uuid()",
      api_started_at: "now()",
      first_assistant_event_acknowledged_at: "now()",
      summary: "'fixture'",
      trigger_brief: "'fixture'",
    } as const;
    for (const column of metadataColumns) {
      await expectDatabaseError(client, {
        code: "23514",
        messageIncludes: "agent_runs_metadata_presence_check",
        query: `UPDATE agent_runs SET "${column}" = ${metadataValues[column]} WHERE id = $1`,
        values: [fixture.lifecycleRunId],
      });
    }

    const validStates = await client.query<{
      autonomyBudget: number | null;
      id: string;
      summary: string | null;
      triggerSource: string | null;
    }>(
      `
      SELECT
        "id"::text AS "id",
        "trigger_source" AS "triggerSource",
        "autonomy_budget" AS "autonomyBudget",
        "summary"
      FROM "agent_runs"
      WHERE "id" IN ($1, $2)
      ORDER BY "id"
    `,
      [fixture.productRunId, fixture.lifecycleRunId],
    );
    assert.deepEqual(validStates.rows, [
      {
        autonomyBudget: 10,
        id: fixture.productRunId,
        summary: null,
        triggerSource: "chat",
      },
      {
        autonomyBudget: null,
        id: fixture.lifecycleRunId,
        summary: null,
        triggerSource: null,
      },
    ]);

    console.log(
      "   ✅ nullable two-state metadata, range, permanent readers, and physical zero_runs removal are enforced\n",
    );
  } finally {
    await client.query(`DELETE FROM "agents" WHERE "id" = $1`, [
      fixture.agentId,
    ]);
    await client.end();
  }
}

async function validateConnectorCatalogFinalConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.6: Validate final connector catalog constraints ===\n",
  );
  const attemptConstraint =
    "connector_catalog_sync_state_attempt_cache_reuse_complete";
  const candidateConstraint =
    "connector_catalog_sync_state_rejected_candidate_complete";
  const authorityConstraint =
    "connector_catalog_sync_state_rejection_authority_complete";

  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO "connector_catalog_sync_state" (
        "source_id",
        "schema_version",
        "last_attempt_at",
        "last_attempt_outcome",
        "last_attempt_reused_cached_rejection",
        "last_failure_code",
        "last_rejected_catalog_version",
        "last_rejected_catalog_key",
        "last_rejected_catalog_digest",
        "last_rejected_pointer_etag",
        "last_rejected_failure_code",
        "last_rejected_backend_version",
        "last_rejected_build_commit_sha"
      )
      VALUES
        (
          'migration-final-catalog-accepted',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          FALSE,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL
        ),
        (
          'migration-final-catalog-rejected',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          TRUE,
          'invalid-artifact',
          '2026-07-25.1',
          'connectors/v1/releases/2026-07-25.1/catalog.json',
          'sha256:${"b".repeat(64)}',
          '"final-authority-etag"',
          'invalid-artifact',
          '1.319.0',
          '${"a".repeat(40)}'
        )
    `);
    const validRows = await client.query<{ source_id: string }>(`
      SELECT "source_id"
      FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
      ORDER BY "source_id"
    `);
    assert.deepEqual(
      validRows.rows.map((row) => {
        return row.source_id;
      }),
      ["migration-final-catalog-accepted", "migration-final-catalog-rejected"],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_attempt_reused_cached_rejection")
        VALUES ('invalid-provenance-without-attempt', 1, FALSE)
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_failure_code"
        )
        VALUES (
          'invalid-missing-attempt-provenance',
          1,
          '2026-07-25 00:00:00',
          'rejected',
          'source-unavailable'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: attemptConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_attempt_at",
          "last_attempt_outcome",
          "last_attempt_reused_cached_rejection"
        )
        VALUES (
          'invalid-reused-accepted-attempt',
          1,
          '2026-07-25 00:00:00',
          'accepted',
          TRUE
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: candidateConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-partial-rejected-candidate',
          1,
          '2026-07-25.2',
          'invalid-artifact',
          '1.319.0'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_catalog_version",
          "last_rejected_catalog_key",
          "last_rejected_catalog_digest",
          "last_rejected_failure_code"
        )
        VALUES (
          'invalid-candidate-without-authority',
          1,
          '2026-07-25.3',
          'connectors/v1/releases/2026-07-25.3/catalog.json',
          'sha256:${"c".repeat(64)}',
          'invalid-artifact'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state"
          ("source_id", "schema_version", "last_rejected_backend_version")
        VALUES ('invalid-authority-without-candidate', 1, '1.319.0')
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version"
        )
        VALUES (
          'invalid-rejection-backend-version',
          1,
          '"invalid-version-etag"',
          'invalid-pointer',
          '1.319.0-rc.1'
        )
      `,
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: authorityConstraint,
      query: `
        INSERT INTO "connector_catalog_sync_state" (
          "source_id",
          "schema_version",
          "last_rejected_pointer_etag",
          "last_rejected_failure_code",
          "last_rejected_backend_version",
          "last_rejected_build_commit_sha"
        )
        VALUES (
          'invalid-rejection-build-commit',
          1,
          '"invalid-build-etag"',
          'invalid-pointer',
          '1.319.0',
          '${"d".repeat(39)}'
        )
      `,
    });

    await client.query(`
      DELETE FROM "connector_catalog_sync_state"
      WHERE "source_id" IN (
        'migration-final-catalog-accepted',
        'migration-final-catalog-rejected'
      )
    `);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Final connector catalog constraints accept complete state and reject ambiguous state\n",
  );
}

async function validateCustomConnectorOauthModeConstraints(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.7: Validate custom connector OAuth mode constraints ===\n",
  );
  const fixture = {
    orgId: "migration-custom-connector-oauth-org",
    createdBy: "migration-custom-connector-oauth-user",
    manualConnectorId: "72000000-0000-4000-8000-000000000001",
    oauthConnectorId: "72000000-0000-4000-8000-000000000002",
    automaticConnectorId: "72000000-0000-4000-8000-000000000005",
    automaticAccountId: "72000000-0000-4000-8000-000000000006",
    dcrRegistrationId: "72000000-0000-4000-8000-000000000007",
    otherAutomaticConnectorId: "72000000-0000-4000-8000-000000000008",
    otherAutomaticAccountId: "72000000-0000-4000-8000-000000000009",
  } as const;
  const insertConnector = `
    INSERT INTO "org_custom_connectors" (
      "id",
      "org_id",
      "slug",
      "display_name",
      "prefix_templates",
      "fields",
      "header_injections",
      "query_injections",
      "auth_mode",
      "created_by"
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      '["https://api.example.test/"]'::jsonb,
      CASE
        WHEN $5 = 'manual' THEN '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb
        ELSE '[]'::jsonb
      END,
      CASE
        WHEN $5 = 'manual' THEN '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb
        ELSE '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb
      END,
      '[]'::jsonb,
      $5,
      $6
    )
  `;
  const insertOauthConfig = `
    INSERT INTO "org_custom_connector_oauth_configs" (
      "connector_id",
      "org_id",
      "provider_adapter",
      "client_id",
      "encrypted_client_secret",
      "authorization_url",
      "token_url",
      "token_endpoint_auth_method",
      "pkce_method"
    )
    VALUES (
      $1,
      $2,
      'standard',
      'migration-client',
      'migration-encrypted-secret',
      'https://oauth.example.test/authorize',
      'https://oauth.example.test/token',
      'client_secret_basic',
      'none'
    )
  `;
  const insertAutomaticConnector = `
    INSERT INTO "org_custom_connectors" (
      "id",
      "org_id",
      "slug",
      "display_name",
      "fields",
      "header_injections",
      "query_injections",
      "auth_mode",
      "mcp_endpoint",
      "mcp_transport",
      "created_by"
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      '[]'::jsonb,
      '[]'::jsonb,
      '[]'::jsonb,
      'automatic',
      'https://mcp.example.test',
      'streamable-http',
      $5
    )
  `;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    const retiredDefinitionColumn = await client.query<{ count: string }>(`
      SELECT count(*)::text AS "count"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'org_custom_connectors'
        AND "column_name" = 'oauth_setup'
    `);
    assert.equal(retiredDefinitionColumn.rows[0]?.count, "0");

    await client.query(insertConnector, [
      fixture.manualConnectorId,
      fixture.orgId,
      "_migration_manual",
      "Migration Manual Connector",
      "manual",
      fixture.createdBy,
    ]);

    await client.query("BEGIN");
    await client.query(insertConnector, [
      fixture.oauthConnectorId,
      fixture.orgId,
      "_migration_oauth",
      "Migration OAuth Connector",
      "oauth",
      fixture.createdBy,
    ]);
    await client.query(insertOauthConfig, [
      fixture.oauthConnectorId,
      fixture.orgId,
    ]);
    await client.query("COMMIT");

    await client.query(insertAutomaticConnector, [
      fixture.automaticConnectorId,
      fixture.orgId,
      "_migration_automatic_oauth",
      "Migration Automatic OAuth Connector",
      fixture.createdBy,
    ]);
    await client.query(insertAutomaticConnector, [
      fixture.otherAutomaticConnectorId,
      fixture.orgId,
      "_migration_other_automatic_oauth",
      "Migration Other Automatic OAuth Connector",
      fixture.createdBy,
    ]);

    await expectDatabaseError(client, {
      code: "23514",
      query: `
        UPDATE "org_custom_connectors"
        SET "mcp_endpoint" = NULL, "mcp_transport" = NULL
        WHERE "id" = $1
      `,
      values: [fixture.automaticConnectorId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      query: `
        UPDATE "org_custom_connectors"
        SET "header_injections" =
          '[{"name":"Authorization","valueTemplate":"Bearer {{oauth.access_token}}"}]'::jsonb
        WHERE "id" = $1
      `,
      values: [fixture.automaticConnectorId],
    });

    await client.query(
      `
        INSERT INTO "connectors" (
          "id", "custom_connector_id", "auth_method", "storage_version",
          "user_id", "org_id"
        )
        VALUES ($1, $2, 'oauth', 1, $3, $4)
      `,
      [
        fixture.automaticAccountId,
        fixture.automaticConnectorId,
        fixture.createdBy,
        fixture.orgId,
      ],
    );
    await client.query(
      `
        INSERT INTO "connectors" (
          "id", "custom_connector_id", "auth_method", "storage_version",
          "user_id", "org_id"
        )
        VALUES ($1, $2, 'oauth', 1, $3, $4)
      `,
      [
        fixture.otherAutomaticAccountId,
        fixture.otherAutomaticConnectorId,
        fixture.createdBy,
        fixture.orgId,
      ],
    );
    await client.query(
      `
        INSERT INTO "org_custom_connector_dcr_registrations" (
          "id", "org_id", "custom_connector_id", "issuer", "client_id",
          "encrypted_client_secret", "token_endpoint_auth_method",
          "registered_scopes", "redirect_uri", "issued_at", "expires_at"
        )
        VALUES (
          $1, $2, $3, 'https://issuer.example.test', 'dcr-client',
          'encrypted-dcr-secret', 'client_secret_basic', ARRAY['read'],
          'https://app.example.test/api/custom-connectors/oauth2/callback',
          '2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z'
        )
      `,
      [fixture.dcrRegistrationId, fixture.orgId, fixture.automaticConnectorId],
    );
    await expectDatabaseError(client, {
      code: "23505",
      query: `
        INSERT INTO "org_custom_connector_dcr_registrations" (
          "org_id", "custom_connector_id", "issuer", "client_id",
          "token_endpoint_auth_method", "registered_scopes", "redirect_uri",
          "issued_at"
        )
        VALUES (
          $1, $2, 'https://issuer.example.test', 'duplicate-client', 'none',
          ARRAY[]::text[],
          'https://app.example.test/api/custom-connectors/oauth2/callback',
          '2026-08-31T00:00:00Z'
        )
      `,
      values: [fixture.orgId, fixture.automaticConnectorId],
    });
    await expectDatabaseError(client, {
      code: "23503",
      query: `
        INSERT INTO "custom_connector_account_oauth_bindings" (
          "connector_account_id", "custom_connector_id", "issuer", "resource",
          "token_endpoint", "client_id", "token_endpoint_auth_method",
          "registration_method", "dcr_registration_id"
        )
        VALUES (
          $1, $2, 'https://issuer.example.test', 'https://mcp.example.test',
          'https://issuer.example.test/token', 'dcr-client',
          'client_secret_basic', 'dcr', $3
        )
      `,
      values: [
        fixture.otherAutomaticAccountId,
        fixture.otherAutomaticConnectorId,
        fixture.dcrRegistrationId,
      ],
    });
    await client.query(
      `
        INSERT INTO "custom_connector_account_oauth_bindings" (
          "connector_account_id", "custom_connector_id", "issuer", "resource",
          "token_endpoint", "client_id", "token_endpoint_auth_method",
          "registration_method"
        )
        VALUES (
          $1, $2, 'https://cimd.example.test', 'https://other-mcp.example.test',
          'https://cimd.example.test/token', 'cimd-client', 'none', 'cimd'
        )
      `,
      [fixture.otherAutomaticAccountId, fixture.otherAutomaticConnectorId],
    );
    await expectDatabaseError(client, {
      code: "23514",
      query: `
        UPDATE "custom_connector_account_oauth_bindings"
        SET "token_endpoint_auth_method" = 'client_secret_post'
        WHERE "connector_account_id" = $1
      `,
      values: [fixture.otherAutomaticAccountId],
    });
    await client.query(
      `
        INSERT INTO "custom_connector_account_oauth_bindings" (
          "connector_account_id", "custom_connector_id", "issuer", "resource",
          "resource_metadata_url", "token_endpoint", "client_id",
          "token_endpoint_auth_method", "registration_method", "dcr_registration_id"
        )
        VALUES (
          $1, $2, 'https://issuer.example.test', 'https://mcp.example.test',
          'https://mcp.example.test/.well-known/oauth-protected-resource',
          'https://issuer.example.test/token', 'dcr-client',
          'client_secret_basic', 'dcr', $3
        )
      `,
      [
        fixture.automaticAccountId,
        fixture.automaticConnectorId,
        fixture.dcrRegistrationId,
      ],
    );
    const account = await client.query<{ auth_method: string }>(
      `SELECT "auth_method" FROM "connectors" WHERE "id" = $1`,
      [fixture.automaticAccountId],
    );
    assert.equal(account.rows[0]?.auth_method, "oauth");
    await expectDatabaseError(client, {
      code: "23514",
      query: `
        UPDATE "org_custom_connector_dcr_registrations"
        SET "expires_at" = "issued_at"
        WHERE "id" = $1
      `,
      values: [fixture.dcrRegistrationId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      query: `
        UPDATE "custom_connector_account_oauth_bindings"
        SET "registration_method" = 'cimd'
        WHERE "connector_account_id" = $1
      `,
      values: [fixture.automaticAccountId],
    });
    await client.query(`DELETE FROM "connectors" WHERE "id" = $1`, [
      fixture.automaticAccountId,
    ]);
    const deletedBinding = await client.query(
      `
        SELECT 1 FROM "custom_connector_account_oauth_bindings"
        WHERE "connector_account_id" = $1
      `,
      [fixture.automaticAccountId],
    );
    assert.equal(deletedBinding.rowCount, 0);

    await client.query(
      `
        DELETE FROM "org_custom_connectors"
        WHERE "id" IN ($1, $2, $3, $4)
      `,
      [
        fixture.manualConnectorId,
        fixture.oauthConnectorId,
        fixture.automaticConnectorId,
        fixture.otherAutomaticConnectorId,
      ],
    );
    const deletedRegistration = await client.query(
      `
        SELECT 1 FROM "org_custom_connector_dcr_registrations"
        WHERE "id" = $1
      `,
      [fixture.dcrRegistrationId],
    );
    assert.equal(deletedRegistration.rowCount, 0);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ OAuth and Automatic modes, bindings, and cascades preserve strict ownership\n",
  );
}

async function validateCustomConnectorSkillVersionPair(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.8: Validate custom connector skill version pair ===\n",
  );
  const fixture = {
    connectorId: "73000000-0000-4000-8000-000000000001",
    orgId: "migration-custom-connector-skill-org",
    storageId: "73000000-0000-4000-8000-000000000002",
    userId: "migration-custom-connector-skill-user",
    versionId: "7".repeat(64),
  } as const;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    await client.query(
      `
        INSERT INTO "storages" (
          "id", "user_id", "name", "org_id", "s3_prefix"
        ) VALUES ($1, '__org__', '_migration_skill_storage', $2, $3)
      `,
      [
        fixture.storageId,
        fixture.orgId,
        `${fixture.orgId}/volume/_migration_skill_storage`,
      ],
    );
    await client.query(
      `
        INSERT INTO "storage_versions" (
          "id", "storage_id", "s3_key", "archive_size", "created_by"
        ) VALUES ($1, $2, $3, 1, $4)
      `,
      [
        fixture.versionId,
        fixture.storageId,
        `${fixture.orgId}/volume/_migration_skill_storage/${fixture.versionId}`,
        fixture.userId,
      ],
    );
    await client.query(
      `
        INSERT INTO "org_custom_connectors" (
          "id",
          "org_id",
          "slug",
          "display_name",
          "prefix_templates",
          "fields",
          "header_injections",
          "query_injections",
          "auth_mode",
          "created_by"
        ) VALUES (
          $1,
          $2,
          '_migration_skill_pair',
          'Migration Skill Pair',
          '["https://api.example.test/"]'::jsonb,
          '[{"key":"secret","label":"Secret","kind":"secret","required":true}]'::jsonb,
          '[{"name":"Authorization","valueTemplate":"Bearer {{secrets.secret}}"}]'::jsonb,
          '[]'::jsonb,
          'manual',
          $3
        )
      `,
      [fixture.connectorId, fixture.orgId, fixture.userId],
    );
    await client.query(
      `
        UPDATE "org_custom_connectors"
        SET
          "skill_markdown" = 'Use the migration skill.',
          "skill_storage_version_id" = $2
        WHERE "id" = $1
      `,
      [fixture.connectorId, fixture.versionId],
    );

    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_skill_version_pair",
      query: `
        UPDATE "org_custom_connectors"
        SET "skill_markdown" = NULL
        WHERE "id" = $1
      `,
      values: [fixture.connectorId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_org_custom_connectors_skill_version_pair",
      query: `
        UPDATE "org_custom_connectors"
        SET "skill_storage_version_id" = NULL
        WHERE "id" = $1
      `,
      values: [fixture.connectorId],
    });

    await client.query(
      `
        UPDATE "org_custom_connectors"
        SET "skill_markdown" = NULL, "skill_storage_version_id" = NULL
        WHERE "id" = $1
      `,
      [fixture.connectorId],
    );
    await client.query(`DELETE FROM "org_custom_connectors" WHERE "id" = $1`, [
      fixture.connectorId,
    ]);
    await client.query(`DELETE FROM "storages" WHERE "id" = $1`, [
      fixture.storageId,
    ]);
  } finally {
    await client.end();
  }

  console.log(
    "   ✅ Custom connector skill columns accept complete pairs and reject mixed state\n",
  );
}

interface ExtractedSchema {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
  indexes: Map<string, Set<string>>;
  constraints: Map<string, Set<string>>;
}

function groupSchemaObjects(
  rows: Array<{ object_name: string; table_name: string }>,
): Map<string, Set<string>> {
  const objects = new Map<string, Set<string>>();
  for (const row of rows) {
    const tableObjects = objects.get(row.table_name) ?? new Set<string>();
    tableObjects.add(row.object_name);
    objects.set(row.table_name, tableObjects);
  }
  return objects;
}

async function extractSchemaFromDb(dbUrl: string): Promise<ExtractedSchema> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  try {
    // Get all tables
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '__drizzle_migrations'
      ORDER BY table_name
    `);

    const tables = new Set<string>(
      tablesResult.rows.map((r) => {
        return r.table_name;
      }),
    );
    const columns = new Map<string, Set<string>>();

    for (const row of tablesResult.rows) {
      const tableName = row.table_name;

      // Get columns
      const columnsResult = await client.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY column_name
      `,
        [tableName],
      );

      columns.set(
        tableName,
        new Set(
          columnsResult.rows.map((c) => {
            return c.column_name;
          }),
        ),
      );
    }

    const indexesResult = await client.query<{
      object_name: string;
      table_name: string;
    }>(`
      SELECT
        "tablename" AS "table_name",
        "indexname" AS "object_name"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
      ORDER BY "tablename", "indexname"
    `);
    const constraintsResult = await client.query<{
      object_name: string;
      table_name: string;
    }>(`
      SELECT
        "relation"."relname" AS "table_name",
        "constraint"."conname" AS "object_name"
      FROM "pg_constraint" AS "constraint"
      JOIN "pg_class" AS "relation"
        ON "relation"."oid" = "constraint"."conrelid"
      JOIN "pg_namespace" AS "namespace"
        ON "namespace"."oid" = "relation"."relnamespace"
      WHERE "namespace"."nspname" = 'public'
        AND "constraint"."contype" = 'p'
      ORDER BY "relation"."relname", "constraint"."conname"
    `);

    return {
      tables,
      columns,
      indexes: groupSchemaObjects(indexesResult.rows),
      constraints: groupSchemaObjects(constraintsResult.rows),
    };
  } finally {
    await client.end();
  }
}

interface SnapshotTable {
  name?: string;
  columns?: Record<string, unknown>;
  indexes?: Record<string, unknown>;
  compositePrimaryKeys?: Record<string, unknown>;
}

function extractSchemaFromSnapshot(snapshotPath: string): ExtractedSchema {
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
    tables?: Record<string, SnapshotTable>;
  };
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const indexes = new Map<string, Set<string>>();
  const constraints = new Map<string, Set<string>>();

  for (const [tableKey, tableData] of Object.entries(snapshot.tables || {})) {
    // Normalize table name: extract actual table name from the key
    // Could be "users" or "public.users", we want just "users"
    const tableName = tableData.name || tableKey.replace(/^public\./, "");
    tables.add(tableName);

    const tableColumns = new Set<string>(Object.keys(tableData.columns || {}));
    columns.set(tableName, tableColumns);
    const primaryKeys = Object.keys(tableData.compositePrimaryKeys || {});
    indexes.set(
      tableName,
      new Set([...Object.keys(tableData.indexes || {}), ...primaryKeys]),
    );
    constraints.set(tableName, new Set(primaryKeys));
  }

  return { tables, columns, indexes, constraints };
}

function compareSchemas(
  dbSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  snapshotSchema: { tables: Set<string>; columns: Map<string, Set<string>> },
  migrationIdx: number,
): { matches: boolean; differences: string[] } {
  const differences: string[] = [];

  // Compare tables
  const dbTables = Array.from(dbSchema.tables).sort();
  const snapshotTables = Array.from(snapshotSchema.tables).sort();

  const missingInSnapshot = dbTables.filter((t) => {
    return !snapshotTables.includes(t);
  });
  const extraInSnapshot = snapshotTables.filter((t) => {
    return !dbTables.includes(t);
  });

  if (missingInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in DB but not in snapshot: ${missingInSnapshot.join(", ")}`,
    );
  }
  if (extraInSnapshot.length > 0) {
    differences.push(
      `Migration ${migrationIdx}: Tables in snapshot but not in DB: ${extraInSnapshot.join(", ")}`,
    );
  }

  // Compare columns for each table
  for (const tableName of dbTables) {
    if (!snapshotSchema.columns.has(tableName)) continue;

    const dbCols = Array.from(dbSchema.columns.get(tableName) || []).sort();
    const snapshotCols = Array.from(
      snapshotSchema.columns.get(tableName) || [],
    ).sort();

    const missingCols = dbCols.filter((column) => {
      return !snapshotCols.includes(column);
    });
    const extraCols = snapshotCols.filter((c) => {
      return !dbCols.includes(c);
    });

    if (missingCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in DB but not in snapshot: ${missingCols.join(", ")}`,
      );
    }
    if (extraCols.length > 0) {
      differences.push(
        `Migration ${migrationIdx}, table ${tableName}: Columns in snapshot but not in DB: ${extraCols.join(", ")}`,
      );
    }
  }

  return {
    matches: differences.length === 0,
    differences,
  };
}

async function validateTimestampOrdering(): Promise<void> {
  console.log("=== Phase 0.5: Validate Journal Timestamp Ordering ===\n");

  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{
    idx: number;
    tag: string;
    when: number;
  }>;

  if (entries.length < 2) {
    console.log("   Skipping (fewer than 2 migrations)\n");
    return;
  }

  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const curr = entries[i]!;
    if (curr.when <= prev.when) {
      const diffMs = prev.when - curr.when;
      const diffDays = (diffMs / (1000 * 60 * 60 * 24)).toFixed(1);
      violations.push(
        `   ${String(prev.idx).padStart(4, "0")} ${prev.tag} (when=${prev.when}) → ` +
          `${String(curr.idx).padStart(4, "0")} ${curr.tag} (when=${curr.when}) — ` +
          `timestamp goes BACKWARDS by ${diffDays} days`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `   ❌ Found ${violations.length} timestamp ordering violation(s):\n`,
    );
    for (const v of violations) {
      console.error(v);
    }
    console.error(
      `\n   Drizzle's migrator only applies migrations whose timestamp`,
    );
    console.error(`   is greater than the last applied migration's timestamp.`);
    console.error(
      `   Out-of-order timestamps cause migrations to be SKIPPED in production.`,
    );
    console.error(`\n   🔧 How to fix:`);
    console.error(
      `      Update the "when" values in meta/_journal.json so that`,
    );
    console.error(
      `      each entry's timestamp is strictly greater than the previous one.`,
    );
    console.error(
      `      For example, set the violating entry's "when" to prev.when + 1.\n`,
    );
    throw new Error("Journal timestamp ordering violation");
  }

  console.log(
    `   ✅ All ${entries.length} migrations have strictly increasing timestamps`,
  );
  console.log();
}

async function validateLatestSnapshotAccuracy(): Promise<void> {
  console.log("=== Phase 1.5: Validate Latest Snapshot Accuracy ===\n");

  const TEST_DB = "migration_snapshot_accuracy_test";

  // Get the latest migration index from journal
  const journalPath = path.join(MIGRATIONS_DIR, "meta/_journal.json");
  const journal = JSON.parse(await fs.readFile(journalPath, "utf-8"));
  const entries = journal.entries as Array<{ idx: number; tag: string }>;

  if (entries.length === 0) {
    throw new Error("No migrations found in journal");
  }

  const latestEntry = entries[entries.length - 1];
  if (!latestEntry) {
    throw new Error("Failed to get latest migration entry");
  }

  const latestIdx = latestEntry.idx;

  console.log(`   Validating latest snapshot (migration ${latestIdx})\n`);

  // Create clean test database
  await createDatabase(TEST_DB);
  const dbUrl = createTestDbUrl(TEST_DB);

  try {
    // Apply all migrations
    await runMigrations(dbUrl);

    // Extract schema from database
    const dbSchema = await extractSchemaFromDb(dbUrl);

    // Load latest snapshot
    const snapshotPath = path.join(
      MIGRATIONS_DIR,
      "meta",
      `${String(latestIdx).padStart(4, "0")}_snapshot.json`,
    );
    const snapshotSchema = extractSchemaFromSnapshot(snapshotPath);

    // Compare
    const { matches, differences } = compareSchemas(
      dbSchema,
      snapshotSchema,
      latestIdx,
    );

    if (matches) {
      console.log(
        `   ✅ Latest snapshot (${latestIdx}) accurately reflects final DB state`,
      );
    } else {
      console.error(
        `   ❌ Latest snapshot (${latestIdx}) does NOT match final DB state:`,
      );
      for (const diff of differences) {
        console.error(`      ${diff}`);
      }
      console.error(`\n   🔧 How to fix:`);
      console.error(`      1. Reset database: pnpm -F @okouai/db db:reset`);
      console.error(
        `      2. Delete the latest migration file (${String(latestIdx).padStart(4, "0")}_*.sql)`,
      );
      console.error(`      3. Remove migration entry from meta/_journal.json`);
      console.error(
        `      4. Delete the latest snapshot (${String(latestIdx).padStart(4, "0")}_snapshot.json)`,
      );
      console.error(
        `      5. Generate migration: pnpm -F @okouai/db db:generate`,
      );
      console.error(`      6. Apply migration: pnpm -F @okouai/db db:migrate`);
      console.error(
        `\n   ⚠️  IMPORTANT: Never manually write migration files!`,
      );
      console.error(
        `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
      );
      console.error(
        `      Manual migrations cause snapshot/database mismatches.\n`,
      );
      throw new Error(
        `Latest snapshot ${latestIdx} accuracy validation failed`,
      );
    }
  } finally {
    await dropDatabase(TEST_DB);
  }

  console.log();
}

async function validatePermanentUsagePackPendingSnapshotState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate permanent usage-pack pending snapshot state ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");

  const orgId = "permanent-usage-pack-pending-snapshot-org";
  try {
    await client.query(
      `INSERT INTO usage_pack_pending_snapshot_guards
      (org_id, pending_snapshot_count) VALUES ($1, 2)`,
      [orgId],
    );
    // Counts above one represent grandfathered purchases. Admission and release
    // are owned by the API service; the database retains uniqueness and range.
    await client.query("SAVEPOINT guard_constraint");
    await expectDatabaseError(client, {
      code: "23505",
      query: `INSERT INTO usage_pack_pending_snapshot_guards
        (org_id, pending_snapshot_count) VALUES ($1, 0)`,
      values: [orgId],
    });
    await client.query("ROLLBACK TO SAVEPOINT guard_constraint");
    await client.query("SAVEPOINT guard_constraint");
    await expectDatabaseError(client, {
      code: "23514",
      messageIncludes: "chk_usage_pack_pending_snapshot_guard_count",
      query: `UPDATE usage_pack_pending_snapshot_guards
        SET pending_snapshot_count = -1 WHERE org_id = $1`,
      values: [orgId],
    });
    await client.query("ROLLBACK TO SAVEPOINT guard_constraint");
    await client.query("SAVEPOINT guard_constraint");
    await expectDatabaseError(client, {
      code: "23502",
      query: `UPDATE usage_pack_pending_snapshot_guards
        SET pending_snapshot_count = NULL WHERE org_id = $1`,
      values: [orgId],
    });
    await client.query("ROLLBACK TO SAVEPOINT guard_constraint");
    console.log(
      "   ✅ pending guards retain unique organization and nonnegative count constraints\n",
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

async function main(): Promise<void> {
  console.log("🧪 Testing Migration Consistency (Schema Comparison)\n");

  const TEST_DB_1 = "migration_test_existing";
  const TEST_DB_2 = "migration_test_generated";
  let migrationsBackedUp = false;

  try {
    // Step 0: Validate snapshot files
    await validateSnapshotFiles();

    // Step 0.5: Validate timestamp ordering
    await validateTimestampOrdering();

    // Step 1.5: Validate latest snapshot accuracy (NEW)
    await validateLatestSnapshotAccuracy();

    // Step 1: Test with existing migrations
    console.log("=== Phase 2: Test existing migrations ===\n");
    await createDatabase(TEST_DB_1);
    const dbUrl1 = createTestDbUrl(TEST_DB_1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Migrations applied successfully\n");

    console.log("=== Phase 2.1: Validate database reset ===\n");
    await resetDatabase(dbUrl1);
    await resetDatabase(dbUrl1);
    await runMigrations(dbUrl1);
    console.log("   ✅ Consecutive database resets completed successfully\n");

    await validateCanonicalIntegrationIdentitySchema(dbUrl1);
    await validatePermanentTriggerAndFunctionInventory(dbUrl1);
    await validatePermanentMarketingPrivacyState(dbUrl1);
    await validatePermanentUsagePackPendingSnapshotState(dbUrl1);
    await validatePermanentArtifactTriggerBehavior(dbUrl1);
    await validatePermanentAgentRunMetadataState(dbUrl1);
    await validatePermanentBuiltInModelCooldownState(dbUrl1);
    await validatePermanentBuiltInModelKeyState(dbUrl1);
    await validatePermanentSlackPublicBrandState(dbUrl1);
    await validatePermanentOrgPlanEntitlementState(dbUrl1);
    await validateAgentRunLaunchSnapshotSchema(dbUrl1);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl1);
    await validateOfficialAutomationResultEmailSchema(dbUrl1);
    await validateExpandedBrowserSchema(dbUrl1);
    await validateChatEventSourcesAreAppendOnly(dbUrl1);
    await validateChatEventContextPointerConstraints(dbUrl1);
    await validateConnectorCatalogFinalConstraints(dbUrl1);
    await validateCustomConnectorOauthModeConstraints(dbUrl1);
    await validateCustomConnectorSkillVersionPair(dbUrl1);

    // Step 2: Backup and regenerate migrations
    console.log("=== Phase 3: Test regenerated migrations ===\n");
    await backupMigrations();
    migrationsBackedUp = true;
    await generateFreshMigrations();

    // Step 3: Test with regenerated migrations
    await createDatabase(TEST_DB_2);
    const dbUrl2 = createTestDbUrl(TEST_DB_2);
    await runMigrations(dbUrl2);
    console.log("   ✅ Fresh migrations applied successfully\n");
    await validatePermanentBuiltInModelCooldownState(dbUrl2);
    await validatePermanentBuiltInModelKeyState(dbUrl2);
    await validatePermanentSlackPublicBrandState(dbUrl2);
    await validatePermanentOrgPlanEntitlementState(dbUrl2);
    await validateAgentRunLaunchSnapshotSchema(dbUrl2);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl2);
    await validateOfficialAutomationResultEmailSchema(dbUrl2);

    // Step 4: Restore original migrations
    await restoreMigrations();
    migrationsBackedUp = false;

    // Step 5: Run normalized comparison (using pg library)
    console.log("=== Phase 4: Normalized schema comparison ===\n");
    const comparisonPassed = await runNormalizedComparison(dbUrl1, dbUrl2);

    if (comparisonPassed) {
      console.log("\n✅ SUCCESS: All validations passed!");
      console.log("   ✅ Snapshot count matches migration count");
      console.log("   ✅ Snapshot chain is intact (id/prevId references)");
      console.log("   ✅ Journal timestamps are strictly increasing");
      console.log("   ✅ Latest snapshot accurately reflects final DB state");
      console.log(
        "   ✅ Browser state uses canonical thread identity and lifecycle events",
      );
      console.log("   ✅ Chat event source tables reject UPDATE");
      console.log(
        "   ✅ Final connector catalog constraints reject invalid state",
      );
      console.log(
        "   ✅ Custom connector ordinary mode checks, bindings and cascades remain enforced",
      );
      console.log(
        "   ✅ Custom connector skill columns reject mixed version state",
      );
      console.log("   ✅ Agent-run model-key canonical schemas match");
      console.log(
        "   ✅ Org plan restriction and acquisition invariants match",
      );
      console.log("   ✅ Permanent trigger and function inventories match");
      console.log(
        "   ✅ Usage-pack pending guards retain uniqueness and count constraints",
      );
      console.log(
        "   ✅ Permanent artifact triggers preserve cascade and queue behavior",
      );
      console.log(
        "   ✅ Permanent inventory matches API-owned Pi candidate accounting",
      );
      console.log("   ✅ Draining API avatar writes receive preset defaults");
      console.log("   ✅ Consecutive database resets replay all migrations");
      console.log("   ✅ Schemas are functionally equivalent");
      console.log("   ✅ All migrations match the schema definitions");

      // Cleanup
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);

      process.exit(0);
    } else {
      console.log("\n❌ FAILURE: Schemas have functional differences!");
      console.log(
        `\n   This means the migration files don't match the schema definitions.`,
      );
      console.log(`\n   💡 Databases preserved for analysis:`);
      console.log(`      ${TEST_DB_1}`);
      console.log(`      ${TEST_DB_2}`);
      console.log(`\n   For detailed analysis, run:`);
      console.log(
        `     pnpm -F @okouai/db exec tsx scripts/compare-schemas-normalized.ts "<${TEST_DB_1}-url>" "<${TEST_DB_2}-url>"`,
      );
      console.log(`\n   🔧 How to fix:`);
      console.log(`      1. Check if you manually edited any migration files`);
      console.log(`      2. Reset database: pnpm -F @okouai/db db:reset`);
      console.log(`      3. Delete the problematic migration files`);
      console.log(
        `      4. Remove corresponding entries from meta/_journal.json`,
      );
      console.log(`      5. Delete corresponding snapshots`);
      console.log(`      6. Regenerate: pnpm -F @okouai/db db:generate`);
      console.log(`      7. Apply: pnpm -F @okouai/db db:migrate`);
      console.log(
        `\n   ⚠️  IMPORTANT: Never manually write or edit migration files!`,
      );
      console.log(
        `      Always use 'pnpm -F @okouai/db db:generate' to auto-generate migrations.`,
      );
      console.log(
        `      Manual edits break the snapshot system and cause schema mismatches.\n`,
      );

      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ Error during test:", error);

    // Try to cleanup
    try {
      if (migrationsBackedUp) {
        await restoreMigrations();
      }
      await dropDatabase(TEST_DB_1);
      await dropDatabase(TEST_DB_2);
    } catch (cleanupError) {
      console.error("⚠️  Failed to cleanup:", cleanupError);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
