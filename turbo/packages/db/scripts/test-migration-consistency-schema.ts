#!/usr/bin/env tsx
import { validatePiMemoryStage1Cost } from "./test-pi-memory-stage1-cost";
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
import { validatePermanentDiscordFoundation } from "./test-discord-foundation-permanent";
import { validatePermanentDiscordChat } from "./test-discord-chat-permanent";
import { validatePermanentOrgPlanEntitlementState } from "./test-org-plan-entitlement-permanent";
import { validateGpt55Retirement } from "./test-gpt-55-retirement";
import { validateSonnet46Opus48DeepSeekV4ProRetirement } from "./test-sonnet-46-opus-48-deepseek-v4-pro-retirement";
import { validateXResourceUsageSchema } from "./test-x-resource-usage";

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
      "   ✅ Canonical integration identity columns and indexes match\n",
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
      "CREATE TRIGGER ssh_cloudflare_access_binding_guard BEFORE INSERT OR UPDATE OF cloudflare_access_id, org_id, user_id ON public.ssh_connections FOR EACH ROW EXECUTE FUNCTION validate_ssh_cloudflare_access_binding()",
    schemaName: "public",
    tableName: "ssh_connections",
    triggerName: "ssh_cloudflare_access_binding_guard",
  },
  {
    definition:
      "CREATE TRIGGER cloudflare_access_scope_change_guard BEFORE UPDATE OF scope, user_id, org_id ON public.cloudflare_access_configs FOR EACH ROW EXECUTE FUNCTION reject_cloudflare_access_scope_change()",
    schemaName: "public",
    tableName: "cloudflare_access_configs",
    triggerName: "cloudflare_access_scope_change_guard",
  },
] as const satisfies readonly PermanentTrigger[];

