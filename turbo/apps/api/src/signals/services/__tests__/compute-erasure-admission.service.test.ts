import { createHash, randomUUID } from "node:crypto";
import {
  projectErasureDecision,
  type ErasureDecision,
} from "@okouai/db/operations/account-erasure";
import { accountErasureJobs } from "@okouai/db/schema/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunQueue } from "@okouai/db/schema/agent-run-queue";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { users } from "@okouai/db/schema/user";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { createStore } from "ccstate";
import { count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import { env, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import { useSecretKmsProbe } from "../../routes/__tests__/helpers/secret-kms-probe";
import {
  updateFeatureSwitchesForUser,
  deleteFeatureSwitchesForUser,
} from "../../routes/__tests__/helpers/feature-switches";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2CandidatesWithSources,
} from "./pi-memory-phase2-job.test-fixture";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
import { executeRawRows } from "../../../lib/db-raw-rows";
import type { Tx } from "../../../lib/db-types";
import { createBddApi } from "../../routes/__tests__/helpers/api-bdd";
import { createRunsApi } from "../../routes/__tests__/helpers/api-bdd-runs";
import { createDeferredPromise, settle } from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  promoteNextQueuedRun$,
  cleanupExpiredQueueEntries$,
} from "../run-queue.service";
import { COMPUTE_CLOSURE_ERROR } from "../agent-run-terminal-transition.service";

