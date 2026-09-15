import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it, test, onTestFinished } from "vitest";
import { z } from "zod";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { createDeferredPromise } from "../../utils";
import { deleteClerkAgentLifecycleData } from "../agent-lifecycle.service";
import { persistAgentCheckpointInTransaction } from "../agent-webhook-checkpoints.service";
import { lockAgentRunCheckpointLifecycle } from "../agent-run-checkpoint-lifecycle-lock.service";
import {
  deleteLockedRuns,
  deleteRunConversations,
  releaseDeletedConversationReferences,
} from "../conversation-history-deletion.service";
import { testContext } from "../../../__tests__/test-context";
import { executeRawRows } from "../../../lib/db-raw-rows";
import type { ApiDb, Tx } from "../../../lib/db-types";
import { env } from "../../../lib/env";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import {
  admitPiMemoryStage1Candidate,
  commitPiMemoryStage1Candidate,
  deletePiMemoryStage1Candidates,
  deleteStoragesWithPiMemoryCandidates,
  insertPiMemoryStage1Candidates,
  lockPiMemoryCandidateStorage,
} from "../pi-memory-stage1-candidate.service";

// Infrastructure-only exception: HTTP cannot choose the physical trigger,
// interleave DDL/transaction snapshots, or construct a corrupt reference ledger.
// Each test owns a schema, pools and all rows; concurrent API suites never see
// trigger removal. Existing completion and Clerk route tests cover HTTP behavior.
const context = testContext();
function completionTime() {
  return new Date("2026-09-13T12:00:00Z");
}
const oldHash = "1".repeat(64);
const newHash = "2".repeat(64);

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(trigger: boolean, lifecycle = false) {
  const schema = `pi_accounting_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const admin = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 8,
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  onTestFinished(async () => {
    await pool.end();
    await admin.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    await adminPool.end();
  });
  await admin.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
  for (const name of [
    "storages",
    "blobs",
    "pi_memory_stage1_candidates",
    "pi_memory_phase2_jobs",
    "agents",
    "agent_sessions",
    "agent_runs",
    "chat_threads",
    "conversations",
    "checkpoints",
  ]) {
    await db.execute(
      sql`CREATE TABLE ${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING ALL)`,
    );
  }
  // LIKE copies columns/checks/indexes, not FKs. Install the actual ownership
  // constraints in this schema, including the FK acquired by worker enqueue.
  await db.execute(sql`ALTER TABLE pi_memory_stage1_candidates
    ADD FOREIGN KEY (memory_storage_id, org_id, user_id)
      REFERENCES storages(id, org_id, user_id) ON DELETE CASCADE,
    ADD FOREIGN KEY (source_history_hash) REFERENCES blobs(hash)`);
  await db.execute(sql`ALTER TABLE pi_memory_phase2_jobs
    ADD FOREIGN KEY (memory_storage_id, org_id, user_id)
      REFERENCES storages(id, org_id, user_id) ON DELETE CASCADE`);
  if (lifecycle) {
    await db.execute(sql`ALTER TABLE agent_sessions
      ADD FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      ADD FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL`);
    await db.execute(sql`ALTER TABLE agent_runs
      ADD FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      ADD FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL`);
    await db.execute(sql`ALTER TABLE conversations
      ADD FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE`);
    await db.execute(sql`ALTER TABLE checkpoints
      ADD FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
      ADD FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE`);
    await db.execute(sql`ALTER TABLE chat_threads
      ADD FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      ADD FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL`);
  }
  const baseline = await readFile(
    new URL(
      "../../../../../../packages/db/src/migrations/1078_baseline.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const definition = baseline.match(
    /CREATE FUNCTION public\.pi_memory_stage1_candidate_blob_ref_count\(\) RETURNS trigger[\s\S]*?\$\$;/u,
  )?.[0];
  if (!definition) {
    throw new Error("Missing baseline candidate trigger function");
  }
  if (trigger) {
    await pool.query(
      definition.replace(
        "public.pi_memory_stage1_candidate_blob_ref_count",
        "pi_memory_stage1_candidate_blob_ref_count",
      ),
    );
    await db.execute(sql`CREATE TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger
      AFTER INSERT OR DELETE OR UPDATE OF source_history_hash ON pi_memory_stage1_candidates
      FOR EACH ROW EXECUTE FUNCTION pi_memory_stage1_candidate_blob_ref_count()`);
  }
  return { db, pool };
}

async function owner(db: ApiDb, orgId = randomUUID(), userId = randomUUID()) {
  const id = randomUUID();
  const row = { id, orgId, userId, name: "memory", s3Prefix: `${orgId}/${id}` };
  await db.insert(storages).values(row);
  // Admission reads public.user_feature_switches, which the private schema
  // does not shadow. PiMemory is off by default, so enable it for this owner.
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.PiMemory]: true },
  );
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, { orgId, userId });
  });
  return row;
}

function candidate(parent: Awaited<ReturnType<typeof owner>>, hash = oldHash) {
  return {
    memoryStorageId: parent.id,
    orgId: parent.orgId,
    userId: parent.userId,
    piSessionId: randomUUID(),
    sourceRunId: randomUUID(),
    sourceHistoryHash: hash,
    sourceCompletedAt: completionTime(),
    eligibleAt: completionTime(),
  };
}

async function blob(db: ApiDb, hash = oldHash, refCount = 1) {
  await db.insert(blobs).values({
    hash,
    refCount,
    rawSize: 1,
    encodedSize: 1,
    encoding: "identity",
  });
}

async function refs(db: ApiDb) {
  return await db
    .select({ hash: blobs.hash, count: blobs.refCount })
    .from(blobs)
    .orderBy(blobs.hash);
}

async function source(
  h: Harness,
  parent: Awaited<ReturnType<typeof owner>>,
  hash = oldHash,
  piSessionId = randomUUID(),
) {
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  await h.db.insert(agents).values({
    id: agentId,
    orgId: parent.orgId,
    owner: parent.userId,
    name: agentId,
  });
  await h.db.insert(agentSessions).values({
    id: sessionId,
    agentId,
    orgId: parent.orgId,
    userId: parent.userId,
  });
  await h.db
    .insert(chatThreads)
    .values({ id: threadId, agentId, userId: parent.userId });
  await h.db.insert(agentRuns).values({
    id: runId,
    sessionId,
    orgId: parent.orgId,
    userId: parent.userId,
    status: "completed",
    prompt: "fixture",
    chatThreadId: threadId,
    triggerSource: "web",
    autonomyBudget: 0,
  });
  await h.db.insert(conversations).values({
    runId,
    cliAgentType: "pi",
    cliAgentSessionId: piSessionId,
    cliAgentSessionHistoryHash: hash,
  });
  return {
    runId,
    orgId: parent.orgId,
    userId: parent.userId,
    chatThreadId: threadId,
    status: "completed" as const,
    framework: "pi" as const,
    generationEnabled: true,
    triggerSource: "web",
    completedAt: completionTime(),
    idleDelayMs: 0,
  };
}

async function pid(tx: Tx) {
  const [row] = await executeRawRows(
    tx,
    sql`SELECT pg_backend_pid() AS pid`,
    z.object({ pid: z.number().int() }),
  );
  if (!row) {
    throw new Error("Missing test backend PID");
  }
  return row.pid;
}

async function blocked(db: ApiDb, backend: number) {
  await expect
    .poll(async () => {
      const [row] = await executeRawRows(
        db,
        sql`SELECT cardinality(pg_blocking_pids(${backend})) > 0 AS blocked`,
        z.object({ blocked: z.boolean() }),
      );
      return row?.blocked;
    })
    .toBe(true);
}

describe("API C with the migrated schema", () => {
  it("counts only returned insert rows, preserves other references and rejects missing blobs", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    const row = candidate(parent);
    await h.db.transaction(async (tx) => {
      await expect(
        insertPiMemoryStage1Candidates(tx, [row, row]),
      ).resolves.toHaveLength(1);
      await expect(
        insertPiMemoryStage1Candidates(tx, [row]),
      ).resolves.toHaveLength(0);
      await expect(
        insertPiMemoryStage1Candidates(tx, [
          { ...row, sourceHistoryHash: newHash },
        ]),
      ).resolves.toHaveLength(0);
    });
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 2 },
    ]);
    await expect(
      h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [candidate(parent, newHash)]);
      }),
    ).rejects.toThrow(/Failed query/u);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 2 },
    ]);
    await expect(
      h.db.select().from(piMemoryStage1Candidates),
    ).resolves.toHaveLength(1);
  });

  it("preserves exact retries, stale sources, replacement and stale worker fencing", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await blob(h.db, newHash);
    const piSessionId = randomUUID();
    const first = await source(h, parent, oldHash, piSessionId);
    const second = await source(h, parent, newHash, piSessionId);
    const admit = async (args: typeof first) => {
      return await h.db.transaction(async (tx) => {
        return await admitPiMemoryStage1Candidate(tx, args);
      });
    };
    expect((await admit(first)).outcome).toBe("created");
    expect((await admit(first)).outcome).toBe("exact_retry");
    await expect(admit(second)).resolves.toMatchObject({
      outcome: "skipped",
      reason: "stale_source",
    });
    const beforeStatus = await refs(h.db);
    const leaseToken = randomUUID();
    await h.db.update(piMemoryStage1Candidates).set({
      status: "leased",
      leaseToken,
      leaseExpiresAt: new Date("2026-09-13T14:00:00Z"),
    });
    await expect(refs(h.db)).resolves.toStrictEqual(beforeStatus);
    expect(
      (
        await admit({
          ...second,
          completedAt: new Date("2026-09-13T13:00:00Z"),
        })
      ).outcome,
    ).toBe("replaced");
    await expect(
      h.db.transaction(async (tx) => {
        return await commitPiMemoryStage1Candidate(tx, {
          memoryStorageId: parent.id,
          orgId: parent.orgId,
          userId: parent.userId,
          piSessionId,
          sourceHistoryHash: oldHash,
          leaseToken,
          committedAt: new Date("2026-09-13T13:30:00Z"),
          result: { kind: "succeeded_no_output" },
        });
      }),
    ).resolves.toBeFalsy();
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
      { hash: newHash, count: 2 },
    ]);
  });

  it("rolls back replacement and its new retain when the old release is invalid", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await blob(h.db, newHash);
    const session = randomUUID();
    const first = await source(h, parent, oldHash, session);
    const second = await source(h, parent, newHash, session);
    await h.db.transaction(async (tx) => {
      await admitPiMemoryStage1Candidate(tx, first);
    });
    await h.db
      .update(blobs)
      .set({ refCount: 0 })
      .where(eq(blobs.hash, oldHash));
    await expect(
      h.db.transaction(async (tx) => {
        await admitPiMemoryStage1Candidate(tx, {
          ...second,
          completedAt: new Date("2026-09-13T13:00:00Z"),
        });
      }),
    ).rejects.toThrow(/no retained reference/u);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 0 },
      { hash: newHash, count: 1 },
    ]);
    await expect(
      h.db
        .select({ hash: piMemoryStage1Candidates.sourceHistoryHash })
        .from(piMemoryStage1Candidates),
    ).resolves.toStrictEqual([{ hash: oldHash }]);
  });

  it("rolls back a mid-transaction abort and releases only actual deleted candidates", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await expect(
      h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
        throw new Error("abort after retain");
      }),
    ).rejects.toThrow("abort after retain");
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
    ]);
    await h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    });
    await h.db.transaction(async (tx) => {
      await expect(
        deletePiMemoryStage1Candidates(tx, [randomUUID()]),
      ).resolves.toBe(0);
      await expect(
        deletePiMemoryStage1Candidates(tx, [parent.id]),
      ).resolves.toBe(1);
      await expect(
        deletePiMemoryStage1Candidates(tx, [parent.id]),
      ).resolves.toBe(0);
    });
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
    ]);
    await expect(h.db.select().from(storages)).resolves.toHaveLength(1);
  });

  it.each(["org", "user"])(
    "aggregates shared hashes in %s storage cleanup and leaves other owners",
    async (scope) => {
      const h = await harness(false);
      const first = await owner(h.db);
      const second = await owner(
        h.db,
        scope === "org" ? first.orgId : randomUUID(),
        scope === "user" ? first.userId : randomUUID(),
      );
      const other = await owner(h.db);
      await blob(h.db);
      await h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [
          candidate(first),
          candidate(first),
          candidate(second),
          candidate(other),
        ]);
      });
      const condition =
        scope === "org"
          ? eq(storages.orgId, first.orgId)
          : eq(storages.userId, first.userId);
      await h.db.transaction(async (tx) => {
        await expect(
          deleteStoragesWithPiMemoryCandidates(tx, condition),
        ).resolves.toBe(2);
      });
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 2 },
      ]);
      await expect(
        h.db.select({ id: storages.id }).from(storages),
      ).resolves.toStrictEqual([{ id: other.id }]);
    },
  );

  it("rolls back all child releases and parents on an insufficient bulk count", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await blob(h.db, newHash);
    await h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [
        candidate(parent),
        candidate(parent, newHash),
        candidate(parent, newHash),
      ]);
    });
    await h.db
      .update(blobs)
      .set({ refCount: 1 })
      .where(eq(blobs.hash, newHash));
    await expect(
      h.db.transaction(async (tx) => {
        await deleteStoragesWithPiMemoryCandidates(
          tx,
          eq(storages.id, parent.id),
        );
      }),
    ).rejects.toThrow(/no retained reference/u);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 2 },
      { hash: newHash, count: 1 },
    ]);
    await expect(
      h.db.select().from(piMemoryStage1Candidates),
    ).resolves.toHaveLength(3);
    await expect(h.db.select().from(storages)).resolves.toHaveLength(1);
  });

  it("serializes first-storage creation and competing admission without double retain", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    const args = await source(h, parent);
    await h.db.transaction(async (tx) => {
      await deleteStoragesWithPiMemoryCandidates(
        tx,
        eq(storages.id, parent.id),
      );
    });
    const results = await Promise.all(
      [1, 2].map(async () => {
        return await h.db.transaction(async (tx) => {
          return await admitPiMemoryStage1Candidate(tx, args);
        });
      }),
    );
    expect(
      results
        .map((result) => {
          return result.outcome;
        })
        .sort(),
    ).toStrictEqual(["created", "exact_retry"]);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 2 },
    ]);
  });

  it("keeps replacement outside the child-accounting/parent-deletion interval", async () => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await blob(h.db, newHash);
    const session = randomUUID();
    const first = await source(h, parent, oldHash, session);
    const next = await source(h, parent, newHash, session);
    await h.db.transaction(async (tx) => {
      await admitPiMemoryStage1Candidate(tx, first);
    });
    const gate = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!gate.settled()) {
        gate.resolve();
      }
    });
    const ready = createDeferredPromise<void>(context.signal);
    const replacement = h.db.transaction(async (tx) => {
      await lockPiMemoryCandidateStorage(tx, parent);
      ready.resolve();
      await gate.promise;
      return await admitPiMemoryStage1Candidate(tx, {
        ...next,
        completedAt: new Date("2026-09-13T13:00:00Z"),
      });
    });
    await ready.promise;
    const backend = createDeferredPromise<number>(context.signal);
    const deletion = h.db.transaction(async (tx) => {
      backend.resolve(await pid(tx));
      return await deleteStoragesWithPiMemoryCandidates(
        tx,
        eq(storages.id, parent.id),
      );
    });
    await blocked(h.db, await backend.promise);
    gate.resolve();
    expect((await replacement).outcome).toBe("replaced");
    await expect(deletion).resolves.toBe(1);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
      { hash: newHash, count: 1 },
    ]);
    await expect(
      h.db.select().from(piMemoryStage1Candidates),
    ).resolves.toHaveLength(0);
  });
});

async function usesExplicitCandidateReferences(tx: Tx): Promise<boolean> {
  // ROW EXCLUSIVE is compatible with other writers and blocks trigger DDL.
  // The catalog SELECT must be a separate READ COMMITTED statement AFTER the
  // lock: a statement snapshot taken before a waiting lock could be stale.
  await tx.execute(
    sql`LOCK TABLE ${piMemoryStage1Candidates} IN ROW EXCLUSIVE MODE`,
  );
  const [settings] = await executeRawRows(
    tx,
    sql`SELECT current_setting('transaction_isolation') AS isolation,
      current_setting('session_replication_role') AS replication_role`,
    z.object({
      isolation: z.literal("read committed"),
      replication_role: z.literal("origin"),
    }),
  );
  if (!settings) {
    throw new Error("Missing Pi candidate transaction settings");
  }
  const triggers = await executeRawRows(
    tx,
    sql`SELECT t.tgname AS name,
      (t.tgenabled = 'O' AND t.tgtype = 29 AND NOT t.tgdeferrable
        AND NOT t.tginitdeferred AND t.tgqual IS NULL
        AND t.tgnargs = 0 AND octet_length(t.tgargs) = 0
        AND t.tgattr::text = a.attnum::text
        AND p.proname = 'pi_memory_stage1_candidate_blob_ref_count'
        AND p.pronamespace = c.relnamespace
        AND p.proconfig IS NULL AND NOT p.prosecdef AND p.provolatile = 'v'
        AND p.pronargs = 0 AND p.prorettype = 'trigger'::regtype
        AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
        AND md5(p.prosrc) = '576154890be37fff1ec9f9f4c318428c') AS valid
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'source_history_hash'
      WHERE t.tgrelid = 'pi_memory_stage1_candidates'::regclass
        AND NOT t.tgisinternal`,
    z.object({ name: z.string(), valid: z.boolean() }),
  );
  if (triggers.length === 0) {
    return true;
  }
  if (
    triggers.length !== 1 ||
    triggers[0]?.name !== "pi_memory_stage1_candidate_blob_ref_count_trigger" ||
    !triggers[0].valid
  ) {
    throw new Error("Unexpected Pi candidate reference trigger configuration");
  }
  return false;
}

// The B insertion path is retained only for the still-supported migration and
// rollback boundary (preparation cfdc9cd3c36cede429281e6f97ddf35a9ead2bef).
// Preserve its separate lock/settings/catalog statements; C never imports this.
async function insertBCandidates(
  tx: Tx,
  rows: readonly (typeof piMemoryStage1Candidates.$inferInsert)[],
) {
  await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      inArray(storages.id, [
        ...new Set(
          rows.map((row) => {
            return row.memoryStorageId;
          }),
        ),
      ]),
    )
    .orderBy(asc(storages.id))
    .for("no key update");
  const explicit = await usesExplicitCandidateReferences(tx);
  const created = await tx
    .insert(piMemoryStage1Candidates)
    .values([...rows])
    .onConflictDoNothing()
    .returning({ hash: piMemoryStage1Candidates.sourceHistoryHash });
  if (explicit) {
    for (const row of [...created].sort((a, b) => {
      return a.hash.localeCompare(b.hash);
    })) {
      const [retained] = await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1` })
        .where(eq(blobs.hash, row.hash))
        .returning({ hash: blobs.hash });
      if (!retained) {
        throw new Error("Pi memory candidate source blob does not exist");
      }
    }
  }
  return created;
}

