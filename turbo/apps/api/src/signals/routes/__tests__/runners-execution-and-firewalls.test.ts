import { randomUUID } from "node:crypto";
import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { logsListContract } from "@okouai/api-contracts/contracts/logs";
import { MODEL_PROVIDER_FIREWALL_CONFIGS } from "@okouai/api-contracts/contracts/model-provider-firewalls";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersBuiltinFirewallsResolveContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerConnectorFirewall,
  projectRunnerRuntimeFirewall,
} from "@okouai/connectors/firewall-metadata/runner-runtime-catalog";
import { beforeAll, describe, expect, it } from "vitest";
import { setupAppWithRoutes } from "../../../__tests__/test-app";
import { accept, testContext } from "../../../__tests__/test-context";
import { TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE } from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { API_TEST_CONNECTOR_CATALOG } from "../../../test-fixtures/connector-catalog";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { instructionsRoutes } from "../instructions";
import { logsRoutes } from "../logs";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { holdDownloadSigning } from "./helpers/hold-download-signing";
import { completePublicClaudeRun } from "./helpers/public-native-run";
import { publicRunOwner } from "./helpers/public-run-owner";

const NATIVE_CLAUDE_MODEL = "claude-fable-5-1";

function officialRunnerAuthHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function expectedRunnerFirewallCatalog() {
  return createRunnerRuntimeFirewallCatalog([
    ...API_TEST_CONNECTOR_CATALOG.connectors.flatMap((connector) => {
      const firewall = projectRunnerConnectorFirewall(connector);
      return firewall === null ? [] : [firewall];
    }),
    ...Object.values(MODEL_PROVIDER_FIREWALL_CONFIGS).map(
      projectRunnerRuntimeFirewall,
    ),
  ]);
}

