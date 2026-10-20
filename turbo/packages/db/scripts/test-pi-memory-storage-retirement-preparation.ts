import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import postgres from "postgres";
import { z } from "zod";

import { schema } from "../src/index";
import { piMemoryPhase2Jobs } from "../src/runtime/pi-memory-phase2-job";
import { outgoingPiMemoryJobs } from "./fixtures/pi-memory-storage-outgoing";
import { applyFixtureMigrations } from "./fixtures/migrate-with-empty-instructions";
import { validatePermanentPiMemoryJobs } from "./test-pi-memory-job-permanent";

// Retain through independent production contraction acceptance under #39171.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string(), when: z.number() })) })
  .parse(
    JSON.parse(
      await readFile(
        new URL("../src/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ),
  );
const preparation = journal.entries.find(({ tag }) => {
  return tag.endsWith("_prepare_pi_memory_storage_retirement");
});
const contraction = journal.entries.find(({ tag }) => {
  return tag.endsWith("_retire_pi_memory_compatibility_storage");
});
assert.ok(
  preparation,
  "Retain the writer preparation through contraction acceptance",
);
assert.ok(contraction, "Exercise the actual contraction migration");
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const databaseName = `pi_memory_storage_${randomUUID().replaceAll("-", "")}`;
const ownedUrl = new URL(adminUrl);
ownedUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
const client = new Client({ connectionString: ownedUrl.toString() });
const migrationSql = postgres(ownedUrl.toString(), {
  max: 1,
  onnotice: () => {},
});
const db = drizzle(client, { schema });
const rowSchema = z.object({ value: z.record(z.string(), z.unknown()) });

async function retainedState() {
  const rows: Record<string, unknown[]> = {};
  for (const table of [
    "agents",
    "agent_sessions",
    "agent_runs",
    "conversations",
    "blobs",
    "storages",
    "storage_versions",
    "storage_version_lineage",
  ]) {
    rows[table] = (
      await client.query(
        `SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )
    ).rows.map((row: unknown) => {
      return rowSchema.parse(row).value;
    });
  }
  const jobs = (await db.select().from(piMemoryPhase2Jobs)).sort((a, b) => {
    return a.memoryStorageId.localeCompare(b.memoryStorageId);
  });
  const journalRows = (
    await client.query(
      "SELECT to_jsonb(t) AS value FROM drizzle.__drizzle_migrations t ORDER BY id",
    )
  ).rows.map((row: unknown) => {
    return rowSchema.parse(row).value;
  });
  return { data: rows, jobs, journal: journalRows };
}

try {
  await client.connect();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: preparation.when,
  });
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const conversationId = randomUUID();
  const storageId = randomUUID();
  const versionId = "c".repeat(64);
  const baseVersionId = "a".repeat(64);
  const selectionDigest = "b".repeat(64);
  const historyHash = "d".repeat(64);
  await client.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, 'storage-retirement-org', 'storage-retirement-user', 'retained-agent')",
    [agentId],
  );
  await client.query(
    "INSERT INTO agent_sessions (id, agent_id, org_id, user_id) VALUES ($1, $2, 'storage-retirement-org', 'storage-retirement-user')",
    [sessionId, agentId],
  );
  await client.query(
    "INSERT INTO agent_runs (id, session_id, org_id, user_id, prompt, status, result) VALUES ($1, $2, 'storage-retirement-org', 'storage-retirement-user', 'retained run', 'completed', $3)",
    [
      runId,
      sessionId,
      JSON.stringify({ conversationId, artifact: { memory: versionId } }),
    ],
  );
  await client.query(
    "INSERT INTO blobs (hash, raw_size, encoded_size, encoding, ref_count) VALUES ($1, 1, 1, 'identity', 1)",
    [historyHash],
  );
  await client.query(
    "INSERT INTO conversations (id, run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history_hash) VALUES ($1, $2, 'pi', 'retained-native-session', $3)",
    [conversationId, runId, historyHash],
  );
  await client.query(
    "UPDATE agent_sessions SET conversation_id = $1 WHERE id = $2",
    [conversationId, sessionId],
  );
  await client.query(
    "INSERT INTO storages (id, org_id, user_id, name, s3_prefix) VALUES ($1::uuid, 'storage-retirement-org', 'storage-retirement-user', 'memory', $1::text)",
    [storageId],
  );
  await client.query(
    "INSERT INTO storage_versions (id, storage_id, s3_key, archive_size, created_by) VALUES ($1, $2, 'retained-memory', 0, 'storage-retirement-user')",
    [versionId, storageId],
  );
  await client.query("UPDATE storages SET head_version_id = $1 WHERE id = $2", [
    versionId,
    storageId,
  ]);
  await client.query(
    "INSERT INTO storage_version_lineage (storage_id, version_id, parent_version_id, run_id) VALUES ($1, $2, $3, $4)",
    [storageId, versionId, baseVersionId, runId],
  );
  await db.insert(outgoingPiMemoryJobs).values({
    memoryStorageId: storageId,
    orgId: "storage-retirement-org",
    userId: "storage-retirement-user",
    status: "idle",
    completedRevision: 1,
    lastMaintenanceRunId: runId,
    lastMaintenanceRevision: 1,
    lastMaintenanceBaseVersionId: baseVersionId,
    lastMaintenanceSelectionDigest: selectionDigest,
    lastMaintenanceOutcome: "published",
    lastMaintenancePublicationVersionId: versionId,
    lastPublishedVersionId: versionId,
    lastPublishedAt: new Date(),
  });
  await client.query(
    "INSERT INTO pi_memory_phase2_checkpoints (run_id, memory_storage_id, org_id, user_id, lease_token, claimed_revision, claimed_base_version_id, selection_digest, version_id) VALUES ($1, $2, 'storage-retirement-org', 'storage-retirement-user', $3, 1, $4, $5, $6)",
    [runId, storageId, randomUUID(), baseVersionId, selectionDigest, versionId],
  );

  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when,
  });
  // Stale compatibility output is neither a current result nor a live lease.
  await db
    .update(outgoingPiMemoryJobs)
    .set({
      sandboxLeaseToken: randomUUID(),
      lastMaintenancePublicationVersionId: "e".repeat(64),
    })
    .where(eq(outgoingPiMemoryJobs.memoryStorageId, storageId));
  await validatePermanentPiMemoryJobs(ownedUrl.toString());
  const before = await retainedState();

  for (const dependency of [
    {
      create:
        "CREATE INDEX memory_unexpected_index ON pi_memory_phase2_jobs (legacy_lease_token)",
      drop: "DROP INDEX memory_unexpected_index",
    },
    {
      create:
        "ALTER TABLE pi_memory_phase2_jobs ADD CONSTRAINT memory_unexpected_check CHECK (legacy_lease_token IS NULL)",
      drop: "ALTER TABLE pi_memory_phase2_jobs DROP CONSTRAINT memory_unexpected_check",
    },
    {
      create:
        "CREATE VIEW memory_unexpected_view AS SELECT last_maintenance_checkpoint_version_id FROM pi_memory_phase2_jobs",
      drop: "DROP VIEW memory_unexpected_view",
    },
    {
      create:
        "CREATE VIEW memory_unexpected_row_view AS SELECT t FROM pi_memory_phase2_jobs t",
      drop: "DROP VIEW memory_unexpected_row_view",
    },
    {
      create:
        "CREATE FUNCTION memory_unexpected_routine() RETURNS text LANGUAGE sql AS $$ SELECT last_maintenance_checkpoint_version_id FROM pi_memory_phase2_jobs LIMIT 1 $$",
      drop: "DROP FUNCTION memory_unexpected_routine()",
    },
    {
      create:
        "CREATE TABLE memory_unexpected_child () INHERITS (pi_memory_phase2_jobs)",
      drop: "DROP TABLE memory_unexpected_child",
    },
    {
      create:
        "CREATE VIEW memory_unexpected_receipt_view AS SELECT run_id FROM pi_memory_phase2_checkpoints",
      drop: "DROP VIEW memory_unexpected_receipt_view",
    },
    {
      create:
        "CREATE INDEX memory_unexpected_receipt_index ON pi_memory_phase2_checkpoints (version_id)",
      drop: "DROP INDEX memory_unexpected_receipt_index",
    },
    {
      create:
        "ALTER TABLE pi_memory_phase2_checkpoints ADD CONSTRAINT memory_unexpected_receipt_check CHECK (claimed_revision > 0)",
      drop: "ALTER TABLE pi_memory_phase2_checkpoints DROP CONSTRAINT memory_unexpected_receipt_check",
    },
    {
      create:
        "CREATE FUNCTION memory_unexpected_receipt_routine() RETURNS uuid LANGUAGE sql AS $$ SELECT run_id FROM pi_memory_phase2_checkpoints LIMIT 1 $$",
      drop: "DROP FUNCTION memory_unexpected_receipt_routine()",
    },
    {
      create:
        "CREATE TABLE memory_unexpected_reference (run_id uuid REFERENCES pi_memory_phase2_checkpoints(run_id))",
      drop: "DROP TABLE memory_unexpected_reference",
    },
  ]) {
    await client.query(dependency.create);
    await assert.rejects(
      applyFixtureMigrations(migrationSql, {
        beforeMillis: contraction.when + 1,
      }),
      (error: unknown) => {
        return (
          error instanceof Error && "code" in error && error.code === "2BP01"
        );
      },
    );
    assert.deepEqual(
      await retainedState(),
      before,
      "Rejected contraction preserves data and journal",
    );
    assert.equal(
      (await db.select().from(outgoingPiMemoryJobs))[0]
        ?.lastMaintenancePublicationVersionId,
      "e".repeat(64),
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM pi_memory_phase2_checkpoints",
        )
      ).rows[0]?.count,
      1,
    );
    await client.query(dependency.drop);
  }

  // Untracked trigger code must also block DROP.
  await client.query(
    "CREATE FUNCTION memory_unexpected_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
  );
  await client.query(
    "CREATE TRIGGER memory_unexpected_trigger BEFORE INSERT ON pi_memory_phase2_checkpoints FOR EACH ROW EXECUTE FUNCTION memory_unexpected_trigger()",
  );
  await assert.rejects(
    applyFixtureMigrations(migrationSql, {
      beforeMillis: contraction.when + 1,
    }),
    /Unexpected Pi memory storage dependencies/,
  );
  assert.deepEqual(await retainedState(), before);
  await client.query(
    "DROP TRIGGER memory_unexpected_trigger ON pi_memory_phase2_checkpoints",
  );
  await client.query("DROP FUNCTION memory_unexpected_trigger()");

  const token = randomUUID();
  await db
    .update(outgoingPiMemoryJobs)
    .set({
      status: "leased",
      inputRevision: 2,
      claimedRevision: 2,
      claimedBaseVersionId: versionId,
      leaseToken: token,
      sandboxLeaseToken: token,
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      claimedSelectionDigest: selectionDigest,
      claimedSelectedCount: 0,
      claimedSelectedUtf8Bytes: 0,
    })
    .where(eq(outgoingPiMemoryJobs.memoryStorageId, storageId));
  const leased = await retainedState();
  await assert.rejects(
    applyFixtureMigrations(migrationSql, {
      beforeMillis: contraction.when + 1,
    }),
    /Pi memory compatibility leases remain/,
  );
  assert.deepEqual(await retainedState(), leased);
  // Expiry alone cannot certify drain, including the older legacy claim shape.
  await db
    .update(outgoingPiMemoryJobs)
    .set({
      legacyLeaseToken: token,
      sandboxLeaseToken: null,
      leaseExpiresAt: new Date(Date.now() - 1),
    })
    .where(eq(outgoingPiMemoryJobs.memoryStorageId, storageId));
  const expiredLegacy = await retainedState();
  await assert.rejects(
    applyFixtureMigrations(migrationSql, {
      beforeMillis: contraction.when + 1,
    }),
    /Pi memory compatibility leases remain/,
  );
  assert.deepEqual(await retainedState(), expiredLegacy);
  // A new prepared claim fences the old token; its real lease survives DROP.
  await db
    .update(piMemoryPhase2Jobs)
    .set({
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 3_600_000),
      maintenanceRunId: randomUUID(),
    })
    .where(eq(piMemoryPhase2Jobs.memoryStorageId, storageId));
  const ready = await retainedState();
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  const after = await retainedState();
  const { journal: beforeJournal, ...beforeData } = ready;
  const { journal: afterJournal, ...afterData } = after;
  assert.deepEqual(afterData, beforeData);
  assert.equal(afterJournal.length, beforeJournal.length + 1);
  assert.equal(
    (
      await client.query(
        "SELECT to_regclass('pi_memory_phase2_checkpoints') AS name",
      )
    ).rows[0]?.name,
    null,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid = 'pi_memory_phase2_jobs'::regclass AND attname IN ('legacy_lease_token', 'sandbox_lease_token', 'last_maintenance_checkpoint_version_id') AND NOT attisdropped",
      )
    ).rows[0]?.count,
    0,
  );
  await validatePermanentPiMemoryJobs(ownedUrl.toString());
  await applyFixtureMigrations(migrationSql, {
    beforeMillis: contraction.when + 1,
  });
  assert.deepEqual(
    await retainedState(),
    after,
    "Migration retry is idempotent",
  );
  console.log(
    "Pi memory storage contraction preserves Jobs, real leases, native history and Storage; dependency/lease failures preserve the journal.",
  );
} finally {
  await client.end();
  await migrationSql.end();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
