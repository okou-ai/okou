import { randomUUID } from "node:crypto";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  PI_DEFERRED_SANDBOX_HEADER,
  runnersJobClaimContract,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
// eslint-disable-next-line no-restricted-imports -- Crash/epoch/capacity fixtures must seed and observe the durable ownership fence itself.
import {
  agentRunInference,
  agentRunSandboxIntent,
  agentRunSandboxLease,
} from "@okouai/db/schema/agent-run-inference";
// eslint-disable-next-line no-restricted-imports -- Provider-boundary capacity proof must establish that no executable job exists.
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
// eslint-disable-next-line no-restricted-imports -- Source-loss recovery requires deleting the exact captured key after admission.
import { builtInModelKeys } from "@okouai/db/schema/built-in-model-key";
// eslint-disable-next-line no-restricted-imports -- Lost-process recovery fixtures need a canonical replacement session identity.
import { agentSessions } from "@okouai/db/schema/agent-session";
// eslint-disable-next-line no-restricted-imports -- Lost-process recovery fixtures need a canonical isolated thread.
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, eq, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
// eslint-disable-next-line no-restricted-imports -- Explicit advisory-lock and process-loss fixtures require direct PostgreSQL ownership control.
import { db } from "../../../lib/db";
import { env, mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { runnersRoutes } from "../runners";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  createPiApiFirstTurnUsagePricingResolution,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  piResponsesContentSse,
  piResponsesTextSse,
} from "./helpers/pi-responses";
// eslint-disable-next-line no-restricted-imports -- Process-loss fixtures retain exact immutable receipts without invoking a second producer.
import {
  publishPiInferenceObject,
  readPiInferenceObject,
  retainPiInferenceObject,
} from "../../services/pi-inference-object.service";
// eslint-disable-next-line no-restricted-imports -- Process-loss fixtures validate the same immutable object schemas as production.
import {
  piDeferredConfigurationSchema,
  piDeferredContextSchema,
} from "../../services/pi-deferred-sandbox-contract";
import { createBillingMediaApi } from "./helpers/api-bdd-billing-media";

