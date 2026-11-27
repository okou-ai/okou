import { randomUUID } from "node:crypto";

import {
  chatEventsContract,
  chatSearchContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runRunnerContract,
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import type {
  HomeReuseResult,
  SandboxReuseResult,
  SandboxStartupPath,
} from "@okouai/api-contracts/contracts/runner-primitives";
import { runnersRunStartupContract } from "@okouai/api-contracts/contracts/runner-startup";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookTelemetryContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { HttpResponse } from "msw";
import { v5 as uuidv5 } from "uuid";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockOptionalEnv } from "../../../lib/env";
import { now, nowDate, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runnersStartupRoutes } from "../runners-startup";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { deliverOrganizationCreated } from "./helpers/api-bdd-webhooks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import {
  createChatEventsFixture,
  eventBackedContents,
  userMessages,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { publicRunOwner } from "./helpers/public-run-owner";
import { createRouteMocks } from "./helpers/route-test";

const STARTUP_OPTIONAL_ENVS = Object.freeze(["OPENROUTER_API_KEY"] as const);

interface DispatchedStartupRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly threadId: string;
  readonly sandboxToken: string;
  readonly cliAgentType: string;
  readonly markCompleted: () => void;
}

const WARMUP_UUID = "00000000-0000-4000-8000-000000000001";
const ASSISTANT_EVENT_ID_NAMESPACE = "bfec4fb6-d5b8-43e4-a72a-9f58f87d7e01";
const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

function expectedAssistantEventId(runId: string, runEventId: string): string {
  return uuidv5(`${runId}:${runEventId}`, ASSISTANT_EVENT_ID_NAMESPACE);
}

