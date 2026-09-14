import { z } from "zod";
import { executeRawRows } from "../../../lib/db-raw-rows";
import { createDeferredPromise, settle } from "../../utils";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_PROFILE } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import {
  piMemoryStage1Days,
  piMemoryStage1Selections,
  piMemoryStage1Watermarks,
} from "@okouai/db/schema/pi-memory-stage1-schedule";
import { storages } from "@okouai/db/schema/storage";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { mockNow, nowDate } from "../../../lib/time";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import {
  commitPiMemoryStage1Candidate,
  deleteStoragesWithPiMemoryCandidates,
  insertPiMemoryStage1Candidates,
} from "../pi-memory-stage1-candidate.service";
import {
  consumePiMemoryStage1Days,
  requestPiMemoryStage1Day,
} from "../pi-memory-stage1-schedule.service";
import { claimPiMemoryStage1Work } from "../pi-memory-stage1-worker.service";
import { advancePiMemoryStage1Watermark } from "../pi-memory-stage1-watermark.service";

// Infrastructure exception required by #34044: real transactions, deleted
// parents, outgoing SQL, controlled clock and competing leases are not HTTP
// inputs. Existing chat completion/admission and cron tests cover the routes.
const context = testContext();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
beforeEach(() => {
  mockNow(new Date("2026-09-14T12:00:00Z"));
});

