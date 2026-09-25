import { chatEventSequences } from "@okouai/db/schema/chat-event-sequence";
import { createHash, randomUUID } from "node:crypto";
import { server } from "../../../mocks/server";
import {
  assertErasureSubjectWritable,
  projectErasureDecision,
  lockErasureSubjects,
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
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { users } from "@okouai/db/schema/user";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { runActivitySnapshots } from "@okouai/db/schema/run-activity-snapshot";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import { HttpResponse, http } from "msw";
import { testCronCleanupSandboxesStateContract } from "@okouai/api-contracts/contracts/test-cron-cleanup-sandboxes-state";
import { createStore } from "ccstate";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { testCronCleanupSandboxesStateRoutes } from "../../routes/test-cron-cleanup-sandboxes-state";
import { chatThreadActivitySummaryRoutes } from "../../routes/chat-threads-activity-summary";
import {
  withActivityCommitBarrierFixture,
  advanceRunActivityClockFixture,
} from "../../../test-fixtures/run-activity";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate, mockNow, clearMockNow } from "../../../lib/time";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import { configureNativeCliArtifact } from "../../routes/__tests__/helpers/chat-events-fixture";
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
import { createAuthOrgAgentsBddApi } from "../../routes/__tests__/helpers/api-bdd-auth-org";
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
import { admitNewComputeRun } from "../compute-erasure-admission.service";

import { generateSandboxToken } from "../../auth/tokens";
import { createChatFilesBddApi } from "../../routes/__tests__/helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "../../routes/__tests__/helpers/api-bdd-webhooks";
import { createRouteMocks } from "../../routes/__tests__/helpers/route-test";
import { insertAssistantEvents } from "../chat-event-shared.service";
import {
  readRunContentOwnership,
  withRunContentWrite,
  RunOutputDiagnostics,
} from "../run-content-erasure-admission.service";
import { isLockNotAvailable, safeSqlStateCode } from "../../../lib/pg-errors";
import {
  handleChatInternalCallback$,
  handleChatInternalCallbackWithoutCcstate,
} from "../internal-chat-run-callback.service";
import {
  receiveAgentEvents$,
  dispatchOptionalAgentEventConsumers$,
} from "../agent-webhook-events.service";
import type { AgentEvent } from "../../../lib/event-consumer/verify";