const EXPECTED_PERMANENT_FUNCTIONS = [
  {
    bodyHash: "31c9604bf9c9306578d884bc8aa9e5ce",
    functionName: "billing_usage_source",
    identityArguments: "trigger_source text",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "56fbba07cf9d2a5877b03524c215c28b",
    functionName: "ensure_billing_run_attribution",
    identityArguments:
      "billing_id uuid, billed_org text, billed_user text, original_start timestamp without time zone, billing_source text",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "58e58b34a3eb3679ad3ba9d984bf2b8b",
    functionName: "capture_billing_run_attribution",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "8699ee12596b337ac2df0a58e1ec6d59",
    functionName: "ensure_billing_run_thread",
    identityArguments: "billing_id uuid, original_thread uuid",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "a1cded319d3a0e285807a877e8d85b74",
    functionName: "reject_billing_attribution_update",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "b002912b7bba9df6783801b84490bada",
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
    bodyHash: "78a8128b76b3379792960174c17b9bf1",
    functionName: "validate_ssh_cloudflare_access_binding",
    identityArguments: "",
    kind: "f",
    schemaName: "public",
  },
  {
    bodyHash: "9a32858723d6facc53fb33925484a8f3",
    functionName: "reject_cloudflare_access_scope_change",
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

async function validateConnectorAutomaticOAuthConstraints(
  dbUrl: string,
): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const accountId = "73000000-0000-4000-8000-000000000001";
  const registrationId = "73000000-0000-4000-8000-000000000002";
  const contractHash = "a".repeat(64);
  try {
    await client.query(
      `INSERT INTO connectors (id, connector_slug, auth_method, automatic_auth_type, storage_version, org_id, user_id) VALUES ($1, 'migration-mcp', 'smart-connect', 'none', 1, 'migration-builtin-org', 'migration-builtin-user')`,
      [accountId],
    );
    await expectDatabaseError(client, {
      code: "23514",
      query: `UPDATE connectors SET token_expires_at = now() WHERE id = $1`,
      values: [accountId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      query: `UPDATE connectors SET automatic_auth_type = 'manual' WHERE id = $1`,
      values: [accountId],
    });
    await client.query(
      `UPDATE connectors SET automatic_auth_type = 'oauth' WHERE id = $1`,
      [accountId],
    );
    await client.query(
      `INSERT INTO connector_dcr_registrations (id, org_id, connector_slug, auth_method, contract_hash, issuer, client_id, token_endpoint_auth_method, redirect_uri, issued_at) VALUES ($1, 'migration-builtin-org', 'migration-mcp', 'smart-connect', $2, 'https://issuer.example.test', 'builtin-client', 'none', 'https://api.example.test/callback', now())`,
      [registrationId, contractHash],
    );
    const insertBinding = `INSERT INTO connector_account_oauth_bindings (connector_account_id, org_id, user_id, connector_slug, auth_method, storage_version, contract_hash, endpoint, issuer, resource, token_endpoint, client_id, token_endpoint_auth_method, registration_method, dcr_registration_id) VALUES ($1, $2, 'migration-builtin-user', 'migration-mcp', 'smart-connect', 1, $3, 'https://mcp.example.test', 'https://issuer.example.test', 'https://mcp.example.test', 'https://issuer.example.test/token', 'builtin-client', 'none', 'dcr', $4)`;
    await expectDatabaseError(client, {
      code: "23503",
      query: insertBinding,
      values: [accountId, "foreign-org", contractHash, registrationId],
    });
    await expectDatabaseError(client, {
      code: "23503",
      query: insertBinding,
      values: [
        accountId,
        "migration-builtin-org",
        "b".repeat(64),
        registrationId,
      ],
    });
    await client.query(insertBinding, [
      accountId,
      "migration-builtin-org",
      contractHash,
      registrationId,
    ]);
    await expectDatabaseError(client, {
      code: "23514",
      query: `UPDATE connector_account_oauth_bindings SET registration_method = 'cimd' WHERE connector_account_id = $1`,
      values: [accountId],
    });
    await expectDatabaseError(client, {
      code: "23514",
      query: `UPDATE connector_dcr_registrations SET token_endpoint_auth_method = 'client_secret_basic' WHERE id = $1`,
      values: [registrationId],
    });
    await client.query(`DELETE FROM connectors WHERE id = $1`, [accountId]);
    const bindings = await client.query(
      `SELECT 1 FROM connector_account_oauth_bindings WHERE connector_account_id = $1`,
      [accountId],
    );
    assert.equal(bindings.rowCount, 0);
    await client.query(
      `DELETE FROM connector_dcr_registrations WHERE id = $1`,
      [registrationId],
    );
  } finally {
    await client.end();
  }
  console.log(
    "   ✅ Builtin Automatic OAuth retains method identity and rejects cross-owner or cross-contract bindings\n",
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
    await validateCanonicalBillingSources(dbUrl1);
    await validatePiMemoryStage1Cost(dbUrl1);
    await validatePermanentUsagePackPendingSnapshotState(dbUrl1);
    await validatePermanentAgentRunMetadataState(dbUrl1);
    await validatePermanentBuiltInModelCooldownState(dbUrl1);
    await validatePermanentBuiltInModelKeyState(dbUrl1);
    await validatePermanentDiscordFoundation(dbUrl1);
    await validatePermanentDiscordChat(dbUrl1);
    await validatePermanentOrgPlanEntitlementState(dbUrl1);
    await validateGpt55Retirement(dbUrl1);
    await validateSonnet46Opus48DeepSeekV4ProRetirement(dbUrl1);
    await validateXResourceUsageSchema(dbUrl1);
    await validateAgentRunLaunchSnapshotSchema(dbUrl1);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl1);
    await validateOfficialAutomationResultEmailSchema(dbUrl1);
    await validateExpandedBrowserSchema(dbUrl1);
    await validateCanonicalChatEventStorage(dbUrl1);
    await validateChatEventContextPointerConstraints(dbUrl1);
    await validateConnectorCatalogFinalConstraints(dbUrl1);
    await validateCustomConnectorOauthModeConstraints(dbUrl1);
    await validateConnectorAutomaticOAuthConstraints(dbUrl1);
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
    await validatePermanentDiscordFoundation(dbUrl2);
    await validatePermanentDiscordChat(dbUrl2);
    await validatePermanentOrgPlanEntitlementState(dbUrl2);
    await validateXResourceUsageSchema(dbUrl2);
    await validateAgentRunLaunchSnapshotSchema(dbUrl2);
    await validateAgentRunOfficialWorkflowProvenanceSchema(dbUrl2);
    await validateOfficialAutomationResultEmailSchema(dbUrl2);
    await validateConnectorAutomaticOAuthConstraints(dbUrl2);

    // Step 4: Restore original migrations
    await restoreMigrations();
    migrationsBackedUp = false;

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
      console.log(
        "   ✅ Chat event storage accepts explicit sequences and cursors",
      );
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