describe("Runner execution and builtin firewalls", () => {
  const context = testContext();
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const fixture = createChatEventsFixture(context);

  const chatEventsApi = setupAppWithRoutes({
    context,
    routes: chatEventsRoutes,
  })(chatEventsContract);
  const chatThreadByIdApi = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadByIdContract);
  const chatThreadEventsApi = setupAppWithRoutes({
    context,
    routes: chatThreadRoutes,
  })(chatThreadEventsContract);
  const instructionsApi = setupAppWithRoutes({
    context,
    routes: instructionsRoutes,
  })(instructionsContract);
  const logsApi = setupAppWithRoutes({
    context,
    routes: logsRoutes,
  })(logsListContract);
  const onboardingCompleteApi = setupAppWithRoutes({
    context,
    routes: onboardingCompleteRoutes,
  })(onboardingCompleteContract);
  const personalModelProvidersApi = setupAppWithRoutes({
    context,
    routes: meModelProvidersUpsertRoutes,
  })(personalModelProvidersMainContract);
  const runsByIdApi = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsByIdContract);
  const runsCancelApi = setupAppWithRoutes({
    context,
    routes: runsCancelRoutes,
  })(runsCancelContract);
  const runsQueueApi = setupAppWithRoutes({
    context,
    routes: runsRoutes,
  })(runsQueueContract);
  const builtinFirewallsApi = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersBuiltinFirewallsResolveContract);
  const runnersHeartbeatApi = setupAppWithRoutes({
    context,
    routes: runnersRoutes,
  })(runnersHeartbeatContract);
  const webhookEventsApi = setupAppWithRoutes({
    context,
    routes: webhooksAgentEventsRoutes,
  })(webhookEventsContract);
  const webhookCompleteApi = setupAppWithRoutes({
    context,
    routes: webhooksAgentCompleteRoutes,
  })(webhookCompleteContract);

  beforeAll(async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const warmupId = randomUUID();
    await Promise.all([
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
          },
        }),
        [401],
      ),
      accept(
        chatThreadByIdApi.get({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        chatThreadEventsApi.rows({
          headers: {},
          params: { threadId: warmupId },
          query: { sinceSeqId: 0 },
        }),
        [401],
      ),
      accept(
        instructionsApi.update({
          headers: {},
          body: { content: "warmup" },
        }),
        [401],
      ),
      accept(
        logsApi.list({
          headers: {},
          query: {},
        }),
        [401],
      ),
      accept(
        onboardingCompleteApi.complete({
          headers: {},
          body: {},
        }),
        [401],
      ),
      accept(
        personalModelProvidersApi.upsert({
          headers: {},
          body: {
            type: "claude-code-oauth-token",
            secret: "warmup-secret",
          },
        }),
        [401],
      ),
      accept(
        runsByIdApi.getById({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runsCancelApi.cancel({
          headers: {},
          params: { id: warmupId },
        }),
        [401],
      ),
      accept(
        runsQueueApi.getQueue({
          headers: {},
        }),
        [401],
      ),
      accept(
        builtinFirewallsApi.resolve({
          headers: {},
          body: { names: ["github"] },
        }),
        [401],
      ),
      accept(
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: warmupId,
            group: "vm0/warmup",
            snapshotGeneration: 1,
            snapshotSequence: 1,
            totalVcpu: 1,
            totalMemoryMb: 1024,
            maxConcurrent: 1,
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
        webhookEventsApi.send({
          headers: {},
          body: {
            runId: warmupId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: warmupId,
                sequenceNumber: 0,
              },
            ],
          },
        }),
        [401],
      ),
      accept(
        webhookCompleteApi.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 0 },
        }),
        [401],
      ),
    ]);
  });

  async function dispatchChatRun(args: {
    readonly actor: ApiTestUser;
    readonly owner: ReturnType<typeof publicRunOwner>;
    readonly runnerGroup: string;
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: string | null;
  }) {
    const sent = await args.owner.run(() => {
      return fixture.chat.requestSendEvent(
        args.actor,
        {
          prompt: args.prompt,
          clientEventId: randomUUID(),
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
          ...(args.model === undefined ? {} : { model: args.model }),
        },
        [201],
      );
    });
    if (sent.status !== 201) {
      throw new Error("Expected chat send to be accepted");
    }
    const execution = await runsApi.nextReceivedExecution(args.runnerGroup);
    args.owner.rememberExecution(execution.runId, execution.sandboxToken);
    return {
      runId: execution.runId,
      threadId: sent.body.threadId,
      execution,
    };
  }

  async function setupNativeBindingThread(options?: {
    readonly personalInstructionsAfterFirstDispatch?: string;
  }) {
    const actor = bdd.user();
    fixture.chatCallbacks.acceptChatObjectStorage();
    fixture.api.acceptStorageDownloads();
    fixture.api.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    fixture.chatCallbacks.disableVapid();
    mockClaudeCodeTokenEndpoint();
    const runnerGroupPromise = fixture.api.configureRunnerGroup();
    const owner = publicRunOwner(context, actor);

    const [runnerGroup] = await Promise.all([
      runnerGroupPromise,
      owner.run(async () => {
        await bdd.provisionWorkspace(actor);
        await Promise.all([
          bdd.completeOnboarding(actor),
          fixture.api.createPersonalModelProvider(actor, {
            type: "claude-code-oauth-token",
            secret: "bdd-personal-claude-token",
          }),
        ]);
      }),
    ]);

    const first = await dispatchChatRun({
      actor,
      owner,
      runnerGroup,
      model: NATIVE_CLAUDE_MODEL,
      prompt: "Initialize native Thread session",
    });
    const instructions = options?.personalInstructionsAfterFirstDispatch;
    await owner.run(async () => {
      await Promise.all([
        completePublicClaudeRun(
          context,
          { runId: first.runId, threadId: first.threadId },
          { authorization: `Bearer ${first.execution.sandboxToken}` },
          "Native session initialized",
        ),
        ...(instructions === undefined
          ? []
          : [bdd.updatePersonalInstructions(actor, instructions)]),
      ]);
    });

    return { actor, owner, runnerGroup, firstRun: first };
  }

  describe("Runner builtin firewall resolver", () => {
    it("runners-builtin-firewalls-002 rejects unknown builtin firewall names and preserves subsequent valid resolution", async () => {
      const headers = officialRunnerAuthHeaders();
      const expectedCatalog = expectedRunnerFirewallCatalog();

      const rejected = await accept(
        builtinFirewallsApi.resolve({
          headers,
          body: { names: ["github", "not-a-builtin-firewall"] },
        }),
        [400],
      );
      expect(rejected.body.error.message).toBe(
        "Unknown builtin firewall: not-a-builtin-firewall",
      );

      const resolved = await accept(
        builtinFirewallsApi.resolve({
          headers,
          body: { names: ["github"] },
        }),
        [200],
      );
      expect(resolved.body).toStrictEqual({
        catalogDigest: expectedCatalog.catalogDigest,
        catalogVersion: expectedCatalog.catalogVersion,
        firewalls: {
          github: expectedCatalog.firewalls.github,
        },
      });
    });

    it("runners-builtin-firewalls-003 resolves connector and model-provider builtin firewalls", async () => {
      const headers = officialRunnerAuthHeaders();
      const expectedCatalog = expectedRunnerFirewallCatalog();

      const resolved = await accept(
        builtinFirewallsApi.resolve({
          headers,
          body: {
            names: [
              "github",
              "github",
              "model-provider:claude-code-oauth-token",
            ],
          },
        }),
        [200],
      );

      expect(resolved.body.catalogDigest).toBe(expectedCatalog.catalogDigest);
      expect(resolved.body.catalogVersion).toBe(expectedCatalog.catalogVersion);
      expect(Object.keys(resolved.body.firewalls).sort()).toStrictEqual([
        "github",
        "model-provider:claude-code-oauth-token",
      ]);
      expect(resolved.body.firewalls.github?.name).toBe("github");
      expect(
        resolved.body.firewalls["model-provider:claude-code-oauth-token"]
          ?.apis[0],
      ).toStrictEqual({
        base: "https://api.anthropic.com/v1/messages",
        auth: {
          headers: {
            Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
          },
        },
        permissions: [],
      });
    });

    it("runners-builtin-firewalls-004 publishes the Codex OAuth backend API firewall to Runner", async () => {
      const resolved = await accept(
        builtinFirewallsApi.resolve({
          headers: officialRunnerAuthHeaders(),
          body: { names: ["model-provider:codex-oauth-token"] },
        }),
        [200],
      );

      expect(
        resolved.body.firewalls["model-provider:codex-oauth-token"]?.apis,
      ).toStrictEqual([
        {
          base: "https://chatgpt.com/backend-api",
          auth: {
            headers: {
              Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
              "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
            },
          },
          permissions: [
            {
              name: "codex:api",
              rules: ["GET /{path*}", "POST /{path*}"],
            },
          ],
        },
        {
          base: "https://auth.openai.com",
          auth: { headers: {} },
          permissions: [],
        },
      ]);
    });

    it("runners-builtin-firewalls-008 resolves the full generated builtin firewall catalog when names are omitted", async () => {
      const expectedCatalog = expectedRunnerFirewallCatalog();
      const resolved = await accept(
        builtinFirewallsApi.resolve({
          headers: officialRunnerAuthHeaders(),
          body: {},
        }),
        [200],
      );

      const parsed =
        runnersBuiltinFirewallsResolveContract.resolve.responses[200].parse(
          resolved.body,
        );
      expect(parsed.catalogDigest).toBe(expectedCatalog.catalogDigest);
      expect(parsed.catalogVersion).toBe(expectedCatalog.catalogVersion);
      expect(Object.keys(parsed.firewalls)).toStrictEqual(
        expectedCatalog.names,
      );
      expect(parsed.firewalls.github?.name).toBe("github");
      expect(
        parsed.firewalls["model-provider:claude-code-oauth-token"]?.apis[0],
      ).toStrictEqual({
        base: "https://api.anthropic.com/v1/messages",
        auth: {
          headers: {
            Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
          },
        },
        permissions: [],
      });
    });
  });

  describe("Runner first-start Thread binding", () => {
    it(
      "runners-thread-binding-005 retains initialized native context after a failed outcome",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const { actor, owner, runnerGroup, firstRun } =
          await setupNativeBindingThread();

        const second = await dispatchChatRun({
          actor,
          owner,
          runnerGroup,
          threadId: firstRun.threadId,
          prompt: "Second Run initializes a new native session before failing",
        });
        expect(second.execution.nativeContinuation).toMatchObject({
          sessionId: firstRun.threadId,
          generationRunId: firstRun.runId,
        });

        const secondHeaders = {
          authorization: `Bearer ${second.execution.sandboxToken}`,
        };
        const nextSessionId = `session-${randomUUID()}`;
        const initResponse = await owner.run(() => {
          return fixture.webhooks.requestAgentEvents(
            {
              runId: second.runId,
              events: [
                {
                  type: "system",
                  subtype: "init",
                  session_id: nextSessionId,
                  sequenceNumber: 0,
                },
              ],
            },
            secondHeaders,
            [200],
          );
        });
        expect(initResponse.status).toBe(200);

        const completeResponse = await owner.run(() => {
          return fixture.webhooks.requestAgentComplete(
            {
              runId: second.runId,
              exitCode: 1,
              error: "Execution failed after native initialization",
            },
            secondHeaders,
            [200],
          );
        });
        expect(completeResponse.status).toBe(200);
        await flushWaitUntilForTest();

        const third = await dispatchChatRun({
          actor,
          owner,
          runnerGroup,
          threadId: firstRun.threadId,
          prompt: "Resume native context after failed second Run",
        });
        expect(third.execution.nativeContinuation).toMatchObject({
          sessionId: nextSessionId,
          generationRunId: second.runId,
        });
      },
    );

    it(
      "runners-thread-binding-001 preserves native context when cancellation wins during execution preparation",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const { actor, owner, runnerGroup, firstRun } =
          await setupNativeBindingThread({
            personalInstructionsAfterFirstDispatch: `Personal binding instructions ${randomUUID()}`,
          });

        const held = holdDownloadSigning(context);
        const cancelledClientEventId = randomUUID();
        const followUpSend = await owner.run(() => {
          return fixture.chat.requestSendEvent(
            actor,
            {
              threadId: firstRun.threadId,
              prompt: "Follow-up cancelled during execution preparation",
              clientEventId: cancelledClientEventId,
            },
            [201],
          );
        });
        expect(followUpSend.status).toBe(201);

        await held.waitForPending();

        const listed = await fixture.chat.listThreadEvents(
          actor,
          firstRun.threadId,
        );
        const pendingRunId = listed.events.find((event) => {
          return event.revokesEventId === cancelledClientEventId;
        })?.runId;
        if (!pendingRunId) {
          throw new Error("Expected follow-up send to admit a pending Run");
        }

        const beforeCancel = await fixture.api.readRun(actor, pendingRunId);
        expect(beforeCancel.status).toBe("pending");

        const cancelResponse = await owner.run(() => {
          return fixture.api.requestCancelRun(actor, pendingRunId, [200]);
        });
        expect(cancelResponse.status).toBe(200);

        held.release();
        await flushWaitUntilForTest();

        expect(
          runsApi.receivedDispatches(runnerGroup).some((dispatch) => {
            return dispatch.executionContext.runId === pendingRunId;
          }),
        ).toBeFalsy();

        const [afterCancel, queue, thread] = await Promise.all([
          fixture.api.readRun(actor, pendingRunId),
          fixture.api.readRunQueue(actor),
          fixture.chat.readThread(actor, firstRun.threadId),
        ]);
        expect(afterCancel.status).toBe("cancelled");
        expect(afterCancel.startedAt).toBeUndefined();
        expect(queue.body.concurrency.active).toBe(0);
        expect(thread.cancellationRecoveryPending).toBeFalsy();

        const next = await dispatchChatRun({
          actor,
          owner,
          runnerGroup,
          threadId: firstRun.threadId,
          prompt: "Continue Thread after pre-dispatch cancel",
        });
        expect(next.execution.nativeContinuation).toMatchObject({
          sessionId: firstRun.threadId,
          generationRunId: firstRun.runId,
        });
      },
    );

    it(
      "runners-thread-binding-002 preserves the preceding native context when a waiting input is recalled",
      { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);
        const { actor, owner, runnerGroup, firstRun } =
          await setupNativeBindingThread();

        const blocker = await dispatchChatRun({
          actor,
          owner,
          runnerGroup,
          model: NATIVE_CLAUDE_MODEL,
          prompt: "Occupy the single concurrent Run slot",
        });

        const waitingClientEventId = randomUUID();
        const waitingSend = await owner.run(() => {
          return fixture.chat.requestSendEvent(
            actor,
            {
              threadId: firstRun.threadId,
              prompt: "Waiting prompt to be recalled",
              clientEventId: waitingClientEventId,
            },
            [201],
          );
        });
        expect(waitingSend.status).toBe(201);
        await flushWaitUntilForTest();

        const recallSend = await owner.run(() => {
          return fixture.chat.requestSendEvent(
            actor,
            {
              threadId: firstRun.threadId,
              revokesEventId: waitingClientEventId,
              clientEventId: randomUUID(),
            },
            [201],
          );
        });
        expect(recallSend.status).toBe(201);
        await flushWaitUntilForTest();

        await owner.run(() => {
          return completePublicClaudeRun(
            context,
            { runId: blocker.runId, threadId: blocker.threadId },
            { authorization: `Bearer ${blocker.execution.sandboxToken}` },
            "Blocker completed",
          );
        });

        const next = await dispatchChatRun({
          actor,
          owner,
          runnerGroup,
          threadId: firstRun.threadId,
          prompt: "Continue Thread after recalling waiting input",
        });
        expect(next.execution.nativeContinuation).toMatchObject({
          sessionId: firstRun.threadId,
          generationRunId: firstRun.runId,
        });
      },
    );
  });
});