test("holds a DML-compatible lock through commit while DROP TRIGGER waits", async () => {
  const h = await harness(true);
  const first = await owner(h.db);
  const second = await owner(h.db);
  await blob(h.db);
  await blob(h.db, newHash);
  const gate = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!gate.settled()) {
      gate.resolve();
    }
  });
  const ready = createDeferredPromise<void>(context.signal);
  const writer = h.db.transaction(async (tx) => {
    await insertBCandidates(tx, [candidate(first)]);
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  // Different owners and hashes commit before the first writer releases its lock.
  await h.db.transaction(async (tx) => {
    await insertBCandidates(tx, [candidate(second, newHash)]);
  });
  const backend = createDeferredPromise<number>(context.signal);
  const ddl = h.db.transaction(async (tx) => {
    backend.resolve(await pid(tx));
    await tx.execute(
      sql`DROP TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger ON pi_memory_stage1_candidates`,
    );
  });
  await blocked(h.db, await backend.promise);
  gate.resolve();
  await writer;
  await ddl;
  await h.db.transaction(async (tx) => {
    await insertBCandidates(tx, [candidate(first)]);
  });
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 3 },
    { hash: newHash, count: 2 },
  ]);
});

test.each(["COMMIT", "ROLLBACK"] as const)(
  "b observes DDL %s in its post-lock statement despite an earlier snapshot",
  async (finish) => {
    const h = await harness(true);
    const parent = await owner(h.db);
    await blob(h.db);
    const gate = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!gate.settled()) {
        gate.resolve();
      }
    });
    const ready = createDeferredPromise<void>(context.signal);
    const ddl = h.db.transaction(async (tx) => {
      await tx.execute(
        sql`DROP TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger ON pi_memory_stage1_candidates`,
      );
      await tx.execute(
        sql`DROP FUNCTION pi_memory_stage1_candidate_blob_ref_count()`,
      );
      ready.resolve();
      await gate.promise;
      if (finish === "ROLLBACK") {
        throw new Error("injected DDL rollback");
      }
    });
    const ddlOutcome = Promise.allSettled([ddl]);
    await ready.promise;
    const backend = createDeferredPromise<number>(context.signal);
    const writer = h.db.transaction(async (tx) => {
      backend.resolve(await pid(tx)); // Establish a pre-DDL-commit snapshot.
      await insertBCandidates(tx, [candidate(parent)]);
    });
    await blocked(h.db, await backend.promise);
    gate.resolve();
    await expect(ddlOutcome).resolves.toStrictEqual([
      finish === "ROLLBACK"
        ? { status: "rejected", reason: new Error("injected DDL rollback") }
        : { status: "fulfilled", value: undefined },
    ]);
    await writer;
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 2 },
    ]);
  },
);