async function harness(enabled = true) {
  const schema = `pi_schedule_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: env("DATABASE_URL"), max: 1 });
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 8,
    options: `-c search_path=${schema},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  onTestFinished(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
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
  const migration = await readFile(
    new URL(
      "../../../../../../packages/db/src/migrations/1122_pi_memory_stage1_daily_batches.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await pool.query(migration.replaceAll('"public".', ""));
  await db.execute(
    sql`ALTER TABLE pi_memory_stage1_candidates ADD FOREIGN KEY (memory_storage_id,org_id,user_id) REFERENCES storages(id,org_id,user_id) ON DELETE CASCADE, ADD FOREIGN KEY (source_history_hash) REFERENCES blobs(hash)`,
  );
  await db.execute(
    sql`ALTER TABLE chat_threads ADD FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE`,
  );
  await db.execute(
    sql`ALTER TABLE agent_runs ADD FOREIGN KEY (chat_thread_id) REFERENCES chat_threads(id) ON DELETE SET NULL`,
  );
  const userId = randomUUID();
  const orgId = randomUUID();
  const storageId = randomUUID();
  await db.insert(storages).values({
    id: storageId,
    userId,
    orgId,
    name: "memory",
    s3Prefix: storageId,
  });
  if (enabled) {
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
  }
  onTestFinished(async () => {
    await deleteFeatureSwitchesForUser(context, { userId, orgId });
  });
  async function source(
    age = 7 * HOUR,
    options: {
      threadId?: string;
      piSessionId?: string;
      hash?: string;
      status?: string;
      checkpoint?: boolean;
      triggerSource?: string;
    } = {},
  ) {
    const id = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const threadId = options.threadId ?? randomUUID();
    const at = new Date(nowDate().getTime() - age);
    if (!options.threadId) {
      await db
        .insert(agents)
        .values({ id: agentId, orgId, owner: userId, name: agentId });
      await db
        .insert(chatThreads)
        .values({ id: threadId, userId, agentId, lastMessageAt: at });
    }
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    if (!thread) {
      throw new Error("Missing fixture thread");
    }
    await db
      .insert(agentSessions)
      .values({ id: sessionId, userId, orgId, agentId: thread.agentId });
    const [run] = await db
      .insert(agentRuns)
      .values({
        id,
        sessionId,
        orgId,
        userId,
        chatThreadId: threadId,
        status: options.status ?? "completed",
        prompt: "fixture",
        triggerSource: options.triggerSource ?? "web",
        autonomyBudget: 0,
        launchSnapshot: {
          schemaVersion: 3,
          framework: "pi",
          runnerProfile: DEFAULT_PROFILE,
        },
        createdAt: at,
        completedAt:
          options.status && options.status !== "completed" ? null : at,
      })
      .returning();
    if (!run) {
      throw new Error("Missing fixture run");
    }
    const piSessionId = options.piSessionId ?? randomUUID();
    const hash = options.hash ?? createHash("sha256").update(id).digest("hex");
    if (options.checkpoint !== false) {
      await db
        .insert(blobs)
        .values({
          hash,
          refCount: 1,
          rawSize: 1,
          encodedSize: 1,
          encoding: "identity",
        })
        .onConflictDoNothing();
      await db.insert(conversations).values({
        runId: id,
        cliAgentType: "pi",
        cliAgentSessionId: piSessionId,
        cliAgentSessionHistoryHash: hash,
      });
    }
    return { run, threadId, piSessionId, hash, at };
  }
  async function startup() {
    const trigger = await source(0, { status: "pending", checkpoint: false });
    await db.transaction(async (tx) => {
      await requestPiMemoryStage1Day(tx, trigger.run);
    });
    return trigger;
  }
  async function select() {
    await consumePiMemoryStage1Days(db, nowDate(), [storageId]);
    return await db.select().from(piMemoryStage1Selections);
  }
  async function claim() {
    return await claimPiMemoryStage1Work(db, {
      currentTime: nowDate(),
      scope: { memoryStorageIds: [storageId] },
    });
  }
  return {
    schema,
    db,
    pool,
    source,
    startup,
    select,
    claim,
    userId,
    orgId,
    storageId,
  };
}

describe("durable Pi Stage 1 daily scheduling", () => {
  it("commits one cross-org day, rolls back failures, and survives trigger deletion and zero selection", async () => {
    const h = await harness();
    const a = await h.source(0, { status: "pending", checkpoint: false });
    const b = await h.source(0, { status: "queued", checkpoint: false });
    await expect(
      h.db.transaction(async (tx) => {
        await requestPiMemoryStage1Day(tx, a.run);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(h.db.select().from(piMemoryStage1Days)).resolves.toHaveLength(
      0,
    );
    await Promise.all(
      [a, b].map(async ({ run }) => {
        await h.db.transaction(async (tx) => {
          await requestPiMemoryStage1Day(tx, run);
        });
      }),
    );
    await expect(h.select()).resolves.toHaveLength(0);
    const [day] = await h.db.select().from(piMemoryStage1Days);
    expect(day?.consumedAt).toStrictEqual(nowDate());
    await h.db.delete(chatThreads).where(eq(chatThreads.userId, h.userId));
    await h.source();
    await h.startup();
    await expect(h.select()).resolves.toHaveLength(0);
    await expect(h.db.select().from(piMemoryStage1Days)).resolves.toStrictEqual(
      [day],
    );
    const otherOrg = randomUUID();
    await updateFeatureSwitchesForUser(
      context,
      { userId: h.userId, orgId: otherOrg },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    onTestFinished(async () => {
      await deleteFeatureSwitchesForUser(context, {
        userId: h.userId,
        orgId: otherOrg,
      });
    });
    const switched = await h.source(0, { status: "queued", checkpoint: false });
    await h.db
      .update(agents)
      .set({ orgId: otherOrg })
      .where(
        eq(
          agents.id,
          (
            await h.db
              .select()
              .from(chatThreads)
              .where(eq(chatThreads.id, switched.threadId))
          )[0]?.agentId ?? "",
        ),
      );
    await h.db.transaction(async (tx) => {
      await requestPiMemoryStage1Day(tx, { ...switched.run, orgId: otherOrg });
    });
    await expect(h.db.select().from(piMemoryStage1Days)).resolves.toStrictEqual(
      [day],
    );
  });

  it("freezes two distinct product threads across session rotations and concurrent crons without refill", async () => {
    const h = await harness();
    const rotated = await h.source(9 * HOUR);
    await h.source(7 * HOUR, { threadId: rotated.threadId });
    await h.source(8 * HOUR);
    await h.source(10 * HOUR);
    await h.startup();
    await Promise.all([h.select(), h.select(), h.select()]);
    const selected = await h.select();
    expect(selected).toHaveLength(2);
    expect(
      new Set(
        selected.map((s) => {
          return s.chatThreadId;
        }),
      ).size,
    ).toBe(2);
    const claimed = (await Promise.all([h.claim(), h.claim()])).flatMap((c) => {
      return c.claimed;
    });
    expect(claimed).toHaveLength(2);
    for (const work of claimed) {
      await h.db.transaction(async (tx) => {
        await expect(
          commitPiMemoryStage1Candidate(tx, {
            ...work,
            committedAt: nowDate(),
            selectedSource: work.selection,
            result: { kind: "succeeded_no_output" },
          }),
        ).resolves.toBeTruthy();
      });
    }
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.db.delete(chatThreads).where(eq(chatThreads.id, rotated.threadId));
    await h.startup();
    await expect(h.select()).resolves.toHaveLength(2);
    expect((await h.claim()).claimed).toHaveLength(0);
    await expect(
      h.db
        .insert(piMemoryStage1Selections)
        .values({ ...selected[0]!, slot: 3, chatThreadId: randomUUID() }),
    ).rejects.toThrow(/pi_memory_stage1_selections/);
  });

  it.each([6 * HOUR - 1, 6 * HOUR, 10 * DAY, 10 * DAY + 1])(
    "enforces inclusive activity boundaries at age %i",
    async (age) => {
      const h = await harness();
      await h.source(age);
      await h.startup();
      await expect(h.select()).resolves.toHaveLength(
        age >= 6 * HOUR && age <= 10 * DAY ? 1 : 0,
      );
    },
  );

  it.each(["queued", "pending", "running", "failed"])(
    "rejects a newer %s continuation without a conversation",
    async (status) => {
      const h = await harness();
      const original = await h.source(2 * DAY);
      await h.source(7 * HOUR, {
        threadId: original.threadId,
        status,
        checkpoint: false,
      });
      await h.startup();
      await expect(h.select()).resolves.toHaveLength(0);
    },
  );

  it("rechecks fresh active work and frozen source identity at claim", async () => {
    const h = await harness();
    const original = await h.source();
    await h.startup();
    const selected = await h.select();
    expect(selected).toHaveLength(1);
    await h.source(0, {
      threadId: original.threadId,
      status: "queued",
      checkpoint: false,
    });
    expect((await h.claim()).claimed).toHaveLength(0);
    await expect(h.select()).resolves.toHaveLength(1);
  });

  it("rejects unscheduled legacy backlog and stale requests across midnight", async () => {
    const h = await harness();
    const source = await h.source();
    await h.db.transaction(async (tx) => {
      await insertPiMemoryStage1Candidates(tx, [
        {
          memoryStorageId: h.storageId,
          orgId: h.orgId,
          userId: h.userId,
          piSessionId: source.piSessionId,
          sourceRunId: source.run.id,
          sourceHistoryHash: source.hash,
          sourceCompletedAt: source.at,
          eligibleAt: source.at,
        },
      ]);
    });
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.startup();
    mockNow(new Date("2026-09-15T00:00:00Z"));
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.startup();
    expect((await h.claim()).claimed).toHaveLength(1);
  });

  it("keeps hourly retries within the selected slots and requires a new-day startup", async () => {
    const h = await harness();
    await h.source();
    await h.startup();
    const work = (await h.claim()).claimed[0];
    if (!work) {
      throw new Error("Missing claim");
    }
    await h.db.transaction(async (tx) => {
      await commitPiMemoryStage1Candidate(tx, {
        ...work,
        selectedSource: work.selection,
        committedAt: nowDate(),
        result: {
          kind: "retryable_failure",
          retryAt: new Date(nowDate().getTime() + HOUR),
          errorClass: "provider_failure",
        },
      });
    });
    mockNow(new Date("2026-09-14T12:59:59.999Z"));
    expect((await h.claim()).claimed).toHaveLength(0);
    mockNow(new Date("2026-09-14T13:00:00Z"));
    expect((await h.claim()).claimed).toHaveLength(1);
    mockNow(new Date("2026-09-15T00:00:00Z"));
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.startup();
    expect((await h.claim()).claimed).toHaveLength(1);
  });

  it("settles a valid pre-midnight lease after midnight and never regresses success", async () => {
    mockNow(new Date("2026-09-14T23:30:00Z"));
    const h = await harness();
    const original = await h.source();
    await h.startup();
    const work = (await h.claim()).claimed[0];
    if (!work) {
      throw new Error("Missing claim");
    }
    mockNow(new Date("2026-09-15T00:01:00Z"));
    await h.db.transaction(async (tx) => {
      await expect(
        commitPiMemoryStage1Candidate(tx, {
          ...work,
          selectedSource: work.selection,
          committedAt: nowDate(),
          result: { kind: "succeeded_no_output" },
        }),
      ).resolves.toBeTruthy();
    });
    const [watermark] = await h.db.select().from(piMemoryStage1Watermarks);
    expect(watermark?.sourceHistoryHash).toBe(original.hash);
    await h.db.transaction(async (tx) => {
      await advancePiMemoryStage1Watermark(tx, {
        memoryStorageId: h.storageId,
        orgId: h.orgId,
        userId: h.userId,
        chatThreadId: original.threadId,
        sourceActivityAt: new Date(0),
        sourceHistoryHash: "0".repeat(64),
      });
    });
    await expect(
      h.db.select().from(piMemoryStage1Watermarks),
    ).resolves.toStrictEqual([watermark]);
    await h.startup();
    await expect(h.select()).resolves.toHaveLength(0);
  });

  it.each(["succeeded", "succeeded_no_output"] as const)(
    "preserves absent-metadata legacy %s evidence through replacement failure",
    async (status) => {
      const h = await harness();
      const original = await h.source(2 * DAY);
      await h.db.transaction(async (tx) => {
        await insertPiMemoryStage1Candidates(tx, [
          {
            memoryStorageId: h.storageId,
            orgId: h.orgId,
            userId: h.userId,
            piSessionId: original.piSessionId,
            sourceRunId: original.run.id,
            sourceHistoryHash: original.hash,
            sourceCompletedAt: original.at,
            eligibleAt: original.at,
            status,
            generatedAt: original.at,
            ...(status === "succeeded"
              ? { rawMemory: "legacy", rolloutSummary: "legacy" }
              : {}),
          },
        ]);
      });
      await h.startup();
      await expect(h.select()).resolves.toHaveLength(0);
      mockNow(new Date("2026-09-15T12:00:00Z"));
      await h.source(7 * HOUR, {
        threadId: original.threadId,
        piSessionId: original.piSessionId,
      });
      // The old writer left a success row even after run-history retention.
      await h.db.delete(agentRuns).where(eq(agentRuns.id, original.run.id));
      await h.startup();
      const work = (await h.claim()).claimed[0];
      if (!work) {
        throw new Error("Missing advanced claim");
      }
      await h.db.transaction(async (tx) => {
        await commitPiMemoryStage1Candidate(tx, {
          ...work,
          selectedSource: work.selection,
          committedAt: nowDate(),
          result: { kind: "terminal_failure", errorClass: "bad_source" },
        });
      });
      await expect(
        h.db.select().from(piMemoryStage1Watermarks),
      ).resolves.toMatchObject([
        { sourceHistoryHash: original.hash, sourceActivityAt: original.at },
      ]);
      await h.db.transaction(async (tx) => {
        await expect(
          commitPiMemoryStage1Candidate(tx, {
            ...work,
            selectedSource: work.selection,
            committedAt: nowDate(),
            result: { kind: "succeeded_no_output" },
          }),
        ).resolves.toBeFalsy();
      });
    },
  );

  it("does not invert a foreground Thread lock with the daily decision", async () => {
    const h = await harness();
    const source = await h.source();
    await h.startup();
    const locked = createDeferredPromise<number>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const foreground = h.db.transaction(async (tx) => {
      await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, source.threadId))
        .for("update");
      const [backend] = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS pid`,
        z.object({ pid: z.number() }),
      );
      if (!backend) {
        throw new Error("Missing lock backend");
      }
      locked.resolve(backend.pid);
      await release.promise;
      await tx
        .update(agentRuns)
        .set({ status: "pending", completedAt: null })
        .where(eq(agentRuns.id, source.run.id));
      await requestPiMemoryStage1Day(tx, {
        ...source.run,
        status: "pending",
        completedAt: null,
      });
    });
    const blockerPid = await locked.promise;
    const selection = h.select();
    const blocked = await settle(
      Promise.resolve(
        expect
          .poll(async () => {
            const rows = await executeRawRows(
              h.db,
              sql`SELECT pid FROM pg_stat_activity WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))`,
              z.object({ pid: z.number() }),
            );
            return rows.length;
          })
          .toBeGreaterThan(0),
      ),
    );
    release.resolve(undefined);
    await Promise.all([foreground, selection]);
    if (!blocked.ok) {
      throw blocked.error;
    }
    await expect(selection).resolves.toHaveLength(0);
    expect((await h.claim()).claimed).toHaveLength(0);
  });

  it("never exposes an older idle checkpoint through newer recent activity", async () => {
    const h = await harness();
    const source = await h.source(2 * DAY);
    await h.source(HOUR, { threadId: source.threadId });
    await h.startup();
    await expect(h.select()).resolves.toHaveLength(0);
  });

  it("rolls back the entire selection, candidate and reference reservation on a failed commit", async () => {
    const h = await harness();
    const source = await h.source();
    await h.startup();
    await h.db.execute(
      sql`ALTER TABLE pi_memory_stage1_selections ADD CONSTRAINT reject_selection CHECK (false) NOT VALID`,
    );
    await expect(h.select()).rejects.toThrow(/pi_memory_stage1_selections/);
    await expect(
      h.db.select().from(piMemoryStage1Candidates),
    ).resolves.toHaveLength(0);
    await expect(h.db.select().from(piMemoryStage1Days)).resolves.toMatchObject(
      [{ consumedAt: null }],
    );
    await expect(
      h.db
        .select({ count: blobs.refCount })
        .from(blobs)
        .where(eq(blobs.hash, source.hash)),
    ).resolves.toStrictEqual([{ count: 1 }]);
    await h.db.execute(
      sql`ALTER TABLE pi_memory_stage1_selections DROP CONSTRAINT reject_selection`,
    );
    await expect(h.select()).resolves.toHaveLength(1);
  });

  it("rejects a frozen source after classification, owner or hash changes", async () => {
    const h = await harness();
    const source = await h.source();
    await h.startup();
    await expect(h.select()).resolves.toHaveLength(1);
    await h.db
      .update(agentRuns)
      .set({ triggerSource: "agent" })
      .where(eq(agentRuns.id, source.run.id));
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.db
      .update(agentRuns)
      .set({ triggerSource: "web", userId: randomUUID() })
      .where(eq(agentRuns.id, source.run.id));
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.db
      .update(agentRuns)
      .set({ userId: h.userId })
      .where(eq(agentRuns.id, source.run.id));
    await h.db.insert(blobs).values({
      hash: "a".repeat(64),
      rawSize: 1,
      encodedSize: 1,
      encoding: "identity",
    });
    await h.db
      .update(conversations)
      .set({ cliAgentSessionHistoryHash: "a".repeat(64) })
      .where(eq(conversations.runId, source.run.id));
    expect((await h.claim()).claimed).toHaveLength(0);
    await expect(h.select()).resolves.toHaveLength(1);
  });

  it("keeps gates off and deletes owned metadata without refunding storage deletion", async () => {
    const h = await harness(false);
    await h.source();
    await h.startup();
    await expect(h.db.select().from(piMemoryStage1Days)).resolves.toHaveLength(
      0,
    );
    expect((await h.claim()).claimed).toHaveLength(0);
    await updateFeatureSwitchesForUser(
      context,
      { userId: h.userId, orgId: h.orgId },
      { [FeatureSwitchKey.PiMemory]: true },
    );
    await h.startup();
    const selected = await h.select();
    expect(selected).toHaveLength(1);
    await h.db.transaction(async (tx) => {
      await deleteStoragesWithPiMemoryCandidates(
        tx,
        eq(storages.id, h.storageId),
      );
    });
    await expect(
      h.db.select().from(piMemoryStage1Selections),
    ).resolves.toStrictEqual(selected);
    expect((await h.claim()).claimed).toHaveLength(0);
    await h.db
      .delete(piMemoryStage1Days)
      .where(eq(piMemoryStage1Days.userId, h.userId));
    await expect(
      h.db.select().from(piMemoryStage1Selections),
    ).resolves.toHaveLength(0);
  });
});
