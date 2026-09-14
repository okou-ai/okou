import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, eq, sql } from "drizzle-orm";
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
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { createDeferredPromise } from "../../utils";
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

async function harness(trigger: boolean) {
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

describe.each([true, false])("API B with trigger present=%s", (trigger) => {
  it("counts only returned insert rows, preserves other references and rejects missing blobs", async () => {
    const h = await harness(trigger);
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
    const h = await harness(trigger);
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
    const h = await harness(trigger);
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
    ).rejects.toThrow(trigger ? /Failed query/u : /no retained reference/u);
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
    const h = await harness(trigger);
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
      const h = await harness(trigger);
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
    const h = await harness(trigger);
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
    ).rejects.toThrow(trigger ? /Failed query/u : /no retained reference/u);
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
    const h = await harness(trigger);
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
    const h = await harness(trigger);
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
    await insertPiMemoryStage1Candidates(tx, [candidate(first)]);
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  // Different owners and hashes commit before the first writer releases its lock.
  await h.db.transaction(async (tx) => {
    await insertPiMemoryStage1Candidates(tx, [candidate(second, newHash)]);
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
    await insertPiMemoryStage1Candidates(tx, [candidate(first)]);
  });
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 3 },
    { hash: newHash, count: 2 },
  ]);
});

test("refreshes the catalog after waiting for DDL despite an earlier transaction snapshot", async () => {
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
    ready.resolve();
    await gate.promise;
  });
  await ready.promise;
  const backend = createDeferredPromise<number>(context.signal);
  const writer = h.db.transaction(async (tx) => {
    backend.resolve(await pid(tx)); // Establish a pre-DDL-commit statement snapshot.
    await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
  });
  await blocked(h.db, await backend.promise);
  gate.resolve();
  await ddl;
  await writer;
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 2 },
  ]);
});

test.each(["repeatable read", "serializable"] as const)(
  "rejects unsupported %s snapshots atomically",
  async (isolationLevel) => {
    const h = await harness(false);
    const parent = await owner(h.db);
    await blob(h.db);
    await expect(
      h.db.transaction(
        async (tx) => {
          await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
        },
        { isolationLevel },
      ),
    ).rejects.toThrow(/read committed/u);
    await expect(refs(h.db)).resolves.toStrictEqual([
      { hash: oldHash, count: 1 },
    ]);
  },
);

test("rejects disabled or renamed triggers instead of silently choosing accounting", async () => {
  const h = await harness(true);
  const parent = await owner(h.db);
  await blob(h.db);
  await h.db.execute(
    sql`ALTER TABLE pi_memory_stage1_candidates DISABLE TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger`,
  );
  await expect(
    h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    }),
  ).rejects.toThrow("Unexpected Pi candidate reference trigger configuration");
  await h.db.execute(
    sql`ALTER TABLE pi_memory_stage1_candidates ENABLE TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger`,
  );
  await h.db.execute(
    sql`ALTER TRIGGER pi_memory_stage1_candidate_blob_ref_count_trigger ON pi_memory_stage1_candidates RENAME TO unexpected_trigger`,
  );
  await expect(
    h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    }),
  ).rejects.toThrow("Unexpected Pi candidate reference trigger configuration");
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
});

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
  const h = await harness(true);
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
          trigger_state: z.object({
            user_triggers: z.literal(1),
            expected_triggers: z.literal(1),
          }),
          reconciliation: z.object({
            below_candidate_floor: z.literal(1),
            candidate_hashes_below_known_owners: z.literal(1),
            candidate_hashes_above_known_owners: z.literal(0),
            all_hashes_differing_from_known_owners: z.literal(1),
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

test("rejects function search-path overrides and replication-role bypass", async () => {
  const h = await harness(true);
  const parent = await owner(h.db);
  await blob(h.db);
  await h.db.execute(
    sql`ALTER FUNCTION pi_memory_stage1_candidate_blob_ref_count() SET search_path TO pg_catalog`,
  );
  await expect(
    h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    }),
  ).rejects.toThrow("Unexpected Pi candidate reference trigger configuration");
  await h.db.execute(
    sql`ALTER FUNCTION pi_memory_stage1_candidate_blob_ref_count() RESET ALL`,
  );
  await expect(
    h.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await insertPiMemoryStage1Candidates(tx, [candidate(parent)]);
    }),
  ).rejects.toThrow(/origin/u);
  await expect(
    h.db.select().from(piMemoryStage1Candidates),
  ).resolves.toHaveLength(0);
  await expect(refs(h.db)).resolves.toStrictEqual([
    { hash: oldHash, count: 1 },
  ]);
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