// B2b1 explicitly requires the real dormant projector and actual writers, plus
// locks/absence of partial records. No public deletion ingress exists. Only
// unique synthetic infrastructure faults are seeded below; admission, creation,
// promotion, claim, billing metadata and PostgreSQL are never mocked.
describe("actual compute transactions versus the B1 projector", () => {
  const context = testContext({ connectorCatalog: true });
  const api = createRunsApi(context);
  const bdd = createBddApi(context);
  const agentsApi = createAuthOrgAgentsBddApi(context);
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

  async function fixture(orgId?: string) {
    const actor = bdd.user(orgId === undefined ? {} : { orgId });
    if (!actor.orgId) {
      throw new Error("Synthetic fixture requires an organization");
    }
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const runnerGroup = api.configureRunnerGroup();
    // Pin two admitted runs so the queue shapes below stay independent of the
    // Pro plan's own concurrency limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    await api.grantProEntitlement(actor);
    const { providerId } = await api.ensureOrgModelProvider(actor);
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);
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
    const releaseOnce = () => {
      if (!release.settled()) {
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
    await seedBuiltInModelKey(context, "deepseek-v4.1-flash");
    // V4.1 Flash dispatch requires the commit-addressed CLI reader artifact.
    configureNativeCliArtifact();
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
    "existing-session-create",
    "failed-existing-session-create",
    "promotion",
    "claim",
    "invalid-context",
    "history-load",
  ] as const;
  type WriterKind = (typeof writerKinds)[number];

  async function writerFixture(kind: WriterKind): Promise<{
    readonly f: Fixture;
    readonly runId: string | undefined;
    readonly sessionId?: string;
    readonly invoke: () => Promise<unknown>;
  }> {
    const f = await fixture();
    if (kind === "failed-create" || kind === "failed-existing-session-create") {
      const agentName = `synthetic-${randomUUID().slice(0, 8)}`;
      const agent = await api.createDirectAgent(f.actor, {
        version: "1",
        agents: {
          [agentName]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "synthetic-key" },
            experimental_runner: {
              group:
                kind === "failed-existing-session-create"
                  ? f.runnerGroup
                  : "other/synthetic",
            },
          },
        },
      });
      f.agentId = agent.agentId;
      const initial =
        kind === "failed-existing-session-create"
          ? await api.createDirectRun(f.actor, {
              agentId: f.agentId,
              prompt: "Synthetic initial session",
            })
          : undefined;
      if (initial) {
        // A failed first preparation has no canonical session Storage mounts.
        // Create a usable session, then make its continuation fail preparation.
        await api.createDirectAgent(f.actor, {
          version: "1",
          agents: {
            [agentName]: {
              framework: "claude-code",
              environment: { ANTHROPIC_API_KEY: "synthetic-key" },
              experimental_runner: { group: "other/synthetic" },
            },
          },
        });
      }
      return {
        f,
        runId: undefined,
        sessionId: initial?.sessionId,
        invoke: () => {
          return api.requestDirectRun(
            f.actor,
            {
              agentId: f.agentId,
              sessionId: initial?.sessionId,
              prompt: "Synthetic failed preparation",
            },
            [201, 409],
          );
        },
      };
    }
    if (kind === "existing-session-create") {
      const initial = await pending(f);
      return {
        f,
        runId: undefined,
        sessionId: initial.sessionId,
        invoke: () => {
          return api.requestCreateRun(
            f.actor,
            {
              agentId: f.agentId,
              sessionId: initial.sessionId,
              prompt: "Synthetic session continuation",
              modelProvider: "anthropic-api-key",
            },
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

  it.each([
    "pending-create",
    "existing-session-create",
    "failed-existing-session-create",
    "claim",
  ] as const)(
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

  it.each([
    "existing-session-create",
    "failed-existing-session-create",
  ] as const)(
    "rejects %s when the session organization changes before its locked reread",
    async (kind) => {
      const w = await writerFixture(kind);
      const sessionId = w.sessionId;
      if (!sessionId) {
        throw new Error("Missing synthetic existing session");
      }
      const before = await counts(w.f);
      // Ownership transfer during admission has no production test control.
      const held = await holdBusinessRow(
        (tx) => {
          return tx
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(eq(agentSessions.id, sessionId))
            .for("update");
        },
        (tx) => {
          return tx
            .update(agentSessions)
            .set({ orgId: `synthetic-session-org-${randomUUID()}` })
            .where(eq(agentSessions.id, sessionId));
        },
      );
      const writing = settle(w.invoke());
      await waitForBlockedBy(held.pid);
      await held.release();
      await expect(writing).resolves.toMatchObject({
        ok: true,
        value: { status: 409 },
      });
      await expect(counts(w.f)).resolves.toStrictEqual(before);
    },
  );

  it.each([
    { resource: false, session: true, unbound: false },
    { resource: true, session: false, unbound: false },
    { resource: false, session: false, unbound: false },
    { resource: true, session: true, unbound: true },
  ])(
    "locks surviving admission subjects before rejecting $resource/$session/$unbound observations",
    async ({ resource, session, unbound }) => {
      const resourceFixture = await fixture();
      const sessionFixture = await fixture();
      const initial = await pending(sessionFixture);
      if (unbound) {
        await db
          .update(agentSessions)
          .set({ agentId: null })
          .where(eq(agentSessions.id, initial.sessionId));
      }
      const caller = bdd.user();
      if (!caller.orgId) {
        throw new Error("Synthetic caller requires an organization");
      }
      const callerOrgId = caller.orgId;
      const expectedOwner = `synthetic-expected-owner-${randomUUID()}`;
      const closedSubject = session
        ? sessionFixture.actor.userId
        : resource
          ? resourceFixture.actor.userId
          : expectedOwner;
      const held = await holdClosure(decision(closedSubject));
      // Production prechecks reject missing/mismatched IDs before persistence;
      // no endpoint can pause between preparation and this first observation.
      // Exercise that infrastructure race directly with real DB locks. Distinct
      // expected/actual owners prove surviving rows still contribute subjects.
      const writing = settle(
        db.transaction((tx) => {
          return admitNewComputeRun(tx, {
            userId: caller.userId,
            orgId: callerOrgId,
            agentId: resource ? resourceFixture.agentId : randomUUID(),
            ownerUserId: expectedOwner,
            agentOrgId: resourceFixture.orgId,
            existingSessionId: session ? initial.sessionId : randomUUID(),
          });
        }),
      );
      await waitForBlockedBy(held.pid);
      await held.release();
      await expect(writing).resolves.toStrictEqual({ ok: true, value: false });
    },
  );

  it("fences an existing session when its distinct shared Agent owner closes", async () => {
    const f = await fixture();
    const member = bdd.user({ orgId: f.orgId });
    const initial = await api.createRun(member, {
      agentId: f.agentId,
      prompt: "Synthetic shared session",
      modelProvider: "anthropic-api-key",
    });
    await api.requestCancelRun(member, initial.runId, [200]);
    const continued = await api.createRun(member, {
      agentId: f.agentId,
      sessionId: initial.sessionId,
      prompt: "Synthetic writable shared continuation",
      modelProvider: "anthropic-api-key",
    });
    expect(continued).toMatchObject({
      status: "pending",
      sessionId: initial.sessionId,
    });
    const before = await counts({ ...f, actor: member });
    const held = await holdClosure(decision(f.actor.userId));
    const writing = settle(
      api.requestCreateRun(
        member,
        {
          agentId: f.agentId,
          sessionId: initial.sessionId,
          prompt: "Synthetic shared continuation",
          modelProvider: "anthropic-api-key",
        },
        [409],
      ),
    );
    await waitForBlockedBy(held.pid);
    await held.release();
    await expect(writing).resolves.toMatchObject({
      ok: true,
      value: { status: 409 },
    });
    await expect(counts({ ...f, actor: member })).resolves.toStrictEqual(
      before,
    );
  });

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

  it("rechecks a changed session owner against closure before claiming", async () => {
    const w = await writerFixture("claim");
    if (!w.runId) {
      throw new Error("Missing synthetic run");
    }
    const runId = w.runId;
    const [run] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    if (!run) {
      throw new Error("Missing synthetic session");
    }
    const nextOwner = `synthetic-session-owner-${randomUUID()}`;
    await close(decision(nextOwner));
    const held = await holdBusinessRow(
      (tx) => {
        return tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(eq(agentSessions.id, run.sessionId))
          .for("update");
      },
      (tx) => {
        return tx
          .update(agentSessions)
          .set({ userId: nextOwner })
          .where(eq(agentSessions.id, run.sessionId));
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
        .select({ status: agentRuns.status, error: agentRuns.error })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([
      { status: "cancelled", error: COMPUTE_CLOSURE_ERROR },
    ]);
  });

  it("does not claim a resource deleted after its initial ownership read", async () => {
    const w = await writerFixture("claim");
    const held = await holdBusinessRow(
      (tx) => {
        return tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, w.f.agentId))
          .for("update");
      },
      (tx) => {
        return tx.delete(agents).where(eq(agents.id, w.f.agentId));
      },
    );
    const writing = settle(w.invoke());
    await waitForBlockedBy(held.pid);
    await held.release();
    await expect(writing).resolves.toMatchObject({
      ok: true,
      value: { status: 404 },
    });
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
        if (kind === "failed-existing-session-create") {
          expect(written.value).toMatchObject({
            body: { status: "failed", sessionId: w.sessionId },
          });
        } else if (kind === "existing-session-create") {
          expect(written.value).toMatchObject({
            body: { status: "pending", sessionId: w.sessionId },
          });
        }
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
    async function outputFixture(orgId?: string) {
      return await outputForFixture(await fixture(orgId));
    }

    async function outputForFixture(f: Fixture) {
      const sent = await chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          prompt: "Synthetic output admission",
          clientEventId: randomUUID(),
          model: "claude-fable-5-1",
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

    describe("Agent mutation isolation", () => {
      it.each(["updateAgent", "updateAgentMetadata"] as const)(
        "completes a run while a sibling %s waits on its own resource",
        async (operation) => {
          const first = await outputFixture();
          const second = await outputFixture(first.orgId);
          // The old organization scan locks rows in UUID order. Choose the
          // lower resource for the run, so its lock precedes the blocked row.
          const [running, sibling] =
            first.agentId < second.agentId ? [first, second] : [second, first];
          mockOptionalEnv("OPENROUTER_API_KEY", undefined);
          const claimed = await api.claimRunnerJob(running.runId);
          await sendOutput(running);
          await flushWaitUntilForTest();

          // Infrastructure-only exception: production APIs cannot retain a
          // row lock. The mutation, completion and observations use real APIs.
          const held = await holdResource(sibling.agentId);
          const updating = settle(
            bdd[operation](sibling.actor, sibling.agentId, {
              displayName: "Updated sibling",
            }),
          );
          onTestFinished(async () => {
            await settle(held.release());
            await updating;
          });
          await waitForBlockedBy(held.pid);

          const completed = await webhooks.requestAgentComplete(
            {
              runId: running.runId,
              exitCode: 0,
              lastEventSequence: 3,
              checkpoint: {
                cliAgentType: "claude-code",
                cliAgentSessionId: `synthetic-${running.runId}`,
                cliAgentSessionHistoryHash: createHash("sha256")
                  .update(`bdd session history ${running.runId}`)
                  .digest("hex"),
              },
            },
            { authorization: `Bearer ${claimed.sandboxToken}` },
            [200],
          );
          await flushWaitUntilForTest();
          const result = await chat.listThreadEvents(
            running.actor,
            running.threadId,
          );
          await held.release();
          const updated = await updating;
          expect(completed.body).toMatchObject({ status: "completed" });
          expect(
            result.events.filter((event) => {
              return (
                event.runId === running.runId &&
                event.eventType === "run.completed"
              );
            }),
          ).toHaveLength(1);
          expect(updated).toMatchObject({
            ok: true,
            value: { displayName: "Updated sibling" },
          });
        },
      );

      it("creates an Agent while an unrelated resource row is held", async () => {
        const f = await fixture();
        const held = await holdResource(f.agentId);
        let finished = false;
        const creating = (async () => {
          const result = await settle(
            bdd.createAgent(f.actor, { displayName: "Independent Agent" }),
          );
          finished = true;
          return result;
        })();
        onTestFinished(async () => {
          await settle(held.release());
          await creating;
        });
        // Observe either the response or this fixture's exact lock waiter;
        // this makes the old broad scan fail without a guessed delay.
        await expect
          .poll(async () => {
            const waiters = await executeRawRows(
              db,
              sql`SELECT pid FROM pg_stat_activity WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`,
              z.object({ pid: z.number() }),
            );
            return finished || waiters.length > 0;
          })
          .toBe(true);
        const completedWhileHeld = finished;
        await held.release();
        const created = await creating;
        expect(completedWhileHeld).toBeTruthy();
        expect(created).toMatchObject({
          ok: true,
          value: { displayName: "Independent Agent", visibility: "public" },
        });
      });

      it.each(["requestUpdateAgent", "requestUpdateAgentMetadata"] as const)(
        "preserves the public quota across concurrent creation and %s",
        async (operation) => {
          const f = await fixture();
          const existingPublic = (await bdd.listAgents(f.actor)).filter(
            (agent) => {
              return agent.visibility === "public";
            },
          ).length;
          for (let index = existingPublic; index < 6; index++) {
            await bdd.createAgent(f.actor, { displayName: `Public ${index}` });
          }
          const privateAgent = await bdd.createAgent(f.actor, {
            displayName: "Private contender",
            visibility: "private",
          });
          // Retain the exact quota key shared with previously deployed API
          // writers, then release both real requests from this explicit gate.
          const held = await holdBusinessRow(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtextextended('canonical-agent-public-limit:' || ${f.orgId}::text, 0))`,
            );
          });
          const requests = Promise.all([
            settle(
              bdd.requestCreateAgent(
                f.actor,
                { displayName: "New public", visibility: "public" },
                [201, 409],
              ),
            ),
            settle(
              agentsApi[operation](
                f.actor,
                privateAgent.agentId,
                { visibility: "public" },
                [200, 409],
              ),
            ),
          ]);
          onTestFinished(async () => {
            await settle(held.release());
            await requests;
          });
          await expect
            .poll(async () => {
              const waiters = await executeRawRows(
                db,
                sql`SELECT pid FROM pg_stat_activity WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`,
                z.object({ pid: z.number() }),
              );
              return waiters.length;
            })
            .toBe(2);
          await held.release();
          const results = await requests;
          const responses = results.map((result) => {
            if (!result.ok) {
              throw result.error;
            }
            return result.value;
          });
          expect(
            responses.map((response) => {
              return response.status;
            }),
          ).toContain(409);
          expect(
            responses.filter((response) => {
              return response.status !== 409;
            }),
          ).toHaveLength(1);
          const listed = await bdd.listAgents(f.actor);
          expect(
            listed.filter((agent) => {
              return agent.visibility === "public";
            }),
          ).toHaveLength(7);
        },
      );
    });

    it("completes an independent chat run while another member retains normal admission", async () => {
      const holder = await outputFixture();
      const f = await outputFixture(holder.orgId);
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      const claimed = await api.claimRunnerJob(f.runId);
      await sendOutput(f);
      await flushWaitUntilForTest();
      // Infrastructure-only exception: no public API can pause a transaction
      // after admission. All run setup, completion and assertions use real APIs.
      const held = await holdBusinessRow(async (tx) => {
        await assertErasureSubjectWritable(tx, [
          { subjectKind: "user", subjectId: holder.userId },
          { subjectKind: "organization", subjectId: holder.orgId },
        ]);
      });
      const completed = await webhooks.requestAgentComplete(
        {
          runId: f.runId,
          exitCode: 0,
          lastEventSequence: 3,
          checkpoint: {
            cliAgentType: "claude-code",
            cliAgentSessionId: `synthetic-${f.runId}`,
            cliAgentSessionHistoryHash: createHash("sha256")
              .update(`bdd session history ${f.runId}`)
              .digest("hex"),
          },
        },
        { authorization: `Bearer ${claimed.sandboxToken}` },
        [200],
      );
      expect(completed.body).toMatchObject({ status: "completed" });
      await flushWaitUntilForTest();
      const result = await chat.listThreadEvents(f.actor, f.threadId);
      expect(
        result.events.filter((event) => {
          return event.runId === f.runId && event.eventType === "run.completed";
        }),
      ).toHaveLength(1);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          runId: f.runId,
          eventType: "output.message",
          content: "answer 1",
        }),
      );
      await held.release();
    });

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
        .select({
          sequence: sql`COALESCE(${chatEventSequences.lastSeqId}, 0)`.mapWith(
            chatEventSequences.lastSeqId,
          ),
        })
        .from(chatThreads)
        .leftJoin(
          chatEventSequences,
          eq(chatEventSequences.chatThreadId, chatThreads.id),
        )
        .where(eq(chatThreads.id, f.threadId));
      return { content, materialization, citations, run, thread };
    }

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

    // B2b2-P uses the existing infrastructure exception: production APIs cannot
    // hold PostgreSQL locks, project dormant B1 decisions or expose a rejection
    // before HTTP classification. The receipt below is the handler's actual
    // invocation-owned capture; no logger or Axiom calls are observed.
    describe("required-output failure provenance", () => {
      function expectReceipt(
        diagnostics: RunOutputDiagnostics,
        error: unknown,
        phase: string,
      ) {
        const receipt = diagnostics.takeFailure(error);
        expect(receipt?.outputPhase).toBe(phase);
        for (const elapsed of [
          receipt?.outputPhaseElapsedMs,
          receipt?.outputAttemptElapsedMs,
        ]) {
          expect(Number.isInteger(elapsed)).toBeTruthy();
          expect(elapsed).toBeGreaterThanOrEqual(0);
          expect(elapsed).toBeLessThanOrEqual(60_000);
        }
        expect(receipt?.outputAttemptElapsedMs).toBeGreaterThanOrEqual(
          receipt!.outputPhaseElapsedMs!,
        );
        expect(diagnostics.takeFailure(error)).toBeUndefined();
      }

      // The split output transaction waits only on its run row and the event
      // FK; erasure subjects, resources, sessions and projections are not
      // locked around the append.
      describe.each(["thread_lock", "run_lock"] as const)(
        "real %s output timeout",
        (phase) => {
          async function prepareBlockedOutput() {
            const f = await outputFixture();
            await sendOutput(f);
            await flushWaitUntilForTest();
            const before = await contentState(f);
            const held = await holdBusinessRow((tx) => {
              switch (phase) {
                case "thread_lock": {
                  return tx
                    .select()
                    .from(chatThreads)
                    .where(eq(chatThreads.id, f.threadId))
                    .for("update");
                }
                case "run_lock": {
                  return tx
                    .select()
                    .from(agentRuns)
                    .where(eq(agentRuns.id, f.runId))
                    .for("update");
                }
              }
            });
            return { f, before, held };
          }

          it(`retries a real ${phase} HTTP timeout after rollback and keeps replay idempotent`, async () => {
            const { f, before, held } = await prepareBlockedOutput();
            await webhooks.requestAgentEvents(
              outputBody(f, 10),
              outputHeaders(f),
              [503],
            );
            await expect(contentState(f)).resolves.toStrictEqual(before);
            await held.release();
            await sendOutput(f, 10);
            await flushWaitUntilForTest();
            const accepted = await contentState(f);
            expect(accepted.content).toHaveLength(4);
            expect(accepted.materialization).toMatchObject([
              { latestResultText: "result 10" },
            ]);
            await sendOutput(f, 10);
            await flushWaitUntilForTest();
            // Existing insertion reserves sequence numbers before deduplication.
            // Replays keep the same durable output, while sequence gaps are legal.
            await expect(contentState(f)).resolves.toMatchObject({
              content: accepted.content,
              citations: accepted.citations,
              run: accepted.run,
              materialization: [{ latestResultText: "result 10" }],
            });
          });
        },
      );

      it.each([false, true])(
        "resets an actual ownership retry before its next outcome (timeout: %s)",
        async (timeout) => {
          const f = await outputFixture();
          const resourceOwner = `synthetic-resource-${randomUUID()}`;
          await db
            .update(agents)
            .set({ owner: resourceOwner })
            .where(eq(agents.id, f.agentId));
          const ownership = await readRunContentOwnership(db, f.runId);
          await db
            .update(agents)
            .set({ owner: `synthetic-transient-${randomUUID()}` })
            .where(eq(agents.id, f.agentId));
          const held = await holdResource(f.agentId, resourceOwner);
          const subject = timeout
            ? await holdBusinessRow((tx) => {
                return lockErasureSubjects(tx, [
                  { subjectKind: "user", subjectId: resourceOwner },
                ]);
              })
            : undefined;
          const diagnostics = new RunOutputDiagnostics();
          const writing = settle(
            withRunContentWrite(
              db,
              { runId: f.runId, ownership, diagnostics },
              async (tx) => {
                await tx.insert(runOutputMaterializations).values({
                  runId: f.runId,
                  latestResultText: "retry accepted",
                });
              },
              context.signal,
            ),
          );
          await waitForBlockedBy(held.pid);
          await held.release();
          if (subject) {
            await waitForBlockedBy(subject.pid);
          }
          const result = await writing;
          if (timeout) {
            if (result.ok) {
              throw new Error("Expected second-attempt subject timeout");
            }
            expect(isLockNotAvailable(result.error)).toBeTruthy();
            expectReceipt(diagnostics, result.error, "subject_admission");
            expect((await contentState(f)).materialization).toHaveLength(0);
          } else {
            expect(result).toMatchObject({
              ok: true,
              value: { outcome: "written" },
            });
            expect((await contentState(f)).materialization).toMatchObject([
              { latestResultText: "retry accepted" },
            ]);
            expect(diagnostics.takeFailure(undefined)).toBeUndefined();
          }
          await subject?.release();
        },
      );
    });

    it("rejects mismatched sandbox identity", async () => {
      const f = await outputFixture();
      const before = await contentState(f);
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

    // Agent rows are not locked around the append: a transfer committed after
    // the output transaction is a later ownership change, not a race.
    it.each([
      "thread-owner",
      "session-owner",
      "run-owner",
      "thread-deletion",
    ] as const)(
      "rolls back a %s race and never attributes prepared content to the new identity",
      async (kind) => {
        const f = await outputFixture();
        const before = await contentState(f);
        const next = `synthetic-transfer-${randomUUID()}`;
        const held = await holdBusinessRow(
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

    // B2b2-R1: the real route/optional consumer versus dormant B1. Only PG
    // transaction delivery, held rows, closure and ownership transfers require
    // infrastructure control; every account/agent/thread/run is API-created.
    describe("activity copy admission", () => {
      async function activityFixture(orgId?: string) {
        mockOptionalEnv("OPENROUTER_API_KEY", undefined);
        const f = await outputFixture(orgId);
        return f;
      }

      function snapshot(f: OutputFixture) {
        return db
          .select()
          .from(runActivitySnapshots)
          .where(eq(runActivitySnapshots.runId, f.runId));
      }

      function summarize(f: OutputFixture) {
        createRouteMocks(context).clerk.session(f.userId, f.orgId);
        return setupApp({ context, routes: chatThreadActivitySummaryRoutes })(
          chatThreadActivitySummaryContract,
        ).summarize({
          headers: { authorization: "Bearer clerk-session" },
          params: { id: f.threadId },
          body: { runId: f.runId },
        });
      }

      function activityProvider(
        reply: () => string | Response | Promise<string | Response> = () => {
          return "Checking launch materials";
        },
      ) {
        mockOptionalEnv("OPENROUTER_API_KEY", "synthetic-activity-key");
        const requests: unknown[] = [];
        server.use(
          http.post(
            "https://openrouter.ai/api/v1/chat/completions",
            async ({ request }) => {
              const body = z
                .object({
                  messages: z.array(
                    z.object({ role: z.string(), content: z.string() }),
                  ),
                })
                .parse(await request.json());
              if (
                !body.messages[0]?.content.startsWith(
                  "Write three short, distinct, user-visible progress messages",
                )
              ) {
                return HttpResponse.json({
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: "Opening copy" },
                    },
                  ],
                });
              }
              requests.push(body);
              const result = await reply();
              return typeof result === "string"
                ? HttpResponse.json({
                    choices: [
                      { finish_reason: "stop", message: { content: result } },
                    ],
                  })
                : result;
            },
          ),
        );
        return requests;
      }

      async function acceptedActivity(f: OutputFixture, sequence = 30) {
        const store = createStore();
        const result = await store.set(
          receiveAgentEvents$,
          {
            auth: { userId: f.userId, orgId: f.orgId, runId: f.runId },
            body: {
              runId: f.runId,
              events: [
                {
                  type: "assistant",
                  sequenceNumber: sequence,
                  message: {
                    content: [
                      { type: "text", text: `Required answer ${sequence}` },
                      {
                        type: "tool_use",
                        id: `tool-${sequence}`,
                        name: "bash",
                        input: { command: `inspect launch ${sequence}` },
                      },
                    ],
                  },
                },
              ],
            },
          },
          context.signal,
        );
        expect(result.response.status).toBe(200);
        if (!("acceptedEvents" in result) || !result.acceptedEvents) {
          throw new Error("Expected admitted required output");
        }
        const accepted = result.acceptedEvents;
        return {
          accepted,
          dispatch: (signal = context.signal) => {
            return store.set(
              dispatchOptionalAgentEventConsumers$,
              accepted,
              signal,
            );
          },
        };
      }

      async function capture(f: OutputFixture, sequence = 30) {
        await (await acceptedActivity(f, sequence)).dispatch();
      }

      function ineligible(f: OutputFixture) {
        return {
          status: 200,
          body: { runId: f.runId, status: "ineligible", messages: [] },
        };
      }

      function unavailable(f: OutputFixture) {
        return {
          status: 200,
          body: { runId: f.runId, status: "unavailable", messages: [] },
        };
      }

      it.each(["capture", "claim", "completion", "cooldown"] as const)(
        "%s commits before closure can project and retains activity deadlines",
        async (stage) => {
          const f = await activityFixture();
          const accepted =
            stage === "capture" ? await acceptedActivity(f) : undefined;
          const requests = activityProvider(() => {
            return stage === "cooldown" ? "" : "Checking launch materials";
          });
          await withActivityCommitBarrierFixture(
            {
              runId: f.runId,
              stage: stage === "cooldown" ? "completion" : stage,
              work: async (barrier) => {
                const writing = accepted
                  ? settle(accepted.dispatch())
                  : settle(summarize(f));
                const settings = await barrier.entered;
                expect(settings).toMatchObject({
                  lockTimeout: "250ms",
                  statementTimeout: "3s",
                });
                const closing = close(decision(f.userId));
                await waitForBlockedBy(settings.pid);
                if (stage === "claim") {
                  expect(requests).toHaveLength(0);
                }
                barrier.release();
                const [written] = await Promise.all([writing, closing]);
                expect(written.ok).toBeTruthy();
                const rows = await snapshot(f);
                expect(rows).toHaveLength(1);
                if (stage === "capture") {
                  expect(rows[0]?.entries).toHaveLength(2);
                } else if (stage === "claim") {
                  expect(rows[0]?.claimId).not.toBeNull();
                  expect(rows[0]?.summary).toBeNull();
                } else if (stage === "cooldown") {
                  expect(rows[0]?.claimId).toBeNull();
                  expect(rows[0]?.summary).toBeNull();
                  expect(rows[0]?.nextAttemptAt).toBeInstanceOf(Date);
                } else {
                  expect(rows[0]?.summary).toBe("Checking launch materials");
                }
                if (stage === "completion" || stage === "cooldown") {
                  expect(written).toMatchObject({
                    ok: true,
                    value: {
                      status: 200,
                      body: {
                        status: "available",
                        messages:
                          stage === "completion"
                            ? [{ text: "Checking launch materials" }]
                            : [],
                      },
                    },
                  });
                } else if (stage !== "capture") {
                  expect(written).toMatchObject({
                    ok: true,
                    value: ineligible(f),
                  });
                }
              },
            },
            context.signal,
          );
        },
      );

      it.each(["capture", "claim"] as const)(
        "closure first blocks %s without any snapshot or provider request",
        async (stage) => {
          const f = await activityFixture();
          const accepted =
            stage === "capture" ? await acceptedActivity(f) : undefined;
          const required = await contentState(f);
          const requests = activityProvider();
          const closure = await holdClosure(decision(f.userId));
          const writing = accepted
            ? settle(accepted.dispatch())
            : settle(summarize(f));
          await waitForBlockedBy(closure.pid);
          await closure.release();
          const result = await writing;
          expect(result.ok).toBeTruthy();
          if (stage === "claim") {
            if (!result.ok) {
              throw result.error;
            }
            if (!result.value || result.value.status !== 200) {
              throw new Error("Expected an activity summary response");
            }
            expect(result.value.body).toMatchObject({
              runId: f.runId,
              messages: [],
            });
            // The optional claim can exhaust its 250 ms lock deadline before
            // closure commits. Either empty response is safe for that request;
            // a fresh request must observe the committed closure.
            expect(["ineligible", "unavailable"]).toContain(
              result.value.body.status,
            );
            await expect(summarize(f)).resolves.toMatchObject(ineligible(f));
          }
          await expect(snapshot(f)).resolves.toHaveLength(0);
          await expect(contentState(f)).resolves.toStrictEqual(required);
          expect(requests).toHaveLength(0);
        },
      );

      it.each(["success", "unusable", "failure", "deadline"] as const)(
        "rejects %s completion and final resurrection after closure commits during an admitted provider request",
        async (outcome) => {
          const f = await activityFixture();
          const entered = createDeferredPromise<void>(context.signal);
          const release = createDeferredPromise<void>(context.signal);
          const deadline = new AbortController();
          onTestFinished(() => {
            deadline.abort();
          });
          context.mocks.abortSignal.timeout.mockImplementation(
            (milliseconds) => {
              return milliseconds === 10_000 ? deadline.signal : undefined;
            },
          );
          const requests = activityProvider(async () => {
            entered.resolve();
            await release.promise;
            return outcome === "failure"
              ? HttpResponse.json(
                  { error: { message: "Synthetic upstream failure" } },
                  { status: 503 },
                )
              : outcome === "unusable"
                ? ""
                : "Late private phrase";
          });
          const pending = settle(summarize(f));
          await entered.promise;
          // Keep the provider pending until closure commits. Polling for a DB
          // waiter here races the activity writer's 250 ms lock deadline.
          await close(decision(f.userId));
          // Physical collector deletion has no exposed API while B1 is dormant.
          await db
            .delete(runActivitySnapshots)
            .where(eq(runActivitySnapshots.runId, f.runId));
          if (outcome === "deadline") {
            deadline.abort(
              new DOMException("Synthetic deadline", "TimeoutError"),
            );
          }
          release.resolve();
          await expect(pending).resolves.toMatchObject({
            ok: true,
            value: ineligible(f),
          });
          await expect(snapshot(f)).resolves.toHaveLength(0);
          expect(requests).toHaveLength(1);
        },
      );

      it.each(["current-run", "terminal", "cleanup"] as const)(
        "%s first prevents stale completion and response state",
        async (change) => {
          const f = await activityFixture();
          const entered = createDeferredPromise<void>(context.signal);
          const release = createDeferredPromise<string>(context.signal);
          activityProvider(async () => {
            entered.resolve();
            return await release.promise;
          });
          const pending = summarize(f);
          await entered.promise;
          const before = await snapshot(f);
          if (change === "current-run") {
            await db
              .update(chatThreads)
              .set({ agentSessionRunId: null })
              .where(eq(chatThreads.id, f.threadId));
          } else if (change === "terminal") {
            await db
              .update(agentRuns)
              .set({ status: "completed", completedAt: nowDate() })
              .where(eq(agentRuns.id, f.runId));
          } else {
            // Production cleanup owns the same row-level delete. No user API can
            // remove one collector while a provider request is in flight.
            await db
              .delete(runActivitySnapshots)
              .where(eq(runActivitySnapshots.runId, f.runId));
          }
          release.resolve("Stale provider phrase");
          await expect(pending).resolves.toMatchObject(
            change === "cleanup" ? unavailable(f) : ineligible(f),
          );
          await expect(snapshot(f)).resolves.toStrictEqual(
            change === "cleanup" ? [] : before,
          );
        },
      );

      it.each([
        "close",
        "transfer",
        "current-run",
        "terminal",
        "cleanup",
      ] as const)(
        "returns committed completion state before %s can proceed",
        async (change) => {
          const f = await activityFixture();
          activityProvider();
          await withActivityCommitBarrierFixture(
            {
              runId: f.runId,
              stage: "completion",
              work: async (barrier) => {
                let responded = false;
                const observed = summarize(f).then(
                  (value) => {
                    responded = true;
                    return value;
                  },
                  (error: unknown) => {
                    responded = true;
                    throw error;
                  },
                );
                const settings = await barrier.entered;
                const competing = (async () => {
                  if (change === "close") {
                    await close(decision(f.userId));
                  } else if (change === "transfer") {
                    await db
                      .update(agents)
                      .set({ owner: `survivor-${randomUUID()}` })
                      .where(eq(agents.id, f.agentId));
                  } else if (change === "current-run") {
                    await db
                      .update(chatThreads)
                      .set({ agentSessionRunId: null })
                      .where(eq(chatThreads.id, f.threadId));
                  } else if (change === "terminal") {
                    await db
                      .update(agentRuns)
                      .set({ status: "completed", completedAt: nowDate() })
                      .where(eq(agentRuns.id, f.runId));
                  } else {
                    await db
                      .delete(runActivitySnapshots)
                      .where(eq(runActivitySnapshots.runId, f.runId));
                  }
                })();
                await waitForBlockedBy(settings.pid);
                expect(responded).toBeFalsy();
                barrier.release();
                const [result] = await Promise.all([observed, competing]);
                expect(result).toMatchObject({
                  status: 200,
                  body: {
                    status: "available",
                    messages: [{ text: "Checking launch materials" }],
                  },
                });
                await expect(snapshot(f)).resolves.toMatchObject(
                  change === "cleanup"
                    ? []
                    : [{ summary: "Checking launch materials" }],
                );
              },
            },
            context.signal,
          );
        },
      );

      const transfers = [
        "run",
        "session",
        "thread",
        "resource",
        "organization",
      ] as const;
      async function transfer(
        f: OutputFixture,
        target: (typeof transfers)[number],
      ) {
        const survivor = `survivor-${randomUUID()}`;
        if (target === "run") {
          await db
            .update(agentRuns)
            .set({ userId: survivor })
            .where(eq(agentRuns.id, f.runId));
        } else if (target === "session") {
          await db
            .update(agentSessions)
            .set({ userId: survivor })
            .where(eq(agentSessions.id, f.sessionId));
        } else if (target === "thread") {
          await db
            .update(chatThreads)
            .set({ userId: survivor })
            .where(eq(chatThreads.id, f.threadId));
        } else if (target === "resource") {
          await db
            .update(agents)
            .set({ owner: survivor })
            .where(eq(agents.id, f.agentId));
        } else {
          await db
            .update(agents)
            .set({ orgId: survivor })
            .where(eq(agents.id, f.agentId));
        }
      }

      it.each(transfers)(
        "does not repin accepted optional activity after %s transfer",
        async (target) => {
          const f = await activityFixture();
          await capture(f);
          const before = await snapshot(f);
          const accepted = await acceptedActivity(f, 40);
          const required = await contentState(f);
          expect(Object.isFrozen(accepted.accepted.ownership)).toBeTruthy();
          expect(
            Object.isFrozen(accepted.accepted.ownership.resources),
          ).toBeTruthy();
          await transfer(f, target);
          await accepted.dispatch();
          await expect(snapshot(f)).resolves.toStrictEqual(before);
          await expect(contentState(f)).resolves.toStrictEqual(required);
        },
      );

      it.each(transfers)(
        "does not repin provider content after %s transfer",
        async (target) => {
          const f = await activityFixture();
          const entered = createDeferredPromise<void>(context.signal);
          const release = createDeferredPromise<string>(context.signal);
          activityProvider(async () => {
            entered.resolve();
            return await release.promise;
          });
          const pending = summarize(f);
          await entered.promise;
          const before = await snapshot(f);
          await transfer(f, target);
          release.resolve("Do not attach to another owner");
          await expect(pending).resolves.toMatchObject(ineligible(f));
          await expect(snapshot(f)).resolves.toStrictEqual(before);
        },
      );

      it.each([
        "user",
        "organization",
        "session-user",
        "session-org",
        "resource-user",
        "resource-org",
      ] as const)(
        "fences the complete %s subject in capture and claim while preserving an independent survivor",
        async (subject) => {
          const f = await activityFixture();
          const independent = await activityFixture();
          let foreignId = `distinct-${randomUUID()}`;
          if (subject === "session-user" || subject === "session-org") {
            await db
              .update(agentSessions)
              .set(
                subject === "session-user"
                  ? { userId: foreignId }
                  : { orgId: foreignId },
              )
              .where(eq(agentSessions.id, f.sessionId));
          } else if (subject === "resource-org") {
            const resource = await fixture();
            foreignId = resource.orgId;
            await db
              .update(agentSessions)
              .set({ agentId: resource.agentId })
              .where(eq(agentSessions.id, f.sessionId));
          } else if (subject === "resource-user") {
            await db
              .update(agents)
              .set({ owner: foreignId })
              .where(eq(agents.id, f.agentId));
          }
          const accepted = await acceptedActivity(f);
          await close(
            decision(
              subject === "user"
                ? f.userId
                : subject === "organization"
                  ? f.orgId
                  : foreignId,
              subject === "organization" || subject.endsWith("-org")
                ? "organization"
                : "user",
            ),
          );
          await accepted.dispatch();
          const requests = activityProvider();
          await expect(summarize(f)).resolves.toMatchObject(ineligible(f));
          await expect(snapshot(f)).resolves.toHaveLength(0);
          expect(requests).toHaveLength(0);
          await expect(summarize(independent)).resolves.toMatchObject({
            status: 200,
            body: { status: "available" },
          });
          expect(requests).toHaveLength(1);
        },
      );

      it("keeps cooldown and expiry unchanged when closure wins after claim", async () => {
        const f = await activityFixture();
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<string>(context.signal);
        activityProvider(async () => {
          entered.resolve();
          return await release.promise;
        });
        const pending = summarize(f);
        await entered.promise;
        const before = await snapshot(f);
        await close(decision(f.userId));
        release.resolve("");
        await expect(pending).resolves.toMatchObject(ineligible(f));
        await expect(snapshot(f)).resolves.toStrictEqual(before);
      });

      it.each(["organization", "session", "resource"] as const)(
        "rejects late %s closure without returning the previous stored phrase",
        async (owner) => {
          const f = await activityFixture();
          const subjectId =
            owner === "organization" ? f.orgId : `distinct-${randomUUID()}`;
          // Distinct persisted ownership is a dormant-B1 infrastructure case.
          if (owner === "session") {
            await db
              .update(agentSessions)
              .set({ userId: subjectId })
              .where(eq(agentSessions.id, f.sessionId));
          } else if (owner === "resource") {
            await db
              .update(agents)
              .set({ owner: subjectId })
              .where(eq(agents.id, f.agentId));
          }
          activityProvider();
          await accept(summarize(f), [200]);
          await capture(f);
          await advanceRunActivityClockFixture(f.runId, 16_000);
          const entered = createDeferredPromise<void>(context.signal);
          const release = createDeferredPromise<string>(context.signal);
          activityProvider(async () => {
            entered.resolve();
            return await release.promise;
          });
          const pending = summarize(f);
          await entered.promise;
          const before = await snapshot(f);
          expect(before[0]?.summary).toBe("Checking launch materials");
          await close(
            decision(
              subjectId,
              owner === "organization" ? "organization" : "user",
            ),
          );
          release.resolve("Late provider phrase");
          await expect(pending).resolves.toMatchObject(ineligible(f));
          await expect(snapshot(f)).resolves.toStrictEqual(before);
        },
      );

      it("absorbs a missing run in the accepted optional gap", async () => {
        const f = await activityFixture();
        const accepted = await acceptedActivity(f);
        await db.delete(agentRuns).where(eq(agentRuns.id, f.runId));
        await expect(accepted.dispatch()).resolves.toBeUndefined();
        await expect(snapshot(f)).resolves.toHaveLength(0);
      });

      it("propagates the original optional abort instead of converting it to ineligibility", async () => {
        const f = await activityFixture();
        const accepted = await acceptedActivity(f);
        const controller = new AbortController();
        const error = new Error("Synthetic owned cancellation");
        controller.abort(error);
        await expect(accepted.dispatch(controller.signal)).rejects.toBe(error);
        await expect(snapshot(f)).resolves.toHaveLength(0);
      });

      it("retains silent capture contention, degrades the summary claim and preserves the row", async () => {
        const f = await activityFixture();
        await capture(f);
        const before = await snapshot(f);
        const accepted = await acceptedActivity(f, 40);
        const held = await holdBusinessRow((tx) => {
          return tx
            .select()
            .from(runActivitySnapshots)
            .where(eq(runActivitySnapshots.runId, f.runId))
            .for("update");
        });
        await expect(accepted.dispatch()).resolves.toBeUndefined();
        await expect(snapshot(f)).resolves.toStrictEqual(before);
        await expect(summarize(f)).resolves.toMatchObject({
          status: 200,
          body: { runId: f.runId, status: "unavailable", messages: [] },
        });
        // The API intentionally hides SQLSTATE. At the real PG infrastructure
        // boundary verify the original error, rather than inspecting a log.
        const failure = await settle(
          withRunContentWrite(
            db,
            {
              runId: f.runId,
              ownership: f.ownership,
              deadlineProfile: "activity",
            },
            async (tx) => {
              return await tx
                .select()
                .from(runActivitySnapshots)
                .where(eq(runActivitySnapshots.runId, f.runId))
                .for("update");
            },
            context.signal,
          ),
        );
        expect(failure.ok).toBeFalsy();
        if (!failure.ok) {
          expect(safeSqlStateCode(failure.error)).toBe("55P03");
        }
        await held.release();
        await expect(snapshot(f)).resolves.toStrictEqual(before);
      });

      it("cleans closed snapshots and skips a held expired row without blocking another owner", async () => {
        const f = await activityFixture();
        const other = await activityFixture();
        await capture(f);
        await capture(other);
        await advanceRunActivityClockFixture(f.runId, 25 * 60 * 60 * 1000);
        await advanceRunActivityClockFixture(other.runId, 25 * 60 * 60 * 1000);
        await close(decision(f.userId));
        await close(decision(other.userId));
        const held = await holdBusinessRow((tx) => {
          return tx
            .select()
            .from(runActivitySnapshots)
            .where(eq(runActivitySnapshots.runId, f.runId))
            .for("update");
        });
        const cleanup = () => {
          return setupApp({
            context,
            routes: testCronCleanupSandboxesStateRoutes,
          })(testCronCleanupSandboxesStateContract).cleanup({
            body: {
              runIds: [f.runId, other.runId],
              chatThreadIds: [],
              orgIds: [],
              exportJobIds: [],
            },
          });
        };
        await accept(cleanup(), [200]);
        await expect(snapshot(f)).resolves.toHaveLength(1);
        await expect(snapshot(other)).resolves.toHaveLength(0);
        await held.release();
        await accept(cleanup(), [200]);
        await expect(snapshot(f)).resolves.toHaveLength(0);
      });
    });

    describe("terminal callback content admission", () => {
      type TerminalKind = "completed" | "failed" | "cancelled";

      async function terminalFixture(kind: TerminalKind, orgId?: string) {
        const f = await outputFixture(orgId);
        mockOptionalEnv("OPENROUTER_API_KEY", undefined);
        // The dormant B1 projector and a pause between terminal settlement and
        // callback projection have no public test control. Creation is real.
        await db
          .update(agentRuns)
          .set({
            status: kind,
            completedAt: nowDate(),
            error: kind === "cancelled" ? "Run cancelled" : null,
          })
          .where(eq(agentRuns.id, f.runId));
        return f;
      }

      function deliveries(f: OutputFixture) {
        return {
          slackDelivery: {
            channelId: "synthetic-channel",
            threadTs: "123.456",
          },
          feishuDelivery: {
            installationId: randomUUID(),
            connectionId: randomUUID(),
            chatId: "synthetic-chat",
            messageId: "synthetic-message",
            threadId: "synthetic-thread",
            replyInThread: true,
          },
          teamsDelivery: {
            tenantId: "synthetic-tenant",
            tenantName: null,
            teamId: null,
            teamName: null,
            channelId: null,
            conversationId: "synthetic-conversation",
            conversationType: "personal",
            threadId: "synthetic-thread",
            activityId: null,
            serviceUrl: "https://smba.trafficmanager.net/amer/",
            connectionId: randomUUID(),
            teamsUserId: "synthetic-user",
            teamsUserDisplayName: null,
            teamsUserPrincipalName: null,
            botId: null,
            botName: null,
            publicBrand: "okou" as const,
          },
          telegramDelivery: {
            installationId: randomUUID(),
            chatId: "synthetic-chat",
            messageId: "1",
            rootMessageId: null,
            userLinkId: randomUUID(),
            userLinkKind: "official" as const,
            agentId: f.agentId,
            isDM: true,
          },
          agentphoneDelivery: {
            messageId: "synthetic-message",
            conversationId: null,
            channel: "sms" as const,
            isGroup: false,
            rootMessageId: "synthetic-root",
            phoneHandle: "synthetic-handle",
            fromNumber: "synthetic-from",
            toNumber: "synthetic-to",
            userLinkId: randomUUID(),
            agentId: f.agentId,
            agentphoneAgentId: "synthetic-agent",
          },
          githubDelivery: {
            installationId: randomUUID(),
            repo: "synthetic/erasure",
            subjectNumber: 1,
            subjectKind: "issue" as const,
            agentId: f.agentId,
          },
        };
      }

      async function startTerminal(
        f: OutputFixture,
        kind: TerminalKind,
        options: {
          mode?: "plain" | "ccstate";
          payload?: Record<string, unknown>;
          sourceCallbackId?: string;
        } = {},
      ) {
        const callback = {
          runId: f.runId,
          status:
            kind === "completed" ? ("completed" as const) : ("failed" as const),
          error:
            kind === "cancelled"
              ? "Run cancelled"
              : "Synthetic terminal failure",
          callbackId: options.sourceCallbackId,
          payload: {
            threadId: f.threadId,
            agentId: f.agentId,
            publicBrand: "okou",
            ...options.payload,
          },
        };
        const result =
          options.mode === "ccstate"
            ? await createStore().set(
                handleChatInternalCallback$,
                { callback },
                context.signal,
              )
            : await handleChatInternalCallbackWithoutCcstate(
                db,
                callback,
                context.signal,
              );
        expect(result).toStrictEqual({ success: true });
      }

      async function invokeTerminal(...args: Parameters<typeof startTerminal>) {
        await startTerminal(...args);
        await flushWaitUntilForTest();
      }

      async function terminalState(f: OutputFixture) {
        const events = await db
          .select()
          .from(chatEvents)
          .where(eq(chatEvents.chatThreadId, f.threadId))
          .orderBy(asc(chatEvents.seqId));
        const callbacks = await db
          .select({
            id: agentRunCallbacks.id,
            runId: agentRunCallbacks.runId,
            kind: agentRunCallbacks.internalKind,
            payload: agentRunCallbacks.payload,
            encryptedSecret: agentRunCallbacks.encryptedSecret,
          })
          .from(agentRunCallbacks)
          .where(eq(agentRunCallbacks.runId, f.runId))
          .orderBy(asc(agentRunCallbacks.id));
        const thread = await db
          .select({
            seq: sql`COALESCE(${chatEventSequences.lastSeqId}, 0)`.mapWith(
              chatEventSequences.lastSeqId,
            ),
            lastMessageAt: chatThreads.lastMessageAt,
          })
          .from(chatThreads)
          .leftJoin(
            chatEventSequences,
            eq(chatEventSequences.chatThreadId, chatThreads.id),
          )
          .where(eq(chatThreads.id, f.threadId));
        const sidebar = await db
          .select()
          .from(chatThreadEvents)
          .where(eq(chatThreadEvents.chatThreadId, f.threadId))
          .orderBy(asc(chatThreadEvents.seqId));
        const sidebarSequence = await db
          .select()
          .from(chatThreadEventSequences)
          .where(
            and(
              eq(chatThreadEventSequences.userId, f.userId),
              eq(chatThreadEventSequences.orgId, f.orgId),
            ),
          );
        return { events, callbacks, thread, sidebar, sidebarSequence };
      }

      it("pins ownership before asynchronous error formatting and rejects the open new owner", async () => {
        const f = await terminalFixture("failed");
        await db
          .update(agentRuns)
          .set({
            failureReason: "invalid_credentials",
            modelProviderCredentialScope: "org",
          })
          .where(eq(agentRuns.id, f.runId));
        const before = await terminalState(f);
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        await db
          .delete(orgMembersCache)
          .where(
            and(
              eq(orgMembersCache.userId, f.userId),
              eq(orgMembersCache.orgId, f.orgId),
            ),
          );
        context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
          async () => {
            entered.resolve();
            await release.promise;
            return {
              data: [{ role: "org:admin", organization: { id: f.orgId } }],
              totalCount: 1,
            };
          },
        );
        const writing = invokeTerminal(f, "failed", { mode: "ccstate" });
        await entered.promise;
        await db
          .update(agentRuns)
          .set({ userId: `synthetic-new-${randomUUID()}` })
          .where(eq(agentRuns.id, f.runId));
        release.resolve();
        // The source callback keeps this work and retries; nothing is written.
        await expect(writing).rejects.toThrow(
          "Prepared run content ownership no longer matches",
        );
        await expect(terminalState(f)).resolves.toStrictEqual(before);
      });

      it("open callback collisions keep one terminal event and six delivery rows", async () => {
        const f = await terminalFixture("failed");
        const payload = deliveries(f);
        await Promise.all([
          invokeTerminal(f, "failed", { payload }),
          invokeTerminal(f, "cancelled", { payload }),
          invokeTerminal(f, "completed", { payload }),
        ]);
        const after = await terminalState(f);
        expect(
          after.events.filter((event) => {
            return ["run.completed", "run.failed", "run.cancelled"].includes(
              event.eventType,
            );
          }),
        ).toHaveLength(1);
        expect(
          after.callbacks.filter((row) => {
            return row.kind !== "chat";
          }),
        ).toHaveLength(6);
      });

      it("open missing users row and a same-text user subject do not close the organization", async () => {
        const f = await terminalFixture("failed");
        await db.delete(users).where(eq(users.id, f.userId));
        await close(decision(f.orgId, "user"));
        await invokeTerminal(f, "failed");
        expect(
          (await terminalState(f)).events.filter((event) => {
            return event.eventType === "run.failed";
          }),
        ).toHaveLength(1);
      });

      it("a wrong source callback rolls back sequence, event and sidebar writes and a correct retry succeeds", async () => {
        const f = await terminalFixture("failed");
        const before = await terminalState(f);
        const payload = { slackDelivery: deliveries(f).slackDelivery };
        await expect(
          invokeTerminal(f, "failed", {
            payload,
            sourceCallbackId: randomUUID(),
          }),
        ).rejects.toThrow(
          "Canonical delivery run is missing its chat callback",
        );
        await expect(terminalState(f)).resolves.toStrictEqual(before);
        await invokeTerminal(f, "failed", { payload });
        const after = await terminalState(f);
        expect(
          after.events.filter((event) => {
            return event.eventType === "run.failed";
          }),
        ).toHaveLength(1);
        expect(
          after.callbacks.filter((row) => {
            return row.kind === "slack:chat";
          }),
        ).toHaveLength(1);
      });

      it.each(["cancel", "disconnect"] as const)(
        "a real PostgreSQL %s rolls back and leaves a successful retry possible",
        async (fault) => {
          const f = await terminalFixture("failed");
          const before = await terminalState(f);
          // Own the driver socket error caused by this test's targeted backend
          // termination, separately from the real writer's rejected query.
          const disconnected =
            fault === "disconnect"
              ? createDeferredPromise<Error>(context.signal)
              : undefined;
          const clients = new Set<PoolClient>();
          const connectionError = (error: Error) => {
            disconnected?.resolve(error);
          };
          const acquired = (client: PoolClient) => {
            if (!clients.has(client)) {
              clients.add(client);
              client.once("error", connectionError);
            }
          };
          if (disconnected) {
            pool.on("acquire", acquired);
            onTestFinished(() => {
              pool.removeListener("acquire", acquired);
              for (const client of clients) {
                client.removeListener("error", connectionError);
              }
            });
          }
          // The atomic append waits only on its thread's sequence row.
          const held = await holdBusinessRow((tx) => {
            return tx
              .select({ id: chatEventSequences.chatThreadId })
              .from(chatEventSequences)
              .where(eq(chatEventSequences.chatThreadId, f.threadId))
              .for("update");
          });
          const writing = settle(invokeTerminal(f, "failed"));
          const writerPid = await waitForBlockedBy(held.pid);
          const rows = await executeRawRows(
            db,
            fault === "cancel"
              ? sql`SELECT pg_cancel_backend(${writerPid}) AS stopped`
              : sql`SELECT pg_terminate_backend(${writerPid}) AS stopped`,
            z.object({ stopped: z.boolean() }),
          );
          expect(rows).toStrictEqual([{ stopped: true }]);
          expect((await writing).ok).toBeFalsy();
          await expect(terminalState(f)).resolves.toStrictEqual(before);
          await held.release();
          await invokeTerminal(f, "failed");
          expect(
            (await terminalState(f)).events.filter((event) => {
              return event.eventType === "run.failed";
            }),
          ).toHaveLength(1);
        },
      );

      it("an aborted callback is not acknowledged or projected", async () => {
        const f = await terminalFixture("failed");
        const before = await terminalState(f);
        const controller = new AbortController();
        controller.abort();
        await expect(
          settleIncludingAbort(
            handleChatInternalCallbackWithoutCcstate(
              db,
              {
                runId: f.runId,
                status: "failed",
                error: "synthetic failure",
                payload: { threadId: f.threadId, agentId: f.agentId },
              },
              controller.signal,
            ),
          ),
        ).resolves.toMatchObject({ ok: false, error: { name: "AbortError" } });
        await expect(terminalState(f)).resolves.toStrictEqual(before);
      });

      it("projects terminal content while a thread identity pin is held", async () => {
        const f = await terminalFixture("failed");
        const held = await holdBusinessRow((tx) => {
          return tx
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(eq(chatThreads.id, f.threadId))
            .for("key share");
        });

        await invokeTerminal(f, "failed");
        expect(
          (await terminalState(f)).events.filter((event) => {
            return event.eventType === "run.failed";
          }),
        ).toHaveLength(1);
        await held.release();
      });
    });
  });
});