// B2b1 explicitly requires the real dormant projector and actual writers, plus
// locks/absence of partial records. No public deletion ingress exists. Only
// unique synthetic infrastructure faults are seeded below; admission, creation,
// promotion, claim, billing metadata and PostgreSQL are never mocked.
describe("actual compute transactions versus the B1 projector", () => {
  const context = testContext();
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 8 });
  const db = drizzle(pool);
  const jobIds: string[] = [];
  afterAll(async () => {
    if (jobIds.length) {
      await db
        .delete(accountErasureJobs)
        .where(inArray(accountErasureJobs.id, jobIds));
    }
    await pool.end();
  });

  function decision(
    subjectId: string,
    subjectKind: ErasureDecision["subjectKind"] = "user",
  ): ErasureDecision {
    return {
      subjectId,
      subjectKind,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: nowDate(),
      deadlineAt: new Date("2099-01-01T00:00:00Z"),
    };
  }

  async function close(
    input: ErasureDecision,
    executor: Parameters<typeof projectErasureDecision>[0] = db,
  ) {
    const job = await projectErasureDecision(executor, input);
    jobIds.push(job.id);
    return job;
  }

  async function fixture() {
    const actor = bdd.user();
    if (!actor.orgId) {
      throw new Error("Synthetic fixture requires an organization");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const runnerGroup = api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Synthetic erasure admission",
      visibility: "public",
    });
    return { actor, orgId: actor.orgId, agentId: agent.agentId, runnerGroup };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function create(f: Fixture) {
    return api.requestCreateRun(
      f.actor,
      {
        agentId: f.agentId,
        prompt: "Synthetic admission content",
        modelProvider: "anthropic-api-key",
      },
      [201, 409],
    );
  }
  async function pending(f: Fixture) {
    const result = await create(f);
    if (result.status !== 201) {
      throw new Error("Expected synthetic pending creation");
    }
    return result.body;
  }

  function counts(f: Fixture) {
    const runIds = db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.userId, f.actor.userId));
    const tables = [
      db
        .select({ count: count() })
        .from(agentRuns)
        .where(eq(agentRuns.userId, f.actor.userId)),
      db
        .select({ count: count() })
        .from(agentSessions)
        .where(eq(agentSessions.userId, f.actor.userId)),
      db
        .select({ count: count() })
        .from(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds)),
      db
        .select({ count: count() })
        .from(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds)),
      db
        .select({ count: count() })
        .from(agentRunQueue)
        .where(inArray(agentRunQueue.runId, runIds)),
    ];
    return Promise.all(
      tables.map(async (query) => {
        return (await query)[0]?.count;
      }),
    );
  }

  async function backendPid(tx: Tx) {
    const [row] = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS pid`,
      z.object({ pid: z.number() }),
    );
    if (!row) {
      throw new Error("Missing backend PID");
    }
    return row.pid;
  }
  async function waitForBlockedBy(pid: number) {
    const waiters = () => {
      return executeRawRows(
        db,
        sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`,
        z.object({ pid: z.number() }),
      );
    };
    await expect
      .poll(
        async () => {
          return (await waiters()).length;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    const [waiter] = await waiters();
    if (!waiter) {
      throw new Error("Expected an observed PostgreSQL lock waiter");
    }
    return waiter.pid;
  }

  async function holdBusinessRow(
    lock: (tx: Tx) => PromiseLike<unknown>,
    beforeCommit?: (tx: Tx) => PromiseLike<unknown>,
  ) {
    const entered = createDeferredPromise<number>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let released = false;
    const releaseOnce = () => {
      if (!released && !context.signal.aborted) {
        released = true;
        release.resolve();
      }
    };
    const held = db.transaction(async (tx) => {
      await lock(tx);
      entered.resolve(await backendPid(tx));
      await release.promise;
      await beforeCommit?.(tx);
    });
    onTestFinished(async () => {
      releaseOnce();
      await settle(held);
    });
    return {
      pid: await entered.promise,
      release: async () => {
        releaseOnce();
        await held;
      },
    };
  }

  function holdResource(agentId: string, nextOwner?: string) {
    return holdBusinessRow(
      (tx) => {
        return tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, agentId))
          .for("update");
      },
      nextOwner === undefined
        ? undefined
        : (tx) => {
            return tx
              .update(agents)
              .set({ owner: nextOwner })
              .where(eq(agents.id, agentId));
          },
    );
  }

  async function maintenance() {
    api.acceptStorageDownloads();
    const scope = await createPhase2TestScope("erasure-admission", {
      emptyBase: true,
    });
    await updateFeatureSwitchesForUser(context, scope, {
      [FeatureSwitchKey.PiMemory]: true,
    });
    onTestFinished(() => {
      return deleteFeatureSwitchesForUser(context, scope);
    });
    await seedOrgMetadata({
      orgId: scope.orgId,
      tier: "pro",
      credits: 100_000,
    });
    await seedBuiltInModelKey(context, "gpt-5.6-terra");
    await insertPhase2CandidatesWithSources(
      scope,
      ["first", "second"].map((name) => {
        return {
          piSessionId: randomUUID(),
          sourceRunId: randomUUID(),
          sourceHistoryHash: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
          sourceCompletedAt: nowDate(),
          rawMemory: `${name} synthetic candidate`,
          rolloutSummary: `${name} synthetic summary`,
        };
      }),
    );
    await insertPendingPhase2Job(scope, { updatedAt: nowDate() });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const dispatched = await createStore().set(
      executePiMemoryPhase2Work$,
      { scope, currentTime: nowDate() },
      context.signal,
    );
    if (dispatched.outcome !== "dispatched") {
      throw new Error(`Maintenance dispatch failed: ${dispatched.outcome}`);
    }
    return { ...scope, runId: dispatched.runId };
  }

  async function holdClosure(input: ErasureDecision) {
    const entered = createDeferredPromise<number>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let released = false;
    const releaseOnce = () => {
      if (!released && !context.signal.aborted) {
        released = true;
        release.resolve();
      }
    };
    const held = db.transaction(async (tx) => {
      await close(input, tx);
      entered.resolve(await backendPid(tx));
      await release.promise;
    });
    onTestFinished(async () => {
      releaseOnce();
      await settle(held);
    });
    return {
      pid: await entered.promise,
      release: async () => {
        releaseOnce();
        await held;
      },
    };
  }

  const writerKinds = [
    "pending-create",
    "queued-create",
    "failed-create",
    "promotion",
    "claim",
    "invalid-context",
    "history-load",
  ] as const;
  type WriterKind = (typeof writerKinds)[number];

  async function writerFixture(kind: WriterKind): Promise<{
    readonly f: Fixture;
    readonly runId: string | undefined;
    readonly invoke: () => Promise<unknown>;
  }> {
    const f = await fixture();
    if (kind === "failed-create") {
      const agent = await api.createDirectAgent(f.actor, {
        version: "1",
        agents: {
          [`synthetic-${randomUUID().slice(0, 8)}`]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "synthetic-key" },
            experimental_runner: { group: "other/synthetic" },
          },
        },
      });
      f.agentId = agent.agentId;
      return {
        f,
        runId: undefined,
        invoke: () => {
          return api.requestDirectRun(
            f.actor,
            { agentId: f.agentId, prompt: "Synthetic failed preparation" },
            [201, 409],
          );
        },
      };
    }
    if (kind === "pending-create" || kind === "queued-create") {
      if (kind === "queued-create") {
        await pending(f);
        await pending(f);
      }
      return {
        f,
        runId: undefined,
        invoke: () => {
          return create(f);
        },
      };
    }
    if (kind === "promotion") {
      const active = [await pending(f), await pending(f)];
      const queued = await pending(f);
      expect(queued.status).toBe("queued");
      // A fixture-only freed slot avoids a completion owner's automatic drain.
      await db
        .update(agentRuns)
        .set({ status: "completed", completedAt: nowDate() })
        .where(
          inArray(
            agentRuns.id,
            active.map((run) => {
              return run.runId;
            }),
          ),
        );
      return {
        f,
        runId: queued.runId,
        invoke: () => {
          return createStore().set(
            promoteNextQueuedRun$,
            { orgId: f.orgId },
            context.signal,
          );
        },
      };
    }
    const run = await pending(f);
    await db.insert(agentRunCallbacks).values({
      runId: run.runId,
      url: `https://synthetic.example/${randomUUID()}`,
      payload: {},
    });
    if (kind === "invalid-context") {
      await db
        .update(runnerJobQueue)
        .set({
          executionContext: sql`${runnerJobQueue.executionContext} - 'storageMounts'`,
        })
        .where(eq(runnerJobQueue.runId, run.runId));
    }
    if (kind === "history-load") {
      const history = {
        sessionId: `synthetic-${randomUUID()}`,
        historyRef: {
          kind: "blob",
          hash: createHash("sha256").update(randomUUID()).digest("hex"),
        },
      };
      await db
        .update(runnerJobQueue)
        .set({
          executionContext: sql`jsonb_set(${runnerJobQueue.executionContext}, '{resumeSession}', ${JSON.stringify(history)}::jsonb)`,
        })
        .where(eq(runnerJobQueue.runId, run.runId));
    }
    return {
      f,
      runId: run.runId,
      invoke: () => {
        return api.requestClaimRunnerJob(true, run.runId, [200, 400, 404]);
      },
    };
  }

  it("measures bounded concurrent actual claims for shared and separate subject sets", async () => {
    const samples: Record<"shared" | "separate", number[]> = {
      shared: [],
      separate: [],
    };
    for (const mode of ["shared", "separate"] as const) {
      for (let round = 0; round < 2; round++) {
        const first = await fixture();
        const second = mode === "shared" ? first : await fixture();
        const runs = [await pending(first), await pending(second)];
        const started = performance.now();
        const results = await Promise.all(
          runs.map((run) => {
            return api.requestClaimRunnerJob(true, run.runId, [200]);
          }),
        );
        samples[mode].push(performance.now() - started);
        expect(
          results.map((result) => {
            return result.status;
          }),
        ).toStrictEqual([200, 200]);
      }
    }
    // Local end-to-end observations, deliberately no global throughput claim
    // or latency threshold tied to a shared CI machine.
    process.stdout.write(`B2B1_CLAIM_PAIR_MS ${JSON.stringify(samples)}\n`);
  });

  it("promotes a surviving queued item behind a closed corrupt payload and retains its locator", async () => {
    const f = await fixture();
    const active = [await pending(f), await pending(f)];
    const closed = await pending(f);
    const survivor = bdd.user({ orgId: f.orgId });
    const agent = await bdd.createAgent(survivor, {
      displayName: "Surviving queued owner",
      visibility: "public",
    });
    const live = await api.createRun(survivor, {
      agentId: agent.agentId,
      prompt: "Live queued payload",
      modelProvider: "anthropic-api-key",
    });
    expect(live.status).toBe("queued");
    await db
      .update(agentRuns)
      .set({ status: "completed", completedAt: nowDate() })
      .where(
        inArray(
          agentRuns.id,
          active.map((run) => {
            return run.runId;
          }),
        ),
      );
    await db
      .update(agentRunQueue)
      .set({ encryptedParams: "synthetic-corrupt-ciphertext" })
      .where(eq(agentRunQueue.runId, closed.runId));
    await close(decision(f.actor.userId));
    await expect(
      createStore().set(
        promoteNextQueuedRun$,
        { orgId: f.orgId },
        context.signal,
      ),
    ).resolves.toMatchObject({
      kind: "activation",
      activation: { runnerNotification: { runId: live.runId } },
    });
    await expect(
      db
        .select({
          error: agentRuns.error,
          creditAdmitted: agentRuns.creditAdmitted,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, closed.runId)),
    ).resolves.toStrictEqual([
      { error: COMPUTE_CLOSURE_ERROR, creditAdmitted: false },
    ]);
    await expect(
      db
        .select()
        .from(agentRunQueue)
        .where(eq(agentRunQueue.runId, closed.runId)),
    ).resolves.toHaveLength(1);
    await expect(
      createStore().set(
        promoteNextQueuedRun$,
        { orgId: f.orgId },
        context.signal,
      ),
    ).resolves.toBeNull();
  });

  it("keeps an open corrupt queued payload as an infrastructure error without billing failure", async () => {
    const w = await writerFixture("promotion");
    if (!w.runId) {
      throw new Error("Missing synthetic queue");
    }
    await db
      .update(agentRunQueue)
      .set({ encryptedParams: "synthetic-corrupt-ciphertext" })
      .where(eq(agentRunQueue.runId, w.runId));
    await expect(settle(w.invoke())).resolves.toMatchObject({ ok: false });
    await expect(
      db
        .select({
          status: agentRuns.status,
          failureReason: agentRuns.failureReason,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, w.runId)),
    ).resolves.toStrictEqual([{ status: "queued", failureReason: null }]);
  });

  it("polls past a closed pending candidate without releasing its prompt or deleting its locator", async () => {
    const f = await fixture();
    const closed = await pending(f);
    const survivor = bdd.user({ orgId: f.orgId });
    const agent = await bdd.createAgent(survivor, {
      displayName: "Surviving poll owner",
      visibility: "public",
    });
    const live = await api.createRun(survivor, {
      agentId: agent.agentId,
      prompt: "Live poll payload",
      modelProvider: "anthropic-api-key",
    });
    await close(decision(f.actor.userId));
    const polled = await api.requestPollRunner(
      true,
      { group: f.runnerGroup, supportedProfiles: ["vm0/default"] },
      [200],
    );
    expect(polled).toMatchObject({
      body: { job: { runId: live.runId, prompt: "Live poll payload" } },
    });
    await expect(
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, closed.runId)),
    ).resolves.toStrictEqual([{ status: "cancelled" }]);
    await expect(
      db
        .select()
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, closed.runId)),
    ).resolves.toHaveLength(1);
    await db
      .update(runnerJobQueue)
      .set({ expiresAt: new Date("2020-01-01") })
      .where(eq(runnerJobQueue.runId, closed.runId));
    await accept(
      setupApp({ context, routes: testCronCleanupSandboxesStateRoutes })(
        testCronCleanupSandboxesStateContract,
      ).cleanup({
        body: {
          chatThreadIds: [],
          runIds: [closed.runId],
          orgIds: [f.orgId],
          exportJobIds: [],
        },
      }),
      [200],
    );
    await expect(
      db
        .select()
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, closed.runId)),
    ).resolves.toHaveLength(1);
  });

  it("rechecks maintenance lease expiry after waiting on the actual job lock", async () => {
    const m = await maintenance();
    const held = await holdBusinessRow(
      (tx) => {
        return tx
          .select({ id: piMemoryPhase2Jobs.memoryStorageId })
          .from(piMemoryPhase2Jobs)
          .where(eq(piMemoryPhase2Jobs.memoryStorageId, m.memoryStorageId))
          .for("update");
      },
      (tx) => {
        return tx
          .update(piMemoryPhase2Jobs)
          .set({ leaseExpiresAt: new Date("2020-01-01") })
          .where(eq(piMemoryPhase2Jobs.memoryStorageId, m.memoryStorageId));
      },
    );
    const claiming = settle(
      api.requestClaimRunnerJob(true, m.runId, [200, 404]),
    );
    await waitForBlockedBy(held.pid);
    await held.release();
    await expect(claiming).resolves.toMatchObject({
      ok: true,
      value: { status: 404 },
    });
    await expect(
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, m.runId)),
    ).resolves.toStrictEqual([{ status: "pending" }]);
  });

  it("commits the actual queued retry before closure, after external payload encryption", async () => {
    const w = await writerFixture("queued-create");
    const entered = createDeferredPromise<
      Awaited<ReturnType<typeof holdResource>>
    >(context.signal);
    useSecretKmsProbe((request, call) => {
      if (call !== 2) {
        return undefined;
      }
      return (async () => {
        const held = await holdResource(w.f.agentId);
        entered.resolve(held);
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      })();
    });
    const writing = settle(w.invoke());
    const held = await entered.promise;
    const writerPid = await waitForBlockedBy(held.pid);
    const closing = settle(close(decision(w.f.actor.userId)));
    await waitForBlockedBy(writerPid);
    await held.release();
    await expect(writing).resolves.toMatchObject({
      ok: true,
      value: { status: 201, body: { status: "queued" } },
    });
    await expect(closing).resolves.toMatchObject({ ok: true });
  });

  it("lets closure win between the no-write attempt and actual queued persistence", async () => {
    const w = await writerFixture("queued-create");
    const before = await counts(w.f);
    useSecretKmsProbe((request, call) => {
      if (call !== 2) {
        return undefined;
      }
      return (async () => {
        await close(decision(w.f.actor.userId));
        return {
          keyId: request.keyId,
          plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
          encryptedDataKey: Buffer.from(`encrypted-data-key:${request.keyId}`),
        };
      })();
    });
    await expect(w.invoke()).resolves.toMatchObject({ status: 409 });
    await expect(counts(w.f)).resolves.toStrictEqual(before);
  });

  it.each(["pending-create", "claim"] as const)(
    "rejects stale %s after agent ownership transfers under the business lock",
    async (kind) => {
      const w = await writerFixture(kind);
      const survivor = bdd.user({ orgId: w.f.orgId });
      const before = await counts(w.f);
      const held = await holdResource(w.f.agentId, survivor.userId);
      const writing = settle(w.invoke());
      await waitForBlockedBy(held.pid);
      await held.release();
      await expect(writing).resolves.toMatchObject({
        ok: true,
        value: { status: kind === "claim" ? 404 : 409 },
      });
      await expect(counts(w.f)).resolves.toStrictEqual(before);
      if (w.runId) {
        await expect(
          db
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(eq(agentRuns.id, w.runId)),
        ).resolves.toStrictEqual([{ status: "pending" }]);
      }
    },
  );

  it("resolves a changed run owner in a fresh transaction without releasing prepared credentials", async () => {
    const w = await writerFixture("claim");
    if (!w.runId) {
      throw new Error("Missing synthetic run");
    }
    const runId = w.runId;
    const held = await holdBusinessRow(
      (tx) => {
        return tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .for("update");
      },
      (tx) => {
        return tx
          .update(agentRuns)
          .set({ userId: `synthetic-transfer-${randomUUID()}` })
          .where(eq(agentRuns.id, runId));
      },
    );
    const writing = settle(w.invoke());
    await waitForBlockedBy(held.pid);
    await held.release();
    await expect(writing).resolves.toMatchObject({
      ok: true,
      value: { status: 404 },
    });
    await expect(
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([{ status: "pending" }]);
  });

  it("preserves subject domains and does not require the optional users registry", async () => {
    const f = await fixture();
    await db.delete(users).where(eq(users.id, f.actor.userId));
    await close(decision(f.orgId, "user"));
    await expect(create(f)).resolves.toMatchObject({ status: 201 });
    const before = await counts(f);
    await close(decision(f.orgId, "organization"));
    await expect(create(f)).resolves.toMatchObject({ status: 409 });
    await expect(counts(f)).resolves.toStrictEqual(before);
  });

  it.each(["valid", "closed", "expired", "wrong-owner"] as const)(
    "validates the actual private maintenance lease: %s",
    async (state) => {
      const m = await maintenance();
      if (state === "closed") {
        await close(decision(m.userId));
      }
      if (state === "expired") {
        await db
          .update(piMemoryPhase2Jobs)
          .set({ leaseExpiresAt: new Date("2020-01-01") })
          .where(eq(piMemoryPhase2Jobs.memoryStorageId, m.memoryStorageId));
      }
      if (state === "wrong-owner") {
        await db
          .update(agentRuns)
          .set({ userId: `synthetic-owner-${randomUUID()}` })
          .where(eq(agentRuns.id, m.runId));
      }
      const claimed = await api.requestClaimRunnerJob(
        true,
        m.runId,
        [200, 404],
      );
      expect(claimed.status).toBe(state === "valid" ? 200 : 404);
      const [run] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, m.runId));
      expect(run?.status).toBe(
        state === "valid"
          ? "running"
          : state === "closed"
            ? "cancelled"
            : "pending",
      );
      if (state === "valid") {
        await close(decision(m.userId));
        const [admitted] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, m.runId));
        expect(admitted).toStrictEqual(run);
      }
    },
  );

  it.each(writerKinds)(
    "closure first fences %s without partial content or ordinary completion",
    async (kind) => {
      const w = await writerFixture(kind);
      const before = await counts(w.f);
      const held = await holdClosure(decision(w.f.actor.userId));
      const writing = settle(w.invoke());
      await waitForBlockedBy(held.pid);
      await expect(counts(w.f)).resolves.toStrictEqual(before);
      await held.release();
      const result = await writing;
      expect(result.ok).toBeTruthy();
      if (result.ok) {
        if (kind === "promotion") {
          expect(result.value).toBeNull();
        } else {
          expect(result.value).toMatchObject({
            status: kind.endsWith("create") ? 409 : 404,
          });
        }
      }
      await flushWaitUntilForTest();
      await expect(counts(w.f)).resolves.toStrictEqual(before);
      if (w.runId) {
        const [run] = await db
          .select()
          .from(agentRuns)
          .where(eq(agentRuns.id, w.runId));
        expect(run).toMatchObject({
          status: "cancelled",
          error: COMPUTE_CLOSURE_ERROR,
          failureReason: null,
        });
        const callbacks = await db
          .select()
          .from(agentRunCallbacks)
          .where(eq(agentRunCallbacks.runId, w.runId));
        expect(
          callbacks.every((callback) => {
            return callback.attempts === 0 && callback.status === "pending";
          }),
        ).toBeTruthy();
      }
    },
  );

  it.each(
    writerKinds.filter((kind) => {
      return kind !== "queued-create";
    }),
  )("writer first commits %s before closure can project", async (kind) => {
    const w = await writerFixture(kind);
    const held = await holdResource(w.f.agentId);
    const writing = settle(w.invoke());
    const writerPid = await waitForBlockedBy(held.pid);
    const closing = settle(close(decision(w.f.actor.userId)));
    await waitForBlockedBy(writerPid);
    await held.release();
    const [written, closed] = await Promise.all([writing, closing]);
    expect(closed.ok).toBeTruthy();
    expect(written.ok).toBeTruthy();
    if (written.ok) {
      if (kind === "promotion") {
        expect(written.value).toMatchObject({ kind: "activation" });
      } else {
        expect(written.value).toMatchObject({
          status: kind.endsWith("create") ? 201 : kind === "claim" ? 200 : 400,
        });
      }
    }
  });

  it("continues past a closed owner's shared agent while preserving a surviving organization", async () => {
    const w = await writerFixture("promotion");
    const survivor = bdd.user({ orgId: w.f.orgId });
    const agent = await bdd.createAgent(survivor, {
      displayName: "Surviving owner",
      visibility: "public",
    });
    const live = await api.createRun(survivor, {
      agentId: agent.agentId,
      prompt: "Surviving resource",
      modelProvider: "anthropic-api-key",
    });
    await close(decision(w.f.actor.userId));
    const deniedShared = await api.requestCreateRun(
      survivor,
      {
        agentId: w.f.agentId,
        prompt: "Shared closed resource",
        modelProvider: "anthropic-api-key",
      },
      [409],
    );
    expect(deniedShared.status).toBe(409);
    const promoted = await createStore().set(
      promoteNextQueuedRun$,
      { orgId: w.f.orgId },
      context.signal,
    );
    expect(promoted).toBeNull();
    const polled = await api.requestPollRunner(
      true,
      { group: w.f.runnerGroup, supportedProfiles: ["vm0/default"] },
      [200],
    );
    expect(polled).toMatchObject({
      status: 200,
      body: { job: { runId: live.runId } },
    });
    await expect(api.claimRunnerJob(live.runId)).resolves.toMatchObject({
      runId: live.runId,
      prompt: "Surviving resource",
    });
    if (!w.runId) {
      throw new Error("Missing queued synthetic run");
    }
    const [retained] = await db
      .select()
      .from(agentRunQueue)
      .where(eq(agentRunQueue.runId, w.runId));
    expect(retained?.encryptedParams).toBeTruthy();
    await db
      .update(agentRunQueue)
      .set({ expiresAt: new Date("2020-01-01") })
      .where(eq(agentRunQueue.runId, w.runId));
    await createStore().set(
      cleanupExpiredQueueEntries$,
      [w.runId],
      context.signal,
    );
    await expect(
      db.select().from(agentRunQueue).where(eq(agentRunQueue.runId, w.runId)),
    ).resolves.toHaveLength(1);
  });
});
