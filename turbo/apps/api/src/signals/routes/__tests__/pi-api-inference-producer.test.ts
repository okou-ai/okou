import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  PI_DEFERRED_SANDBOX_HEADER,
  runnersJobClaimContract,
} from "@okouai/api-contracts/contracts/runners";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { createAppWithRoutes } from "../../../app-factory-core";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settle } from "../../utils";
import { runnersRoutes } from "../runners";
import { testCronCleanupSandboxesStateRoutes } from "../test-cron-cleanup-sandboxes-state";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  configureNativeCliArtifact,
  createChatEventsFixture,
  createPiApiFirstTurnUsagePricingResolution,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  requireOrgId,
} from "./helpers/chat-events-fixture";
import {
  piResponsesContentSse,
  piResponsesTextSse,
} from "./helpers/pi-responses";
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
  publishPendingPiInstructions,
  claimChatRun,
  failChatRun,
  completeChatRunOk,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

const SELECTED_MODEL = "deepseek-v4.1-flash";
const PROVIDER_URL = "https://api.deepseek.com/responses";

async function requestStateAction(body: Record<string, unknown>) {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronCleanupSandboxesStateRoutes,
  });
  const response = await app.request(
    "/api/test/cron-cleanup-sandboxes-state/action",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Scoped state action failed with ${response.status}: ${await response.text()}`,
    );
  }
  return z
    .object({ ok: z.literal(true) })
    .passthrough()
    .parse(await response.json());
}

async function cleanupRuns(
  runIds: readonly string[],
  orgIds: readonly string[],
) {
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
        runIds,
        orgIds,
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
    body: z
      .object({ cleaned: z.number(), errors: z.number() })
      .passthrough()
      .parse(await response.json()),
  };
}

async function cleanupRun(runId: string, orgId: string) {
  return await cleanupRuns([runId], [orgId]);
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

// Infrastructure exception: the synthetic process-loss fixture must observe the
// transient ownership clock to prove each sequential recovery claim uses fresh time.
async function readRecoveryDeadline(runId: string): Promise<number> {
  const response = await requestStateAction({
    action: "get-pi-inference-recovery-deadline",
    run_id: runId,
  });
  const deadline = z
    .object({ recovery_deadline: z.string().datetime() })
    .parse(response).recovery_deadline;
  return new Date(deadline).getTime();
}

async function seedProducerRecoveryRun(
  sourceRunId: string,
  kind: "ready" | "publishing",
  options?: {
    readonly omitBillingCapture?: boolean;
    readonly deadlineAt?: Date;
  },
): Promise<string> {
  const response = await requestStateAction({
    action: "seed-pi-inference-recovery",
    source_run_id: sourceRunId,
    kind,
    ...(options?.omitBillingCapture ? { omit_billing_capture: true } : {}),
    ...(options?.deadlineAt
      ? { deadline_at: options.deadlineAt.toISOString() }
      : {}),
  });
  return z.object({ run_id: z.string().uuid() }).parse(response).run_id;
}

async function expirePiInference(runId: string, deadlineAt = new Date(0)) {
  await requestStateAction({
    action: "expire-pi-inference",
    run_id: runId,
    deadline_at: deadlineAt.toISOString(),
  });
}

async function deleteCapturedPiModelKey(runId: string) {
  await requestStateAction({
    action: "delete-pi-inference-model-key",
    run_id: runId,
  });
}

async function withPiTestLock<T>(
  kind: "org-sandbox-capacity" | "run-output-projection",
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockId = randomUUID();
  const holding = requestStateAction({
    action: "hold-pi-inference-test-lock",
    lock_id: lockId,
    lock_kind: kind,
    key,
  });
  await expect
    .poll(async () => {
      const state = await requestStateAction({
        action: "get-pi-inference-test-lock",
        lock_id: lockId,
      });
      return z.object({ held: z.boolean() }).parse(state).held;
    })
    .toBe(true);
  const result = await settle(operation(), context.signal);
  await requestStateAction({
    action: "release-pi-inference-test-lock",
    lock_id: lockId,
  });
  await holding;
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function expectNoDeferredPiRun(runId: string, runnerGroup: string) {
  const runnerId = randomUUID();
  await api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group: runnerGroup,
  });
  const response = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        params: { id: runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      },
    ),
    [404],
  );
  expect(response.body.error.message).toBe("Job not found in queue");
}

async function claimDeferredPiRun(runId: string, runnerGroup: string) {
  const runnerId = randomUUID();
  await api.requestHeartbeatRunner(true, [200], {
    runnerId,
    group: runnerGroup,
  });
  const response = await accept(
    setupApp({ context, routes: runnersRoutes })(runnersJobClaimContract).claim(
      {
        params: { id: runId },
        headers: {
          authorization: `Bearer ${OFFICIAL_RUNNER_TOKEN_PREFIX}${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        extraHeaders: { [PI_DEFERRED_SANDBOX_HEADER]: "1" },
        body: {
          runnerIdentity: { runnerId, heartbeatGeneration: 1 },
          capabilities: { piModelConfigGenerations: [1, 2, 3, 4] },
        },
      },
    ),
    [200],
  );
  return { claim: response.body, runnerId };
}

