import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { workflowsDetailContract } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HTTPException } from "hono/http-exception";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  holdOrgAdmissionLockFixture,
  holdPiApiFirstTurnLifecycleLockFixture,
  readRunUsageEventsFixture,
} from "../../../test-fixtures/chat-events";
import { holdPiContextPreparationStagesFixture } from "../../../test-fixtures/pi-context-preparation";
import { withStableAgentPromptBuildCountFixture } from "../../../test-fixtures/pi-stable-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createChatEventsFixture,
  API_FIRST_TURN_OWNERSHIP_BUDGET_MS,
  API_FIRST_TURN_COORDINATION_BUDGET_MS,
  requireOrgId,
  expectTerraApiFollowUpUsage,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  eventBackedContents,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  piResponsesDeveloperPrompt,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";

const context = testContext();
const {
  bdd,
  api,
  chat,
  webhooks,
  routeMocks,
  entitledChatActor,
  configureBuiltInPiModel,
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  requestSendEventRaw,
  cancelBeforeLatePiResult,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

function jsonHttpException(status: 409 | 422, message: string) {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

function observePendingSend<T>(send: Promise<T>) {
  const result = settleIncludingAbort(send);
  const phases: Promise<unknown>[] = [];

  async function beforeSettlement(phase: PromiseLike<unknown>) {
    // Vitest polls are lazy thenables. Normalize once and retain each started
    // poll so an early request failure cannot leave it running after cleanup.
    const work = Promise.resolve(phase);
    phases.push(work);
    await Promise.race([
      work,
      result.then((settled) => {
        if (!settled.ok) {
          throw settled.error;
        }
        throw new Error(
          "Chat send completed before its held preparation phase",
        );
      }),
    ]);
  }

  async function joinPhases() {
    await Promise.allSettled(phases);
  }

  return { result, beforeSettlement, joinPhases };
}

describe("CHAT-02: model-first provider policies", () => {
  it("overlaps captured legacy context branches and skips deferred cache identity", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await api.heartbeatRunner(runnerGroup);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const providerBodies: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        providerBodies.push(await request.text());
        return nativeCodexSseResponse(
          piResponsesTextSse("overlapped legacy answer", providerBodies.length),
        );
      }),
    );
    const thread = await chat.createThread(actor, { agentId });
    const preparation = holdPiContextPreparationStagesFixture({
      userId: actor.userId,
      orgId,
      signal: context.signal,
    });
    const countedRun = withStableAgentPromptBuildCountFixture(async () => {
      return await sendChatRun(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt: "exercise overlapped legacy context preparation",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
    });

    await Promise.all([
      preparation.arrival("post-authorization-context"),
      preparation.arrival("thread-session"),
    ]);
    expect(preparation.hasArrived("subscription-account")).toBeFalsy();
    expect(preparation.hasArrived("model-provider")).toBeFalsy();
    expect(preparation.hasArrived("connector-contexts")).toBeFalsy();
    preparation.release("post-authorization-context");
    preparation.release("thread-session");

    await Promise.all([
      preparation.arrival("model-provider"),
      preparation.arrival("connector-contexts"),
    ]);
    expect(preparation.hasArrived("user-timezone")).toBeFalsy();
    expect(preparation.hasArrived("media-models")).toBeFalsy();
    expect(preparation.hasArrived("official-workflow")).toBeFalsy();
    expect(providerBodies).toHaveLength(0);
    preparation.release("model-provider");
    preparation.release("connector-contexts");

    await Promise.all([
      preparation.arrival("user-timezone"),
      preparation.arrival("media-models"),
      preparation.arrival("official-workflow"),
    ]);
    preparation.releaseAll();

    const {
      buildCount,
      cacheIdentityBuildCount,
      result: run,
    } = await countedRun;
    expect(buildCount).toBe(1);
    expect(cacheIdentityBuildCount).toBe(0);
    await waitForRunStatus(actor, run.runId, "completed", 10_000);
    expect(providerBodies).toHaveLength(1);
    expect(piResponsesDeveloperPrompt(providerBodies[0])).toContain(
      "# Current User Info",
    );
  }, 30_000);

  it("settles simultaneous legacy preparation failures in dependency order without post-admission effects", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    const thread = await chat.createThread(actor, { agentId });
    const preparation = holdPiContextPreparationStagesFixture({
      userId: actor.userId,
      orgId,
      signal: context.signal,
    });
    const clientEventId = randomUUID();
    const prompt = "reject simultaneous legacy preparation failures";
    const send = requestSendEventRaw(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt,
        clientEventId,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
        model: "gpt-5.6-terra",
      },
      context.signal,
      usagePricingResolution,
    );
    const observed = observePendingSend(send);

    await Promise.all([
      preparation.arrival("post-authorization-context"),
      preparation.arrival("thread-session"),
    ]);
    preparation.reject(
      "thread-session",
      jsonHttpException(422, "session preparation failed"),
    );
    await observed.beforeSettlement(preparation.departure("thread-session"));
    preparation.reject(
      "post-authorization-context",
      jsonHttpException(409, "authorization preparation failed"),
    );

    const response = await send;
    expect(response).toStrictEqual({
      status: 409,
      body: { error: { message: "authorization preparation failed" } },
    });
    await observed.joinPhases();
    await preparation.departure("post-authorization-context");
    preparation.releaseAll();
    const events = await chat.listThreadEvents(actor, thread.id);
    expect(events.events).toStrictEqual([
      expect.objectContaining({
        eventType: "input.prompt",
        id: clientEventId,
      }),
    ]);
  });

  it("settles held legacy preparation branches before surfacing cancellation without post-admission effects", async () => {
    const { actor, agentId } = await entitledChatActor();
    const orgId = requireOrgId(actor);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    const thread = await chat.createThread(actor, { agentId });
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([controller.signal, context.signal]);
    const preparation = holdPiContextPreparationStagesFixture({
      userId: actor.userId,
      orgId,
      signal: requestSignal,
      gateSignal: context.signal,
    });
    const clientEventId = randomUUID();
    const prompt = "cancel held legacy preparation";
    const send = requestSendEventRaw(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt,
        clientEventId,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
        model: "gpt-5.6-terra",
      },
      requestSignal,
      usagePricingResolution,
    );
    const observed = observePendingSend(send);

    await Promise.all([
      preparation.arrival("post-authorization-context"),
      preparation.arrival("thread-session"),
    ]);
    controller.abort(new DOMException("cancelled by route test", "AbortError"));
    preparation.release("thread-session");
    await observed.beforeSettlement(preparation.departure("thread-session"));
    preparation.release("post-authorization-context");

    const response = await send;
    expect(response.status).toBe(500);
    await observed.joinPhases();
    await preparation.departure("post-authorization-context");
    preparation.releaseAll();
    const events = await chat.listThreadEvents(actor, thread.id);
    expect(events.events).toStrictEqual([
      expect.objectContaining({
        eventType: "input.prompt",
        id: clientEventId,
      }),
    ]);
  });

  it.each(["pending", "cancelled", "queued"] as const)(
    "keeps %s admission responsive while API preparation is blocked",
    async (outcome) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await api.heartbeatRunner(runnerGroup);
      let anchor: Awaited<ReturnType<typeof sendChatRun>> | undefined;
      if (outcome === "queued") {
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
        anchor = await sendChatRun(actor, {
          agentId,
          prompt: "hold admission capacity",
          model: "claude-sonnet-5",
        });
      }
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      const usagePricingResolution = await createGptUsagePricingResolution();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const instructions = await publishPendingPiInstructions(actor, agentId);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      });
      const requests: string[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          const key = new URL(request.url).searchParams.get("object");
          if (!key) {
            throw new Error("Expected exact resource identity");
          }
          return new HttpResponse(piS3Object(key));
        }),
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.text());
            return nativeCodexSseResponse(
              piResponsesTextSse("prepared admission answer", requests.length),
            );
          },
        ),
      );
      const send = sendChatRun(
        actor,
        {
          agentId,
          prompt: "keep the complete admission independent",
          model: "gpt-5.6-terra",
        },
        usagePricingResolution,
      );
      await entered.promise;
      const run = await send;
      expect(requests).toHaveLength(0);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: outcome === "queued" ? "queued" : "pending",
      });
      if (outcome !== "queued") {
        // Ably is the real Runner notification transport boundary.
        expect(context.mocks.ably.publish.mock.calls).toContainEqual([
          "job",
          expect.objectContaining({ runId: run.runId }),
        ]);
      }
      if (outcome !== "pending") {
        await cancelChatRun(actor, run.runId);
      }
      release.resolve(undefined);
      if (outcome === "pending") {
        await waitForRunStatus(actor, run.runId, "completed", 10_000);
        expect(requests).toHaveLength(1);
        expect(piResponsesDeveloperPrompt(requests[0])).toContain(instructions);
        const events = (await chat.listThreadEvents(actor, run.threadId))
          .events;
        expect(eventBackedContents(events, run.runId)).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: "prepared admission answer" }),
          ]),
        );
      } else {
        await flushWaitUntilForTest();
        expect(requests).toHaveLength(0);
        expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      }
      if (anchor) {
        await cancelChatRun(actor, anchor.runId);
      }
    },
    30_000,
  );

  it.each(["connected", "disconnected", "rolled-back"] as const)(
    "owns completed SDK preparation across %s admission without pre-commit effects",
    async (caller) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await api.heartbeatRunner(runnerGroup);
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.PiLoop]: true },
      );
      const usagePricingResolution = await createGptUsagePricingResolution();
      const checkpointObjects = mockPiCheckpointObjectStore();
      const instructions = await publishPendingPiInstructions(actor, agentId);
      const thread = await chat.createThread(actor, { agentId });
      const sdk = await context.mocks.piSdk.controlInitialization(
        { sessionId: thread.id, instructions, holdInitialization: false },
        context.signal,
      );
      // No production API can hold the admission transaction open. This existing
      // infrastructure fixture owns a real PostgreSQL lock for this organization.
      const lock = await holdOrgAdmissionLockFixture({
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      onTestFinished(async () => {
        lock.release();
        await lock.done;
      });
      const requests: string[] = [];
      server.use(
        http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
          const key = new URL(request.url).searchParams.get("object");
          if (!key) {
            throw new Error("Expected exact resource identity");
          }
          return new HttpResponse(piS3Object(key));
        }),
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.text());
            return nativeCodexSseResponse(
              piResponsesTextSse("committed once", requests.length),
            );
          },
        ),
      );
      const controller = new AbortController();
      const prompt = "prepare while admission owns the database lock";
      const send = requestSendEventRaw(
        actor,
        {
          agentId,
          threadId: thread.id,
          prompt,
          clientEventId: randomUUID(),
          userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
          hasTextContent: true,
          model: "gpt-5.6-terra",
        },
        AbortSignal.any([controller.signal, context.signal]),
        usagePricingResolution,
      );
      const [completedResponse] = await Promise.all([
        send,
        sdk.ready.then(async () => {
          // The held lock keeps admission uncommitted while the SDK's own
          // readiness signal establishes the completed-preparation boundary.
          expect(requests).toHaveLength(0);
          expect(
            [...checkpointObjects.keys()].filter((key) => {
              return key.includes("/pi-api-first-turn/");
            }),
          ).toStrictEqual([]);
          const events = (await chat.listThreadEvents(actor, thread.id)).events;
          expect(
            events.filter((event) => {
              return (
                event.eventType.startsWith("output.") ||
                event.eventType === "run.completed"
              );
            }),
          ).toStrictEqual([]);
          if (caller === "disconnected") {
            controller.abort(new Error("caller disconnected during admission"));
          }
          if (caller === "rolled-back") {
            // Only rollback needs a blocked query to cancel. Keep the lock
            // until the request returns so cancellation wins over admission.
            await expect.poll(lock.waiterCount).toBe(1);
            await expect(lock.cancelBlockedQueries()).resolves.toBe(1);
          } else {
            lock.release();
          }
        }),
      ]);
      lock.release();
      await lock.done;
      if (caller === "connected") {
        expect(completedResponse.status).toBe(201);
      }
      const runs = await api.listAgentRuns(actor, {
        status: "pending,running,completed,failed,cancelled",
        limit: 100,
      });
      const run = runs.runs.find((candidate) => {
        return candidate.prompt === prompt;
      });
      if (caller === "rolled-back") {
        expect(completedResponse.status).toBe(500);
        expect(run).toBeUndefined();
        await sdk.disposed;
        await flushWaitUntilForTest();
        expect(sdk.disposeCount()).toBe(1);
        expect(requests).toHaveLength(0);
        expect(
          [...checkpointObjects.keys()].filter((key) => {
            return key.includes("/pi-api-first-turn/");
          }),
        ).toStrictEqual([]);
        return;
      }
      if (!run) {
        throw new Error("Expected the committed run to survive its caller");
      }
      await waitForRunStatus(actor, run.id, "completed", 10_000);
      expect(context.mocks.ably.publish.mock.calls).toContainEqual([
        "job",
        expect.objectContaining({ runId: run.id }),
      ]);
      expect(requests).toHaveLength(1);
      expect(sdk.disposeCount()).toBe(1);
    },
    30_000,
  );

  it("returns queued admission before a late SDK initializer finishes and releases its session once", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await api.heartbeatRunner(runnerGroup);
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold capacity for late initialization",
      model: "claude-sonnet-5",
    });
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const instructions = await publishPendingPiInstructions(actor, agentId);
    const thread = await chat.createThread(actor, { agentId });
    const sdkOwner = new AbortController();
    const sdk = await context.mocks.piSdk.controlInitialization(
      { sessionId: thread.id, instructions, holdInitialization: true },
      AbortSignal.any([context.signal, sdkOwner.signal]),
    );
    // Infrastructure must hold admission until the real SDK initializer has
    // started; no production endpoint can schedule that late-result boundary.
    const lock = await holdOrgAdmissionLockFixture({
      orgId: requireOrgId(actor),
      signal: context.signal,
    });
    const lockDone = settleIncludingAbort(lock.done);
    onTestFinished(async () => {
      lock.release();
      await lock.done;
    });
    const requests: string[] = [];
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
        const key = new URL(request.url).searchParams.get("object");
        if (!key) {
          throw new Error("Expected exact resource identity");
        }
        return new HttpResponse(piS3Object(key));
      }),
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.text());
        return nativeCodexSseResponse(
          piResponsesTextSse("unexpected speculative answer", requests.length),
        );
      }),
    );
    const send = sendChatRun(
      actor,
      {
        agentId,
        threadId: thread.id,
        prompt: "queue without waiting for SDK completion",
        model: "gpt-5.6-terra",
      },
      usagePricingResolution,
    );
    const observed = observePendingSend(send);
    const result = await settleIncludingAbort(async () => {
      await observed.beforeSettlement(sdk.entered);
      lock.release();
      await lock.done;
      const run = await send;
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "queued",
      });
      expect(sdk.disposeCount()).toBe(0);
      expect(requests).toHaveLength(0);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      sdk.release();
      await sdk.disposed;
      await flushWaitUntilForTest();
      expect(sdk.disposeCount()).toBe(1);
      expect(requests).toHaveLength(0);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "queued",
      });
      await cancelChatRun(actor, run.runId);
      await cancelChatRun(actor, anchor.runId);
    });
    sdk.release();
    lock.release();
    sdkOwner.abort(
      new DOMException("SDK preparation scope finished", "AbortError"),
    );
    const cleanup = await settleIncludingAbort(async () => {
      await observed.joinPhases();
      const [sent, unlocked] = await Promise.all([observed.result, lockDone]);
      await flushWaitUntilForTest();
      if (!unlocked.ok) {
        throw unlocked.error;
      }
      if (!result.ok && sent.ok) {
        await api.requestCancelRun(actor, sent.value.runId, [200, 400]);
      }
      if (!result.ok) {
        await api.requestCancelRun(actor, anchor.runId, [200, 400]);
      }
      await flushWaitUntilForTest();
      if (!sent.ok) {
        throw sent.error;
      }
    });
    if (!result.ok) {
      throw result.error;
    }
    if (!cleanup.ok) {
      throw cleanup.error;
    }
  }, 30_000);

  it("retains a pre-commit SDK initialization failure for canonical Sandbox handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await api.heartbeatRunner(runnerGroup);
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await updateFeatureSwitchesForUser(
      context,
      { ...actor, orgId: requireOrgId(actor) },
      { [FeatureSwitchKey.PiLoop]: true },
    );
    const usagePricingResolution = await createGptUsagePricingResolution();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const instructions = await publishPendingPiInstructions(actor, agentId);
    const thread = await chat.createThread(actor, { agentId });
    const initializationFailure = new Error(
      "Pi SDK initialization fixture failure",
    );
    const sdkOwner = new AbortController();
    const sdk = await context.mocks.piSdk.controlInitialization(
      {
        sessionId: thread.id,
        instructions,
        holdInitialization: false,
        initializationFailure,
      },
      AbortSignal.any([context.signal, sdkOwner.signal]),
    );
    // This real lock separates the external SDK failure from the durable
    // admission result without observing the private preparation handle.
    const lock = await holdOrgAdmissionLockFixture({
      orgId: requireOrgId(actor),
      signal: context.signal,
    });
    const lockDone = settleIncludingAbort(lock.done);
    onTestFinished(async () => {
      lock.release();
      await lock.done;
    });
    mockPiResourceArchiveDownloads();
    let providerCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        providerCalls += 1;
        return nativeCodexSseResponse(
          piResponsesTextSse("unexpected speculative answer", providerCalls),
        );
      }),
    );
    const prompt = "retain the original SDK preparation failure";
    const send = sendChatRun(
      actor,
      { agentId, threadId: thread.id, prompt, model: "gpt-5.6-terra" },
      usagePricingResolution,
    );
    const observed = observePendingSend(send);
    const result = await settleIncludingAbort(async () => {
      await observed.beforeSettlement(expect.poll(lock.waiterCount).toBe(1));
      await observed.beforeSettlement(sdk.failed);
      await expect(sdk.failed).resolves.toBe(initializationFailure);
      expect(sdk.initializationCount()).toBe(1);
      expect(providerCalls).toBe(0);
      expect(
        [...checkpointObjects.keys()].filter((key) => {
          return key.includes("/pi-api-first-turn/");
        }),
      ).toStrictEqual([]);
      const beforeCommit = (await chat.listThreadEvents(actor, thread.id))
        .events;
      expect(
        beforeCommit.filter((event) => {
          return (
            event.eventType.startsWith("output.") ||
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toStrictEqual([]);

      lock.release();
      await lock.done;
      const run = await send;
      await flushWaitUntilForTest();
      expect(context.mocks.ably.publish.mock.calls).toContainEqual([
        "job",
        expect.objectContaining({ runId: run.runId }),
      ]);
      // The existing PI_API_PREHEAT_FAILED classification permits this H0
      // transfer; an untyped model failure would instead fail the durable run.
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(
          checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}",
        ),
      );
      expect(manifest).toMatchObject({
        outcome: "ownership-transfer",
        mode: "sandbox-first",
        baseSession: { sessionId: thread.id, sha256: null },
        session: { sessionId: thread.id },
        sandboxEventSequenceStart: 1,
        apiUsage: {
          schemaVersion: 1,
          state: "no-inference",
          sampledAt: expect.any(Number),
        },
      });
      const sessionKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`;
      const h0 = MemoryPiSession.fromJsonl(
        checkpointObjects.get(sessionKey)?.toString("utf8") ?? "",
      );
      expect(h0.buildSessionContext().messages).toHaveLength(0);
      expect(providerCalls).toBe(0);
      expect(sdk.initializationCount()).toBe(1);
      expect(sdk.disposeCount()).toBe(0);
      await expectNoBuiltInModelUsage(run.runId);
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "pending",
      });
      const events = (await chat.listThreadEvents(actor, thread.id)).events;
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim).toMatchObject({
        cliAgentType: "pi",
        piSessionId: thread.id,
        prompt,
      });
      await cancelChatRun(actor, run.runId);
    });
    sdk.release();
    lock.release();
    sdkOwner.abort(
      new DOMException("SDK preparation scope finished", "AbortError"),
    );
    const cleanup = await settleIncludingAbort(async () => {
      await observed.joinPhases();
      const [sent, unlocked] = await Promise.all([observed.result, lockDone]);
      await flushWaitUntilForTest();
      if (!unlocked.ok) {
        throw unlocked.error;
      }
      if (!result.ok && sent.ok) {
        await api.requestCancelRun(actor, sent.value.runId, [200, 400]);
      }
      await flushWaitUntilForTest();
      if (!sent.ok) {
        throw sent.error;
      }
    });
    if (!result.ok) {
      throw result.error;
    }
    if (!cleanup.ok) {
      throw cleanup.error;
    }
  }, 30_000);

  it("uses newly published Pi instruction indexes with resource archives unavailable", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiCheckpointObjectStore();
    mockPiResourceArchiveDownloads();
    const requests: string[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.text());
        return nativeCodexSseResponse(
          piResponsesTextSse("indexed response", requests.length),
        );
      }),
    );
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      "Initial indexed instruction",
    );
    const queued = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "warm exact resource versions",
    });
    await completeChatRunOk(
      queued.anchor.runId,
      queued.anchorClaim.sandboxHeaders,
      { usagePricingResolution: queued.usagePricingResolution },
    );
    await waitForRunStatus(actor, queued.run.runId, "completed", 10_000);
    await flushWaitUntilForTest();

    // A new instruction version forces a new full-snapshot key. Its synchronous
    // index and the warmed shared versions must suffice without archive access.
    await bdd.updateAgentInstructions(
      actor,
      agentId,
      "Updated instruction available immediately",
    );
    mockPiResourceArchiveDownloads(true);
    const next = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "use the newly saved instructions",
        model: "gpt-5.6-terra",
      },
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, next.runId, "completed", 10_000);
    const events = (await chat.listThreadEvents(actor, next.threadId)).events;
    expect(eventBackedContents(events, next.runId)).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "indexed response" }),
      ]),
    );
    expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(
      "Updated instruction available immediately",
    );
    await flushWaitUntilForTest();
    const pendingInstructions = await publishPendingPiInstructions(
      actor,
      agentId,
    );
    let archiveReads = 0;
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
        archiveReads++;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected a resource archive identity");
        }
        return new HttpResponse(piS3Object(objectKey));
      }),
    );
    const pending = await sendChatRun(
      actor,
      {
        agentId,
        prompt: "load the one pending resource version",
        model: "gpt-5.6-terra",
      },
      queued.usagePricingResolution,
    );
    await waitForRunStatus(actor, pending.runId, "completed", 10_000);
    expect(archiveReads).toBe(1);
    expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(
      pendingInstructions,
    );
  }, 30_000);

  it.each(["created", "copied"] as const)(
    "discovers a newly %s Workflow without reading its archive",
    async (publication) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiCheckpointObjectStore();
      mockPiResourceArchiveDownloads();
      const requests: string[] = [];
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            requests.push(await request.text());
            return nativeCodexSseResponse(
              piResponsesTextSse("workflow indexed", requests.length),
            );
          },
        ),
      );
      const queued = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "warm shared resource versions",
      });
      await completeChatRunOk(
        queued.anchor.runId,
        queued.anchorClaim.sandboxHeaders,
        { usagePricingResolution: queued.usagePricingResolution },
      );
      await waitForRunStatus(actor, queued.run.runId, "completed", 10_000);
      await flushWaitUntilForTest();

      const sourceAgentId =
        publication === "created"
          ? agentId
          : (await bdd.createAgent(actor, { displayName: "Workflow source" }))
              .agentId;
      const name = `indexed-${randomUUID().slice(0, 8)}`;
      const workflow = await createMiscRoutesApi(context).createWorkflow(
        actor,
        sourceAgentId,
        name,
        { content: "Produce the indexed workflow report." },
        [201],
      );
      if (workflow.status !== 201) {
        throw new Error("Expected the workflow to be published");
      }
      if (publication === "copied") {
        routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
        await accept(
          setupApp({ context, routes: workflowsRoutes })(
            workflowsDetailContract,
          ).copy({
            headers: { authorization: "Bearer clerk-session" },
            params: { workflowId: workflow.body.id },
            body: { toAgentId: agentId },
          }),
          [201],
        );
      }
      mockPiResourceArchiveDownloads(true);
      const next = await sendChatRun(
        actor,
        {
          agentId,
          prompt: "discover the new workflow",
          model: "gpt-5.6-terra",
        },
        queued.usagePricingResolution,
      );
      await waitForRunStatus(actor, next.runId, "completed", 10_000);
      expect(piResponsesDeveloperPrompt(requests.at(-1))).toContain(name);
      const events = (await chat.listThreadEvents(actor, next.threadId)).events;
      expect(eventBackedContents(events, next.runId)).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "workflow indexed" }),
        ]),
      );
    },
    30_000,
  );

  it("transfers authoritative H0 when API ownership expires before provider transport", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const resourceEntered = createDeferredPromise<void>(context.signal);
    const releaseResource = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!resourceEntered.settled()) {
          resourceEntered.resolve(undefined);
        }
        await releaseResource.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive object identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return nativeCodexSseResponse(
          piResponsesTextSse("must not become H1", modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "replay the original pre-provider prompt in Sandbox";
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await resourceEntered.promise;
    // Speculative queued preparation can read resources before promotion; the
    // durable pending status is the Runner claim boundary.
    await waitForRunStatus(actor, run.runId, "pending", 5000);
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "deliver this input once after deadline transfer",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected deadline-bound active input to be reserved");
    }

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS);
    releaseResource.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);

    expect(modelCalls).toBe(0);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const h0 = checkpointObjects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
    );
    if (!h0) {
      throw new Error("Expected pre-provider deadline H0");
    }
    expect(
      MemoryPiSession.fromJsonl(h0.toString("utf8")).buildSessionContext()
        .messages,
    ).toHaveLength(0);
    expect(claimed.claim.prompt).toBe(prompt);
    expect(claimed.claim.piLaunchConfig?.apiFirstTurn.deadlineAt).toBe(
      apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS,
    );
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const activeInputEvents = await chat.listThreadEvents(actor, run.threadId);
    expect(
      activeInputEvents.events.filter((event) => {
        return event.revokesEventId === activeInputEventId;
      }),
    ).toHaveLength(1);
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  }, 90_000);

  it("discards a late API success and completes once from sandbox-first H0", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    const lateApiAnswer = "late API answer must remain usage-only";
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        providerEntered.resolve(undefined);
        await releaseProvider.promise;
        return nativeCodexSseResponse(
          piResponsesTextSse(lateApiAnswer, modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const prompt = "complete the timed-out prompt once in Sandbox";
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt,
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await providerEntered.promise;

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
    releaseProvider.resolve(undefined);
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
    await expect
      .poll(() => {
        return checkpointObjects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);

    expect(modelCalls).toBe(1);
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(checkpointObjects.get(manifestKey)?.toString("utf8") ?? "{}"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      baseSession: { sessionId: run.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    const beforeSandbox = eventBackedContents(
      (await chat.listThreadEvents(actor, run.threadId)).events,
      run.runId,
    );
    expect(beforeSandbox).toStrictEqual([]);
    await flushWaitUntilForTest();
    // Pending late-attempt usage is intentionally absent from public usage
    // summaries, so inspect this run's uniquely owned ledger rows directly.
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toMatchObject([
      { category: "tokens.input", quantity: 5, status: "pending" },
      { category: "tokens.output", quantity: 3, status: "pending" },
    ]);

    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.prompt).toBe(prompt);
    const sandboxAnswer = "Sandbox owns the only visible answer";
    await completeSandboxFirstPiRun({
      actor,
      answer: sandboxAnswer,
      checkpointObjects,
      claim: claimed,
      prompt,
      run,
      usagePricingResolution,
    });
    await expectTerraApiFollowUpUsage(run.runId);

    const completedEvents = (await chat.listThreadEvents(actor, run.threadId))
      .events;
    expect(
      eventBackedContents(completedEvents, run.runId).filter((message) => {
        return message.content === sandboxAnswer;
      }),
    ).toHaveLength(1);
    expect(JSON.stringify(completedEvents)).not.toContain(lateApiAnswer);
    expect(
      completedEvents.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.completed" }]);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "completed",
    });
  }, 90_000);

  it("lets canonical cancellation win the deadline ownership boundary", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        providerEntered.resolve(undefined);
        await releaseProvider.promise;
        return nativeCodexSseResponse(
          piResponsesTextSse("cancelled late API result", modelCalls),
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "cancel at the timeout transfer boundary",
      });
    const apiStartedAt = now();
    mockNow(apiStartedAt);
    onTestFinished(() => {
      clearMockNow();
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await providerEntered.promise;

    mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
    await cancelBeforeLatePiResult(
      actor,
      run.runId,
      () => {
        releaseProvider.resolve(undefined);
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(1);
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ),
    ).toStrictEqual([]);
    await expectTerraApiFollowUpUsage(run.runId);
    await api.requestClaimRunnerJob(true, run.runId, [404], {
      capabilities: { piModelConfigGenerations: [1, 2, 3] },
    });
  }, 90_000);

  it.each(["deadline", "model failure"] as const)(
    "fails once when deadline handoff cannot settle by the coordination cap after %s",
    async (trigger) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          modelCalls += 1;
          providerEntered.resolve(undefined);
          await releaseProvider.promise;
          if (trigger === "model failure") {
            return HttpResponse.json(
              { error: "private-model-failure-sentinel" },
              { status: 525 },
            );
          }
          return nativeCodexSseResponse(
            piResponsesTextSse("late result before handoff expiry", modelCalls),
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "expire the bounded handoff publication",
        });
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      onTestFinished(() => {
        clearMockNow();
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await providerEntered.promise;
      // No public API can deterministically hold this lifecycle transaction
      // across the coordination cap; this run-owned fixture isolates that race.
      const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lifecycleLock.release();
        await lifecycleLock.done;
      });

      if (trigger === "deadline") {
        mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
      }
      releaseProvider.resolve(undefined);
      await expect.poll(lifecycleLock.waiterCount).toBe(1);
      mockNow(apiStartedAt + API_FIRST_TURN_COORDINATION_BUDGET_MS);
      lifecycleLock.release();
      await lifecycleLock.done;
      await waitForRunStatus(actor, run.runId, "failed", 5000);
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      if (trigger === "deadline") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
    },
    90_000,
  );

  it.each(["deadline", "model failure"] as const)(
    "emits one canonical warning when the sandbox retry fails after %s",
    async (trigger) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          modelCalls += 1;
          providerEntered.resolve(undefined);
          await releaseProvider.promise;
          if (trigger === "model failure") {
            return HttpResponse.json(
              { error: "private-model-failure-sentinel" },
              { status: 525 },
            );
          }
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded before Sandbox failure", modelCalls),
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "let the single Sandbox recovery fail",
        });
      const apiStartedAt = now();
      mockNow(apiStartedAt);
      onTestFinished(() => {
        clearMockNow();
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await providerEntered.promise;
      if (trigger === "deadline") {
        mockNow(apiStartedAt + API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 2000);
      }
      releaseProvider.resolve(undefined);
      const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`;
      await expect
        .poll(() => {
          return checkpointObjects.get(manifestKey);
        })
        .toBeInstanceOf(Buffer);
      const claimed = await claimChatRun(runnerGroup, run.runId);

      await webhooks.requestAgentComplete(
        {
          runId: run.runId,
          exitCode: 1,
          error: "Sandbox retry failed",
        },
        claimed.sandboxHeaders,
        [200],
        undefined,
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "failed", 5000);
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      if (trigger === "deadline") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
    },
    90_000,
  );
});
