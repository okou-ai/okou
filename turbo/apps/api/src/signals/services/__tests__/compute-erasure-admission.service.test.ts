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
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { createStore } from "ccstate";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import { env, mockOptionalEnv } from "../../../lib/env";
import { nowDate, mockNow, clearMockNow } from "../../../lib/time";
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
import {
  createDeferredPromise,
  settle,
  settleIncludingAbort,
} from "../../utils";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  promoteNextQueuedRun$,
  cleanupExpiredQueueEntries$,
} from "../run-queue.service";
import { COMPUTE_CLOSURE_ERROR } from "../agent-run-terminal-transition.service";

import { generateSandboxToken } from "../../auth/tokens";
import { createChatFilesBddApi } from "../../routes/__tests__/helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "../../routes/__tests__/helpers/api-bdd-webhooks";
import { insertAssistantEvents } from "../chat-event-shared.service";
import { readRunContentOwnership } from "../run-content-erasure-admission.service";
import {
  handleChatInternalCallback$,
  handleChatInternalCallbackWithoutCcstate,
} from "../internal-chat-run-callback.service";
import { receiveAgentEvents$ } from "../agent-webhook-events.service";
import type { AgentEvent } from "../../../lib/event-consumer/verify";

// B2b1 explicitly requires the real dormant projector and actual writers, plus
// locks/absence of partial records. No public deletion ingress exists. Only
// unique synthetic infrastructure faults are seeded below; admission, creation,
// promotion, claim, billing metadata and PostgreSQL are never mocked.
describe("actual compute transactions versus the B1 projector", () => {
  const context = testContext();
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const chat = createChatFilesBddApi(context);
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

  it("keeps inconsistent queue/run ownership as an error without admitting work", async () => {
    const w = await writerFixture("promotion");
    if (!w.runId) {
      throw new Error("Missing synthetic queue");
    }
    await db
      .update(agentRunQueue)
      .set({ userId: `synthetic-queue-owner-${randomUUID()}` })
      .where(eq(agentRunQueue.runId, w.runId));
    await expect(settle(w.invoke())).resolves.toMatchObject({ ok: false });
    await expect(
      db
        .select({
          status: agentRuns.status,
          creditAdmitted: agentRuns.creditAdmitted,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, w.runId)),
    ).resolves.toStrictEqual([{ status: "queued", creditAdmitted: false }]);
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

  // B2b2-O extends the same dormant-projector/real-PostgreSQL exception.
  // No public API can project closure, expose lock waits, or inspect private
  // citations/ack fields. Setup still creates runs through the actual API.
  describe("late run content admission", () => {
    async function outputFixture() {
      const f = await fixture();
      const sent = await chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          prompt: "Synthetic output admission",
          clientEventId: randomUUID(),
          model: "claude-sonnet-5",
        },
        [201],
      );
      if (sent.status !== 201 || !sent.body.runId) {
        throw new Error("Expected the real chat API to create a run");
      }
      const run = { runId: sent.body.runId };
      const ownership = await readRunContentOwnership(db, run.runId);
      if (!ownership.thread) {
        throw new Error("Expected the real creation API to bind a thread");
      }
      await flushWaitUntilForTest();
      return {
        ...f,
        runId: run.runId,
        sessionId: ownership.sessionId,
        threadId: ownership.thread.chatThreadId,
        userId: ownership.thread.userId,
        ownership,
      };
    }
    type OutputFixture = Awaited<ReturnType<typeof outputFixture>>;

    function events(sequence = 1): AgentEvent[] {
      return [
        {
          type: "assistant",
          sequenceNumber: sequence,
          message: { content: [{ type: "text", text: `answer ${sequence}` }] },
        },
        {
          type: "item.completed",
          sequenceNumber: sequence + 1,
          item: {
            type: "reasoning",
            id: `thinking-${sequence}`,
            text: "synthetic thinking",
          },
        },
        {
          type: "result",
          sequenceNumber: sequence + 2,
          result: `result ${sequence}`,
        },
      ];
    }
    const citation = {
      entries: [
        {
          path: "MEMORY.md",
          lineStart: 1,
          lineEnd: 2,
          note: "Synthetic source",
        },
      ],
      rolloutIds: ["0199e517-0000-7000-8000-000000000001"],
    };
    function outputBody(f: Pick<OutputFixture, "runId">, sequence = 1) {
      return {
        runId: f.runId,
        events: events(sequence),
        piMemoryCitationTransport: {
          schemaVersion: 1 as const,
          citations: [{ sequenceNumber: sequence, citation }],
        },
      };
    }
    function outputHeaders(
      f: Pick<OutputFixture, "actor" | "runId" | "orgId">,
    ) {
      return {
        authorization: `Bearer ${generateSandboxToken(f.actor.userId, f.runId, f.orgId)}`,
      };
    }
    function sendOutput(f: OutputFixture, sequence = 1) {
      return webhooks.requestAgentEvents(
        outputBody(f, sequence),
        outputHeaders(f),
        [200],
      );
    }
    function assistantInput(f: OutputFixture, sequence = 1) {
      return {
        runId: f.runId,
        threadId: f.threadId,
        userId: f.userId,
        orgId: f.orgId,
        ownership: f.ownership,
        items: [
          {
            eventType: "output.message" as const,
            runEventSequenceNumber: sequence,
            runEventId: `callback:${sequence}`,
            content: `history ${sequence}`,
          },
        ],
      };
    }
    function insertHistory(f: OutputFixture, sequence = 1) {
      return insertAssistantEvents(
        db,
        assistantInput(f, sequence),
        context.signal,
      );
    }
    async function contentState(f: Pick<OutputFixture, "runId" | "threadId">) {
      const content = await db
        .select()
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.runId, f.runId),
            inArray(chatEvents.eventType, [
              "output.message",
              "output.thinking",
            ]),
          ),
        )
        .orderBy(asc(chatEvents.seqId));
      const materialization = await db
        .select()
        .from(runOutputMaterializations)
        .where(eq(runOutputMaterializations.runId, f.runId));
      const citations = await db
        .select()
        .from(runOutputMemoryCitations)
        .where(eq(runOutputMemoryCitations.runId, f.runId))
        .orderBy(asc(runOutputMemoryCitations.sequenceNumber));
      const [run] = await db
        .select({
          ack: agentRuns.firstAssistantEventAcknowledgedAt,
          creditAdmitted: agentRuns.creditAdmitted,
          modelProvider: agentRuns.modelProvider,
          modelProviderId: agentRuns.modelProviderId,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, f.runId));
      const [thread] = await db
        .select({ sequence: chatThreads.lastChatEventSeqId })
        .from(chatThreads)
        .where(eq(chatThreads.id, f.threadId));
      return { content, materialization, citations, run, thread };
    }

    describe.each(["webhook", "callback"] as const)(
      "%s transaction",
      (kind) => {
        it("closure first blocks the actual transaction with no partial content", async () => {
          const f = await outputFixture();
          const before = await contentState(f);
          const closure = await holdClosure(decision(f.actor.userId));
          const writing =
            kind === "webhook"
              ? settle(sendOutput(f))
              : settle(insertHistory(f));
          await waitForBlockedBy(closure.pid);
          await expect(contentState(f)).resolves.toStrictEqual(before);
          await closure.release();
          expect((await writing).ok).toBeTruthy();
          await flushWaitUntilForTest();
          await expect(contentState(f)).resolves.toStrictEqual(before);
        });

        it("writer first commits before B1 closure", async () => {
          const f = await outputFixture();
          const resource = await holdResource(f.agentId);
          const writing =
            kind === "webhook"
              ? settle(sendOutput(f))
              : settle(insertHistory(f));
          const writerPid = await waitForBlockedBy(resource.pid);
          const closing = close(decision(f.actor.userId));
          await waitForBlockedBy(writerPid);
          await resource.release();
          expect((await writing).ok).toBeTruthy();
          await closing;
          await flushWaitUntilForTest();
          const after = await contentState(f);
          expect(after.content).toHaveLength(kind === "webhook" ? 2 : 1);
          expect(after.thread?.sequence).toBeGreaterThan(0);
          if (kind === "webhook") {
            expect(after.materialization).toMatchObject([
              { latestResultText: "result 1" },
            ]);
            expect(after.citations).toMatchObject([{ citation }]);
            expect(after.run?.ack).toBeInstanceOf(Date);
          }
          const beforeRetry = await contentState(f);
          await (kind === "webhook" ? sendOutput(f, 8) : insertHistory(f, 8));
          await flushWaitUntilForTest();
          await expect(contentState(f)).resolves.toStrictEqual(beforeRetry);
        });
      },
    );

    it("reacquires closure admission for fallback after a committed history transaction", async () => {
      const f = await outputFixture();
      await insertHistory(f);
      await flushWaitUntilForTest();
      const before = await contentState(f);
      await close(decision(f.actor.userId));
      await expect(insertHistory(f, 20)).resolves.toBe(0);
      await expect(insertHistory(f, 20)).resolves.toBe(0);
      await expect(contentState(f)).resolves.toStrictEqual(before);
    });

    it("closure in the publication gap blocks the separate acknowledgement transaction", async () => {
      const f = await outputFixture();
      const resource = await holdResource(f.agentId);
      const writing = settle(insertHistory(f));
      const writerPid = await waitForBlockedBy(resource.pid);
      const closing = holdClosure(decision(f.actor.userId));
      await waitForBlockedBy(writerPid);
      await resource.release();
      const closure = await closing;
      expect((await writing).ok).toBeTruthy();
      await waitForBlockedBy(closure.pid);
      const before = await contentState(f);
      expect(before.content).toHaveLength(1);
      expect(before.run?.ack).toBeNull();
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        `chatThreadMessageCreated:${f.threadId}`,
        null,
      );
      await closure.release();
      await flushWaitUntilForTest();
      await expect(contentState(f)).resolves.toStrictEqual(before);
    });

    it.each(["running", "completed", "cancelled"] as const)(
      "retains open %s output and rejects only real closure on retries",
      async (status) => {
        const f = await outputFixture();
        await db
          .update(agentRuns)
          .set({ status })
          .where(eq(agentRuns.id, f.runId));
        await sendOutput(f);
        await flushWaitUntilForTest();
        expect((await contentState(f)).content).toHaveLength(2);
        await close(decision(f.actor.userId));
        const before = await contentState(f);
        await Promise.all([
          sendOutput(f, 7),
          insertHistory(f, 20),
          sendOutput(f, 7),
        ]);
        await flushWaitUntilForTest();
        await expect(contentState(f)).resolves.toStrictEqual(before);
      },
    );

    it("preserves concurrent retries, event IDs and monotone result sequences", async () => {
      const f = await outputFixture();
      await Promise.all([
        sendOutput(f, 20),
        sendOutput(f, 20),
        sendOutput(f, 1),
      ]);
      await flushWaitUntilForTest();
      const after = await contentState(f);
      expect(after.content).toHaveLength(4);
      expect(
        new Set(
          after.content.map((row) => {
            return row.id;
          }),
        ).size,
      ).toBe(4);
      expect(
        new Set(
          after.content.map((row) => {
            return row.seqId;
          }),
        ).size,
      ).toBe(4);
      expect(after.materialization).toMatchObject([
        { latestResultSequence: 22, latestResultText: "result 20" },
      ]);
      expect(after.citations).toHaveLength(2);
    });

    it("denied required projection returns no accepted batch or optional consumer effects", async () => {
      const f = await outputFixture();
      await updateFeatureSwitchesForUser(
        context,
        { userId: f.actor.userId, orgId: f.orgId },
        {
          [FeatureSwitchKey.ThreadActivitySummary]: true,
        },
      );
      onTestFinished(() => {
        return deleteFeatureSwitchesForUser(context, {
          userId: f.actor.userId,
          orgId: f.orgId,
        });
      });
      await close(decision(f.actor.userId));
      context.mocks.ably.publish.mockClear();
      const body = outputBody(f);
      const result = await createStore().set(
        receiveAgentEvents$,
        {
          auth: { userId: f.actor.userId, orgId: f.orgId, runId: f.runId },
          body,
        },
        context.signal,
      );
      expect(result).not.toHaveProperty("acceptedEvents");
      await sendOutput(f);
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish).not.toHaveBeenCalled();
      await expect(
        db
          .select()
          .from(runActivitySnapshots)
          .where(eq(runActivitySnapshots.runId, f.runId)),
      ).resolves.toHaveLength(0);
    });

    it("preserves infrastructure lock failures and rejects mismatched sandbox identity", async () => {
      const f = await outputFixture();
      const before = await contentState(f);
      const held = await holdResource(f.agentId);
      await webhooks.requestAgentEvents(outputBody(f), outputHeaders(f), [503]);
      await held.release();
      await expect(contentState(f)).resolves.toStrictEqual(before);
      await webhooks.requestAgentEvents(
        outputBody(f),
        {
          authorization: `Bearer ${generateSandboxToken(`synthetic-other-${randomUUID()}`, f.runId, f.orgId)}`,
        },
        [503],
      );
      await expect(contentState(f)).resolves.toStrictEqual(before);
    });

    it("preserves timeout and missing-run delivery dispositions", async () => {
      const f = await outputFixture();
      await db
        .update(agentRuns)
        .set({ status: "timeout" })
        .where(eq(agentRuns.id, f.runId));
      const before = await contentState(f);
      await sendOutput(f);
      await expect(contentState(f)).resolves.toStrictEqual(before);
      const missing = { ...f, runId: randomUUID() };
      await sendOutput(missing);
    });

    it.each([
      "thread-owner",
      "thread-agent",
      "agent-owner",
      "session-owner",
      "run-owner",
      "thread-deletion",
    ] as const)(
      "rolls back a %s race and never attributes prepared content to the new identity",
      async (kind) => {
        const f = await outputFixture();
        const before = await contentState(f);
        const next = `synthetic-transfer-${randomUUID()}`;
        const peer = kind === "thread-agent" ? await fixture() : undefined;
        const held =
          kind === "agent-owner" || kind === "thread-agent"
            ? await holdBusinessRow(
                (tx) => {
                  return tx
                    .select({ id: agents.id })
                    .from(agents)
                    .where(eq(agents.id, f.agentId))
                    .for("update");
                },
                async (tx) => {
                  if (kind === "agent-owner") {
                    await tx
                      .update(agents)
                      .set({ owner: next })
                      .where(eq(agents.id, f.agentId));
                  } else if (peer) {
                    await tx
                      .update(chatThreads)
                      .set({ agentId: peer.agentId })
                      .where(eq(chatThreads.id, f.threadId));
                  }
                },
              )
            : await holdBusinessRow(
                (tx) => {
                  return tx
                    .select({ id: chatThreads.id })
                    .from(chatThreads)
                    .where(eq(chatThreads.id, f.threadId))
                    .for("update");
                },
                async (tx) => {
                  if (kind === "thread-owner") {
                    await tx
                      .update(chatThreads)
                      .set({ userId: next })
                      .where(eq(chatThreads.id, f.threadId));
                  }
                  if (kind === "session-owner") {
                    await tx
                      .update(agentSessions)
                      .set({ userId: next })
                      .where(eq(agentSessions.id, f.sessionId));
                  }
                  if (kind === "run-owner") {
                    await tx
                      .update(agentRuns)
                      .set({ userId: next })
                      .where(eq(agentRuns.id, f.runId));
                  }
                  if (kind === "thread-deletion") {
                    await tx
                      .delete(chatThreads)
                      .where(eq(chatThreads.id, f.threadId));
                  }
                },
              );
        const writing = webhooks.requestAgentEvents(
          outputBody(f),
          outputHeaders(f),
          [503],
        );
        await waitForBlockedBy(held.pid);
        await held.release();
        await writing;
        const after = await contentState(f);
        expect(after.content).toStrictEqual(before.content);
        expect(after.materialization).toStrictEqual(before.materialization);
        expect(after.citations).toStrictEqual(before.citations);
        expect(after.run).toStrictEqual(before.run);
        if (kind !== "thread-deletion") {
          expect(after.thread).toStrictEqual(before.thread);
        }
      },
    );

    it("fences thread, session and resource subjects without closing a surviving member", async () => {
      const f = await outputFixture();
      const peer = bdd.user({ orgId: f.orgId });
      const privateRun = await api.createRun(peer, {
        agentId: f.agentId,
        prompt: "Other member private output",
        modelProvider: "anthropic-api-key",
      });
      const ownAgent = await bdd.createAgent(peer, {
        displayName: "Surviving owned resource",
        visibility: "public",
      });
      const survivor = await api.createRun(peer, {
        agentId: ownAgent.agentId,
        prompt: "Surviving owned output",
        modelProvider: "anthropic-api-key",
      });
      await close(decision(f.actor.userId));
      await sendOutput(f);
      for (const [run, countExpected] of [
        [privateRun, 0],
        [survivor, 1],
      ] as const) {
        await webhooks.requestAgentEvents(
          {
            runId: run.runId,
            events: [
              { type: "result", sequenceNumber: 1, result: "other owner" },
            ],
          },
          {
            authorization: `Bearer ${generateSandboxToken(peer.userId, run.runId, f.orgId)}`,
          },
          [200],
        );
        await expect(
          db
            .select()
            .from(runOutputMaterializations)
            .where(eq(runOutputMaterializations.runId, run.runId)),
        ).resolves.toHaveLength(countExpected);
      }
    });

    it.each(["thread", "session", "resource-organization"] as const)(
      "includes the independently owned %s subject",
      async (kind) => {
        const f = await outputFixture();
        const subjectId = `synthetic-distinct-${randomUUID()}`;
        if (kind === "thread") {
          await db
            .update(chatThreads)
            .set({ userId: subjectId })
            .where(eq(chatThreads.id, f.threadId));
        }
        if (kind === "session") {
          await db
            .update(agentSessions)
            .set({ userId: subjectId })
            .where(eq(agentSessions.id, f.sessionId));
        }
        if (kind === "resource-organization") {
          await db
            .update(agents)
            .set({ orgId: subjectId })
            .where(eq(agents.id, f.agentId));
        }
        await close(
          decision(
            subjectId,
            kind === "resource-organization" ? "organization" : "user",
          ),
        );
        const before = await contentState(f);
        await sendOutput(f);
        await expect(contentState(f)).resolves.toStrictEqual(before);
      },
    );

    it("uses distinct subject domains and allows a missing optional users row", async () => {
      const f = await outputFixture();
      await db.delete(users).where(eq(users.id, f.actor.userId));
      await close(decision(f.orgId, "user"));
      await sendOutput(f);
      await flushWaitUntilForTest();
      await close(decision(f.orgId, "organization"));
      const before = await contentState(f);
      await sendOutput(f, 9);
      await expect(contentState(f)).resolves.toStrictEqual(before);
    });

    it("accepts terminal private threadless maintenance after lease/job retirement and then fences closure", async () => {
      const m = await maintenance();
      await db
        .update(agentRuns)
        .set({ status: "completed" })
        .where(eq(agentRuns.id, m.runId));
      await db
        .update(piMemoryPhase2Jobs)
        .set({ maintenanceRunId: null, leaseExpiresAt: new Date("2020-01-01") })
        .where(eq(piMemoryPhase2Jobs.memoryStorageId, m.memoryStorageId));
      const body = outputBody(m);
      const headers = {
        authorization: `Bearer ${generateSandboxToken(m.userId, m.runId, m.orgId)}`,
      };
      await webhooks.requestAgentEvents(body, headers, [200]);
      const before = await contentState({
        runId: m.runId,
        threadId: randomUUID(),
      });
      expect(before.content).toHaveLength(0);
      expect(before.materialization).toHaveLength(1);
      expect(before.citations).toHaveLength(1);
      await close(decision(m.userId));
      await webhooks.requestAgentEvents(outputBody(m, 20), headers, [200]);
      await expect(
        contentState({ runId: m.runId, threadId: randomUUID() }),
      ).resolves.toStrictEqual(before);
    });

    it.each(["ccstate", "plain"] as const)(
      "fences the actual %s callback result fallback and its retries",
      async (mode) => {
        const f = await outputFixture();
        await webhooks.requestAgentEvents(
          {
            runId: f.runId,
            events: [
              {
                type: "result",
                sequenceNumber: 4,
                result: "callback result fallback",
              },
            ],
          },
          outputHeaders(f),
          [200],
        );
        await flushWaitUntilForTest();
        await db
          .update(agentRuns)
          .set({
            status: "completed",
            completedAt: nowDate(),
            lastEventSequence: 4,
          })
          .where(eq(agentRuns.id, f.runId));
        const callback = {
          runId: f.runId,
          status: "completed" as const,
          payload: { threadId: f.threadId, agentId: f.agentId },
        };
        const closure = await holdClosure(decision(f.actor.userId));
        const before = await contentState(f);
        const invoke = async () => {
          if (mode === "ccstate") {
            await createStore().set(
              handleChatInternalCallback$,
              { callback },
              context.signal,
            );
          } else {
            await handleChatInternalCallbackWithoutCcstate(
              db,
              callback,
              context.signal,
            );
          }
          await flushWaitUntilForTest();
        };
        const writing = settle(invoke());
        await waitForBlockedBy(closure.pid);
        await closure.release();
        expect((await writing).ok).toBeTruthy();
        await invoke();
        const after = await contentState(f);
        expect(after.content).toStrictEqual(before.content);
        expect(after.citations).toStrictEqual(before.citations);
        expect(after.materialization).toStrictEqual(before.materialization);
        expect(after.run).toStrictEqual(before.run);
        // Other callback lifecycle/summary transactions remain B2b2-R, so their
        // sequence reservations are intentionally outside this projection test.
      },
    );

    it.each([
      "assistant",
      "thinking",
      "result",
      "citation",
      "threadless",
    ] as const)(
      "denies a first %s batch without content or sequence reservations",
      async (kind) => {
        const f = await outputFixture();
        if (kind === "threadless") {
          await db
            .update(agentRuns)
            .set({ chatThreadId: null })
            .where(eq(agentRuns.id, f.runId));
        }
        await close(decision(f.actor.userId));
        const before = await contentState(f);
        const all = events();
        const selected =
          kind === "assistant"
            ? [all[0]!]
            : kind === "thinking"
              ? [all[1]!]
              : [all[2]!];
        await webhooks.requestAgentEvents(
          {
            runId: f.runId,
            events: selected,
            piMemoryCitationTransport: {
              schemaVersion: 1,
              citations: [
                { sequenceNumber: selected[0]!.sequenceNumber, citation },
              ],
            },
          },
          outputHeaders(f),
          [200],
        );
        await flushWaitUntilForTest();
        await expect(contentState(f)).resolves.toStrictEqual(before);
      },
    );

    it("rolls back an aborted standalone insertion instead of returning closure denial", async () => {
      const f = await outputFixture();
      const before = await contentState(f);
      const controller = new AbortController();
      const held = await holdResource(f.agentId);
      const writing = settleIncludingAbort(
        insertAssistantEvents(db, assistantInput(f), controller.signal),
      );
      await waitForBlockedBy(held.pid);
      controller.abort();
      await held.release();
      await expect(writing).resolves.toMatchObject({
        ok: false,
        error: { name: "AbortError" },
      });
      await expect(contentState(f)).resolves.toStrictEqual(before);
    });

    it("timestamps standalone acknowledgement after publication registration", async () => {
      const f = await outputFixture();
      const before = nowDate().getTime();
      const publishedAt = before + 1234;
      mockNow(before);
      onTestFinished(clearMockNow);
      context.mocks.ably.publish.mockImplementation((topic: unknown) => {
        if (topic === `chatThreadMessageCreated:${f.threadId}`) {
          mockNow(publishedAt);
        }
        return Promise.resolve();
      });
      await insertHistory(f);
      await flushWaitUntilForTest();
      expect((await contentState(f)).run?.ack).toStrictEqual(
        new Date(publishedAt),
      );
    });

    it("measures finite same-subject and independent-subject output pairs", async () => {
      const f = await outputFixture();
      const peer = await outputFixture();
      const samples: { shared: boolean; elapsedMs: number }[] = [];
      for (const shared of [true, false, true, false]) {
        const start = performance.now();
        await Promise.all([
          sendOutput(f, 100 + samples.length * 10),
          sendOutput(shared ? f : peer, 105 + samples.length * 10),
        ]);
        samples.push({ shared, elapsedMs: performance.now() - start });
      }
      // Finite local observations, with no CI latency or production-throughput claim.
      process.stdout.write(`B2B2_OUTPUT_PAIR_MS ${JSON.stringify(samples)}\n`);
      expect(samples).toHaveLength(4);
    });
  });
});