test("protects a zero-count source from concurrent GC until candidate accounting commits", async () => {
  const h = await harness(false);
  const parent = await owner(h.db);
  await blob(h.db, oldHash, 0);
  const gate = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!gate.settled()) {
      gate.resolve();
    }
  });
  const ready = createDeferredPromise<void>(context.signal);
  const writer = h.db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  const backend = createDeferredPromise<number>(context.signal);
  const gc = h.db.transaction(async (tx) => {
    backend.resolve(await pid(tx));
    return await tx
      .delete(blobs)
      .where(and(eq(blobs.hash, oldHash), eq(blobs.refCount, 0)))
      .returning({ hash: blobs.hash });
  });
  await blocked(h.db, await backend.promise);
  gate.resolve();
  await writer;
  await expect(gc).resolves.toStrictEqual([]);
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
});

test("audits known conversation and candidate ownership without exporting content or identities", async () => {
  const h = await harness(false);
  const parent = await owner(h.db);
  await blob(h.db);
  await blob(h.db, newHash, 0);
  await source(h, parent); // The initial oldHash reference belongs to this conversation.
  await h.db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [
      candidate(parent),
      candidate(parent),
      candidate(parent, newHash),
    ]);
  });
  // Infrastructure-only corrupt-ledger fixture; no production API exposes it.
  await h.db.update(blobs).set({ refCount: 0 }).where(eq(blobs.hash, newHash));
  const audit = await readFile(
    new URL(
      "../../../../../../packages/db/scripts/audit-pi-memory-candidate-references.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const [schema] = await executeRawRows(
    h.db,
    sql`SELECT current_schema() AS name`,
    z.object({ name: z.string().regex(/^pi_accounting_[a-f0-9]+$/u) }),
  );
  if (!schema) {
    throw new Error("Missing owned audit schema");
  }
  // Keep the exact diagnostic statements; redirect only its fixed schema to
  // this test's owned copy, without touching production/shared test tables.
  const results = z
    .array(z.object({ rows: z.array(z.unknown()) }))
    .parse(
      await h.pool.query(
        audit.replace(
          "SET LOCAL search_path = public, pg_catalog;",
          `SET LOCAL search_path = ${schema.name}, pg_catalog;`,
        ),
      ),
    );
  const rows = results.flatMap((result) => {
    return result.rows;
  });
  const [row] = z
    .array(
      z.object({
        pi_candidate_reference_audit: z.object({
          transaction_read_only: z.literal("on"),
          candidate_integrity: z.object({
            candidate_rows: z.literal(3),
            missing_source_blobs: z.literal(0),
            missing_storage_owners: z.literal(0),
          }),
          catalog: z.object({
            user_triggers: z.literal(0),
            expected_triggers: z.literal(0),
            named_functions: z.literal(0),
          }),
          reconciliation: z.object({
            below_candidate_floor: z.literal(1),
            below_known_owners: z.literal(1),
            balanced_hashes: z.literal(1),
            old_source_deleted_run_residuals: z.literal(0),
            unexplained_hashes: z.literal(1),
          }),
        }),
      }),
    )
    .parse(rows);
  expect(row).toBeDefined();
  const exported = JSON.stringify(rows);
  for (const identity of [
    parent.id,
    parent.orgId,
    parent.userId,
    oldHash,
    newHash,
  ]) {
    expect(exported).not.toContain(identity);
  }
});

