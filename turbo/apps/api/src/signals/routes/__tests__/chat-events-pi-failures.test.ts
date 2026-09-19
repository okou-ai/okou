import { createHash, randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import {
  holdPiApiFirstTurnLifecycleLockFixture,
  readRunUsageEventsFixture,
} from "../../../test-fixtures/chat-events";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { expectApiError } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  API_FIRST_TURN_OWNERSHIP_BUDGET_MS,
  GPT_PI_BDD_MODELS,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  expectPiApiUsage,
  expectTerraApiUsage,
  expectTerraApiFollowUpUsage,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  eventBackedContents,
  type PiCheckpointS3Command,
  piS3ObjectKey,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  piResponsesContentSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  authDeviceSupport,
  entitledChatActor,
  configureBuiltInPiModel,
  configureUserOwnedGptPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  claimGptPiSandbox,
  cancelBeforeLatePiResult,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  expectPiApiFirstTurnTerminalWithoutOutput,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  queueCapabilityProvenPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: model-first provider policies", () => {
  it("keeps explicit subscription allowance terminal instead of retrying its HTTP 429", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor);
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    let calls = 0;
    server.use(
      http.post("https://chatgpt.com/backend-api/codex/responses", () => {
        calls += 1;
        return HttpResponse.json(
          {
            error: {
              code: "usage_limit_reached",
              message: "Subscription allowance exhausted",
            },
          },
          { status: 429 },
        );
      }),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "respect the subscription allowance",
      runOptions: { codexServiceTier: "fast" },
    });
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([
      { eventType: "run.failed", failureReason: "usage_limit" },
    ]);
    expectNoPiApiFirstTurnArtifacts(run.runId, objects);
    await api.heartbeatRunner(runnerGroup);
    await api.requestClaimRunnerJob(true, run.runId, [404]);
    expect(calls).toBe(1);
  });

  it.each([200, 503])(
    "keeps explicit queue expiry terminal after HTTP %s without a Sandbox retry",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const message =
        "We were unable to start processing your request within the 900-second timeout limit. Please try again later.";
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls++;
          const error = { code: "server_error", message };
          return status === 200
            ? nativeCodexSseResponse(
                `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error } })}\n\n`,
              )
            : HttpResponse.json({ error }, { status });
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "stop after the provider expires its queue",
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(modelCalls).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      expect(
        (await chat.listThreadEvents(actor, run.threadId)).events,
      ).toContainEqual(
        expect.objectContaining({
          runId: run.runId,
          eventType: "run.failed",
          failureReason: "provider_queue_timeout",
        }),
      );
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );

  it("lets canonical cancellation win before provider ownership without API artifacts", async () => {
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
        return new HttpResponse(piResponsesTextSse("late", modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "cancel before the provider boundary",
    });

    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await resourceEntered.promise;
    await cancelChatRun(actor, run.runId);
    releaseResource.resolve(undefined);
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(0);
    await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
      [],
    );
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
      ),
    ).toBeFalsy();
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ),
    ).toHaveLength(0);
    const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
    expect(claim.status).toBe(404);
  }, 90_000);

  it.each([
    { name: "run cancel route", kind: "cancel" as const },
    { name: "chat interrupt route", kind: "interrupt" as const },
  ])(
    "canonicalizes uppercase cancellation through the $name before lifecycle locking and provider abort",
    async ({ kind }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const providerAborted = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseProvider.settled()) {
          releaseProvider.resolve(undefined);
        }
      });
      let modelCalls = 0;
      server.use(
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            modelCalls += 1;
            const markProviderAborted = () => {
              if (!providerAborted.settled()) {
                providerAborted.resolve(undefined);
              }
            };
            if (request.signal.aborted) {
              markProviderAborted();
            } else {
              request.signal.addEventListener("abort", markProviderAborted, {
                once: true,
              });
            }
            if (!providerEntered.settled()) {
              providerEntered.resolve(undefined);
            }
            await releaseProvider.promise;
            return new HttpResponse(
              piResponsesTextSse(
                "discard this late provider result",
                modelCalls,
              ),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        ),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "cancel one in-flight API-first request",
      });

      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      await providerEntered.promise;
      // No public API holds this transaction open. The scoped fixture proves
      // that both UUID spellings select the same production advisory-lock key.
      const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lifecycleLock.release();
        await lifecycleLock.done;
      });
      const cancellation =
        kind === "cancel"
          ? api.requestCancelRun(actor, run.runId.toUpperCase(), [200])
          : chat.requestSendEvent(
              actor,
              {
                agentId,
                threadId: run.threadId,
                interruptsRunId: run.runId.toUpperCase(),
                clientEventId: randomUUID(),
              },
              [201],
            );
      await expect.poll(lifecycleLock.waiterCount).toBe(1);
      lifecycleLock.release();
      await lifecycleLock.done;
      const cancelled = await cancellation;
      if (kind === "cancel") {
        expect(cancelled.body).toMatchObject({
          id: run.runId,
          status: "cancelled",
        });
      } else {
        expect(cancelled.body).toMatchObject({
          runId: null,
          threadId: run.threadId,
        });
      }
      await expect
        .poll(() => {
          return providerAborted.settled();
        })
        .toBeTruthy();
      await providerAborted.promise;
      expect(modelCalls).toBe(1);
      releaseProvider.resolve(undefined);
      await flushWaitUntilForTest();

      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(modelCalls).toBe(1);
      await expect(readRunUsageEventsFixture(run.runId)).resolves.toStrictEqual(
        [],
      );
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404]);
      expect(claim.status).toBe(404);
    },
    90_000,
  );

  it.each([
    ...GPT_PI_BDD_MODELS.flatMap((selectedModel) => {
      return (["openai", "openrouter"] as const).map((gptRoute) => {
        return {
          name: `${gptRoute} ${selectedModel}`,
          selectedModel,
          providerUrl:
            gptRoute === "openai"
              ? "https://api.openai.com/v1/responses"
              : "https://openrouter.ai/api/v1/responses",
          observedServiceTier: "default",
          codexServiceTier: "fast" as const,
          gptRoute,
          inputTokens: 10,
          expectedInput: 5,
        };
      });
    }),
    {
      name: "built-in DeepSeek Flash",
      selectedModel: "deepseek-v4-flash",
      providerUrl: "https://api.deepseek.com/responses",
      observedServiceTier: "priority",
      codexServiceTier: undefined,
      gptRoute: undefined,
      inputTokens: 300_000,
      expectedInput: 299_995,
    },
    {
      name: "built-in DeepSeek V4.1 Flash",
      selectedModel: "deepseek-v4.1-flash",
      providerUrl: "https://api.deepseek.com/responses",
      observedServiceTier: "default",
      codexServiceTier: undefined,
      gptRoute: undefined,
      inputTokens: 300_000,
      expectedInput: 299_995,
    },
  ] as const)(
    "bills one late $name result exactly once after cancellation wins",
    async ({
      selectedModel,
      providerUrl,
      observedServiceTier,
      codexServiceTier,
      gptRoute,
      inputTokens,
      expectedInput,
    }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const providerEntered = createDeferredPromise<void>(context.signal);
      const releaseProvider = createDeferredPromise<void>(context.signal);
      let modelCalls = 0;
      const modelRequests: unknown[] = [];
      server.use(
        http.post(providerUrl, async ({ request }) => {
          modelCalls += 1;
          modelRequests.push(await request.json());
          if (!providerEntered.settled()) {
            providerEntered.resolve(undefined);
          }
          await releaseProvider.promise;
          return new HttpResponse(
            piResponsesTextSse(
              "result blocked before publication",
              modelCalls,
              {
                input_tokens: inputTokens,
                output_tokens: 3,
                total_tokens: inputTokens + 3,
                input_tokens_details: {
                  cached_tokens: 3,
                  cache_write_tokens: 2,
                },
              },
              observedServiceTier,
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "let cancellation commit before API publication",
          ...(codexServiceTier === undefined ? {} : { codexServiceTier }),
          ...(gptRoute === undefined ? {} : { gptRoute }),
          selectedModel,
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      await providerEntered.promise;
      const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
        runId: run.runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        lifecycleLock.release();
        await lifecycleLock.done;
      });

      const cancellation = api.requestCancelRun(
        actor,
        run.runId,
        [200],
        usagePricingResolution,
      );
      await expect.poll(lifecycleLock.waiterCount).toBe(1);
      releaseProvider.resolve(undefined);
      await expect.poll(lifecycleLock.waiterCount).toBe(2);
      lifecycleLock.release();
      await lifecycleLock.done;
      await cancellation;
      await flushWaitUntilForTest();

      expect(modelCalls).toBe(1);
      if (codexServiceTier === "fast") {
        expect(
          z
            .object({ service_tier: z.literal("priority") })
            .passthrough()
            .parse(modelRequests[0]).service_tier,
        ).toBe("priority");
      } else {
        expect(modelRequests[0]).not.toHaveProperty("service_tier");
      }
      await expectPiApiUsage(
        run.runId,
        selectedModel,
        gptRoute === "openai" ? ".fast" : "",
        {
          input: expectedInput,
          output: 3,
          cacheRead: 3,
          cacheCreation: 2,
        },
      );
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
    },
    90_000,
  );

  it("keeps API completion terminal when it wins the lifecycle lock before cancellation", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const providerEntered = createDeferredPromise<void>(context.signal);
    const releaseProvider = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    const answer = "completion committed before cancellation";
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        if (!providerEntered.settled()) {
          providerEntered.resolve(undefined);
        }
        await releaseProvider.promise;
        return new HttpResponse(piResponsesTextSse(answer, modelCalls), {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );
    mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run } = await queueCapabilityProvenPiRun({
      actor,
      agentId,
      runnerGroup,
      prompt: "let API completion commit first",
    });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
    await providerEntered.promise;
    const lifecycleLock = await holdPiApiFirstTurnLifecycleLockFixture({
      runId: run.runId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      lifecycleLock.release();
      await lifecycleLock.done;
    });

    releaseProvider.resolve(undefined);
    await expect.poll(lifecycleLock.waiterCount).toBe(1);
    const cancellation = api.requestCancelRun(actor, run.runId, [400]);
    await expect.poll(lifecycleLock.waiterCount).toBe(2);
    lifecycleLock.release();
    await lifecycleLock.done;
    const cancelResponse = await cancellation;
    expectApiError(cancelResponse.body);
    expect(cancelResponse.body.error.message).toContain(
      "Run cannot be cancelled",
    );
    await waitForRunStatus(actor, run.runId, "completed", 5000);
    await flushWaitUntilForTest();

    expect(modelCalls).toBe(1);
    expect(
      eventBackedContents(
        (await chat.listThreadEvents(actor, run.threadId)).events,
        run.runId,
      ).filter((message) => {
        return message.content === answer;
      }),
    ).toHaveLength(1);
  }, 90_000);

  it.each([
    { name: "text below cap", content: "text", atCap: false },
    { name: "text at cap", content: "text", atCap: true },
    { name: "empty", content: "empty", atCap: false },
    { name: "thinking-only", content: "thinking", atCap: false },
  ] as const)(
    "fails incomplete Pi $name output once after recording consumed Built-in usage",
    async ({ content, atCap }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const usagePricingResolution = await createGptUsagePricingResolution();
      await configureBuiltInPiModel(actor, "gpt-5.6-terra");
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PiLoop]: true,
      });
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const consumedAgentEvents: { runId: string; eventType: string }[] = [];
      const requests: unknown[] = [];
      let outputTokens = 0;
      const partialText = `private-incomplete-answer-${randomUUID()}`;
      server.use(
        http.post(
          "https://api.axiom.co/v1/datasets/agent-run-events/ingest",
          async ({ request }) => {
            const events = z
              .array(z.object({ runId: z.string(), eventType: z.string() }))
              .parse(await request.json());
            consumedAgentEvents.push(...events);
            return HttpResponse.json({
              ingested: events.length,
              failed: 0,
              processedBytes: 123,
            });
          },
        ),
        http.post(
          "https://api.openai.com/v1/responses",
          async ({ request }) => {
            const body = await request.json();
            requests.push(body);
            const { max_output_tokens: cap } = z
              .object({ max_output_tokens: z.number().int().positive() })
              .parse(body);
            expect(cap).toBeGreaterThan(3);
            outputTokens = atCap ? cap : 3;
            return nativeCodexSseResponse(
              piResponsesContentSse({
                sequence: requests.length,
                blocks:
                  content === "text"
                    ? [{ type: "text", text: partialText }]
                    : [],
                includeReasoning: content === "thinking",
                incomplete: true,
                usage: {
                  input_tokens: 10,
                  output_tokens: outputTokens,
                  total_tokens: 10 + outputTokens,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                },
              }),
            );
          },
        ),
      );
      const run = await sendChatRun(
        actor,
        {
          agentId,
          model: "gpt-5.6-terra",
          prompt: "finish one API-first answer",
        },
        usagePricingResolution,
      );
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        [...objects.keys()].filter((key) => {
          return key.includes("/blobs/");
        }),
      ).toStrictEqual([]);
      expect(requests).toHaveLength(1);
      // The existing run-scoped usage observation is the only billing ledger
      // surface; public usage summaries cannot prove per-category exactness.
      await expectTerraApiUsage(run.runId, "", {
        input: 5,
        output: outputTokens,
        cacheRead: 3,
        cacheCreation: 2,
      });
      expect(context.mocks.ably.channelGet).toHaveBeenCalledWith(
        `runner-group:${runnerGroup}`,
      );
      expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
        runId: run.runId,
        mode: "hard",
      });
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      const sandboxHeaders = {
        authorization: `Bearer ${api.sandboxTokenForRun(actor, run.runId)}`,
      };
      await webhooks.requestAgentComplete(
        { runId: run.runId, exitCode: 0 },
        sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      await expectTerraApiUsage(run.runId, "", {
        input: 5,
        output: outputTokens,
        cacheRead: 3,
        cacheCreation: 2,
      });
      expect(requests).toHaveLength(1);
      expect(
        (await chat.listThreadEvents(actor, run.threadId)).events.filter(
          (event) => {
            return (
              event.runId === run.runId && event.eventType === "run.failed"
            );
          },
        ),
      ).toStrictEqual([
        expect.objectContaining({ failureReason: "output_token_limit" }),
      ]);
      expect(
        consumedAgentEvents.filter((event) => {
          return event.runId === run.runId;
        }),
      ).toStrictEqual([]);
    },
    90_000,
  );

  it.each(USER_OWNED_GPT_FAST_BDD_ROUTES)(
    "fails incomplete Pi $name Fast output without Built-in billing or provider substitution",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureUserOwnedGptPiModel(actor, route);
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: string[] = [];
      server.use(
        ...USER_OWNED_GPT_FAST_BDD_ROUTES.map((candidate) => {
          return http.post(candidate.endpoint, ({ request }) => {
            requests.push(request.url);
            return nativeCodexSseResponse(
              piResponsesContentSse({
                sequence: requests.length,
                blocks: [
                  { type: "text", text: "incomplete user-owned answer" },
                ],
                incomplete: true,
              }),
            );
          });
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "finish the user-owned turn",
        runOptions: { codexServiceTier: "fast" },
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
      await expectNoBuiltInModelUsage(run.runId);
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      expect(
        [...objects.keys()].filter((key) => {
          return key.includes("/blobs/");
        }),
      ).toStrictEqual([]);
      await api.heartbeatRunner(runnerGroup);
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expect(requests).toStrictEqual([route.endpoint]);
    },
    90_000,
  );

  it.each(["in-flight", "late-result"] as const)(
    "keeps canonical cancellation ahead of incomplete Pi output at the %s boundary",
    async (phase) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let requests = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", async () => {
          requests += 1;
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesContentSse({
              sequence: requests,
              blocks: [{ type: "text", text: "incomplete cancelled answer" }],
              incomplete: true,
            }),
          );
        }),
      );
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "cancel an incomplete API-first turn",
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(
          actor,
          run.runId,
          () => {
            release.resolve(undefined);
          },
          usagePricingResolution,
        );
      } else {
        await api.requestCancelRun(
          actor,
          run.runId,
          [200],
          usagePricingResolution,
        );
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "cancelled");
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      if (phase === "late-result") {
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        await expectNoBuiltInModelUsage(run.runId);
      }
      await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expect(requests).toBe(1);
    },
    90_000,
  );

  it("fails incomplete Pi output while preserving undelivered active-input ownership", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const requests: unknown[] = [];
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        if (!entered.settled()) {
          entered.resolve(undefined);
        }
        await release.promise;
        return nativeCodexSseResponse(
          piResponsesContentSse({
            sequence: requests.length,
            blocks: [
              {
                type: "text",
                text:
                  requests.length === 1
                    ? "incomplete before accepted steer"
                    : "completed the separately queued input",
              },
            ],
            incomplete: requests.length === 1,
          }),
        );
      }),
    );
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "hold the incomplete API-first turn",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await entered.promise;
    const claimed = await claimChatRun(runnerGroup, run.runId);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "keep this accepted input",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claimed.claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected in-flight active input to be reserved");
    }
    expect(reserved.prompt).toContain("keep this accepted input");
    release.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "failed");
    await flushWaitUntilForTest();
    await expectPiApiFirstTurnTerminalWithoutOutput(actor, run, "failed");
    expectNoPiApiFirstTurnArtifacts(run.runId, objects);
    await expect(
      api.reserveRunnerActiveInputs(claimed.claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual({ outcome: "terminal" });
    await expect(
      api.recordRunnerActiveInputDelivery(
        claimed.claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toMatchObject({ outcome: "rejected" });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return event.id === activeInputEventId;
      }),
    ).toHaveLength(1);
    const replacements = events.filter((event) => {
      return event.revokesEventId === activeInputEventId;
    });
    expect(replacements).toHaveLength(1);
    const successor = replacements[0];
    if (!successor?.runId) {
      throw new Error("Expected undelivered input to retain queue ownership");
    }
    expect(successor.runId).not.toBe(run.runId);
    // Terminal failure releases the accepted input into its own queued run.
    // That explicit input owns the second request; the failed turn is not retried.
    await waitForRunStatus(actor, successor.runId, "completed");
    expect(eventBackedContents(events, successor.runId)).toMatchObject([
      { content: "completed the separately queued input" },
    ]);
    expect(JSON.stringify(requests[1])).toContain("keep this accepted input");
    expect(JSON.stringify(requests[1])).not.toContain(
      "incomplete before accepted steer",
    );
    await expectTerraApiFollowUpUsage(run.runId);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith("cancel", {
      runId: run.runId,
      mode: "hard",
    });
    expect(requests).toHaveLength(2);
  }, 90_000);

  it("preserves ordinary Pi stop checkpoints and length with pending tools after incomplete output fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PiLoop]: true,
    });
    mockPiResourceArchiveDownloads();
    const objects = mockPiCheckpointObjectStore();
    const requests: unknown[] = [];
    const answer = "the last complete canonical answer";
    const incompleteAnswer = "discarded incomplete canonical answer";
    const callId = `call_length_${randomUUID()}`;
    server.use(
      http.post("https://api.openai.com/v1/responses", async ({ request }) => {
        requests.push(await request.json());
        return nativeCodexSseResponse(
          piResponsesContentSse({
            sequence: requests.length,
            incomplete: requests.length !== 1,
            blocks:
              requests.length === 3
                ? [
                    {
                      type: "toolCall",
                      callId,
                      name: "bash",
                      arguments: {
                        command: "printf incomplete-tool-must-not-run",
                      },
                    },
                  ]
                : [
                    {
                      type: "text",
                      text: requests.length === 1 ? answer : incompleteAnswer,
                    },
                  ],
          }),
        );
      }),
    );
    const first = await sendChatRun(
      actor,
      {
        agentId,
        model: "gpt-5.6-terra",
        prompt: "create the last complete checkpoint",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    expect(requests).toHaveLength(1);
    const firstEvents = (await chat.listThreadEvents(actor, first.threadId))
      .events;
    expect(eventBackedContents(firstEvents, first.runId)).toMatchObject([
      { content: answer },
    ]);
    expect(
      firstEvents.filter((event) => {
        return (
          event.runId === first.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.completed" }]);
    await expectTerraApiFollowUpUsage(first.runId);
    const blobEntries = [...objects.entries()].filter(([key]) => {
      return key.includes("/blobs/");
    });
    expect(blobEntries).toHaveLength(1);
    const h0 = blobEntries[0]?.[1];
    if (!h0) {
      throw new Error("Expected the ordinary stop checkpoint");
    }
    const h0Hash = createHash("sha256").update(h0).digest("hex");

    const failed = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "produce incomplete output on the existing session",
      },
      usagePricingResolution,
    );
    await waitForRunStatus(actor, failed.runId, "failed");
    await flushWaitUntilForTest();
    await expectPiApiFirstTurnTerminalWithoutOutput(actor, failed, "failed");
    expectNoPiApiFirstTurnArtifacts(failed.runId, objects);
    expect(
      [...objects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      }),
    ).toStrictEqual(blobEntries);
    expect(requests).toHaveLength(2);

    // Only this explicit user request continues the last successful H0. The
    // failed turn cannot publish a new canonical checkpoint or start a retry.
    const next = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue the preserved canonical session with tools",
      },
      usagePricingResolution,
    );
    const manifestKey = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${next.runId}/manifest.json`;
    await expect
      .poll(() => {
        return objects.get(manifestKey);
      })
      .toBeInstanceOf(Buffer);
    await flushWaitUntilForTest();
    const manifestBytes = objects.get(manifestKey);
    if (!manifestBytes) {
      throw new Error("Expected pending-tool ownership transfer");
    }
    expect(
      piApiFirstTurnManifestSchema.parse(
        JSON.parse(manifestBytes.toString("utf8")),
      ),
    ).toMatchObject({
      outcome: "ownership-transfer",
      mode: "pending-tool-continuation",
      baseSession: { sessionId: first.threadId, sha256: h0Hash },
    });
    const claimed = await claimChatRun(runnerGroup, next.runId);
    expect(claimed.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: h0Hash },
    });
    const h1 = objects.get(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${next.runId}/session.jsonl`,
    );
    if (!h1) {
      throw new Error("Expected length plus pending-tool H1");
    }
    const pending = MemoryPiSession.fromJsonl(h1.toString("utf8"))
      .buildSessionContext()
      .messages.at(-1);
    expect(pending).toMatchObject({
      role: "assistant",
      stopReason: "length",
      content: [expect.objectContaining({ type: "toolCall", name: "bash" })],
    });
    expect(occurrences(JSON.stringify(requests[2]), answer)).toBe(1);
    expect(JSON.stringify(requests[2])).not.toContain(incompleteAnswer);
    expect(
      [...objects.entries()].filter(([key]) => {
        return key.includes("/blobs/");
      }),
    ).toStrictEqual(blobEntries);
    const events = (await chat.listThreadEvents(actor, next.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === next.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toStrictEqual([]);
    await cancelChatRun(actor, next.runId, claimed.sandboxHeaders);
    expect(requests).toHaveLength(3);
  }, 90_000);

  it.each([
    { name: "HTTP 429", status: 429, category: "http_error" },
    { name: "HTTP 522", status: 522, category: "http_error" },
    { name: "HTTP 525", status: 525, category: "http_error" },
    { name: "unknown model failure", status: 200, category: "unknown" },
    { name: "terminated stream", status: 200, category: "stream_terminated" },
    { name: "failed result with usage", status: 200, category: "unknown" },
  ])(
    "hands $name directly to Sandbox and completes the same run once",
    async (scenario) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      const privateMarker = "private-provider-sentinel-32751";
      const partial = "partial assistant output must not become H1";
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          if (scenario.status !== 200) {
            return HttpResponse.json(
              {
                error: {
                  message: `${privateMarker} https://private.example/?token=secret ${"x".repeat(10_000)}`,
                },
              },
              { status: scenario.status },
            );
          }
          const body = piResponsesTextSse(partial, 1);
          if (scenario.name === "failed result with usage") {
            return nativeCodexSseResponse(
              body
                .replace(
                  '"type":"response.completed"',
                  '"type":"response.incomplete"',
                )
                .replace(
                  '"status":"completed","output"',
                  '"status":"incomplete","output"',
                ),
            );
          }
          const prefix = body.slice(0, body.lastIndexOf("data: "));
          if (scenario.name === "terminated stream") {
            let emitted = false;
            return new HttpResponse(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (!emitted) {
                    emitted = true;
                    controller.enqueue(new TextEncoder().encode(prefix));
                  } else {
                    controller.error(new TypeError("terminated"));
                  }
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          return nativeCodexSseResponse(
            `${prefix}data: ${JSON.stringify({ type: "error", code: "unknown", message: privateMarker })}\n\n`,
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const prompt = "keep the original input for one Sandbox handoff";
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt,
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await flushWaitUntilForTest();
      const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/`;
      const manifest = piApiFirstTurnManifestSchema.parse(
        JSON.parse(
          checkpointObjects.get(`${prefix}manifest.json`)?.toString("utf8") ??
            "{}",
        ),
      );
      expect(manifest).toMatchObject({
        schemaVersion: 3,
        outcome: "ownership-transfer",
        mode: "sandbox-first",
        baseSession: { sessionId: run.threadId, sha256: null },
        sandboxEventSequenceStart: 1,
      });
      const h0 = checkpointObjects.get(`${prefix}session.jsonl`);
      if (!h0) {
        throw new Error("Expected original H0 after model failure");
      }
      expect(
        MemoryPiSession.fromJsonl(h0.toString("utf8")).buildSessionContext()
          .messages,
      ).toStrictEqual([]);
      expect(manifest.session).toMatchObject({
        sessionId: run.threadId,
        rawSize: h0.length,
        sha256: createHash("sha256").update(h0).digest("hex"),
      });
      expect(modelCalls).toBe(1);
      const before = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(eventBackedContents(before, run.runId)).toStrictEqual([]);
      expect(
        before.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toStrictEqual([]);
      expect(context.mocks.ably.publish).not.toHaveBeenCalledWith(
        "cancel",
        expect.objectContaining({ runId: run.runId }),
      );
      expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
      const claimed = await claimChatRun(runnerGroup, run.runId);
      expect(claimed.claim.prompt).toBe(prompt);
      const answer = "Sandbox recovered the failed model turn";
      await completeSandboxFirstPiRun({
        actor,
        answer,
        checkpointObjects,
        claim: claimed,
        prompt,
        run,
        usagePricingResolution,
      });
      if (scenario.name === "failed result with usage") {
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
      ).toMatchObject([{ eventType: "run.completed" }]);
      expect(
        eventBackedContents(events, run.runId).filter((event) => {
          return event.content === answer;
        }),
      ).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(partial);
      expect(modelCalls).toBe(1);
    },
    90_000,
  );

  it("preserves subscription H0 and active input after a failed resumed model turn", async () => {
    mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor, {
      accountId: "model-handoff-account",
    });
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://chatgpt.com/backend-api/codex/responses", async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return nativeCodexSseResponse(
            piResponsesTextSse("previous settled subscription answer", 0),
          );
        }
        entered.resolve(undefined);
        await release.promise;
        return HttpResponse.json(
          { error: "private subscription provider failure" },
          { status: 525 },
        );
      }),
    );
    const first = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "establish original subscription history",
    });
    await waitForRunStatus(actor, first.runId, "completed");
    await flushWaitUntilForTest();
    const prompt = "resume from the settled subscription H0";
    const run = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      model: "gpt-5.6-terra",
      prompt,
    });
    await entered.promise;
    await api.heartbeatRunner(runnerGroup);
    const claim = await claimGptPiSandbox(actor, run.runId, undefined);
    const activeInputEventId = randomUUID();
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "preserve this in-flight active input",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const reserved = await api.reserveRunnerActiveInputs(
      claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected one reserved active input");
    }
    release.resolve(undefined);
    await flushWaitUntilForTest();
    const prefix = `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/`;
    const manifest = piApiFirstTurnManifestSchema.parse(
      JSON.parse(
        checkpointObjects.get(`${prefix}manifest.json`)?.toString("utf8") ??
          "{}",
      ),
    );
    expect(manifest).toMatchObject({
      outcome: "ownership-transfer",
      mode: "sandbox-first",
      sandboxEventSequenceStart: 1,
      baseSession: { sessionId: first.threadId, sha256: expect.any(String) },
    });
    expect(claim.prompt).toBe(prompt);
    expect(claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: manifest.baseSession.sha256 },
    });
    const h0 = checkpointObjects.get(`${prefix}session.jsonl`);
    expect(h0).toStrictEqual(
      checkpointObjects.get(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${manifest.baseSession.sha256}.blob`,
      ),
    );
    expect(h0?.toString("utf8")).toContain(
      "previous settled subscription answer",
    );
    expect(h0?.toString("utf8")).not.toContain(prompt);
    await expect(
      api.reserveRunnerActiveInputs(claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return event.revokesEventId === activeInputEventId;
      }),
    ).toHaveLength(1);
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toStrictEqual([]);
    expect(modelCalls).toBe(2);
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    await expectNoBuiltInModelUsage(run.runId);
    await cancelChatRun(actor, run.runId, {
      authorization: `Bearer ${claim.sandboxToken}`,
    });
  }, 90_000);

  it("keeps a raw API usage failure terminal before aborting its private attempt", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", () => {
        modelCalls += 1;
        return nativeCodexSseResponse(
          piResponsesTextSse(
            "invalid usage must not authorize H0 replay",
            modelCalls,
            {
              input_tokens: 1.5,
              output_tokens: 3,
              total_tokens: 4.5,
            },
          ),
        );
      }),
    );
    const objects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "reject invalid provider usage without retrying the prompt",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, run.runId, "failed");
    expect(modelCalls).toBe(1);
    expectNoPiApiFirstTurnArtifacts(run.runId, objects);
    await expectPiApiFirstTurnTerminalWithoutOutput(
      actor,
      run,
      "failed",
      "[PI_API_MODEL_FAILED] Pi API first turn failed",
    );
    await expectNoBuiltInModelUsage(run.runId);
  }, 90_000);

  it.each(["H1 commit", "H1 deadline", "handoff publication"] as const)(
    "keeps a genuine %s failure terminal without replaying H0",
    async (stage) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return stage !== "handoff publication"
            ? nativeCodexSseResponse(
                piResponsesTextSse("uncommitted API answer", 1),
              )
            : HttpResponse.json(
                { error: "private model sentinel" },
                { status: 429 },
              );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "surface the real publication failure",
        });
      const deadline = new AbortController();
      onTestFinished(() => {
        deadline.abort();
      });
      if (stage === "H1 deadline") {
        // The public API cannot expire an OS timer at the H1 write boundary.
        // Keep real AbortSignal propagation with this test-owned deadline.
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          return milliseconds > API_FIRST_TURN_OWNERSHIP_BUDGET_MS - 1000 &&
            milliseconds <= API_FIRST_TURN_OWNERSHIP_BUDGET_MS
            ? deadline.signal
            : undefined;
        });
      }
      const store = context.mocks.s3.send.getMockImplementation();
      const sessionWrites: Buffer[] = [];
      let manifestWrites = 0;
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const candidate = command as PiCheckpointS3Command;
        const key = piS3ObjectKey(candidate);
        if (
          candidate.constructor?.name === "PutObjectCommand" &&
          key?.includes(`/pi-api-first-turn/${run.runId}/`)
        ) {
          if (key.endsWith("session.jsonl")) {
            if (!(candidate.input?.Body instanceof Uint8Array)) {
              throw new Error("Expected session bytes");
            }
            sessionWrites.push(Buffer.from(candidate.input.Body));
            if (stage === "H1 deadline") {
              deadline.abort(
                new DOMException(
                  "API ownership expired during H1 write",
                  "TimeoutError",
                ),
              );
              return Promise.reject(deadline.signal.reason);
            }
            if (stage !== "handoff publication") {
              return Promise.reject(new Error("private storage sentinel"));
            }
          }
          if (key.endsWith("manifest.json")) {
            manifestWrites += 1;
            return Promise.reject(new Error("private storage sentinel"));
          }
        }
        return store?.(command) ?? Promise.resolve({});
      });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, run.runId, "failed");
      expect(modelCalls).toBe(1);
      expect(sessionWrites).toHaveLength(1);
      expect(manifestWrites).toBe(stage !== "handoff publication" ? 0 : 1);
      if (stage !== "handoff publication") {
        expect(sessionWrites[0]?.toString("utf8")).toContain(
          "uncommitted API answer",
        );
        await expectTerraApiFollowUpUsage(run.runId);
      } else {
        expect(
          MemoryPiSession.fromJsonl(
            sessionWrites[0]?.toString("utf8") ?? "",
          ).buildSessionContext().messages,
        ).toStrictEqual([]);
      }
      const errorCode =
        stage === "H1 deadline"
          ? "PI_API_FIRST_TURN_DEADLINE_EXCEEDED"
          : stage === "H1 commit"
            ? "PI_API_COMMIT_FAILED"
            : "PI_API_SANDBOX_FALLBACK_FAILED";
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "failed",
        error: expect.stringContaining(`[${errorCode}]`),
      });
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(eventBackedContents(events, run.runId)).toStrictEqual([]);
      expect(
        events.filter((event) => {
          return (
            event.runId === run.runId &&
            isChatRunTerminalEventType(event.eventType)
          );
        }),
      ).toMatchObject([{ eventType: "run.failed" }]);
      expect(
        events
          .filter((event) => {
            return event.eventType === "run.failed";
          })
          .find((event) => {
            return event.runId === run.runId;
          })?.failureReason,
      ).toBeUndefined();
      expect(
        checkpointObjects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );

  it("lets canonical cancellation win a failed model handoff", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    mockPiResourceArchiveDownloads();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let modelCalls = 0;
    server.use(
      http.post("https://api.openai.com/v1/responses", async () => {
        modelCalls += 1;
        entered.resolve(undefined);
        await release.promise;
        return HttpResponse.json(
          { error: "private cancelled model failure" },
          { status: 522 },
        );
      }),
    );
    const checkpointObjects = mockPiCheckpointObjectStore();
    const { anchor, anchorClaim, run, usagePricingResolution } =
      await queueCapabilityProvenPiRun({
        actor,
        agentId,
        runnerGroup,
        prompt: "cancel instead of reviving the run",
      });
    await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
      usagePricingResolution,
    });
    await entered.promise;
    await cancelBeforeLatePiResult(
      actor,
      run.runId,
      () => {
        return release.resolve(undefined);
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
    expect(modelCalls).toBe(1);
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toMatchObject([{ eventType: "run.cancelled" }]);
    await api.requestClaimRunnerJob(true, run.runId, [404]);
  }, 90_000);

  it.each([401, 403])(
    "keeps an explicit HTTP %s credential failure terminal",
    async (status) => {
      mockOptionalEnv("OKOU_DEBUG", "pi-api-first-turn");
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      mockPiResourceArchiveDownloads();
      let modelCalls = 0;
      server.use(
        http.post("https://api.openai.com/v1/responses", () => {
          modelCalls += 1;
          return HttpResponse.json(
            {
              error: {
                code: "invalid_api_key",
                message: "private-credential-sentinel",
              },
            },
            { status },
          );
        }),
      );
      const checkpointObjects = mockPiCheckpointObjectStore();
      const { anchor, anchorClaim, run, usagePricingResolution } =
        await queueCapabilityProvenPiRun({
          actor,
          agentId,
          runnerGroup,
          prompt: "preserve explicit credential failure",
        });
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders, {
        usagePricingResolution,
      });
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expectNoPiApiFirstTurnArtifacts(run.runId, checkpointObjects);
      expect(modelCalls).toBe(1);
      const failed = await api.readRun(actor, run.runId);
      expect(failed.error).toContain("[PI_API_MODEL_FAILED]");
      expect(JSON.stringify(failed)).not.toContain(
        "private-credential-sentinel",
      );
      await api.requestClaimRunnerJob(true, run.runId, [404]);
    },
    90_000,
  );
});
