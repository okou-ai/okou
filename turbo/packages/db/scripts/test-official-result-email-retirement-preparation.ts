import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";
import { schema } from "../src/index";
import { emailOutbox } from "../src/runtime/email-outbox";
import { workflowAutomations } from "../src/runtime/workflow-automation";
import {
  outgoingEmailOutbox,
  outgoingOfficialAutomationResultEmailClaims,
  outgoingWorkflowAutomations,
} from "./fixtures/official-result-email-outgoing";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";
import { validateOfficialAutomationBindingSchema } from "./test-official-automation-binding-schema";

// Keep through release 3 of #39378's physical contraction and its
// drain/rollback acceptance.
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const retirement = journal.entries.find((entry) => {
  return entry.tag.endsWith("_retire_official_result_email_runtime");
});
assert.ok(retirement);
const contraction = journal.entries.find((entry) => {
  return entry.tag.endsWith("_drop_official_result_email_storage");
});
assert.ok(contraction && contraction.when > retirement.when);

const RETIRED_IDENTIFIERS = [
  "official_result_email_enabled",
  "source_run_id",
  "source_workflow_automation_id",
  "official_automation_result_email_claims",
];
const BINDING_CHECK = "workflow_automations_official_binding_check";

function sqlState(error: unknown) {
  const source =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  if (typeof source !== "object" || source === null) {
    return {};
  }
  return {
    code:
      "code" in source && typeof source.code === "string"
        ? source.code
        : undefined,
    constraint:
      "constraint" in source && typeof source.constraint === "string"
        ? source.constraint
        : undefined,
  };
}

function violates(code: string, constraint: string) {
  return (error: unknown) => {
    const state = sqlState(error);
    return state.code === code && state.constraint === constraint;
  };
}

function withoutRetiredProperty(row: object) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => {
      return key !== "officialResultEmailEnabled";
    }),
  );
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const name = `result_email_preparation_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${name}`;
const admin = new Client({ connectionString: adminUrl.toString() });
let created = false;
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const client = new Client({ connectionString: ownedUrl.toString() });
const outgoingStatements: string[] = [];
const runtimeStatements: string[] = [];
const outgoingDb = drizzle(client, {
  logger: {
    logQuery: (query) => {
      outgoingStatements.push(query);
    },
  },
});
const db = drizzle(client, {
  schema,
  logger: {
    logQuery: (query) => {
      runtimeStatements.push(query);
    },
  },
});