test("takes the worker parent FK lock before waiting for a candidate during cleanup", async () => {
  const h = await harness(false);
  const parent = await owner(h.db);
  await blob(h.db);
  const row = candidate(parent);
  const leaseToken = randomUUID();
  await h.db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [
      {
        ...row,
        status: "leased",
        leaseToken,
        leaseExpiresAt: new Date("2026-09-13T14:00:00Z"),
      },
    ]);
  });
  const gate = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!gate.settled()) {
      gate.resolve();
    }
  });
  const ready = createDeferredPromise<void>(context.signal);
  const blocker = h.db.transaction(async (tx) => {
    await tx.select().from(piMemoryStage1Candidates).for("update");
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  const workerBackend = createDeferredPromise<number>(context.signal);
  const worker = h.db.transaction(async (tx) => {
    workerBackend.resolve(await pid(tx));
    return await commitPiMemoryStage1Candidate(tx, {
      ...row,
      leaseToken,
      committedAt: new Date("2026-09-13T13:00:00Z"),
      result: { kind: "succeeded_no_output" },
    });
  });
  const workerPid = await workerBackend.promise;
  await blocked(h.db, workerPid);
  const cleanupBackend = createDeferredPromise<number>(context.signal);
  const cleanup = h.db.transaction(async (tx) => {
    cleanupBackend.resolve(await pid(tx));
    return await deleteStoragesWithPiMemoryCandidates(
      tx,
      eq(storages.id, parent.id),
    );
  });
  const cleanupPid = await cleanupBackend.promise;
  await expect
    .poll(async () => {
      const [waiting] = await executeRawRows(
        h.db,
        sql`SELECT ${workerPid} = ANY(pg_blocking_pids(${cleanupPid})) AS blocked`,
        z.object({ blocked: z.boolean() }),
      );
      return waiting?.blocked;
    })
    .toBe(true);
  gate.resolve();
  await blocker;
  await expect(worker).resolves.toBeTruthy();
  await expect(cleanup).resolves.toBe(1);
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
});