describe("run-lifecycle-chat-events.bdd", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const fixture = createChatEventsFixture(context);
  const routeMocks = createRouteMocks(context);

  const chatEventsClient = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadEventsClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const chatSearchClient = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatSearchContract);
  const onboardingCompleteClient = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const runsByIdClient = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsCancelClient = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const userModelPreferenceClient = setupAppWithRoutes({
    context,
    routes: userModelPreferenceRoutes,
  })(userModelPreferenceContract);
  const personalModelProvidersClient = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const runnersHeartbeatClient = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const webhookClerkClient = setupAppWithRoutes({
    context,
    routes: webhooksClerkRoutes,
  })(webhookClerkContract);
  const webhookEventsClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentEventsRoutes,
  })(webhookEventsContract);
  const webhookCompleteClient = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);
  const startupApi = setupAppWithRoutes({
    context,
    routes: runnersStartupRoutes,
  })(runnersRunStartupContract);
  const runRunnerApi = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runRunnerContract);
  const rawCompleteRequest = setupRawAppRequest({
    context,
    routes: webhooksAgentCompleteRoutes,
  });
  const webhookTelemetryApi = setupAppWithRoutes({
    context,
    routes: webhooksAgentHealthUsageTelemetryRoutes,
  })(webhookTelemetryContract);

  function sessionHeaders(actor: ApiTestUser) {
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return SESSION_HEADERS;
  }

  function sessionHeadersOrUnauth(actor: ApiTestUser | null): {
    readonly authorization?: string;
  } {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    return sessionHeaders(actor);
  }

  async function reportStartup<TStatus extends 204 | 400 | 401 | 404 | 409>(
    runId: string,
    sandboxStartupPath: SandboxStartupPath,
    headers: { readonly authorization?: string },
    statuses: readonly TStatus[],
  ) {
    return await accept(
      startupApi.setStartup({
        headers,
        params: { runId },
        body: { sandboxStartupPath },
      }),
      statuses,
    );
  }

  async function readRunner<TStatus extends 200 | 400 | 401 | 403 | 404>(
    actor: ApiTestUser | null,
    runId: string,
    statuses: readonly TStatus[],
  ) {
    return await accept(
      runRunnerApi.getRunner({
        headers: sessionHeadersOrUnauth(actor),
        params: { id: runId },
      }),
      statuses,
    );
  }

  async function completeStartupRunWithLegacyReuseFields(
    run: DispatchedStartupRun,
    legacyFields: {
      readonly sandboxReuseResult: SandboxReuseResult;
      readonly homeReuseResult: HomeReuseResult;
    },
  ) {
    const response = await rawCompleteRequest("/api/webhooks/run/complete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${run.sandboxToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId: run.runId,
        exitCode: 0,
        sandboxReuseResult: legacyFields.sandboxReuseResult,
        homeReuseResult: legacyFields.homeReuseResult,
        completion: {
          cliAgentType: run.cliAgentType,
          cliAgentSessionId: run.threadId,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      }),
    });
    if (response.status === 200) {
      run.markCompleted();
    }
    return response;
  }

  async function completeStartupRun(run: DispatchedStartupRun) {
    const response = await accept(
      webhookCompleteClient.complete({
        headers: { authorization: `Bearer ${run.sandboxToken}` },
        body: {
          runId: run.runId,
          exitCode: 0,
          completion: {
            cliAgentType: run.cliAgentType,
            cliAgentSessionId: run.threadId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    run.markCompleted();
    return response;
  }

  async function startDispatchedChatRun(): Promise<DispatchedStartupRun> {
    const actor = bdd.user();
    const clockTime = now();
    let activeRun:
      { readonly runId: string; readonly sandboxToken: string } | undefined;
    let completed = false;

    const restoreBefore = captureConnectorExternalState(
      context,
      STARTUP_OPTIONAL_ENVS,
    );
    let restoreAccepted = restoreBefore;

    onTestFinished(async () => {
      restoreAccepted();
      context.mocks.ably.publish.mockResolvedValue(undefined);
      const result = await settleIncludingAbort(() => {
        return withMockNowForTest(clockTime, async () => {
          await flushWaitUntilForTest();
          if (activeRun && !completed) {
            const target = activeRun;
            const current = await readRun(actor, target.runId);
            if (["queued", "pending", "running"].includes(current.status)) {
              await accept(
                runsCancelClient.cancel({
                  headers: sessionHeaders(actor),
                  params: { id: target.runId },
                }),
                [200],
              );
              await accept(
                webhookCompleteClient.complete({
                  headers: { authorization: `Bearer ${target.sandboxToken}` },
                  body: {
                    runId: target.runId,
                    exitCode: 1,
                    error: "Run cancelled",
                  },
                }),
                [200],
              );
              await flushWaitUntilForTest();
            }
          }
        });
      });
      restoreBefore();
      if (!result.ok) {
        throw result.error;
      }
    });

    fixture.chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    fixture.chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", "bdd-startup-openrouter-key");
    restoreAccepted = captureConnectorExternalState(
      context,
      STARTUP_OPTIONAL_ENVS,
    );

    const launched = await withMockNowForTest(clockTime, async () => {
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        deliverOrganizationCreated(context, actor),
      ]);
      const sent = await accept(
        chatEventsClient.send({
          headers: sessionHeaders(actor),
          body: {
            prompt: "Check runner startup persistence.",
            hasTextContent: true,
            clientEventId: randomUUID(),
            model: null,
            userMessage: {
              version: 1,
              parts: [
                { type: "text", text: "Check runner startup persistence." },
              ],
            },
          },
        }),
        [201],
      );
      const dispatched = await runs.nextReceivedExecution(runnerGroup);
      activeRun = {
        runId: dispatched.runId,
        sandboxToken: dispatched.sandboxToken,
      };
      return {
        threadId: sent.body.threadId,
        runId: dispatched.runId,
        sandboxToken: dispatched.sandboxToken,
        cliAgentType: dispatched.cliAgentType,
      };
    });

    return {
      actor,
      ...launched,
      markCompleted: () => {
        completed = true;
      },
    };
  }

  async function listThreadEvents(actor: ApiTestUser, threadId: string) {
    const response = await accept(
      chatThreadEventsClient.rows({
        headers: sessionHeaders(actor),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    return projectChatEventRows(response.body.rows);
  }

  async function sendChatRun(
    actor: ApiTestUser,
    body: {
      readonly prompt: string;
      readonly model: string;
    },
  ): Promise<{ readonly runId: string; readonly threadId: string }> {
    const clientEventId = randomUUID();
    const sent = await accept(
      chatEventsClient.send({
        headers: sessionHeaders(actor),
        body: {
          prompt: body.prompt,
          model: body.model,
          hasTextContent: true,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: body.prompt }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const events = await listThreadEvents(actor, sent.body.threadId);
    const runId = userMessages(events).find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (!runId) {
      throw new Error("Expected the entitled chat send to launch a run");
    }
    return { runId, threadId: sent.body.threadId };
  }

  async function searchChat(actor: ApiTestUser, keyword: string) {
    const response = await accept(
      chatSearchClient.search({
        headers: sessionHeaders(actor),
        query: { keyword },
      }),
      [200],
    );
    return response.body;
  }

  async function readRun(actor: ApiTestUser, runId: string) {
    const response = await accept(
      runsByIdClient.getById({
        headers: sessionHeaders(actor),
        params: { id: runId },
      }),
      [200],
    );
    return response.body;
  }

  async function cancelRun(actor: ApiTestUser, runId: string) {
    return await accept(
      runsCancelClient.cancel({
        headers: sessionHeaders(actor),
        params: { id: runId },
      }),
      [200],
    );
  }

  function installBaseChatMocks(): void {
    fixture.chatCallbacks.acceptChatObjectStorage();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
  }

  async function prepareNativeClaudeActor(options?: {
    readonly runnerOptions?: Parameters<typeof runs.configureRunnerGroup>[0];
  }): Promise<ApiTestUser> {
    const actor = bdd.user();
    installBaseChatMocks();
    mockClaudeCodeTokenEndpoint();
    await Promise.all([
      runs.configureRunnerGroup(options?.runnerOptions),
      bdd.bootstrapLimitedFreeOnboarding(actor),
      accept(
        personalModelProvidersClient.upsert({
          headers: sessionHeaders(actor),
          body: {
            type: "claude-code-oauth-token",
            secret: `bdd-claude-token-${randomUUID()}`,
          },
        }),
        [200, 201],
      ),
    ]);
    return actor;
  }

  async function prepareNativeCodexActor(): Promise<ApiTestUser> {
    const actor = bdd.user();
    installBaseChatMocks();
    await Promise.all([
      runs.configureRunnerGroup(),
      bdd.bootstrapLimitedFreeOnboarding(actor),
      fixture.connectSubscriptionPiModel(actor),
    ]);
    await accept(
      userModelPreferenceClient.update({
        headers: sessionHeaders(actor),
        body: { selectedModel: "gpt-6-astra", serviceTier: null },
      }),
      [200],
    );
    return actor;
  }

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(
      new Error("warmup"),
    );
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
    await Promise.all([
      accept(
        chatEventsClient.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: WARMUP_UUID,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        chatThreadEventsClient.rows({
          headers: {},
          params: { threadId: WARMUP_UUID },
          query: { sinceSeqId: 0 },
        }),
        [401],
      ),
      accept(
        chatSearchClient.search({
          headers: {},
          query: { keyword: "warmup" },
        }),
        [401],
      ),
      accept(
        onboardingCompleteClient.complete({
          headers: {},
          body: {},
        }),
        [401],
      ),
      accept(
        runsByIdClient.getById({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        runsCancelClient.cancel({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        userModelPreferenceClient.update({
          headers: {},
          body: { selectedModel: "gpt-6-astra", serviceTier: null },
        }),
        [401],
      ),
      accept(
        personalModelProvidersClient.upsert({
          headers: {},
          body: {
            type: "claude-code-oauth-token",
            secret: "warmup-token",
          },
        }),
        [401],
      ),
      accept(
        runnersHeartbeatClient.heartbeat({
          headers: {},
          body: {
            runnerId: WARMUP_UUID,
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 8,
            totalMemoryMb: 16_384,
            maxConcurrent: 2,
            allocatedVcpu: 0,
            allocatedMemoryMb: 0,
            runningCount: 0,
            admittableProfiles: ["vm0/default"],
            heldSandboxStates: [],
            heldHomeStates: [],
            activeReuseProducers: [],
            mode: "running",
          },
        }),
        [401],
      ),
      accept(
        webhookClerkClient.post({
          body: "{}",
          extraHeaders: {},
        }),
        [401],
      ),
      accept(
        webhookEventsClient.send({
          headers: {},
          body: {
            runId: WARMUP_UUID,
            events: [
              {
                type: "assistant",
                sequenceNumber: 1,
                message: { content: [{ type: "text", text: "warmup" }] },
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        webhookCompleteClient.complete({
          headers: {},
          body: { runId: WARMUP_UUID, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        startupApi.setStartup({
          headers: {},
          params: { runId: WARMUP_UUID },
          body: { sandboxStartupPath: "blank" },
        }),
        [401],
      ),
      accept(
        runRunnerApi.getRunner({
          headers: {},
          params: { id: WARMUP_UUID },
        }),
        [401],
      ),
      accept(
        webhookTelemetryApi.send({
          headers: {},
          body: {
            sandboxOperations: [
              {
                ts: nowDate().toISOString(),
                action_type: "sandbox_ready",
                duration_ms: 1,
                success: true,
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        rawCompleteRequest("/api/webhooks/run/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ runId: WARMUP_UUID, exitCode: 0 }),
        }),
        [401],
      ),
    ]);
  });

  describe("HOOK-02/CHAT-02: assistant events reach optional chat consumers", () => {
    it(
      "run-lifecycle-chat-events.bdd-004 (1/2) persists Claude assistant events, swallows optional realtime failures, and ignores sequence duplicates",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = bdd.user();
        let statusBeforeDispatchAck: string | undefined;

        installBaseChatMocks();
        mockClaudeCodeTokenEndpoint();
        await Promise.all([
          runs.configureRunnerGroup({
            reply: async (envelope) => {
              const observedRun = await readRun(
                actor,
                envelope.executionContext.runId,
              );
              statusBeforeDispatchAck = observedRun.status;
              return HttpResponse.json({
                runnerId: envelope.runnerId,
                heartbeatGeneration: envelope.heartbeatGeneration,
                runId: envelope.executionContext.runId,
                disposition: "accepted",
              });
            },
          }),
          bdd.bootstrapLimitedFreeOnboarding(actor),
          accept(
            personalModelProvidersClient.upsert({
              headers: sessionHeaders(actor),
              body: {
                type: "claude-code-oauth-token",
                secret: `bdd-claude-token-${randomUUID()}`,
              },
            }),
            [200, 201],
          ),
        ]);

        const owner = publicRunOwner(context, actor);
        await owner.run(async () => {
          const sendTime = now();
          const launched = await withMockNowForTest(sendTime, () => {
            return sendChatRun(actor, {
              prompt: "Persist assistant events and swallow realtime failure",
              model: "claude-fable-5-1",
            });
          });
          const execution = await owner.executionInput(launched.runId);
          const sandboxHeaders = {
            authorization: `Bearer ${execution.sandboxToken}`,
          };

          expect(statusBeforeDispatchAck).toBe("running");
          expect(execution.apiStartTime).toBe(sendTime);

          const messageTopic = `chatThreadMessageCreated:${launched.threadId}`;
          let failedFirstPublish = false;
          const publishedTopics: string[] = [];
          context.mocks.ably.publish.mockImplementation((topic: unknown) => {
            if (topic === messageTopic && !failedFirstPublish) {
              failedFirstPublish = true;
              return Promise.reject(new Error("Simulated realtime failure"));
            }
            if (typeof topic === "string") {
              publishedTopics.push(topic);
            }
            return Promise.resolve();
          });

          const firstText = "First persisted assistant output";
          const secondText = "Second persisted assistant output";

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "assistant",
                    sequenceNumber: 1,
                    message: { content: [{ type: "text", text: firstText }] },
                  },
                ],
              },
            }),
            [200],
          );
          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "assistant",
                    sequenceNumber: 2,
                    message: { content: [{ type: "text", text: secondText }] },
                  },
                  {
                    type: "assistant",
                    sequenceNumber: 1,
                    message: {
                      content: [
                        { type: "text", text: "Mutated duplicate sequence 1" },
                      ],
                    },
                  },
                ],
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          expect(failedFirstPublish).toBeTruthy();
          expect(publishedTopics).toContain(messageTopic);

          const expectedFirstId = expectedAssistantEventId(
            launched.runId,
            "event:1",
          );
          const outputs = eventBackedContents(
            await listThreadEvents(actor, launched.threadId),
            launched.runId,
          );
          expect(outputs).toHaveLength(2);
          expect(outputs[0]?.id).toBe(expectedFirstId);
          expect(outputs[0]?.content).toBe(firstText);
          expect(outputs[1]?.content).toBe(secondText);
        });
      },
    );

    it(
      "run-lifecycle-chat-events.bdd-004 (2/2) filters non-output Codex and tool events before cooperative cancellation",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareNativeClaudeActor();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const launched = await sendChatRun(actor, {
            prompt: "Filter non-output events and cancel cooperatively",
            model: "claude-fable-5-1",
          });
          const execution = await owner.executionInput(launched.runId);
          const sandboxHeaders = {
            authorization: `Bearer ${execution.sandboxToken}`,
          };

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "item.completed",
                    sequenceNumber: 1,
                    item: {
                      id: "item_reasoning_1",
                      type: "reasoning",
                      text: "Internal reasoning trace",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 2,
                    item: {
                      id: "item_codex_note_1",
                      type: "agent_message",
                      text: "Codex follow-up note",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 3,
                    item: {
                      id: "item_command_1",
                      type: "command_execution",
                      command: "ls -la",
                      aggregated_output: "README.md",
                      exit_code: 0,
                      status: "completed",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 4,
                    item: {
                      id: "item_blank_1",
                      type: "agent_message",
                      text: "   ",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 5,
                    item: {
                      id: "item_blank_2",
                      type: "agent_message",
                      text: "",
                    },
                  },
                  {
                    type: "assistant",
                    sequenceNumber: 6,
                    message: {
                      content: [
                        {
                          type: "tool_use",
                          id: "toolu_1",
                          name: "Bash",
                          input: { command: "pwd" },
                        },
                      ],
                    },
                  },
                  {
                    type: "assistant",
                    sequenceNumber: 7,
                    message: { content: [{ type: "text", text: "   " }] },
                  },
                ],
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          expect(
            eventBackedContents(
              await listThreadEvents(actor, launched.threadId),
              launched.runId,
            ).map((entry) => {
              return entry.content;
            }),
          ).toStrictEqual(["Codex follow-up note"]);

          await cancelRun(actor, launched.runId);
          await flushWaitUntilForTest();
          const cancelledRun = await readRun(actor, launched.runId);
          expect(cancelledRun.status).toBe("cancelled");
        });
      },
    );

    it(
      "run-lifecycle-chat-events.bdd-006 records a Codex agent message as the first real assistant output",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareNativeCodexActor();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const sendTime = now();
          const launched = await withMockNowForTest(sendTime, () => {
            return sendChatRun(actor, {
              prompt: "Emit a Codex agent message output",
              model: "gpt-6-astra",
            });
          });
          const execution = await owner.executionInput(launched.runId);
          const sandboxHeaders = {
            authorization: `Bearer ${execution.sandboxToken}`,
          };

          expect(execution.cliAgentType).toBe("codex");
          expect(execution.apiStartTime).toBe(sendTime);

          const publishedTopics: string[] = [];
          context.mocks.ably.publish.mockImplementation((topic: unknown) => {
            if (typeof topic === "string") {
              publishedTopics.push(topic);
            }
            return Promise.resolve();
          });

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "item.completed",
                    sequenceNumber: 1,
                    item: {
                      id: "item_cmd_1",
                      type: "command_execution",
                      command: "echo hello",
                      aggregated_output: "hello",
                      exit_code: 0,
                      status: "completed",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 2,
                    item: {
                      id: "item_agent_1",
                      type: "agent_message",
                      text: "First real Codex output",
                    },
                  },
                  {
                    type: "item.completed",
                    sequenceNumber: 3,
                    item: {
                      id: "item_agent_blank",
                      type: "agent_message",
                      text: "   ",
                    },
                  },
                ],
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          const outputs = eventBackedContents(
            await listThreadEvents(actor, launched.threadId),
            launched.runId,
          );
          expect(outputs).toHaveLength(1);
          expect(outputs[0]?.content).toBe("First real Codex output");
          expect(publishedTopics).toContain(
            `chatThreadMessageCreated:${launched.threadId}`,
          );
        });
      },
    );

    it(
      "run-lifecycle-chat-events.bdd-002 publishes authenticated assistant output to its chat thread",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareNativeClaudeActor();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const launched = await sendChatRun(actor, {
            prompt: "Publish authenticated assistant output",
            model: "claude-fable-5-1",
          });
          const execution = await owner.executionInput(launched.runId);
          const sandboxHeaders = {
            authorization: `Bearer ${execution.sandboxToken}`,
          };

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "assistant",
                    sequenceNumber: 1,
                    message: {
                      content: [
                        {
                          type: "text",
                          text: "authenticated assistant output",
                        },
                      ],
                    },
                  },
                ],
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          const [events, searched] = await Promise.all([
            listThreadEvents(actor, launched.threadId),
            searchChat(actor, "authenticated assistant output"),
          ]);

          const outputs = eventBackedContents(events, launched.runId);
          expect(outputs).toHaveLength(1);
          expect(outputs[0]?.content).toBe("authenticated assistant output");

          expect(searched.results).toContainEqual(
            expect.objectContaining({
              chatThreadId: launched.threadId,
              matchedMessage: expect.objectContaining({
                chatThreadId: launched.threadId,
                role: "assistant",
                runId: launched.runId,
                content: "authenticated assistant output",
              }),
            }),
          );
        });
      },
    );

    it(
      "run-lifecycle-chat-events.bdd-003 uses DB output acknowledged before completion and ignores a late duplicate",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const actor = await prepareNativeClaudeActor();
        const owner = publicRunOwner(context, actor);

        await owner.run(async () => {
          const launched = await sendChatRun(actor, {
            prompt: "Complete with acknowledged DB output",
            model: "claude-fable-5-1",
          });
          const execution = await owner.executionInput(launched.runId);
          const sandboxHeaders = {
            authorization: `Bearer ${execution.sandboxToken}`,
          };

          const originalText = "Original acknowledged assistant output";
          const lateText = "Late duplicate assistant output";

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "assistant",
                    sequenceNumber: 1,
                    message: {
                      content: [{ type: "text", text: originalText }],
                    },
                  },
                ],
              },
            }),
            [200],
          );
          await accept(
            webhookCompleteClient.complete({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                exitCode: 0,
                lastEventSequence: 1,
                completion: {
                  cliAgentType: "claude-code",
                  cliAgentSessionId: `bdd-claude-${launched.runId}`,
                  cliAgentSessionHistoryDisposition: "native_only",
                },
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          const outputsAfterComplete = eventBackedContents(
            await listThreadEvents(actor, launched.threadId),
            launched.runId,
          );
          expect(outputsAfterComplete).toHaveLength(1);
          expect(outputsAfterComplete[0]?.content).toBe(originalText);

          await accept(
            webhookEventsClient.send({
              headers: sandboxHeaders,
              body: {
                runId: launched.runId,
                events: [
                  {
                    type: "assistant",
                    sequenceNumber: 1,
                    message: {
                      content: [{ type: "text", text: lateText }],
                    },
                  },
                ],
              },
            }),
            [200],
          );
          await flushWaitUntilForTest();

          const outputsAfterLate = eventBackedContents(
            await listThreadEvents(actor, launched.threadId),
            launched.runId,
          );
          expect(outputsAfterLate).toHaveLength(1);
          expect(outputsAfterLate[0]?.content).toBe(originalText);
          expect(
            outputsAfterLate.some((entry) => {
              return entry.content === lateText;
            }),
          ).toBeFalsy();
        });
      },
    );
  });

  describe("run runner startup", () => {
    it(
      "run-runner-startup.bdd-001 dedicated startup API persists sandbox through a pre-cleanup completion",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const run = await startDispatchedChatRun();
        const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

        const beforeReport = await readRunner(run.actor, run.runId, [200]);
        expect(beforeReport.body.sandboxStartupPath).toBeNull();

        const reported = await reportStartup(
          run.runId,
          "sandbox",
          sandboxHeaders,
          [204],
        );
        expect(reported.status).toBe(204);

        const afterReport = await readRunner(run.actor, run.runId, [200]);
        expect(afterReport.body.sandboxStartupPath).toBe("sandbox");

        const completed = await completeStartupRunWithLegacyReuseFields(run, {
          sandboxReuseResult: "reused",
          homeReuseResult: "sandboxReused",
        });
        expect(completed.status).toBe(200);
        expect(completed.body).toStrictEqual({
          success: true,
          status: "completed",
        });

        const afterCompletion = await readRunner(run.actor, run.runId, [200]);
        expect(afterCompletion.body.sandboxStartupPath).toBe("sandbox");
      },
    );

    it(
      "run-runner-startup.bdd-002 dedicated startup API persists home through a pre-cleanup completion",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const run = await startDispatchedChatRun();
        const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

        const beforeReport = await readRunner(run.actor, run.runId, [200]);
        expect(beforeReport.body.sandboxStartupPath).toBeNull();

        const reported = await reportStartup(
          run.runId,
          "home",
          sandboxHeaders,
          [204],
        );
        expect(reported.status).toBe(204);

        const afterReport = await readRunner(run.actor, run.runId, [200]);
        expect(afterReport.body.sandboxStartupPath).toBe("home");

        const completed = await completeStartupRunWithLegacyReuseFields(run, {
          sandboxReuseResult: "poolMiss",
          homeReuseResult: "reused",
        });
        expect(completed.status).toBe(200);
        expect(completed.body).toStrictEqual({
          success: true,
          status: "completed",
        });

        const afterCompletion = await readRunner(run.actor, run.runId, [200]);
        expect(afterCompletion.body.sandboxStartupPath).toBe("home");
      },
    );

    it(
      "run-runner-startup.bdd-006 same-value retries succeed and conflicting or telemetry reports cannot overwrite startup",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const run = await startDispatchedChatRun();
        const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };

        const firstBlank = await reportStartup(
          run.runId,
          "blank",
          sandboxHeaders,
          [204],
        );
        expect(firstBlank.status).toBe(204);

        const secondBlank = await reportStartup(
          run.runId,
          "blank",
          sandboxHeaders,
          [204],
        );
        expect(secondBlank.status).toBe(204);

        const conflictingCold = await reportStartup(
          run.runId,
          "cold",
          sandboxHeaders,
          [409],
        );
        expect(conflictingCold.status).toBe(409);

        const completed = await completeStartupRun(run);
        expect(completed.body).toStrictEqual({
          success: true,
          status: "completed",
        });

        const postCompletionBlank = await reportStartup(
          run.runId,
          "blank",
          sandboxHeaders,
          [204],
        );
        expect(postCompletionBlank.status).toBe(204);

        const postCompletionHome = await reportStartup(
          run.runId,
          "home",
          sandboxHeaders,
          [409],
        );
        expect(postCompletionHome.status).toBe(409);

        const telemetry = await accept(
          webhookTelemetryApi.send({
            headers: sandboxHeaders,
            body: {
              runId: run.runId,
              sandboxOperations: [
                {
                  ts: nowDate().toISOString(),
                  action_type: "sandbox_ready",
                  duration_ms: 42,
                  success: true,
                  runner_startup_path: "cold",
                },
              ],
            },
          }),
          [200],
        );
        expect(telemetry.status).toBe(200);

        const finalRunner = await readRunner(run.actor, run.runId, [200]);
        expect(finalRunner.body.sandboxStartupPath).toBe("blank");
      },
    );

    it(
      "run-runner-startup.bdd-008 startup writes and reads preserve Run token, user and organization boundaries",
      { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const run = await startDispatchedChatRun();
        const sandboxHeaders = { authorization: `Bearer ${run.sandboxToken}` };
        const sameOrgMember = bdd.user({
          orgId: run.actor.orgId,
          orgRole: "org:member",
        });
        const sameUserOtherOrg = bdd.user({ userId: run.actor.userId });

        const ownerSessionHeaders = sessionHeaders(run.actor);
        const [wrongRunReport, missingAuthReport, clerkSessionReport] =
          await Promise.all([
            reportStartup(randomUUID(), "blank", sandboxHeaders, [401]),
            reportStartup(run.runId, "blank", {}, [401]),
            reportStartup(run.runId, "blank", ownerSessionHeaders, [401]),
          ]);
        expect(wrongRunReport.status).toBe(401);
        expect(missingAuthReport.status).toBe(401);
        expect(clerkSessionReport.status).toBe(401);

        const stillNull = await readRunner(run.actor, run.runId, [200]);
        expect(stillNull.body.sandboxStartupPath).toBeNull();

        const validReport = await reportStartup(
          run.runId,
          "blank",
          sandboxHeaders,
          [204],
        );
        expect(validReport.status).toBe(204);

        const otherMemberRead = await readRunner(
          sameOrgMember,
          run.runId,
          [404],
        );
        expect(otherMemberRead.status).toBe(404);

        const otherOrgRead = await readRunner(
          sameUserOtherOrg,
          run.runId,
          [404],
        );
        expect(otherOrgRead.status).toBe(404);

        const unauthRead = await readRunner(null, run.runId, [401]);
        expect(unauthRead.status).toBe(401);

        const ownerRead = await readRunner(run.actor, run.runId, [200]);
        expect(ownerRead.body.sandboxStartupPath).toBe("blank");
      },
    );
  });
});