try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  await client.connect();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: retirement.when,
  });

  const orgId = "result-email-preparation-org";
  const ownerUserId = "result-email-owner";
  const agentId = randomUUID();
  const workflowId = randomUUID();
  await client.query(
    'INSERT INTO "agents" ("id", "org_id", "owner", "name") VALUES ($1, $2, $3, $4)',
    [agentId, orgId, ownerUserId, "result-email-agent"],
  );
  await client.query(
    `INSERT INTO "workflows" (
      "id", "org_id", "name", "created_by", "owner_user_id", "agent_id",
      "updated_by", "official_definition_name", "official_installation_state"
    ) VALUES ($1, $2, $3, $4, $4, $5, $4, $3, 'installed')`,
    [workflowId, orgId, "pulse", ownerUserId, agentId],
  );
  const owner = { orgId, workflowId, ownerUserId };
  const schedule = {
    kind: "schedule",
    scheduleType: "loop",
    intervalSeconds: 3600,
  } as const;
  const official = (blueprintKey: string) => {
    return {
      officialBlueprintKey: blueprintKey,
      officialAppliedFingerprint: "a".repeat(64),
      officialReconciliationStatus: "current" as const,
      officialParameterBindings: [],
      officialIntendedEnabled: true,
    };
  };
  const readResultEmail = async (id: string) => {
    const result = await client.query<{ value: boolean | null }>(
      'SELECT "official_result_email_enabled" AS "value" FROM "workflow_automations" WHERE "id" = $1',
      [id],
    );
    return result.rows;
  };

  // Release 2 cannot promote before 1382: its Official rows store NULL mail.
  await assert.rejects(
    db
      .insert(workflowAutomations)
      .values({ ...owner, ...schedule, ...official("premature") }),
    violates("23514", BINDING_CHECK),
  );

  // Outgoing release 1 rows: Official false/true, ordinary NULL, and an
  // Official projection written onto a plain row.
  const historical = await outgoingDb
    .insert(outgoingWorkflowAutomations)
    .values([
      {
        ...owner,
        ...schedule,
        ...official("legacy-disabled"),
        officialResultEmailEnabled: false,
      },
      {
        ...owner,
        ...schedule,
        ...official("legacy-enabled"),
        enabled: false,
        officialIntendedEnabled: false,
        officialResultEmailEnabled: true,
      },
      { ...owner, ...schedule },
    ])
    .returning();
  const [plainHistorical] = await outgoingDb
    .insert(outgoingWorkflowAutomations)
    .values({ ...owner, ...schedule })
    .returning();
  assert.ok(plainHistorical);
  const [markedHistorical] = await outgoingDb
    .update(outgoingWorkflowAutomations)
    .set({ ...official("legacy-marked"), officialResultEmailEnabled: false })
    .where(
      and(
        eq(outgoingWorkflowAutomations.id, plainHistorical.id),
        isNull(outgoingWorkflowAutomations.officialBlueprintKey),
        isNull(outgoingWorkflowAutomations.officialResultEmailEnabled),
      ),
    )
    .returning();
  assert.ok(markedHistorical);
  const [, legacyEnabled, ordinaryHistorical] = historical;
  assert.ok(legacyEnabled && ordinaryHistorical);
  const [historicalClaim] = await outgoingDb
    .insert(outgoingOfficialAutomationResultEmailClaims)
    .values({ runId: randomUUID(), workflowAutomationId: legacyEnabled.id })
    .returning();
  assert.ok(historicalClaim);
  const [historicalEmail] = await outgoingDb
    .insert(outgoingEmailOutbox)
    .values({
      id: historicalClaim.emailOutboxId,
      fromAddress: "Okou <noreply@example.com>",
      toAddresses: "owner@example.com",
      subject: "Pulse finished",
      template: { template: "official-automation-result", props: {} },
      sourceRunId: historicalClaim.runId,
      sourceWorkflowAutomationId: legacyEnabled.id,
    })
    .returning();
  assert.ok(historicalEmail);

  const storedRows = async () => {
    const tables = [
      "workflow_automations",
      "email_outbox",
      "official_automation_result_email_claims",
    ];
    const rows: string[][] = [];
    for (const table of tables) {
      const result = await client.query<{ row: string }>(
        `SELECT t::text AS "row" FROM "${table}" t ORDER BY t::text`,
      );
      rows.push(
        result.rows.map(({ row }) => {
          return row;
        }),
      );
    }
    return rows;
  };
  const beforeRetirement = await storedRows();

  await applyFixtureMigrations(migrationSql, {
    beforeMillis: retirement.when + 1,
  });
  assert.deepEqual(
    (
      await client.query<{ when: string }>(
        'SELECT max("created_at")::text AS "when" FROM "drizzle"."__drizzle_migrations"',
      )
    ).rows,
    [{ when: String(retirement.when) }],
  );

  // (a) Pre-existing rows are byte-identical and outgoing reads still decode.
  assert.deepEqual(await storedRows(), beforeRetirement);
  assert.deepEqual(
    await outgoingDb
      .select()
      .from(outgoingWorkflowAutomations)
      .orderBy(outgoingWorkflowAutomations.id),
    [...historical, markedHistorical].sort((a, b) => {
      return a.id.localeCompare(b.id);
    }),
  );

  // (a) Every outgoing statement shape remains legal after 1382.
  outgoingStatements.length = 0;
  const outgoingInserted = await outgoingDb
    .insert(outgoingWorkflowAutomations)
    .values([
      {
        ...owner,
        ...schedule,
        ...official("outgoing-disabled"),
        officialResultEmailEnabled: false,
      },
      {
        ...owner,
        ...schedule,
        ...official("outgoing-enabled"),
        officialResultEmailEnabled: true,
      },
    ])
    .returning();
  const [, outgoingEnabled] = outgoingInserted;
  assert.equal(outgoingEnabled?.officialResultEmailEnabled, true);
  const [outgoingPlain] = await outgoingDb
    .insert(outgoingWorkflowAutomations)
    .values({ ...owner, ...schedule })
    .returning();
  assert.ok(outgoingPlain);
  assert.equal(outgoingPlain.officialResultEmailEnabled, null);
  const plainWhere = and(
    eq(outgoingWorkflowAutomations.id, outgoingPlain.id),
    isNull(outgoingWorkflowAutomations.officialBlueprintKey),
    isNull(outgoingWorkflowAutomations.officialAppliedFingerprint),
    isNull(outgoingWorkflowAutomations.officialReconciliationStatus),
    isNull(outgoingWorkflowAutomations.officialParameterBindings),
    isNull(outgoingWorkflowAutomations.officialIntendedEnabled),
    isNull(outgoingWorkflowAutomations.officialResultEmailEnabled),
  );
  assert.deepEqual(
    await outgoingDb
      .select()
      .from(outgoingWorkflowAutomations)
      .where(plainWhere)
      .for("update")
      .limit(1),
    [outgoingPlain],
  );
  const [outgoingMarked] = await outgoingDb
    .update(outgoingWorkflowAutomations)
    .set({ ...official("outgoing-marked"), officialResultEmailEnabled: false })
    .where(plainWhere)
    .returning();
  assert.equal(outgoingMarked?.officialResultEmailEnabled, false);
  const [outgoingPatched] = await outgoingDb
    .update(outgoingWorkflowAutomations)
    .set({
      officialAppliedFingerprint: "b".repeat(64),
      officialReconciliationStatus: "reconciling",
      officialResultEmailEnabled: false,
      updatedAt: new Date("2026-10-13T00:00:00Z"),
    })
    .where(eq(outgoingWorkflowAutomations.id, legacyEnabled.id))
    .returning();
  assert.equal(outgoingPatched?.officialResultEmailEnabled, false);
  const [outgoingClaim] = await outgoingDb
    .insert(outgoingOfficialAutomationResultEmailClaims)
    .values({ runId: randomUUID(), workflowAutomationId: legacyEnabled.id })
    .onConflictDoNothing({
      target: [
        outgoingOfficialAutomationResultEmailClaims.runId,
        outgoingOfficialAutomationResultEmailClaims.workflowAutomationId,
      ],
    })
    .returning({
      emailOutboxId: outgoingOfficialAutomationResultEmailClaims.emailOutboxId,
      runId: outgoingOfficialAutomationResultEmailClaims.runId,
    });
  assert.ok(outgoingClaim);
  assert.deepEqual(
    await outgoingDb
      .insert(outgoingOfficialAutomationResultEmailClaims)
      .values({
        runId: outgoingClaim.runId,
        workflowAutomationId: legacyEnabled.id,
      })
      .onConflictDoNothing({
        target: [
          outgoingOfficialAutomationResultEmailClaims.runId,
          outgoingOfficialAutomationResultEmailClaims.workflowAutomationId,
        ],
      })
      .returning({
        emailOutboxId:
          outgoingOfficialAutomationResultEmailClaims.emailOutboxId,
      }),
    [],
  );
  const outgoingEmail = {
    fromAddress: "Okou <noreply@example.com>",
    toAddresses: "owner@example.com",
    subject: "Pulse finished",
    template: { template: "official-automation-result", props: {} },
    status: "pending",
    attempts: 0,
  };
  const [outgoingQueued] = await outgoingDb
    .insert(outgoingEmailOutbox)
    .values({
      ...outgoingEmail,
      id: outgoingClaim.emailOutboxId,
      sourceRunId: outgoingClaim.runId,
      sourceWorkflowAutomationId: legacyEnabled.id,
    })
    .returning();
  assert.equal(outgoingQueued?.sourceRunId, outgoingClaim.runId);
  assert.ok(
    outgoingStatements.length > 0 &&
      outgoingStatements.every((statement) => {
        return RETIRED_IDENTIFIERS.some((identifier) => {
          return statement.includes(`"${identifier}"`);
        });
      }),
    "Every outgoing statement names a retired identifier",
  );
  await assert.rejects(
    outgoingDb.insert(outgoingEmailOutbox).values({
      ...outgoingEmail,
      sourceRunId: outgoingClaim.runId,
      sourceWorkflowAutomationId: legacyEnabled.id,
    }),
    violates("23505", "email_outbox_source_run_automation_unique"),
  );
  await assert.rejects(
    outgoingDb
      .insert(outgoingEmailOutbox)
      .values({ ...outgoingEmail, sourceRunId: randomUUID() }),
    violates("23514", "email_outbox_source_identity_check"),
  );

  // (c) Ordinary rows still require NULL mail.
  await assert.rejects(
    outgoingDb
      .insert(outgoingWorkflowAutomations)
      .values({ ...owner, ...schedule, officialResultEmailEnabled: false }),
    violates("23514", BINDING_CHECK),
  );
  await assert.rejects(
    outgoingDb
      .update(outgoingWorkflowAutomations)
      .set({ officialResultEmailEnabled: true })
      .where(eq(outgoingWorkflowAutomations.id, ordinaryHistorical.id)),
    violates("23514", BINDING_CHECK),
  );

  // (b) The runtime mapping never names the retired storage.
  runtimeStatements.length = 0;
  const [runtimeOfficial] = await db
    .insert(workflowAutomations)
    .values({ ...owner, ...schedule, ...official("runtime-official") })
    .returning();
  assert.ok(runtimeOfficial);
  assert.deepEqual(await readResultEmail(runtimeOfficial.id), [
    { value: null },
  ]);
  const [runtimeOrdinary] = await db
    .insert(workflowAutomations)
    .values({ ...owner, ...schedule })
    .returning();
  assert.ok(runtimeOrdinary);
  assert.deepEqual(await readResultEmail(runtimeOrdinary.id), [
    { value: null },
  ]);
  const [runtimePlain] = await db
    .insert(workflowAutomations)
    .values({ ...owner, ...schedule })
    .returning();
  assert.ok(runtimePlain);
  const [runtimeMarked] = await db
    .update(workflowAutomations)
    .set(official("runtime-marked"))
    .where(
      and(
        eq(workflowAutomations.id, runtimePlain.id),
        isNull(workflowAutomations.officialBlueprintKey),
        isNull(workflowAutomations.officialAppliedFingerprint),
        isNull(workflowAutomations.officialReconciliationStatus),
        isNull(workflowAutomations.officialParameterBindings),
        isNull(workflowAutomations.officialIntendedEnabled),
      ),
    )
    .returning();
  assert.ok(runtimeMarked);
  assert.equal(runtimeMarked.officialBlueprintKey, "runtime-marked");
  assert.deepEqual(await readResultEmail(runtimePlain.id), [{ value: null }]);
  // A runtime update of a retained Official row leaves its legacy value alone.
  const [runtimeReconciled] = await db
    .update(workflowAutomations)
    .set({ officialReconciliationStatus: "reconciling" })
    .where(eq(workflowAutomations.id, outgoingEnabled.id))
    .returning();
  assert.equal(runtimeReconciled?.officialReconciliationStatus, "reconciling");
  assert.deepEqual(await readResultEmail(outgoingEnabled.id), [
    { value: true },
  ]);
  const runtimeHistorical = await db
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, markedHistorical.id));
  assert.deepEqual(runtimeHistorical, [
    withoutRetiredProperty(markedHistorical),
  ]);
  const runtimeRows = await db.query.workflowAutomations.findMany({
    orderBy: workflowAutomations.id,
  });
  assert.deepEqual(
    runtimeRows,
    await db.select().from(workflowAutomations).orderBy(workflowAutomations.id),
  );
  // Four release 1 rows before 1382, three outgoing and three runtime after.
  assert.equal(runtimeRows.length, 10);

  const [runtimeEmail] = await db
    .insert(emailOutbox)
    .values({
      fromAddress: "Okou <noreply@example.com>",
      toAddresses: "owner@example.com",
      subject: "Credit balance is low",
      template: { template: "credit-low-balance", props: {} },
    })
    .returning();
  assert.ok(runtimeEmail);
  assert.deepEqual(
    (
      await client.query(
        'SELECT "source_run_id", "source_workflow_automation_id" FROM "email_outbox" WHERE "id" = $1',
        [runtimeEmail.id],
      )
    ).rows,
    [{ source_run_id: null, source_workflow_automation_id: null }],
  );
  const [runtimeLegacyEmail] = await db
    .update(emailOutbox)
    .set({ status: "sent", resendId: "resend-legacy" })
    .where(eq(emailOutbox.id, historicalEmail.id))
    .returning();
  assert.deepEqual(runtimeLegacyEmail, {
    ...Object.fromEntries(
      Object.entries(historicalEmail).filter(([key]) => {
        return key !== "sourceRunId" && key !== "sourceWorkflowAutomationId";
      }),
    ),
    status: "sent",
    resendId: "resend-legacy",
  });
  assert.equal(
    (
      await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.status, "pending"))
    ).length,
    2,
  );
  const [runtimeDeleted] = await db
    .delete(workflowAutomations)
    .where(eq(workflowAutomations.id, runtimeOrdinary.id))
    .returning();
  assert.deepEqual(runtimeDeleted, runtimeOrdinary);
  assert.ok(runtimeStatements.length > 0);
  for (const statement of runtimeStatements) {
    for (const identifier of RETIRED_IDENTIFIERS) {
      assert.ok(!statement.includes(identifier), statement);
    }
  }

  // Outgoing readers see NULL on release 2 Official rows, which they treat as
  // incomplete materialization; the rollback floor excludes them.
  const [outgoingView] = await outgoingDb
    .select()
    .from(outgoingWorkflowAutomations)
    .where(eq(outgoingWorkflowAutomations.id, runtimeOfficial.id));
  assert.ok(outgoingView);
  assert.equal(outgoingView.officialBlueprintKey, "runtime-official");
  assert.equal(outgoingView.officialResultEmailEnabled, null);
  // Outgoing writers may still set a boolean on release 2 Official rows.
  const [outgoingOnRuntime] = await outgoingDb
    .update(outgoingWorkflowAutomations)
    .set({ officialResultEmailEnabled: false })
    .where(eq(outgoingWorkflowAutomations.id, runtimeOfficial.id))
    .returning();
  assert.equal(outgoingOnRuntime?.officialResultEmailEnabled, false);

  // (c) Every other Official binding invariant holds on NULL-mail rows.
  await assert.rejects(
    db.insert(workflowAutomations).values({
      ...owner,
      ...schedule,
      ...official("runtime-missing-intent"),
      officialIntendedEnabled: null,
    }),
    violates("23514", BINDING_CHECK),
  );
  await assert.rejects(
    db.insert(workflowAutomations).values({
      ...owner,
      ...schedule,
      ...official("runtime-bad-fingerprint"),
      officialAppliedFingerprint: "not-a-fingerprint",
    }),
    violates("23514", BINDING_CHECK),
  );
  for (const assignment of [
    `"official_applied_fingerprint" = 'not-a-fingerprint'`,
    `"official_reconciliation_status" = 'unknown'`,
    `"official_parameter_bindings" = '{}'::jsonb`,
    `"official_intended_enabled" = NULL`,
    `"official_blueprint_key" = NULL`,
  ]) {
    await assert.rejects(
      client.query(
        `UPDATE "workflow_automations" SET ${assignment} WHERE "id" = $1`,
        [runtimeMarked.id],
      ),
      violates("23514", BINDING_CHECK),
      assignment,
    );
  }

  // (d) Retired storage stays physically present for outgoing APIs.
  assert.deepEqual(
    (
      await client.query(
        `SELECT "table_name", "column_name", "data_type", "is_nullable"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND ("table_name", "column_name") IN (
            ('workflow_automations', 'official_result_email_enabled'),
            ('email_outbox', 'source_run_id'),
            ('email_outbox', 'source_workflow_automation_id')
          )
        ORDER BY "table_name", "column_name"`,
      )
    ).rows,
    [
      {
        table_name: "email_outbox",
        column_name: "source_run_id",
        data_type: "uuid",
        is_nullable: "YES",
      },
      {
        table_name: "email_outbox",
        column_name: "source_workflow_automation_id",
        data_type: "uuid",
        is_nullable: "YES",
      },
      {
        table_name: "workflow_automations",
        column_name: "official_result_email_enabled",
        data_type: "boolean",
        is_nullable: "YES",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        `SELECT
          to_regclass('public.official_automation_result_email_claims')::text AS "claims",
          (
            SELECT pg_get_indexdef(to_regclass('public.email_outbox_source_run_automation_unique'))
          ) AS "sourceIndex",
          (
            SELECT "contype"::text FROM "pg_constraint"
            WHERE "conrelid" = 'public.email_outbox'::regclass
              AND "conname" = 'email_outbox_source_identity_check'
          ) AS "sourceCheck"`,
      )
    ).rows,
    [
      {
        claims: "official_automation_result_email_claims",
        sourceIndex:
          "CREATE UNIQUE INDEX email_outbox_source_run_automation_unique ON public.email_outbox USING btree (source_run_id, source_workflow_automation_id)",
        sourceCheck: "c",
      },
    ],
  );
  // Release 3 replays the actual contraction over every row shape above,
  // including retained Official true values, claims and sourced outbox rows.
  const runtimeSnapshot = async () => {
    return {
      automations: await db
        .select()
        .from(workflowAutomations)
        .orderBy(workflowAutomations.id),
      emails: await db.select().from(emailOutbox).orderBy(emailOutbox.id),
    };
  };
  const beforeContraction = await runtimeSnapshot();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  const appliedMigrations = async () => {
    return (
      await client.query(
        'SELECT * FROM "drizzle"."__drizzle_migrations" ORDER BY "id"',
      )
    ).rows;
  };
  const journalBeforeContraction = await appliedMigrations();
  const retiredStorage = async () => {
    return (
      await client.query(
        `SELECT
          to_regclass('public.official_automation_result_email_claims')::text AS "claims",
          to_regclass('public.email_outbox_source_run_automation_unique')::text AS "sourceIndex",
          (
            SELECT count(*)::int FROM "information_schema"."columns"
            WHERE "table_schema" = 'public'
              AND ("table_name", "column_name") IN (
                ('workflow_automations', 'official_result_email_enabled'),
                ('email_outbox', 'source_run_id'),
                ('email_outbox', 'source_workflow_automation_id')
              )
          ) AS "columns",
          (
            SELECT count(*)::int FROM "pg_constraint"
            WHERE "conrelid" = 'public.email_outbox'::regclass
              AND "conname" = 'email_outbox_source_identity_check'
          ) AS "sourceChecks"`,
      )
    ).rows;
  };
  // RESTRICT drops reject an unexpected dependent object, and the rejected
  // migration rolls back without dropping anything or advancing the journal.
  await client.query(
    'CREATE VIEW "result_email_source_view" AS SELECT "source_run_id" FROM "email_outbox"',
  );
  try {
    await assert.rejects(
      applyFixtureMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      }),
      (error: unknown) => {
        return sqlState(error).code === "2BP01";
      },
    );
    assert.deepEqual(await appliedMigrations(), journalBeforeContraction);
    assert.deepEqual(await retiredStorage(), [
      {
        claims: "official_automation_result_email_claims",
        sourceIndex: "email_outbox_source_run_automation_unique",
        columns: 3,
        sourceChecks: 1,
      },
    ]);
  } finally {
    await client.query('DROP VIEW "result_email_source_view"');
  }

  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    (
      await client.query<{ when: string }>(
        'SELECT max("created_at")::text AS "when" FROM "drizzle"."__drizzle_migrations"',
      )
    ).rows,
    [{ when: String(contraction.when) }],
  );
  assert.deepEqual(await retiredStorage(), [
    { claims: null, sourceIndex: null, columns: 0, sourceChecks: 0 },
  ]);
  // Every retained column of every row survives, read through the runtime
  // mappings that 1.729.1 and this release share.
  assert.deepEqual(await runtimeSnapshot(), beforeContraction);
  // The rebuilt binding check admits the retained Official rows and keeps every
  // ordinary/Official invariant.
  await validateOfficialAutomationBindingSchema(ownedUrl.toString());

  // Runtime statements stay legal on the contracted storage.
  const [contractedOfficial] = await db
    .insert(workflowAutomations)
    .values({ ...owner, ...schedule, ...official("contracted-official") })
    .returning();
  assert.ok(contractedOfficial);
  const [contractedPlain] = await db
    .insert(workflowAutomations)
    .values({ ...owner, ...schedule })
    .returning();
  assert.ok(contractedPlain);
  const [contractedMarked] = await db
    .update(workflowAutomations)
    .set(official("contracted-marked"))
    .where(
      and(
        eq(workflowAutomations.id, contractedPlain.id),
        isNull(workflowAutomations.officialBlueprintKey),
      ),
    )
    .returning();
  assert.equal(contractedMarked?.officialBlueprintKey, "contracted-marked");
  assert.deepEqual(
    await db.query.workflowAutomations.findMany({
      orderBy: workflowAutomations.id,
    }),
    await db.select().from(workflowAutomations).orderBy(workflowAutomations.id),
  );
  const [contractedDeleted] = await db
    .delete(workflowAutomations)
    .where(eq(workflowAutomations.id, contractedOfficial.id))
    .returning();
  assert.deepEqual(contractedDeleted, contractedOfficial);

  // Provider replay identity is untouched: a committed key stays unique.
  const providerIdempotencyKey = `okou-email-outbox/v1/${runtimeEmail.id}`;
  const [prepared] = await db
    .update(emailOutbox)
    .set({ providerIdempotencyKey })
    .where(eq(emailOutbox.id, runtimeEmail.id))
    .returning();
  assert.equal(prepared?.providerIdempotencyKey, providerIdempotencyKey);
  await assert.rejects(
    db.insert(emailOutbox).values({
      fromAddress: "Okou <noreply@example.com>",
      toAddresses: "owner@example.com",
      subject: "Credit balance is low",
      template: { template: "credit-low-balance", props: {} },
      providerIdempotencyKey,
    }),
    violates("23505", "email_outbox_provider_idempotency_key_unique"),
  );

  console.log(
    "Official result-email retirement keeps outgoing SQL legal, runtime SQL free of retired storage, and the actual contraction lossless",
  );
} finally {
  try {
    await client.end();
  } finally {
    try {
      await migrationSql.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP DATABASE "${name}"`);
        }
      } finally {
        await admin.end();
      }
    }
  }
}