// Infrastructure-only historical fixture: this represents the exact accepted
// old-source deleted-run residual, which has no writable production API.
test("c releases only the candidate reference from a preserved residual", async () => {
  const h = await harness(false);
  const parent = await owner(h.db);
  await blob(h.db, oldHash, 1);
  await h.db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [
      {
        ...candidate(parent),
        createdAt: new Date("2026-09-11T00:00:00Z"),
        sourceCompletedAt: new Date("2026-09-11T00:00:00Z"),
      },
    ]);
  });
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 2 },
  ]);
  await h.db.transaction(async (tx) => {
    await deletePiMemoryStage1Candidates(tx, [parent.id]);
  });
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
});

// Infrastructure-only #33973 exception: HTTP cannot inspect reference counts,
// inject corrupt ledgers, or pause transactions at FK/blob locks. Production
// Agent, Clerk, checkpoint/completion and threadless routes have separate tests.
async function deleteSourceLifecycle(
  h: Harness,
  runIds: readonly string[],
  root: "run" | "session" | "agent" = "run",
  failAfterRelease = false,
) {
  return await h.db.transaction(async (tx) => {
    const sessions = await tx
      .select({ id: agentSessions.id, agentId: agentSessions.agentId })
      .from(agentSessions)
      .where(
        inArray(
          agentSessions.id,
          tx
            .select({ id: agentRuns.sessionId })
            .from(agentRuns)
            .where(inArray(agentRuns.id, [...runIds])),
        ),
      )
      .orderBy(asc(agentSessions.id))
      .for("update");
    const runs = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(inArray(agentRuns.id, [...runIds]))
      .orderBy(asc(agentRuns.id))
      .for("update");
    const ids = runs.map((run) => {
      return run.id;
    });
    const removed = await deleteRunConversations(tx, ids);
    if (root === "run") {
      await deleteLockedRuns(tx, ids);
    } else if (root === "session") {
      await tx.delete(agentSessions).where(
        inArray(
          agentSessions.id,
          sessions.map((session) => {
            return session.id;
          }),
        ),
      );
    } else {
      await tx.delete(agents).where(
        inArray(
          agents.id,
          sessions.flatMap((session) => {
            return session.agentId === null ? [] : [session.agentId];
          }),
        ),
      );
    }
    const receipt = await releaseDeletedConversationReferences(tx, removed);
    if (failAfterRelease) {
      throw new Error("injected failure before commit");
    }
    return receipt;
  });
}