const context = testContext();
const billing = createBillingMediaApi(context);
const {
  api,
  chat,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  waitForRunStatus,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

const SELECTED_MODEL = "deepseek-v4.1-flash";
const PROVIDER_URL = "https://api.deepseek.com/responses";

async function cleanupRun(runId: string, orgId: string) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
  });
  const response = await app.request(
    "/api/test/cron-cleanup-sandboxes-state/cleanup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runIds: [runId],
        orgIds: [orgId],
        chatThreadIds: [],
        exportJobIds: [],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Scoped cleanup failed with ${response.status}: ${await response.text()}`,
    );
  }
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function enableDurablePi(
  actor: Awaited<ReturnType<typeof entitledChatActor>>["actor"],
) {
  const orgId = requireOrgId(actor);
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId },
    {
      [FeatureSwitchKey.PiLoop]: true,
      [FeatureSwitchKey.PiDeferredSandbox]: true,
    },
  );
  return orgId;
}

async function readProducerState(runId: string) {
  const [state] = await db()
    .select({
      runId: agentRuns.id,
      status: agentRuns.status,
      launchSnapshot: agentRuns.launchSnapshot,
      runnerGroup: agentRuns.runnerGroup,
      phase: agentRunInference.phase,
      providerAttemptState: agentRunInference.providerAttemptState,
      usageSettled: agentRunInference.usageSettled,
      publication: agentRunInference.publication,
      input: agentRunInference.input,
    })
    .from(agentRuns)
    .innerJoin(agentRunInference, eq(agentRunInference.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId));
  return state;
}

async function readExecutionRows(runId: string) {
  const [jobs, intents, leases] = await Promise.all([
    db().select().from(runnerJobQueue).where(eq(runnerJobQueue.runId, runId)),
    db()
      .select()
      .from(agentRunSandboxIntent)
      .where(eq(agentRunSandboxIntent.runId, runId)),
    db()
      .select()
      .from(agentRunSandboxLease)
      .where(eq(agentRunSandboxLease.runId, runId)),
  ]);
  return { jobs, intents, leases };
}

async function seedProducerRecoveryRun(
  sourceRunId: string,
  kind: "ready" | "publishing",
  options?: { readonly omitBillingCapture?: boolean },
): Promise<string> {
  const [[sourceRun], [sourceInference]] = await Promise.all([
    db().select().from(agentRuns).where(eq(agentRuns.id, sourceRunId)),
    db()
      .select()
      .from(agentRunInference)
      .where(eq(agentRunInference.runId, sourceRunId)),
  ]);
  if (!sourceRun || !sourceInference) {
    throw new Error("Expected a durable producer source Run");
  }
  if (sourceInference.input.h0.kind !== "empty") {
    throw new Error("Recovery fixture requires an empty captured H0");
  }
  if (!sourceRun.chatThreadId) {
    throw new Error("Recovery fixture source thread is missing");
  }
  const runId = randomUUID();
  const sessionId = kind === "ready" ? randomUUID() : sourceRun.sessionId;
  const chatThreadId = kind === "ready" ? randomUUID() : sourceRun.chatThreadId;
  if (!chatThreadId) {
    throw new Error("Recovery fixture requires a chat thread");
  }
  let configurationHash = sourceInference.input.configurationHash;
  if (options?.omitBillingCapture) {
    const sourceConfiguration = await readPiInferenceObject(
      db(),
      {
        runId: sourceRunId,
        userId: sourceRun.userId,
        orgId: sourceRun.orgId,
        kind: "configuration",
        hash: configurationHash,
      },
      piDeferredConfigurationSchema,
    );
    const { apiInferenceBilling: _billing, ...withoutBilling } =
      sourceConfiguration;
    configurationHash = await publishPiInferenceObject(
      db(),
      { userId: sourceRun.userId, orgId: sourceRun.orgId },
      "configuration",
      piDeferredConfigurationSchema,
      withoutBilling,
    );
  }
  let contextHash = sourceInference.input.contextHash;
  if (kind === "ready") {
    const sourceContext = await readPiInferenceObject(
      db(),
      {
        runId: sourceRunId,
        userId: sourceRun.userId,
        orgId: sourceRun.orgId,
        kind: "context",
        hash: sourceInference.input.contextHash,
      },
      piDeferredContextSchema,
    );
    contextHash = await publishPiInferenceObject(
      db(),
      { userId: sourceRun.userId, orgId: sourceRun.orgId },
      "context",
      piDeferredContextSchema,
      {
        ...sourceContext,
        baseSession: { sessionId: chatThreadId, sha256: null },
        h0SessionHistory: sourceContext.h0SessionHistory.replaceAll(
          sourceRun.chatThreadId,
          chatThreadId,
        ),
      },
    );
  }
  const createdAt = nowDate();
  await db().transaction(async (tx) => {
    if (kind === "ready") {
      const [sourceSession] = await tx
        .select({ agentId: agentSessions.agentId })
        .from(agentSessions)
        .where(eq(agentSessions.id, sourceRun.sessionId));
      if (!sourceSession) {
        throw new Error("Recovery fixture source session is missing");
      }
      await tx.insert(agentSessions).values({
        id: sessionId,
        agentId: sourceSession.agentId,
        userId: sourceRun.userId,
        orgId: sourceRun.orgId,
      });
      await tx.insert(chatThreads).values({
        id: chatThreadId,
        userId: sourceRun.userId,
        agentId: sourceSession.agentId,
        agentSessionId: sessionId,
      });
    }
    await tx.insert(agentRuns).values({
      ...sourceRun,
      id: runId,
      sessionId,
      continuedFromSessionId: null,
      chatThreadId,
      status: "pending",
      runnerCancellationMode: null,
      result: null,
      error: null,
      failureReason: null,
      createdAt,
      startedAt: null,
      completedAt: null,
      lastHeartbeatAt: null,
      lastEventSequence: null,
      firstAssistantEventAcknowledgedAt: null,
      sandboxId: null,
      sandboxReuseResult: null,
      workspaceReuseResult: null,
      cancellationRecoveryCompleted: null,
      runnerId: null,
      runnerHeartbeatGeneration: null,
      runnerHostname: null,
      runnerVersion: null,
      summary: null,
    });
    await tx.insert(agentRunInference).values({
      runId,
      sourceConversationId: null,
      input: {
        ...sourceInference.input,
        inputEventId: null,
        configurationHash,
        contextHash,
      },
      phase: kind,
      ownerEpoch: 1,
      deadlineAt: new Date(0),
      activationReady: true,
      providerAttemptId: randomUUID(),
      providerAttemptState: kind === "ready" ? "not-started" : "settled",
      publication: kind === "publishing" ? sourceInference.publication : null,
      publishedSequence: 0,
      usageSettled: false,
    });
    await retainPiInferenceObject(tx, {
      runId,
      userId: sourceRun.userId,
      orgId: sourceRun.orgId,
      kind: "configuration",
      hash: configurationHash,
    });
    await retainPiInferenceObject(tx, {
      runId,
      userId: sourceRun.userId,
      orgId: sourceRun.orgId,
      kind: "context",
      hash: contextHash,
    });
    if (sourceInference.input.deferredSecrets.kind === "encrypted") {
      await retainPiInferenceObject(tx, {
        runId,
        userId: sourceRun.userId,
        orgId: sourceRun.orgId,
        kind: "secrets",
        hash: sourceInference.input.deferredSecrets.objectHash,
      });
    }
    if (kind === "publishing") {
      const h1Hash = sourceInference.publication?.h1Hash;
      if (!h1Hash) {
        throw new Error("Recovery fixture source H1 is missing");
      }
      await retainPiInferenceObject(tx, {
        runId,
        userId: sourceRun.userId,
        orgId: sourceRun.orgId,
        kind: "h1",
        hash: h1Hash,
      });
    }
  });
  return runId;
}

describe("durable Pi API producer", () => {
  it("commits the provider uncertainty fence before HTTP and completes without Sandbox demand", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<string>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        const [atBoundary] = await db()
          .select({
            runId: agentRuns.id,
            launchSnapshot: agentRuns.launchSnapshot,
            phase: agentRunInference.phase,
            providerAttemptState: agentRunInference.providerAttemptState,
          })
          .from(agentRuns)
          .innerJoin(
            agentRunInference,
            eq(agentRunInference.runId, agentRuns.id),
          )
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              eq(agentRunInference.phase, "provider"),
            ),
          );
        if (!atBoundary) {
          throw new Error("Provider HTTP crossed without durable ownership");
        }
        expect(atBoundary.launchSnapshot).toStrictEqual({
          schemaVersion: 4,
          framework: "pi",
          executionMode: "api-inference",
          inferenceContractVersion: 1,
        });
        expect(atBoundary.providerAttemptState).toBe("may-have-started");
        await expect(
          readExecutionRows(atBoundary.runId),
        ).resolves.toStrictEqual({ jobs: [], intents: [], leases: [] });
        if (!providerEntered.settled()) {
          providerEntered.resolve(atBoundary.runId);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("durable direct answer", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const run = await db().transaction(async (tx) => {
      // Hold the real Sandbox-capacity key in another database owner. Durable
      // API inference must reach HTTP without waiting for this transaction.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
      const created = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "answer without allocating a Sandbox",
          model: SELECTED_MODEL,
        },
        usagePricingResolution,
      );
      await expect(providerEntered.promise).resolves.toBe(created.runId);
      return created;
    });
    releaseProvider.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readExecutionRows(run.runId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
    await expect(readProducerState(run.runId)).resolves.toMatchObject({
      status: "completed",
      runnerGroup: null,
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: true,
      publication: {
        manifestGeneration: 1,
      },
      input: {
        inputEventId: expect.any(String),
        inputGeneration: 0,
      },
    });
    await billing.processOrgUsageEvents(actor);
    const usage = await billing.readUsageRecord(actor);
    expect(usage.body.totalCredits).toBeGreaterThan(0);
    expect(usage.body.pagination.total).toBeGreaterThan(0);

    const followUp = await sendChatRun(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "continue from the durable answer",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, followUp.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(2);
    const [followUpInput] = await db()
      .select({ input: agentRunInference.input })
      .from(agentRunInference)
      .where(eq(agentRunInference.runId, followUp.runId));
    expect(followUpInput?.input.h0).toMatchObject({ kind: "history" });
    await expect(readExecutionRows(followUp.runId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
  }, 90_000);

  it("publishes untouched H0 demand for native input without provider transport", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(piResponsesTextSse("unexpected", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "/native-command",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await expect
      .poll(async () => {
        const [intent] = await db()
          .select({
            state: agentRunSandboxIntent.state,
            continuation: agentRunSandboxIntent.continuation,
          })
          .from(agentRunSandboxIntent)
          .where(eq(agentRunSandboxIntent.runId, run.runId));
        return intent;
      })
      .toMatchObject({
        state: "waiting",
        continuation: { mode: "untouched-h0" },
      });
    await flushWaitUntilForTest();

    expect(calls).toBe(0);
    const rows = await readExecutionRows(run.runId);
    expect(rows.jobs).toStrictEqual([]);
    expect(rows.intents).toHaveLength(1);
    expect(rows.leases).toStrictEqual([]);
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
  }, 90_000);

  it("lets canonical cancellation fence an in-flight provider without demand or replay", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_ORG_MAX_IN_FLIGHT", "1");
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("cancelled late answer", 1),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "cancel after the provider fence",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
    await expect(readProducerState(run.runId)).resolves.toMatchObject({
      phase: "terminal",
      providerAttemptState: "may-have-started",
    });
    const protectedWhileUncertain = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "remain protected until late usage settles",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(protectedWhileUncertain.status).toBe(429);
    if (protectedWhileUncertain.status === 429) {
      expect(protectedWhileUncertain.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readProducerState(run.runId)).resolves.toMatchObject({
      status: "cancelled",
      phase: "terminal",
      providerAttemptState: "may-have-started",
      usageSettled: true,
    });
    await expect(readExecutionRows(run.runId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
    // Terminal uncertainty releases the technical reservation only after its
    // bounded grace. Expire that clock explicitly instead of waiting 55s.
    await db()
      .update(agentRunInference)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunInference.runId, run.runId));
    const afterSettlement = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "start after the uncertain reservation settles",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, afterSettlement.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    expect(calls).toBe(2);
  }, 90_000);

  it("fences stale output in the write transaction while settling observed usage", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("stale output must not publish", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "cancel at the durable output transaction",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;

    await db().transaction(async (tx) => {
      const lockKey = `run_output_projection:${run.runId}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );
      releaseProvider.resolve(undefined);
      await expect
        .poll(() => {
          return readProducerState(run.runId);
        })
        .toMatchObject({
          phase: "publishing",
          providerAttemptState: "settled",
          usageSettled: true,
        });
      await api.requestCancelRun(
        actor,
        run.runId,
        [200],
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          (event.eventType === "output.message" ||
            event.eventType === "run.completed")
        );
      }),
    ).toStrictEqual([]);
    await expect(readProducerState(run.runId)).resolves.toMatchObject({
      status: "cancelled",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: true,
    });
    await billing.processOrgUsageEvents(actor);
    const usage = await billing.readUsageRecord(actor);
    expect(usage.body.totalCredits).toBeGreaterThan(0);
  }, 90_000);

  it("rejects fleet-wide org overload before a second provider attempt", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_ORG_MAX_IN_FLIGHT", "1");
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse("protected answer", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const first = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "hold the only durable inference slot",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    const rejected = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "must not enter the provider",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(rejected.status).toBe(429);
    if (rejected.status === 429) {
      expect(rejected.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    expect(calls).toBe(1);

    releaseProvider.resolve(undefined);
    await waitForRunStatus(actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
  }, 90_000);

  it("rejects provider-wide overload across organizations before transport", async () => {
    configureNativeCliArtifact();
    mockEnv("PI_INFERENCE_PROVIDER_MAX_IN_FLIGHT", "1");
    const firstActor = await entitledChatActor();
    const secondActor = await entitledChatActor();
    await enableDurablePi(firstActor.actor);
    await enableDurablePi(secondActor.actor);
    await configureBuiltInPiModel(firstActor.actor, SELECTED_MODEL);
    await configureBuiltInPiModel(secondActor.actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("provider protected answer", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const first = await sendChatRun(
      firstActor.actor,
      {
        agentId: firstActor.agentId,
        prompt: "hold the provider-wide durable inference slot",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    const rejected = await chat.requestSendEvent(
      secondActor.actor,
      {
        agentId: secondActor.agentId,
        prompt: "must not cross this shared provider boundary",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [429],
      { usagePricingResolution },
    );
    expect(rejected.status).toBe(429);
    if (rejected.status === 429) {
      expect(rejected.body.error.code).toBe("PI_INFERENCE_BUSY");
    }
    expect(calls).toBe(1);

    releaseProvider.resolve(undefined);
    await waitForRunStatus(firstActor.actor, first.runId, "completed", 10_000);
    await flushWaitUntilForTest();
  }, 90_000);

  it("recovers a lost ready owner through one fresh fenced provider attempt", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse(`ready recovery answer ${calls}`, calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a durable recovery recipe",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunId = await seedProducerRecoveryRun(source.runId, "ready");

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(2);
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "completed",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: true,
    });
    await expect(readExecutionRows(recoveryRunId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
  }, 90_000);

  it("rejects a recovered ready owner after its captured model source disappears", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("credential source", calls),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a source that will be revoked",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunId = await seedProducerRecoveryRun(source.runId, "ready");
    const [captured] = await db()
      .select({ keyId: agentRuns.builtInModelKeyId })
      .from(agentRuns)
      .where(eq(agentRuns.id, recoveryRunId));
    if (!captured?.keyId) {
      throw new Error("Expected a captured built-in model key");
    }
    await db()
      .delete(builtInModelKeys)
      .where(eq(builtInModelKeys.id, captured.keyId));

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "failed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "failed",
      phase: "terminal",
      providerAttemptState: "not-started",
      usageSettled: false,
    });
    await expect(readExecutionRows(recoveryRunId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
  }, 90_000);

  it("recovers settled H1 publication without another provider attempt", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("durable publication source", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture one recoverable settled H1",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
    );

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "completed",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: true,
    });
    await expect(readExecutionRows(recoveryRunId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
    await billing.processOrgUsageEvents(actor);
    const recoveredUsage = await billing.readUsageRecord(actor);
    expect(recoveredUsage.body.totalCredits).toBeGreaterThan(0);
    expect(recoveredUsage.body.pagination.total).toBeGreaterThan(0);
  }, 90_000);

  it("settles a retained H1 receipt after canonical cancellation without publishing output", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesTextSse("terminal accounting receipt", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture terminal accounting recovery",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await billing.processOrgUsageEvents(actor);
    const before = await billing.readUsageRecord(actor);
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
    );

    await api.requestCancelRun(
      actor,
      recoveryRunId,
      [200],
      usagePricingResolution,
    );
    await waitForRunStatus(actor, recoveryRunId, "cancelled", 10_000);
    await db()
      .update(agentRunInference)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunInference.runId, recoveryRunId));
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: false,
    });

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: true,
    });
    await expect(readExecutionRows(recoveryRunId)).resolves.toStrictEqual({
      jobs: [],
      intents: [],
      leases: [],
    });
    const events = (await chat.listThreadEvents(actor, source.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === recoveryRunId &&
          (event.eventType === "output.message" ||
            event.eventType === "run.completed")
        );
      }),
    ).toStrictEqual([]);
    await billing.processOrgUsageEvents(actor);
    const after = await billing.readUsageRecord(actor);
    expect(after.body.totalCredits).toBeGreaterThan(before.body.totalCredits);
  }, 90_000);

  it("does not settle terminal usage when the required billing capture is missing", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(piResponsesTextSse("billing source", calls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture required billing identity",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    await billing.processOrgUsageEvents(actor);
    const before = await billing.readUsageRecord(actor);
    const recoveryRunId = await seedProducerRecoveryRun(
      source.runId,
      "publishing",
      { omitBillingCapture: true },
    );
    await api.requestCancelRun(
      actor,
      recoveryRunId,
      [200],
      usagePricingResolution,
    );
    await waitForRunStatus(actor, recoveryRunId, "cancelled", 10_000);
    await db()
      .update(agentRunInference)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunInference.runId, recoveryRunId));

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(readProducerState(recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
      phase: "terminal",
      providerAttemptState: "settled",
      usageSettled: false,
    });
    await billing.processOrgUsageEvents(actor);
    const after = await billing.readUsageRecord(actor);
    expect(after.body.totalCredits).toBe(before.body.totalCredits);
  }, 90_000);

  it("publishes settled H1 demand for one input committed during provider execution", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("settled before active input", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "start one durable response",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "continue the settled H1 in Sandbox",
        model: SELECTED_MODEL,
        clientEventId: randomUUID(),
      },
      [201],
      { usagePricingResolution },
    );
    releaseProvider.resolve(undefined);

    await expect
      .poll(async () => {
        const [intent] = await db()
          .select({
            state: agentRunSandboxIntent.state,
            continuation: agentRunSandboxIntent.continuation,
          })
          .from(agentRunSandboxIntent)
          .where(eq(agentRunSandboxIntent.runId, run.runId));
        return intent;
      })
      .toMatchObject({
        state: "waiting",
        continuation: { mode: "settled-session" },
      });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    const rows = await readExecutionRows(run.runId);
    expect(rows.jobs).toStrictEqual([]);
    expect(rows.intents).toHaveLength(1);
    expect(rows.leases).toStrictEqual([]);
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await waitForRunStatus(actor, run.runId, "cancelled", 10_000);
  }, 90_000);

  it("terminalizes an expired uncertain provider attempt without replaying H0", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!releaseProvider.settled()) {
        releaseProvider.resolve(undefined);
      }
    });
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        calls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("late uncertain answer", 1),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "do not replay this uncertain provider attempt",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await providerEntered.promise;
    await db()
      .update(agentRunInference)
      .set({ deadlineAt: new Date(0) })
      .where(eq(agentRunInference.runId, run.runId));

    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, run.runId, "failed", 10_000);
    const [terminal] = await db()
      .select({
        phase: agentRunInference.phase,
        ownerEpoch: agentRunInference.ownerEpoch,
        providerAttemptState: agentRunInference.providerAttemptState,
      })
      .from(agentRunInference)
      .where(eq(agentRunInference.runId, run.runId));
    expect(terminal).toMatchObject({
      phase: "terminal",
      ownerEpoch: 3,
      providerAttemptState: "may-have-started",
    });

    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();
    expect(calls).toBe(1);
    await expect(readProducerState(run.runId)).resolves.toMatchObject({
      phase: "terminal",
      providerAttemptState: "may-have-started",
      usageSettled: true,
    });
    await billing.processOrgUsageEvents(actor);
    const lateUsage = await billing.readUsageRecord(actor);
    expect(lateUsage.body.pagination.total).toBeGreaterThan(0);
  }, 90_000);

  it("publishes one durable H1 demand and reaches the accepted consumer without provider replay", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, () => {
        calls += 1;
        return new HttpResponse(
          piResponsesContentSse({
            blocks: [
              {
                type: "toolCall",
                callId: "call_durable_pi_tool",
                name: "bash",
                arguments: { command: "true" },
              },
            ],
            sequence: calls,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const run = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "continue this tool call in the Sandbox",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await expect
      .poll(async () => {
        const [intent] = await db()
          .select({
            state: agentRunSandboxIntent.state,
            continuation: agentRunSandboxIntent.continuation,
          })
          .from(agentRunSandboxIntent)
          .where(eq(agentRunSandboxIntent.runId, run.runId));
        return intent;
      })
      .toMatchObject({
        state: "waiting",
        continuation: {
          mode: "pending-tools",
          pendingToolIds: [expect.stringMatching(/^call_durable_pi_tool\|/u)],
        },
      });
    await flushWaitUntilForTest();
    expect(calls).toBe(1);
    expect((await readExecutionRows(run.runId)).jobs).toStrictEqual([]);

    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const runnerId = randomUUID();
    await api.requestHeartbeatRunner(true, [200], {
      runnerId,
      group: runnerGroup,
    });
    const claimed = await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).claim({
        params: { id: run.runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      }),
      [200],
    );
    const claim = claimed.body;
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: {
        continuation: {
          mode: "pending-tools",
          pendingToolIds: [expect.stringMatching(/^call_durable_pi_tool\|/u)],
        },
      },
    });
    expect(calls).toBe(1);

    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    const handoff = claim.piLaunchConfig?.apiFirstTurn;
    if (!handoff || handoff.schemaVersion !== 2) {
      throw new Error("Expected a deferred Pi claim fence");
    }
    await accept(
      setupApp({ context, routes: runnersRoutes })(
        runnersJobClaimContract,
      ).release({
        params: { id: run.runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        body: {
          runnerId,
          ownerEpoch: handoff.ownerEpoch,
          generation: handoff.generation,
          proof: "destroyed",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
  }, 90_000);
});