async function releaseDeferredPiRun(
  runId: string,
  runnerId: string,
  claim: Awaited<ReturnType<typeof claimDeferredPiRun>>["claim"],
) {
  const handoff = claim.piLaunchConfig?.apiFirstTurn;
  if (!handoff || handoff.schemaVersion !== 2) {
    throw new Error("Expected a deferred Pi claim fence");
  }
  await accept(
    setupApp({ context, routes: runnersRoutes })(
      runnersJobClaimContract,
    ).release({
      params: { id: runId },
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
}

describe("durable Pi API producer", () => {
  it("starts provider transport under held Sandbox capacity and completes without demand", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    const providerBodies: unknown[] = [];
    let calls = 0;
    server.use(
      http.post(PROVIDER_URL, async ({ request }) => {
        calls += 1;
        providerBodies.push(await request.json());
        if (calls === 1) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(
          piResponsesTextSse("durable direct answer", calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    const run = await withPiTestLock(
      "org-sandbox-capacity",
      orgId,
      async () => {
        const created = await sendChatRun(
          actor,
          {
            agentId,
            prompt: "answer without allocating a Sandbox",
            model: SELECTED_MODEL,
          },
          usagePricingResolution,
        );
        await expect(providerEntered.promise).resolves.toBeUndefined();
        await expectNoDeferredPiRun(created.runId, runnerGroup);
        return created;
      },
    );
    releaseProvider.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
    const firstEvents = (await chat.listThreadEvents(actor, run.threadId))
      .events;
    expect(
      firstEvents.some((event) => {
        return (
          event.runId === run.runId &&
          event.eventType === "output.message" &&
          JSON.stringify(event).includes("durable direct answer")
        );
      }),
    ).toBeTruthy();
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
    expect(JSON.stringify(providerBodies[1])).toContain(
      "durable direct answer",
    );
  }, 90_000);

  it("publishes untouched H0 demand for native input without provider transport", async () => {
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
    await flushWaitUntilForTest();
    expect(calls).toBe(0);
    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: { continuation: { mode: "untouched-h0" } },
    });
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await releaseDeferredPiRun(run.runId, runnerId, claim);
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
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === run.runId && event.eventType === "output.message"
        );
      }),
    ).toBeFalsy();
    // Terminal uncertainty releases the technical reservation only after its
    // bounded grace. Expire that clock explicitly instead of waiting 55s.
    await expirePiInference(run.runId);
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

    await withPiTestLock("run-output-projection", run.runId, async () => {
      releaseProvider.resolve(undefined);
      await expect
        .poll(async () => {
          await billing.processOrgUsageEvents(actor);
          return (await billing.readUsageRecord(actor)).body.pagination.total;
        })
        .toBeGreaterThan(0);
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
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await billing.processOrgUsageEvents(actor);
    const usage = await billing.readUsageRecord(actor);
    expect(usage.body.pagination.total).toBeGreaterThan(0);
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
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "completed",
    });
  }, 90_000);

  it("keeps recoverable owners beyond one maintenance batch out of generic timeout", async () => {
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
          piResponsesTextSse(`recovery batch answer ${calls}`, calls),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture a recovery batch recipe",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    const recoveryRunIds: string[] = [];
    for (let index = 0; index < 21; index++) {
      recoveryRunIds.push(
        await seedProducerRecoveryRun(source.runId, "ready", {
          deadlineAt: new Date(index + 1),
        }),
      );
    }
    await expect(cleanupRuns(recoveryRunIds, [orgId])).resolves.toMatchObject({
      body: { errors: 0 },
    });
    expect(calls).toBe(21);
    const overflowRunId = recoveryRunIds.at(-1);
    if (!overflowRunId) {
      throw new Error("Expected one recovery owner beyond the batch");
    }
    await expect(api.readRun(actor, overflowRunId)).resolves.toMatchObject({
      status: "pending",
    });

    await expect(cleanupRun(overflowRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, overflowRunId, "completed", 10_000);
    expect(calls).toBe(22);
  }, 90_000);

  it("starts each sequential recovery deadline when that owner is claimed", async () => {
    configureNativeCliArtifact();
    const { actor, agentId } = await entitledChatActor();
    const orgId = await enableDurablePi(actor);
    await configureBuiltInPiModel(actor, SELECTED_MODEL);
    const usagePricingResolution =
      await createPiApiFirstTurnUsagePricingResolution(SELECTED_MODEL);
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();

    server.use(
      http.post(PROVIDER_URL, () => {
        return new HttpResponse(piResponsesTextSse("deadline source", 1), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const source = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "capture sequential recovery deadlines",
        model: SELECTED_MODEL,
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, source.runId, "completed", 10_000);
    await flushWaitUntilForTest();
    const recoveryRunIds = [
      await seedProducerRecoveryRun(source.runId, "ready", {
        deadlineAt: new Date(1),
      }),
      await seedProducerRecoveryRun(source.runId, "ready", {
        deadlineAt: new Date(2),
      }),
    ];

    const claimedDeadlines: number[] = [];
    let recoveredCalls = 0;
    server.use(
      http.post(PROVIDER_URL, async () => {
        const runId = recoveryRunIds[recoveredCalls];
        if (!runId) {
          throw new Error("Unexpected recovered provider attempt");
        }
        recoveredCalls += 1;
        claimedDeadlines.push(await readRecoveryDeadline(runId));
        if (recoveredCalls === 1) {
          await delay(5000, undefined, { signal: context.signal });
        }
        return new HttpResponse(
          piResponsesTextSse(
            `sequential recovery ${recoveredCalls}`,
            recoveredCalls,
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );

    await expect(cleanupRuns(recoveryRunIds, [orgId])).resolves.toMatchObject({
      body: { errors: 0 },
    });
    expect(recoveredCalls).toBe(2);
    const [firstDeadline, secondDeadline] = claimedDeadlines;
    if (firstDeadline === undefined || secondDeadline === undefined) {
      throw new Error("Expected both recovered ownership deadlines");
    }
    expect(secondDeadline - firstDeadline).toBeGreaterThan(4500);
    for (const runId of recoveryRunIds) {
      await expect(api.readRun(actor, runId)).resolves.toMatchObject({
        status: "completed",
      });
    }
  }, 90_000);

  it("preserves Sandbox-first recovery when durable resource capture fails", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const orgId = requireOrgId(actor);
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiDeferredSandbox]: true },
    );
    let archiveReads = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, () => {
        archiveReads += 1;
        return HttpResponse.json(
          { error: "archive unavailable" },
          { status: 503 },
        );
      }),
    );
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
    const queued = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "recover unavailable Pi resources in Sandbox",
      selectedModel: SELECTED_MODEL,
    });
    await completeChatRunOk(
      queued.anchor.runId,
      queued.anchorClaim.sandboxHeaders,
      { usagePricingResolution: queued.usagePricingResolution },
    );
    await flushWaitUntilForTest();
    expect(archiveReads).toBeGreaterThan(0);
    expect(calls).toBe(0);
    const claimed = await claimChatRun(runnerGroup, queued.run.runId);
    expect(claimed.claim.cliAgentType).toBe("pi");
    await api.requestCancelRun(
      actor,
      queued.run.runId,
      [200],
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, queued.run.runId, "cancelled", 10_000);
    await failChatRun(
      queued.run.runId,
      claimed.sandboxHeaders,
      "Run cancelled",
    );
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
    await deleteCapturedPiModelKey(recoveryRunId);

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, recoveryRunId, "failed", 10_000);
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "failed",
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
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "completed",
    });
    const events = (await chat.listThreadEvents(actor, source.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === recoveryRunId && event.eventType === "output.message"
        );
      }),
    ).toBeTruthy();
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
    await expirePiInference(recoveryRunId);

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
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
    await expirePiInference(recoveryRunId);

    await expect(cleanupRun(recoveryRunId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(api.readRun(actor, recoveryRunId)).resolves.toMatchObject({
      status: "cancelled",
    });
    await billing.processOrgUsageEvents(actor);
    const after = await billing.readUsageRecord(actor);
    expect(after.body.totalCredits).toBe(before.body.totalCredits);
  }, 90_000);

  it("publishes settled H1 demand for one input committed during provider execution", async () => {
    configureNativeCliArtifact();
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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
    await flushWaitUntilForTest();

    expect(calls).toBe(1);
    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
    expect(claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
      apiFirstTurn: { continuation: { mode: "settled-session" } },
    });
    await api.requestCancelRun(actor, run.runId, [200], usagePricingResolution);
    await releaseDeferredPiRun(run.runId, runnerId, claim);
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
    await expirePiInference(run.runId);

    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    await waitForRunStatus(actor, run.runId, "failed", 10_000);

    releaseProvider.resolve(undefined);
    await flushWaitUntilForTest();
    expect(calls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "failed",
    });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.some((event) => {
        return (
          event.runId === run.runId && event.eventType === "output.message"
        );
      }),
    ).toBeFalsy();
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
    await flushWaitUntilForTest();
    expect(calls).toBe(1);

    await expect(cleanupRun(run.runId, orgId)).resolves.toMatchObject({
      body: { errors: 0 },
    });
    const { claim, runnerId } = await claimDeferredPiRun(
      run.runId,
      runnerGroup,
    );
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
    await releaseDeferredPiRun(run.runId, runnerId, claim);
    await flushWaitUntilForTest();
  }, 90_000);
});