async function attachCheckpoint(h: Harness, runId: string) {
  const [row] = await h.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.runId, runId));
  if (!row) {
    throw new Error("Expected a conversation");
  }
  await h.db.insert(checkpoints).values({ runId, conversationId: row.id });
  await h.db
    .update(agentSessions)
    .set({ conversationId: row.id })
    .where(
      inArray(
        agentSessions.id,
        h.db
          .select({ id: agentRuns.sessionId })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId)),
      ),
    );
}

describe("conversation history deletion accounting", () => {
  it.each(["run", "session", "agent"] as const)(
    "releases only the conversation in a %s cascade, then releases the candidate",
    async (root) => {
      const h = await harness(false, true);
      const parent = await owner(h.db);
      await blob(h.db);
      const run = await source(h, parent);
      await attachCheckpoint(h, run.runId);
      await h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [
          { ...candidate(parent), sourceRunId: run.runId },
        ]);
      });
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 2 },
      ]);
      await expect(
        deleteSourceLifecycle(h, [run.runId], root),
      ).resolves.toStrictEqual({
        deletedConversations: 1,
        releasedReferences: 1,
        releasedHashes: 1,
      });
      await expect(h.db.select().from(agentRuns)).resolves.toHaveLength(0);
      await expect(h.db.select().from(conversations)).resolves.toHaveLength(0);
      await expect(h.db.select().from(checkpoints)).resolves.toHaveLength(0);
      await expect(
        h.db.select().from(piMemoryStage1Candidates),
      ).resolves.toHaveLength(1);
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 1 },
      ]);
      if (root === "run") {
        await expect(
          h.db
            .select({ conversationId: agentSessions.conversationId })
            .from(agentSessions),
        ).resolves.toStrictEqual([{ conversationId: null }]);
      }
      await deleteSourceLifecycle(h, [run.runId], root);
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 1 },
      ]);
      await h.db.transaction(async (tx) => {
        await deletePiMemoryStage1Candidates(tx, [parent.id]);
      });
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 0 },
      ]);
    },
  );

  it.each(["user", "organization"] as const)(
    "accounts for direct and owned-agent cascades during Clerk %s deletion",
    async (kind) => {
      const h = await harness(false, true);
      const parent = await owner(h.db);
      const other = await owner(h.db);
      await blob(h.db, oldHash, 4);
      const overlap = await source(h, parent);
      const indirect = await source(h, parent);
      const direct = await source(h, other);
      const survivor = await source(h, other);
      // Cross-user owned-Agent runs are legitimate; a historical cross-org child
      // also remains part of the physical Agent cascade during org deletion.
      await h.db
        .update(agentRuns)
        .set({ userId: other.userId, orgId: other.orgId })
        .where(eq(agentRuns.id, indirect.runId));
      await h.db
        .update(agentRuns)
        .set(
          kind === "user" ? { userId: parent.userId } : { orgId: parent.orgId },
        )
        .where(eq(agentRuns.id, direct.runId));
      for (const run of [overlap, indirect, direct, survivor]) {
        await attachCheckpoint(h, run.runId);
      }
      await h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [
          { ...candidate(parent), sourceRunId: overlap.runId },
          { ...candidate(other), sourceRunId: indirect.runId },
        ]);
      });
      const scope =
        kind === "user"
          ? { kind, userId: parent.userId }
          : { kind, orgId: parent.orgId };
      await deleteClerkAgentLifecycleData(h.db, scope);
      await expect(
        h.db.select({ id: agentRuns.id }).from(agentRuns),
      ).resolves.toStrictEqual([{ id: survivor.runId }]);
      await expect(h.db.select().from(conversations)).resolves.toHaveLength(1);
      await expect(h.db.select().from(checkpoints)).resolves.toHaveLength(1);
      await expect(
        h.db.select().from(piMemoryStage1Candidates),
      ).resolves.toHaveLength(2);
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 3 },
      ]);
      await deleteClerkAgentLifecycleData(h.db, scope);
      await expect(refs(h.db)).resolves.toStrictEqual([
        { hash: oldHash, count: 3 },
      ]);
    },
  );

  it("groups shared hashes across batches and ignores null and legacy inline history", async () => {
    const h = await harness(false, true);
    const parent = await owner(h.db);
    await blob(h.db, oldHash, 1002); // 1001 removed references and one other owner.
    const first = await source(h, parent);
    const [run] = await h.db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, first.runId));
    if (!run) {
      throw new Error("Expected the first Run");
    }
    const ids = Array.from({ length: 1002 }, () => {
      return randomUUID();
    });
    await h.db.insert(agentRuns).values(
      ids.map((id) => {
        return {
          id,
          sessionId: run.sessionId,
          userId: parent.userId,
          orgId: parent.orgId,
          status: "completed",
          prompt: "",
        };
      }),
    );
    await h.db.insert(conversations).values(
      ids.map((id, index) => {
        return {
          runId: id,
          cliAgentType: "pi",
          cliAgentSessionId: id,
          cliAgentSessionHistoryHash: index < 1000 ? oldHash : null,
          cliAgentSessionHistory: index === 1001 ? "legacy inline" : null,
        };
      }),
    );
    await expect(
      deleteSourceLifecycle(h, [first.runId, ...ids]),
    ).resolves.toStrictEqual({
      deletedConversations: 1003,
      releasedReferences: 1001,
      releasedHashes: 1,
    });
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
    ]);
  });

  it.each(["missing", "insufficient"])(
    "rolls back the entire Clerk cascade on a %s reference",
    async (failure) => {
      const h = await harness(false, true);
      const parent = await owner(h.db);
      await blob(h.db);
      if (failure === "insufficient") {
        await blob(h.db, newHash, 0);
      }
      const valid = await source(h, parent);
      const invalid = await source(h, parent, newHash);
      await attachCheckpoint(h, valid.runId);
      await attachCheckpoint(h, invalid.runId);
      await expect(
        deleteClerkAgentLifecycleData(h.db, {
          kind: "user",
          userId: parent.userId,
        }),
      ).rejects.toThrow("Conversation history reference accounting failed");
      await expect(h.db.select().from(agentRuns)).resolves.toHaveLength(2);
      await expect(h.db.select().from(conversations)).resolves.toHaveLength(2);
      await expect(h.db.select().from(agents)).resolves.toHaveLength(2);
      await expect(h.db.select().from(checkpoints)).resolves.toHaveLength(2);
      await expect(refs(h.db)).resolves.toStrictEqual(
        failure === "missing"
          ? [{ hash: oldHash, count: 1 }]
          : [
              { hash: oldHash, count: 1 },
              { hash: newHash, count: 0 },
            ],
      );
    },
  );

  it("rolls back a valid release when a later transaction operation fails", async () => {
    const h = await harness(false, true);
    const parent = await owner(h.db);
    await blob(h.db);
    const run = await source(h, parent);
    await expect(
      deleteSourceLifecycle(h, [run.runId], "agent", true),
    ).rejects.toThrow("injected failure before commit");
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
    ]);
    await expect(h.db.select().from(conversations)).resolves.toHaveLength(1);
    await expect(h.db.select().from(agentRuns)).resolves.toHaveLength(1);
    await expect(h.db.select().from(agents)).resolves.toHaveLength(1);
  });

  it("rolls back on a concurrent candidate release and succeeds on retry", async () => {
    const h = await harness(false, true);
    const parent = await owner(h.db);
    await blob(h.db);
    const run = await source(h, parent);
    await h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    });
    const gate = createDeferredPromise<void>(context.signal);
    const ready = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!gate.settled()) {
        gate.resolve();
      }
    });
    const cleanup = h.db.transaction(async (tx) => {
      await deletePiMemoryStage1Candidates(tx, [parent.id]);
      ready.resolve();
      await gate.promise;
    });
    await ready.promise;
    await expect(deleteSourceLifecycle(h, [run.runId])).rejects.toMatchObject({
      cause: { code: "55P03" },
    });
    await expect(h.db.select().from(conversations)).resolves.toHaveLength(1);
    gate.resolve();
    await cleanup;
    await deleteSourceLifecycle(h, [run.runId]);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 0 },
    ]);
  });

  it.each(["commit", "rollback"])(
    "keeps zero-count GC behind an uncommitted conversation %s",
    async (finish) => {
      const h = await harness(false, true);
      const parent = await owner(h.db);
      await blob(h.db);
      const run = await source(h, parent);
      const gate = createDeferredPromise<void>(context.signal);
      const ready = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!gate.settled()) {
          gate.resolve();
        }
      });
      const deletion = Promise.allSettled([
        h.db.transaction(async (tx) => {
          await tx
            .select({ id: agentRuns.id })
            .from(agentRuns)
            .where(eq(agentRuns.id, run.runId))
            .for("update");
          const removed = await deleteRunConversations(tx, [run.runId]);
          await deleteLockedRuns(tx, [run.runId]);
          await releaseDeletedConversationReferences(tx, removed);
          ready.resolve();
          await gate.promise;
          if (finish === "rollback") {
            throw new Error("rollback deletion");
          }
        }),
      ]);
      await ready.promise;
      const backend = createDeferredPromise<number>(context.signal);
      const gc = h.db.transaction(async (tx) => {
        backend.resolve(await pid(tx));
        // Lock first to exercise the recheck; an ordinary zero-count scan before
        // commit cannot see the newly released row and simply does no work.
        await tx
          .select({ hash: blobs.hash })
          .from(blobs)
          .where(eq(blobs.hash, oldHash))
          .for("update");
        return await tx
          .delete(blobs)
          .where(and(eq(blobs.hash, oldHash), eq(blobs.refCount, 0)))
          .returning({ hash: blobs.hash });
      });
      await blocked(h.db, await backend.promise);
      gate.resolve();
      await deletion;
      await expect(gc).resolves.toStrictEqual(
        finish === "commit" ? [{ hash: oldHash }] : [],
      );
      await expect(h.db.select().from(conversations)).resolves.toHaveLength(
        finish === "commit" ? 0 : 1,
      );
    },
  );
});

test("breaks the shared-blob and surviving-session checkpoint cycle without a deadlock", async () => {
  const h = await harness(false, true);
  const parent = await owner(h.db);
  await blob(h.db);
  const target = await source(h, parent);
  await attachCheckpoint(h, target.runId);
  const [targetRun] = await h.db
    .select({ sessionId: agentRuns.sessionId })
    .from(agentRuns)
    .where(eq(agentRuns.id, target.runId));
  if (!targetRun) {
    throw new Error("Expected target Run");
  }
  const writerRunId = randomUUID();
  await h.db.insert(agentRuns).values({
    id: writerRunId,
    sessionId: targetRun.sessionId,
    orgId: parent.orgId,
    userId: parent.userId,
    status: "failed",
    prompt: "",
    storageMounts: [],
  });
  const gate = createDeferredPromise<void>(context.signal);
  const ready = createDeferredPromise<void>(context.signal);
  onTestFinished(() => {
    if (!gate.settled()) {
      gate.resolve();
    }
  });
  const deletion = Promise.allSettled([
    h.db.transaction(async (tx) => {
      await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, target.runId))
        .for("update");
      const removed = await deleteRunConversations(tx, [target.runId]);
      ready.resolve(); // SET NULL now holds the Session needed by the other Run.
      await gate.promise;
      await deleteLockedRuns(tx, [target.runId]);
      await releaseDeletedConversationReferences(tx, removed);
    }),
  ]);
  await ready.promise;
  const backend = createDeferredPromise<number>(context.signal);
  const writer = h.db.transaction(async (tx) => {
    backend.resolve(await pid(tx));
    await lockAgentRunCheckpointLifecycle(tx, writerRunId);
    return await persistAgentCheckpointInTransaction(
      tx,
      {
        auth: {
          orgId: parent.orgId,
          userId: parent.userId,
          runId: writerRunId,
        },
        body: {
          runId: writerRunId,
          cliAgentType: "claude-code",
          cliAgentSessionId: writerRunId,
          cliAgentSessionHistoryHash: oldHash,
        },
      },
      {},
      context.signal,
      { source: "standalone-webhook" },
    );
  });
  await blocked(h.db, await backend.promise);
  gate.resolve();
  await expect(deletion).resolves.toMatchObject([
    { status: "rejected", reason: { cause: { code: "55P03" } } },
  ]);
  await expect(writer).resolves.toMatchObject({ status: 200 });
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 2 },
  ]);
  await expect(h.db.select().from(conversations)).resolves.toHaveLength(2);
  await deleteSourceLifecycle(h, [target.runId]);
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
  await expect(
    h.db.select({ runId: conversations.runId }).from(conversations),
  ).resolves.toStrictEqual([{ runId: writerRunId }]);
});
