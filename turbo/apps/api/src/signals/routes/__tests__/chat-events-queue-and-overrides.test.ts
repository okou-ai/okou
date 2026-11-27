import { randomUUID } from "node:crypto";

import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import {
  computerUseSessionHostsContract,
  computerUseWriteCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";
import { cronSteerRunTimeBudgetContract } from "@okouai/api-contracts/contracts/cron";
import { getModelProviderPiEndpoint } from "@okouai/api-contracts/contracts/model-providers";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  PI_MODEL_CONFIG_CURRENT_GENERATION,
  PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
  runnersSteerContract,
} from "@okouai/api-contracts/contracts/runners";
import { usageRecordContract } from "@okouai/api-contracts/contracts/usage-record";
import {
  runWebhookContract,
  webhookCompleteContract,
  webhookHeartbeatContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { computerUseRoutes } from "../computer-use";
import { cronSteerRunTimeBudgetRoutes } from "../cron-steer-run-time-budget";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { usageRecordRoutes } from "../usage-record";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../webhooks-agent-health-usage-telemetry";
import {
  createBddApi,
  type ApiTestUser,
  type ApiTestUserOptions,
} from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createChatEventsFixture,
  modelProviderSecretPlaceholder,
  okouTokenFromExecution,
  type PiGptBddModel,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { captureConnectorExternalState } from "./helpers/public-connector-actor";
import { createPublicComputerUseHosts } from "./helpers/public-computer-use-hosts";
import { publicRunOwner } from "./helpers/public-run-owner";
import { readThreadModelCredits } from "./helpers/public-thread-usage";

const RUN_TIME_BUDGET_STEER_AT_MS = 115 * 60 * 1000;
const BUDGET_FALLBACK_EPOCH_MS = Date.parse("2020-01-01T00:00:00.000Z");
const COMPUTER_USE_STALE_ADVANCE_MS = 95 * 1000;
const CODEX_RESPONSES_INFERENCE_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const CODEX_FIREWALL_NAME = "model-provider:codex-oauth-token";

const context = testContext();
const bdd = createBddApi(context);
const fixture = createChatEventsFixture(context);
const firewall = createFirewallApi(context);
const webhooks = createWebhookCallbackApi(context);
const computerUse = createComputerUseBddApi(context);

const chatEventsClient = setupApp({
  context,
  routes: chatEventsRoutes,
})(chatEventsContract);
const chatThreadCreateClient = setupApp({
  context,
  routes: chatThreadCreateRoutes,
})(chatThreadsContract);
const runnersSteerClient = setupApp({
  context,
  routes: runnersRoutes,
})(runnersSteerContract);
const webhookHeartbeatClient = setupApp({
  context,
  routes: webhooksAgentHealthUsageTelemetryRoutes,
})(webhookHeartbeatContract);
const webhookCompleteClient = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const firewallAuthClient = setupApp({
  context,
  routes: webhooksAgentFirewallAuthRoutes,
})(runWebhookContract);
const cronSteerClient = setupApp({
  context,
  routes: cronSteerRunTimeBudgetRoutes,
})(cronSteerRunTimeBudgetContract);
const computerUseWriteClient = setupApp({
  context,
  routes: computerUseRoutes,
})(computerUseWriteCommandContract);
const computerUseSessionHostsClient = setupApp({
  context,
  routes: computerUseRoutes,
})(computerUseSessionHostsContract);
const onboardingCompleteClient = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const personalModelProviderClient = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const codexDeviceAuthClient = setupApp({
  context,
  routes: codexDeviceAuthRoutes,
})(codexDeviceAuthContract);
const chatThreadMetadataClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadMetadataContract);
const chatThreadEventsClient = setupApp({
  context,
  routes: chatThreadRoutes,
})(chatThreadEventsContract);
const usageRecordClient = setupApp({
  context,
  routes: usageRecordRoutes,
})(usageRecordContract);
const runsByIdClient = setupApp({
  context,
  routes: runsRoutes,
})(runsByIdContract);
const runsCancelClient = setupApp({
  context,
  routes: runsCancelRoutes,
})(runsCancelContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmupRunId = randomUUID();
  const warmupThreadId = randomUUID();
  await Promise.all([
    accept(
      chatEventsClient.send({
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
      chatThreadCreateClient.create({
        headers: {},
        body: { title: "warmup", model: null },
      }),
      [401],
    ),
    accept(
      runnersSteerClient.next({
        headers: {},
        params: { runId: warmupRunId },
      }),
      [401],
    ),
    accept(
      webhookHeartbeatClient.send({
        headers: {},
        body: { runId: warmupRunId },
      }),
      [401],
    ),
    accept(
      webhookCompleteClient.complete({
        headers: {},
        body: { runId: warmupRunId, exitCode: 0 },
      }),
      [401],
    ),
    accept(
      firewallAuthClient.firewallAuth({
        headers: {},
        body: { authHeaders: {} },
      }),
      [401],
    ),
    accept(cronSteerClient.steer({ headers: {} }), [401]),
    accept(
      computerUseWriteClient.create({
        headers: {},
        body: { kind: "app.open", app: "Safari", timeoutMs: 60_000 },
      }),
      [401],
    ),
    accept(
      computerUseSessionHostsClient.register({
        headers: {},
        body: {
          installationId: randomUUID(),
          hostName: "warmup",
          appVersion: "0.52.1",
          osVersion: "macOS 15",
          supportedCapabilities: ["app.open"],
          permissions: { accessibility: true, screenRecording: true },
        },
      }),
      [401],
    ),
    accept(onboardingCompleteClient.complete({ headers: {}, body: {} }), [401]),
    accept(
      personalModelProviderClient.upsert({
        headers: {},
        body: { type: "claude-code-oauth-token", secret: "warmup" },
      }),
      [401],
    ),
    accept(
      codexDeviceAuthClient.start({
        headers: {},
        body: { scope: "personal" },
      }),
      [401],
    ),
    accept(
      codexDeviceAuthClient.complete({
        headers: {},
        body: { sessionToken: "warmup" },
      }),
      [401],
    ),
    accept(
      chatThreadMetadataClient.get({
        headers: {},
        params: { id: warmupThreadId },
      }),
      [401],
    ),
    accept(
      chatThreadEventsClient.rows({
        headers: {},
        params: { threadId: warmupThreadId },
        query: { sinceSeqId: 0 },
      }),
      [401],
    ),
    accept(
      usageRecordClient.get({
        headers: {},
        query: {
          scope: "mine",
          range: "24h",
          tz: "UTC",
          page: 1,
          pageSize: 10,
        },
      }),
      [401],
    ),
    accept(
      runsByIdClient.getById({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
    accept(
      runsCancelClient.cancel({
        headers: {},
        params: { id: warmupRunId },
      }),
      [401],
    ),
  ]);
});

function configureSharedRunMocks(openrouterKey: string | undefined): void {
  fixture.chatCallbacks.acceptChatObjectStorage();
  fixture.api.acceptStorageDownloads();
  fixture.api.acceptTelemetryIngest();
  fixture.chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", openrouterKey);
}

async function prepareLimitedFreeActor(
  options: {
    readonly userOptions?: ApiTestUserOptions;
    readonly openrouterKey?: string;
    readonly clockTime?: () => number;
    readonly beforeRuns?: () => Promise<void>;
    readonly afterRuns?: () => Promise<void>;
  } = {},
) {
  const actor = fixture.bdd.user(options.userOptions);
  const previousOpenrouterKey = optionalEnv("OPENROUTER_API_KEY");
  configureSharedRunMocks(options.openrouterKey);
  const captured = captureConnectorExternalState(context, [
    "OPENROUTER_API_KEY",
    "CRON_SECRET",
  ]);
  const owner = publicRunOwner(context, actor, {
    clockTime: options.clockTime,
    restoreEnvironment: () => {
      captured();
      mockOptionalEnv("OPENROUTER_API_KEY", previousOpenrouterKey);
    },
    beforeRuns: options.beforeRuns,
    afterRuns: options.afterRuns,
  });
  await owner.run(async () => {
    await Promise.all([
      bdd.bootstrapLimitedFreeOnboarding(actor),
      fixture.api.configureRunnerGroup(),
    ]);
  });
  return { actor, owner };
}

async function prepareSecondAutoActor(
  actor: ApiTestUser,
  options: {
    readonly clockTime?: () => number;
  } = {},
) {
  const captured = captureConnectorExternalState(context, [
    "OPENROUTER_API_KEY",
    "CRON_SECRET",
  ]);
  const owner = publicRunOwner(context, actor, {
    clockTime: options.clockTime,
    restoreEnvironment: captured,
  });
  await owner.run(async () => {
    await bdd.bootstrapLimitedFreeOnboarding(actor);
  });
  return { actor, owner };
}

function findBudgetEvents(events: readonly ChatEvent[]) {
  return events.filter((event) => {
    return event.eventType === "input.budget";
  });
}

function assertCodexPiDispatch(args: {
  readonly execution: RunnerExecutionInput;
  readonly threadId: string;
  readonly model: PiGptBddModel;
  readonly thinkingLevel: "xhigh" | "medium";
  readonly serviceTier: "fast" | undefined;
  readonly accountSourceId: string;
  readonly rawAccountId: string;
  readonly rawRefreshToken: string;
  readonly expiredAccessToken: string;
}) {
  const { execution } = args;
  expect(execution.cliAgentType).toBe("pi");
  expect(execution.piSessionId).toBe(args.threadId);
  expect(execution.piModelConfig).toMatchObject({
    schemaVersion:
      args.serviceTier === "fast"
        ? PI_MODEL_CONFIG_DIALECT_TIER_GENERATION
        : PI_MODEL_CONFIG_CURRENT_GENERATION,
    dialect: "openai-codex-responses",
    transport: "sse",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    model: args.model,
    thinkingLevel: args.thinkingLevel,
  });
  if (args.serviceTier === "fast") {
    expect(execution.piModelConfig).toMatchObject({ serviceTier: "fast" });
  } else {
    expect(execution.piModelConfig).not.toHaveProperty("serviceTier");
  }
  expect(
    getModelProviderPiEndpoint("codex-oauth-token", "openai-codex-responses")
      ?.inferenceUrl,
  ).toBe(CODEX_RESPONSES_INFERENCE_URL);

  expect(execution.environment).toMatchObject({
    CHATGPT_ACCESS_TOKEN: modelProviderSecretPlaceholder(
      "codex-oauth-token",
      "CHATGPT_ACCESS_TOKEN",
    ),
    CHATGPT_ACCOUNT_ID: modelProviderSecretPlaceholder(
      "codex-oauth-token",
      "CHATGPT_ACCOUNT_ID",
    ),
    OPENAI_MODEL: args.model,
  });
  expect(execution.secretConnectorMetadataMap).toMatchObject({
    CHATGPT_ACCESS_TOKEN: {
      sourceType: "model-provider",
      sourceId: args.accountSourceId,
    },
    CHATGPT_ACCOUNT_ID: {
      sourceType: "model-provider",
      sourceId: args.accountSourceId,
    },
  });

  const serialized = JSON.stringify(execution);
  expect(serialized).not.toContain(args.rawAccountId);
  expect(serialized).not.toContain(args.rawRefreshToken);
  expect(serialized).not.toContain(args.expiredAccessToken);

  expect(execution.firewalls).toContainEqual(
    expect.objectContaining({ name: CODEX_FIREWALL_NAME }),
  );
  expect(execution.networkPolicies?.[CODEX_FIREWALL_NAME]).toMatchObject({
    allow: ["codex:api"],
    unknownPolicy: "deny",
  });
  expect(execution.billableFirewalls).toStrictEqual([]);
}

async function resolveCodexProviderHeaders(execution: RunnerExecutionInput) {
  const response = await firewall.requestFirewallAuth(
    { authorization: `Bearer ${execution.firewallToken}` },
    {
      authHeaders: {
        Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
        "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
      },
      secretConnectorMap: execution.secretConnectorMap ?? undefined,
      secretConnectorMetadataMap:
        execution.secretConnectorMetadataMap ?? undefined,
    },
    [200],
  );
  return response.body;
}

async function runNativeCodexPiScenario(args: {
  readonly model: PiGptBddModel;
  readonly thinkingLevel: "xhigh" | "medium";
  readonly serviceTier: "fast" | undefined;
  readonly outcome: "completed" | "cancelled";
}) {
  const { actor, owner } = await prepareLimitedFreeActor();
  const rawAccountId = `ws_codex_${randomUUID().slice(0, 8)}`;
  const rawRefreshToken = `rt_codex_${randomUUID()}`;
  const nowSeconds = Math.floor(now() / 1000);
  const { oauth, accountSourceId } = await fixture.connectSubscriptionPiModel(
    actor,
    {
      accountId: rawAccountId,
      refreshToken: rawRefreshToken,
      accessTokenExpiresAt: nowSeconds - 120,
      refreshedAccessTokenExpiresAt: nowSeconds + 7200,
    },
  );
  const expiredAccessToken = oauth.oauthTokenResponses[0]?.access_token;
  if (!expiredAccessToken) {
    throw new Error("Expected initial Codex OAuth access token");
  }

  const run1 = await fixture.sendChatRun(actor, {
    prompt: `Run ${args.model} ${args.serviceTier ?? "standard"}`,
    model: args.model,
    ...(args.serviceTier === "fast"
      ? { runOptions: { codexServiceTier: "fast" } }
      : {}),
  });
  const execution1 = await owner.executionInput(run1.runId);
  const sandboxHeaders1 = {
    authorization: `Bearer ${execution1.sandboxToken}`,
  };

  assertCodexPiDispatch({
    execution: execution1,
    threadId: run1.threadId,
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    serviceTier: args.serviceTier,
    accountSourceId,
    rawAccountId,
    rawRefreshToken,
    expiredAccessToken,
  });

  const resolvedHeaders = await resolveCodexProviderHeaders(execution1);
  const refreshCalls = oauth.oauthToken.filter((params) => {
    return params.get("grant_type") === "refresh_token";
  });
  expect(refreshCalls).toHaveLength(1);
  const refreshedAccessToken = oauth.oauthTokenResponses[1]?.access_token;
  if (!refreshedAccessToken) {
    throw new Error("Expected refreshed Codex OAuth access token");
  }
  if (!("headers" in resolvedHeaders)) {
    throw new Error("Expected resolved firewall auth headers");
  }
  expect(resolvedHeaders.headers).toMatchObject({
    Authorization: `Bearer ${refreshedAccessToken}`,
    "ChatGPT-Account-ID": rawAccountId,
  });

  if (args.outcome === "cancelled") {
    await fixture.api.requestCancelRun(actor, run1.runId, [200]);
  }

  const completionBody = {
    runId: run1.runId,
    exitCode: 0,
    completion: {
      cliAgentType: "pi" as const,
      cliAgentSessionId: run1.threadId,
      cliAgentSessionHistoryDisposition: "native_only" as const,
    },
  };
  const firstCallback = await webhooks.requestAgentComplete(
    completionBody,
    sandboxHeaders1,
    [200],
  );
  const retryCallback = await webhooks.requestAgentComplete(
    completionBody,
    sandboxHeaders1,
    [200],
  );
  await flushWaitUntilForTest();

  expect(firstCallback.status).toBe(200);
  expect(retryCallback.status).toBe(200);
  const [finalRun, creditsAfterFirst] = await Promise.all([
    fixture.api.readRun(actor, run1.runId),
    readThreadModelCredits(context, actor, run1.threadId),
  ]);
  expect(finalRun.status).toBe(args.outcome);
  expect(creditsAfterFirst).toBe(0);

  if (args.outcome === "completed") {
    const run2 = await fixture.sendChatRun(actor, {
      threadId: run1.threadId,
      prompt: "Follow up on the same thread",
    });
    const [execution2, creditsAfterFollowup] = await Promise.all([
      owner.executionInput(run2.runId),
      readThreadModelCredits(context, actor, run1.threadId),
    ]);
    expect(execution2.cliAgentType).toBe("pi");
    expect(execution2.piSessionId).toBe(run1.threadId);
    expect(execution2.nativeContinuation).toMatchObject({
      sessionId: run1.threadId,
      generationRunId: run1.runId,
    });
    if (args.serviceTier === "fast") {
      expect(execution2.piModelConfig).toMatchObject({
        schemaVersion: PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
        model: args.model,
        serviceTier: "fast",
      });
    } else {
      expect(execution2.piModelConfig).toMatchObject({
        schemaVersion: PI_MODEL_CONFIG_CURRENT_GENERATION,
        model: args.model,
      });
      expect(execution2.piModelConfig).not.toHaveProperty("serviceTier");
    }
    expect(creditsAfterFollowup).toBe(0);
  }

  return {
    runId: run1.runId,
    threadId: run1.threadId,
    outcome: finalRun.status,
  };
}

describe("chat-events-identity", () => {
  it(
    "chat-events-identity-002 preserves the caller's run annotation on immediate and queued handoffs",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });

      const sourceRun = await fixture.sendChatRun(actor, {
        prompt: "Source orchestrator run",
        model: null,
      });
      const sourceExecution = await owner.executionInput(sourceRun.runId);
      const agentToken = okouTokenFromExecution(sourceExecution);

      const createdChildThread = await accept(
        chatThreadCreateClient.create({
          headers: { authorization: `Bearer ${agentToken}` },
          body: { title: "Child handoff thread", model: null },
        }),
        [201],
      );
      expect(createdChildThread.status).toBe(201);
      const childThreadId = createdChildThread.body.id;

      const firstPrompt = "Immediate child handoff prompt";
      const secondPrompt = "Queued child handoff prompt";
      const firstClientEventId = randomUUID();
      const secondClientEventId = randomUUID();

      const firstSend = await fixture.requestSendEventWithBearer(
        agentToken,
        {
          threadId: childThreadId,
          prompt: firstPrompt,
          clientEventId: firstClientEventId,
        },
        [201],
      );
      expect(firstSend.status).toBe(201);
      await flushWaitUntilForTest();

      const afterFirstSend = await fixture.chat.listThreadEvents(
        actor,
        childThreadId,
      );
      const firstLaunched = afterFirstSend.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === firstClientEventId &&
          event.runId !== undefined
        );
      });
      if (!firstLaunched?.runId) {
        throw new Error("Expected the immediate child handoff to launch a run");
      }
      const firstChildRunId = firstLaunched.runId;
      const firstChildExecution = await owner.executionInput(firstChildRunId);

      const secondSend = await fixture.requestSendEventWithBearer(
        agentToken,
        {
          threadId: childThreadId,
          prompt: secondPrompt,
          clientEventId: secondClientEventId,
        },
        [201],
      );
      expect(secondSend.status).toBe(201);
      await flushWaitUntilForTest();

      await fixture.cancelChatRun(actor, firstChildRunId, {
        authorization: `Bearer ${firstChildExecution.sandboxToken}`,
      });

      const afterPromotion = await fixture.chat.listThreadEvents(
        actor,
        childThreadId,
      );
      const secondLaunched = afterPromotion.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === secondClientEventId &&
          event.runId !== undefined
        );
      });
      if (!secondLaunched?.runId) {
        throw new Error("Expected the queued child handoff to promote");
      }
      const secondChildRunId = secondLaunched.runId;
      const [, firstRunRead, secondRunRead] = await Promise.all([
        owner.executionInput(secondChildRunId),
        fixture.api.readRun(actor, firstChildRunId),
        fixture.api.readRun(actor, secondChildRunId),
      ]);
      expect(firstRunRead).toMatchObject({
        runId: firstChildRunId,
        prompt: firstPrompt,
      });
      expect(secondRunRead).toMatchObject({
        runId: secondChildRunId,
        prompt: secondPrompt,
      });

      const expectedAnnotation = expect.objectContaining({
        type: "chat_thread",
        threadId: sourceRun.threadId,
        runId: sourceRun.runId,
      });
      expect(
        firstLaunched.eventType === "input.prompt"
          ? firstLaunched.userMessage.parts
          : [],
      ).toContainEqual(expectedAnnotation);
      expect(
        secondLaunched.eventType === "input.prompt"
          ? secondLaunched.userMessage.parts
          : [],
      ).toContainEqual(expectedAnnotation);
    },
  );

  it(
    "chat-events-identity-003 (1/4) grants computer-use capability on explicit and sticky host selections",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const hosts = createPublicComputerUseHosts(context);
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
        afterRuns: () => {
          return hosts.cleanup();
        },
      });
      const hostName = "Owner Desk Mac";
      const startedHost = await hosts.start(actor, owner.run, { hostName });

      const selectedRun = await fixture.sendChatRun(actor, {
        prompt: "Explicitly select the online host",
        model: null,
        computerUseHostId: startedHost.hostId,
      });
      const selectedExecution = await owner.executionInput(selectedRun.runId);
      const selectedToken = okouTokenFromExecution(selectedExecution);

      expect(selectedExecution.appendSystemPrompt).toContain(hostName);
      expect(selectedExecution.appendSystemPrompt).not.toContain(
        startedHost.hostId,
      );
      const selectedWrite =
        await computerUse.requestCreateComputerUseWriteCommand(
          { bearer: selectedToken },
          [200],
        );
      expect(selectedWrite.status).toBe(200);

      await fixture.completeChatRunOk(
        selectedRun.runId,
        { authorization: `Bearer ${selectedExecution.sandboxToken}` },
        { cliAgentType: "pi", cliAgentSessionId: selectedRun.threadId },
      );

      const stickyRun = await fixture.sendChatRun(actor, {
        threadId: selectedRun.threadId,
        prompt: "Continue on sticky computer-use host",
      });
      const stickyExecution = await owner.executionInput(stickyRun.runId);
      const stickyToken = okouTokenFromExecution(stickyExecution);

      expect(stickyExecution.appendSystemPrompt).toContain(hostName);
      expect(stickyExecution.appendSystemPrompt).not.toContain(
        startedHost.hostId,
      );
      const stickyWrite =
        await computerUse.requestCreateComputerUseWriteCommand(
          { bearer: stickyToken },
          [200],
        );
      expect(stickyWrite.status).toBe(200);
    },
  );

  it(
    "chat-events-identity-003 (2/4) denies computer-use writes on a no-host run while allowing chat send and recall",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const hosts = createPublicComputerUseHosts(context);
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
        afterRuns: () => {
          return hosts.cleanup();
        },
      });
      await hosts.start(actor, owner.run, { hostName: "Studio Mac" });

      const run = await fixture.sendChatRun(actor, {
        prompt: "Run without computer-use host",
        model: null,
      });
      const execution = await owner.executionInput(run.runId);
      const agentToken = okouTokenFromExecution(execution);

      const deniedWrite =
        await computerUse.requestCreateComputerUseWriteCommand(
          { bearer: agentToken },
          [403],
        );
      expect(deniedWrite.status).toBe(403);

      const queuedEventId = randomUUID();
      const submitted = await fixture.requestSendEventWithBearer(
        agentToken,
        {
          threadId: run.threadId,
          prompt: "Queued from no-host agent token",
          clientEventId: queuedEventId,
        },
        [201],
      );
      expect(submitted.status).toBe(201);

      const recalled = await accept(
        chatEventsClient.send({
          headers: { authorization: `Bearer ${agentToken}` },
          body: {
            threadId: run.threadId,
            revokesEventId: queuedEventId,
          },
        }),
        [201],
      );
      expect(recalled.status).toBe(201);
    },
  );

  it(
    "chat-events-identity-003 (3/4) removes computer-use grant when cleared with explicit null",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const hosts = createPublicComputerUseHosts(context);
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
        afterRuns: () => {
          return hosts.cleanup();
        },
      });
      const startedHost = await hosts.start(actor, owner.run, {
        hostName: "Clearable Desk Mac",
      });

      const selectedRun = await fixture.sendChatRun(actor, {
        prompt: "Bind thread to computer-use host",
        model: null,
        computerUseHostId: startedHost.hostId,
      });
      const selectedExecution = await owner.executionInput(selectedRun.runId);
      await fixture.completeChatRunOk(
        selectedRun.runId,
        { authorization: `Bearer ${selectedExecution.sandboxToken}` },
        { cliAgentType: "pi", cliAgentSessionId: selectedRun.threadId },
      );

      const clearedRun = await fixture.sendChatRun(actor, {
        threadId: selectedRun.threadId,
        prompt: "Clear host grant with explicit null",
        computerUseHostId: null,
      });
      const clearedExecution = await owner.executionInput(clearedRun.runId);
      const clearedToken = okouTokenFromExecution(clearedExecution);

      const clearedWrite =
        await computerUse.requestCreateComputerUseWriteCommand(
          { bearer: clearedToken },
          [403],
        );
      expect(clearedWrite.status).toBe(403);
    },
  );

  it(
    "chat-events-identity-003 (4/4) retains guidance on a stale host selection and succeeds after heartbeat reconnect",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      let currentTime = now();
      const clockTime = () => {
        return currentTime;
      };
      const hosts = createPublicComputerUseHosts(context);
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
        clockTime,
        afterRuns: () => {
          return hosts.cleanup();
        },
      });
      const hostName = "Reconnecting Studio Mac";
      const startedHost = await hosts.start(actor, owner.run, { hostName });

      currentTime += COMPUTER_USE_STALE_ADVANCE_MS;
      await owner.run(async () => {
        await fixture.api.configureRunnerGroup();
      });

      const staleRun = await owner.run(() => {
        return fixture.sendChatRun(actor, {
          prompt: "Select stale host before heartbeat reconnect",
          model: null,
          computerUseHostId: startedHost.hostId,
        });
      });
      const staleExecution = await owner.executionInput(staleRun.runId);
      const staleToken = okouTokenFromExecution(staleExecution);

      expect(staleExecution.appendSystemPrompt).toContain(hostName);
      expect(staleExecution.appendSystemPrompt).not.toContain(
        startedHost.hostId,
      );

      await owner.run(async () => {
        await computerUse.heartbeatComputerUseHost(startedHost.connection, {
          hostName,
        });
      });
      const reconnectedWrite = await owner.run(() => {
        return computerUse.requestCreateComputerUseWriteCommand(
          { bearer: staleToken },
          [200],
        );
      });
      expect(reconnectedWrite.status).toBe(200);
    },
  );
});

describe("chat-events-model-overrides", () => {
  it(
    "chat-events-model-overrides-004 hands native standard subscription gpt-6-luna runs to a generation-2 Sandbox with completed outcome and no built-in billing",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const result = await runNativeCodexPiScenario({
        model: "gpt-6-luna",
        thinkingLevel: "xhigh",
        serviceTier: undefined,
        outcome: "completed",
      });
      expect(result.outcome).toBe("completed");
    },
  );

  it(
    "chat-events-model-overrides-005 hands native Fast subscription gpt-6-luna runs to a generation-3 Sandbox with completed outcome and no built-in billing",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const result = await runNativeCodexPiScenario({
        model: "gpt-6-luna",
        thinkingLevel: "xhigh",
        serviceTier: "fast",
        outcome: "completed",
      });
      expect(result.outcome).toBe("completed");
    },
  );

  it(
    "chat-events-model-overrides-009 hands native Fast subscription gpt-6.1-sol runs to a generation-3 Sandbox with cancelled outcome and no built-in billing",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const result = await runNativeCodexPiScenario({
        model: "gpt-6.1-sol",
        thinkingLevel: "medium",
        serviceTier: "fast",
        outcome: "cancelled",
      });
      expect(result.outcome).toBe("cancelled");
    },
  );

  it(
    "chat-events-model-overrides-002 persists a send model selection on the thread while preserving same-family sessions",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor();
      mockClaudeCodeTokenEndpoint();
      await fixture.api.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "bdd-personal-claude-token",
      });

      const priorAnswer = "Opus-only confidential answer token 9142";
      const opusSessionId = `claude-opus-session-${randomUUID().slice(0, 8)}`;
      const sonnetSessionId = `claude-sonnet-session-${randomUUID().slice(0, 8)}`;

      const run1 = await fixture.sendChatRun(actor, {
        prompt: "First turn with Opus",
        model: "claude-opus-5-5",
      });
      const execution1 = await owner.executionInput(run1.runId);
      expect(execution1.cliAgentType).toBe("claude-code");
      expect(execution1.environment?.ANTHROPIC_MODEL).toBe("claude-opus-5-5");

      fixture.chatCallbacks.mockChatOutputEvents([
        {
          eventType: "assistant",
          sequenceNumber: 1,
          eventData: {
            message: { content: [{ type: "text", text: priorAnswer }] },
          },
        },
      ]);
      await fixture.completeChatRunOk(
        run1.runId,
        { authorization: `Bearer ${execution1.sandboxToken}` },
        {
          cliAgentType: "claude-code",
          cliAgentSessionId: opusSessionId,
        },
      );

      const run2 = await fixture.sendChatRun(actor, {
        threadId: run1.threadId,
        prompt: "Second turn switched to Sonnet",
        model: "claude-sonnet-5-5",
      });
      const execution2 = await owner.executionInput(run2.runId);
      expect(execution2.cliAgentType).toBe("claude-code");
      expect(execution2.environment?.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
      expect(execution2.nativeContinuation).toMatchObject({
        sessionId: opusSessionId,
        generationRunId: run1.runId,
      });
      expect(execution2.prompt).not.toContain(priorAnswer);
      expect(execution2.appendSystemPrompt).toContain(run1.threadId);
      expect(execution2.appendSystemPrompt).toContain(
        `okou chat messages --thread-id ${run1.threadId} --output-dir /tmp/okou-chat-history`,
      );

      const [metadata, threadEvents] = await Promise.all([
        fixture.chat.readThreadMetadata(actor, run1.threadId),
        fixture.chat.requestThreadEvents(actor, {}, [200]),
      ]);
      expect(metadata.selectedModel).toBe("claude-sonnet-5-5");
      expect(threadEvents.status).toBe(200);
      if (threadEvents.status === 200) {
        expect(threadEvents.body.events).toContainEqual(
          expect.objectContaining({
            kind: "model_selection_updated",
            chatThreadId: run1.threadId,
            selectedModel: "claude-sonnet-5-5",
          }),
        );
      }

      await fixture.completeChatRunOk(
        run2.runId,
        { authorization: `Bearer ${execution2.sandboxToken}` },
        {
          cliAgentType: "claude-code",
          cliAgentSessionId: sonnetSessionId,
        },
      );

      const run3 = await fixture.sendChatRun(actor, {
        threadId: run1.threadId,
        prompt: "Third turn omitting model",
      });
      const execution3 = await owner.executionInput(run3.runId);
      expect(execution3.environment?.ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
      expect(execution3.nativeContinuation).toMatchObject({
        sessionId: sonnetSessionId,
        generationRunId: run2.runId,
      });
    },
  );
});

describe("chat-events-budget-steer", () => {
  it(
    "chat-events-budget-steer-001 the scheduled fallback warns active Runs and skips completed Runs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      let currentTime = BUDGET_FALLBACK_EPOCH_MS;
      const clockTime = () => {
        return currentTime;
      };
      const { actor: activeActor, owner: activeOwner } =
        await prepareLimitedFreeActor({
          openrouterKey: "bdd-openrouter-key",
          clockTime,
        });
      const { actor: completedActor, owner: completedOwner } =
        await prepareSecondAutoActor(fixture.bdd.user(), { clockTime });

      const activeRun = await activeOwner.run(() => {
        return fixture.sendChatRun(activeActor, {
          prompt: "Stay active past the budget warning threshold",
          model: null,
        });
      });
      const completedRun = await completedOwner.run(() => {
        return fixture.sendChatRun(completedActor, {
          prompt: "Finish before the budget sweep",
          model: null,
        });
      });

      await activeOwner.executionInput(activeRun.runId);
      const completedExecution = await completedOwner.executionInput(
        completedRun.runId,
      );

      currentTime = BUDGET_FALLBACK_EPOCH_MS + 60_000;
      await completedOwner.run(async () => {
        await fixture.completeChatRunOk(
          completedRun.runId,
          { authorization: `Bearer ${completedExecution.sandboxToken}` },
          {
            cliAgentType: "pi",
            cliAgentSessionId: completedRun.threadId,
          },
        );
        await flushWaitUntilForTest();
      });

      currentTime =
        BUDGET_FALLBACK_EPOCH_MS + RUN_TIME_BUDGET_STEER_AT_MS + 60_000;
      const cronResponse = await withMockNowForTest(currentTime, async () => {
        return await accept(
          cronSteerClient.steer({
            headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
          }),
          [200],
        );
      });
      await flushWaitUntilForTest();

      expect(cronResponse.status).toBe(200);

      const activeThread = await fixture.chat.listThreadEvents(
        activeActor,
        activeRun.threadId,
      );
      expect(findBudgetEvents(activeThread.events)).toHaveLength(1);

      const completedReadback = await fixture.api.readRun(
        completedActor,
        completedRun.runId,
      );
      expect(completedReadback.status).toBe("completed");
      const completedThread = await fixture.chat.listThreadEvents(
        completedActor,
        completedRun.threadId,
      );
      expect(findBudgetEvents(completedThread.events)).toStrictEqual([]);
    },
  );

  it(
    "chat-events-budget-steer-003 revokes an unsteered warning at completion and never gives it to the next run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = now();
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });

      const run1 = await fixture.sendChatRun(actor, {
        prompt: "Reach time budget without steering the warning",
        model: null,
      });
      const execution1 = await owner.executionInput(run1.runId);
      const sandboxHeaders1 = {
        authorization: `Bearer ${execution1.sandboxToken}`,
      };

      const overdueTime = startTime + RUN_TIME_BUDGET_STEER_AT_MS + 60_000;
      await withMockNowForTest(overdueTime, async () => {
        await webhooks.requestAgentHeartbeat(
          { runId: run1.runId },
          sandboxHeaders1,
          [200],
        );
        await flushWaitUntilForTest();
      });

      await fixture.completeChatRunOk(run1.runId, sandboxHeaders1, {
        cliAgentType: "pi",
        cliAgentSessionId: run1.threadId,
      });

      const run2 = await fixture.sendChatRun(actor, {
        threadId: run1.threadId,
        prompt: "Successor run on the same thread",
      });
      const execution2 = await owner.executionInput(run2.runId);

      const [polled, afterSuccessor] = await Promise.all([
        fixture.api.nextSteerableInput(execution2.sandboxToken, run2.runId),
        fixture.chat.listThreadEvents(actor, run1.threadId),
      ]);
      expect(polled.input).toBeNull();

      const budgetEvents = findBudgetEvents(afterSuccessor.events);
      expect(budgetEvents).toHaveLength(1);
      const warningId = budgetEvents[0]?.id;
      if (!warningId) {
        throw new Error("Expected the pending budget warning event");
      }
      const revokes = afterSuccessor.events.filter((event) => {
        return (
          event.eventType === "control.revoke" &&
          event.revokesEventId === warningId
        );
      });
      expect(revokes).toHaveLength(1);
      expect(revokes[0]?.runId).toBe(run1.runId);
    },
  );

  it(
    "chat-events-budget-steer-004 a Run heartbeat does not warn another owner's overdue Run",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = now();
      const { actor: actor1, owner: owner1 } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });
      const { actor: actor2, owner: owner2 } = await prepareSecondAutoActor(
        fixture.bdd.user(),
      );

      const run1 = await fixture.sendChatRun(actor1, {
        prompt: "First owner overdue run",
        model: null,
      });
      const run2 = await fixture.sendChatRun(actor2, {
        prompt: "Second owner overdue run",
        model: null,
      });
      const execution1 = await owner1.executionInput(run1.runId);
      const execution2 = await owner2.executionInput(run2.runId);

      const overdueTime = startTime + RUN_TIME_BUDGET_STEER_AT_MS + 60_000;
      await withMockNowForTest(overdueTime, async () => {
        await webhooks.requestAgentHeartbeat(
          { runId: run1.runId },
          { authorization: `Bearer ${execution1.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });

      const firstThreadAfterFirstHb = await fixture.chat.listThreadEvents(
        actor1,
        run1.threadId,
      );
      const secondThreadAfterFirstHb = await fixture.chat.listThreadEvents(
        actor2,
        run2.threadId,
      );
      expect(findBudgetEvents(firstThreadAfterFirstHb.events)).toHaveLength(1);
      expect(findBudgetEvents(secondThreadAfterFirstHb.events)).toStrictEqual(
        [],
      );

      await withMockNowForTest(overdueTime + 1000, async () => {
        await webhooks.requestAgentHeartbeat(
          { runId: run2.runId },
          { authorization: `Bearer ${execution2.sandboxToken}` },
          [200],
        );
        await flushWaitUntilForTest();
      });

      const secondThreadAfterSecondHb = await fixture.chat.listThreadEvents(
        actor2,
        run2.threadId,
      );
      expect(findBudgetEvents(secondThreadAfterSecondHb.events)).toHaveLength(
        1,
      );
    },
  );
});

describe("chat-events-message-queue", () => {
  it(
    "chat-events-message-queue-002 steers a message into the running sandbox run by its source event id",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });

      const run1 = await fixture.sendChatRun(actor, {
        prompt: "Initial active run",
        model: null,
      });
      const execution1 = await owner.executionInput(run1.runId);

      const queuedEventId = randomUUID();
      const queuedPrompt = "Steer this queued update directly";
      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          prompt: queuedPrompt,
          clientEventId: queuedEventId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      const polled = await fixture.api.nextSteerableInput(
        execution1.sandboxToken,
        run1.runId,
      );
      expect(polled.input).toMatchObject({
        eventId: queuedEventId,
        prompt: expect.stringContaining(queuedPrompt),
      });

      const steeredWhileRunning = await fixture.api.declareSteeredInput(
        execution1.sandboxToken,
        run1.runId,
        queuedEventId,
      );
      expect(steeredWhileRunning).toStrictEqual({ outcome: "steered" });

      await fixture.completeChatRunOk(
        run1.runId,
        { authorization: `Bearer ${execution1.sandboxToken}` },
        {
          cliAgentType: "pi",
          cliAgentSessionId: run1.threadId,
        },
      );
      await flushWaitUntilForTest();

      const steeredAfterComplete = await fixture.api.declareSteeredInput(
        execution1.sandboxToken,
        run1.runId,
        queuedEventId,
      );
      expect(steeredAfterComplete).toStrictEqual({ outcome: "steered" });

      const threadEvents = await fixture.chat.listThreadEvents(
        actor,
        run1.threadId,
      );
      const replacements = threadEvents.events.filter((event) => {
        return event.revokesEventId === queuedEventId;
      });
      expect(replacements).toHaveLength(1);
      expect(replacements[0]).toMatchObject({
        eventType: "input.prompt",
        runId: run1.runId,
      });

      const launchedRunIds = new Set(
        threadEvents.events.flatMap((event) => {
          return event.eventType === "input.prompt" && event.runId !== undefined
            ? [event.runId]
            : [];
        }),
      );
      expect([...launchedRunIds]).toStrictEqual([run1.runId]);
    },
  );

  it(
    "chat-events-message-queue-003 releases unconfirmed prompts before draining in FIFO order",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });

      const run1 = await fixture.sendChatRun(actor, {
        prompt: "Blocking run before FIFO queue",
        model: null,
      });
      const execution1 = await owner.executionInput(run1.runId);

      const firstQueuedId = randomUUID();
      const secondQueuedId = randomUUID();
      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          prompt: "First queued prompt",
          clientEventId: firstQueuedId,
        },
        [201],
      );
      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          prompt: "Second queued prompt",
          clientEventId: secondQueuedId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      const polled = await fixture.api.nextSteerableInput(
        execution1.sandboxToken,
        run1.runId,
      );
      expect(polled.input?.eventId).toBe(firstQueuedId);

      await fixture.completeChatRunOk(
        run1.runId,
        { authorization: `Bearer ${execution1.sandboxToken}` },
        {
          cliAgentType: "pi",
          cliAgentSessionId: run1.threadId,
        },
      );
      await flushWaitUntilForTest();

      const afterComplete = await fixture.chat.listThreadEvents(
        actor,
        run1.threadId,
      );
      const promotedFirst = afterComplete.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === firstQueuedId &&
          event.runId !== undefined
        );
      });
      expect(promotedFirst?.runId).toBeDefined();
      expect(promotedFirst?.runId).not.toBe(run1.runId);
      if (promotedFirst?.runId) {
        await owner.executionInput(promotedFirst.runId);
      }

      const secondReplacements = afterComplete.events.filter((event) => {
        return event.revokesEventId === secondQueuedId;
      });
      expect(secondReplacements).toStrictEqual([]);

      const recallResponse = await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          revokesEventId: secondQueuedId,
        },
        [201],
      );
      expect(recallResponse.status).toBe(201);
    },
  );

  it(
    "chat-events-message-queue-005 queues, retries, and recalls messages behind an active run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor: actor1, owner: owner1 } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });
      mockClaudeCodeTokenEndpoint();
      await fixture.api.createPersonalModelProvider(actor1, {
        type: "claude-code-oauth-token",
        secret: "bdd-personal-claude-token",
      });
      const actor2 = fixture.bdd.user({ orgId: actor1.orgId });
      const otherThread = await fixture.chat.createThread(actor2, {
        model: null,
      });

      const initialEventId = randomUUID();
      const run1 = await fixture.sendChatRun(actor1, {
        prompt: "Active run holding the thread",
        model: null,
        clientEventId: initialEventId,
      });
      await owner1.executionInput(run1.runId);

      const queuedClientEventId = randomUUID();
      const firstQueueSend = await fixture.chat.requestSendEvent(
        actor1,
        {
          threadId: run1.threadId,
          prompt: "Queued behind active run",
          clientEventId: queuedClientEventId,
        },
        [201],
      );
      expect(firstQueueSend.status).toBe(201);

      await fixture.api.updateUserModelPreference(actor1, "claude-sonnet-5-5");
      const retryQueueSend = await fixture.chat.requestSendEvent(
        actor1,
        {
          threadId: run1.threadId,
          prompt: "Queued behind active run",
          model: "claude-sonnet-5-5",
          clientEventId: queuedClientEventId,
        },
        [201],
      );
      expect(retryQueueSend.status).toBe(201);

      const otherUserDuplicate = await fixture.chat.requestSendEvent(
        actor2,
        {
          threadId: otherThread.id,
          prompt: "Cross-user duplicate client id",
          clientEventId: queuedClientEventId,
        },
        [201],
      );
      expect(otherUserDuplicate.status).toBe(201);
      await flushWaitUntilForTest();

      const otherThreadEvents = await fixture.chat.listThreadEvents(
        actor2,
        otherThread.id,
      );
      expect(otherThreadEvents.events).toStrictEqual([]);

      const [ownerThreadEvents, metadata] = await Promise.all([
        fixture.chat.listThreadEvents(actor1, run1.threadId),
        fixture.chat.readThreadMetadata(actor1, run1.threadId),
      ]);
      const originalQueuedInputs = ownerThreadEvents.events.filter((event) => {
        return event.id === queuedClientEventId;
      });
      expect(originalQueuedInputs).toHaveLength(1);
      expect(metadata.selectedModel).toBe("auto");

      const launchedPrompt = ownerThreadEvents.events.find((event) => {
        return event.eventType === "input.prompt" && event.runId === run1.runId;
      });
      if (!launchedPrompt) {
        throw new Error("Expected the active run's prompt event");
      }

      const firstRecall = await fixture.chat.requestSendEvent(
        actor1,
        {
          threadId: run1.threadId,
          revokesEventId: queuedClientEventId,
        },
        [201],
      );
      const [secondRecall, runAssociatedRecall] = await Promise.all([
        fixture.chat.requestSendEvent(
          actor1,
          {
            threadId: run1.threadId,
            revokesEventId: queuedClientEventId,
          },
          [201],
        ),
        fixture.chat.requestSendEvent(
          actor1,
          {
            threadId: run1.threadId,
            revokesEventId: launchedPrompt.id,
          },
          [400],
        ),
      ]);
      expect(firstRecall.status).toBe(201);
      expect(secondRecall.status).toBe(201);
      expect(runAssociatedRecall.status).toBe(400);
      if (runAssociatedRecall.status === 400) {
        expect(runAssociatedRecall.body.error.message).toBe(
          "Only queued user messages can be recalled",
        );
      }

      await fixture.api.requestCancelRun(actor1, run1.runId, [200]);
      const cancelledRun = await fixture.api.readRun(actor1, run1.runId);
      expect(cancelledRun.status).toBe("cancelled");
    },
  );

  it(
    "pf-148 drains multiple queued follow-ups in FIFO order after completion without dropping work",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, owner } = await prepareLimitedFreeActor({
        openrouterKey: "bdd-openrouter-key",
      });

      const run1 = await fixture.sendChatRun(actor, {
        prompt: "Initial active run before multiple queued follow-ups",
        model: null,
      });
      const execution1 = await owner.executionInput(run1.runId);

      const firstQueuedId = randomUUID();
      const secondQueuedId = randomUUID();
      const firstPrompt = "First FIFO queued follow-up";
      const secondPrompt = "Second FIFO queued follow-up";

      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          prompt: firstPrompt,
          clientEventId: firstQueuedId,
        },
        [201],
      );
      await fixture.chat.requestSendEvent(
        actor,
        {
          threadId: run1.threadId,
          prompt: secondPrompt,
          clientEventId: secondQueuedId,
        },
        [201],
      );
      await flushWaitUntilForTest();

      await fixture.completeChatRunOk(
        run1.runId,
        { authorization: `Bearer ${execution1.sandboxToken}` },
        {
          cliAgentType: "pi",
          cliAgentSessionId: run1.threadId,
        },
      );
      await flushWaitUntilForTest();

      const afterFirstComplete = await fixture.chat.listThreadEvents(
        actor,
        run1.threadId,
      );
      const promotedFirst = afterFirstComplete.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === firstQueuedId &&
          event.runId !== undefined
        );
      });
      expect(promotedFirst?.runId).toBeDefined();
      expect(promotedFirst?.runId).not.toBe(run1.runId);
      expect(
        afterFirstComplete.events.filter((event) => {
          return event.revokesEventId === secondQueuedId;
        }),
      ).toStrictEqual([]);
      if (!promotedFirst?.runId) {
        throw new Error("Expected first queued follow-up to launch a Run");
      }

      const execution2 = await owner.executionInput(promotedFirst.runId);
      expect(execution2.prompt).toBe(firstPrompt);

      await fixture.completeChatRunOk(
        promotedFirst.runId,
        { authorization: `Bearer ${execution2.sandboxToken}` },
        {
          cliAgentType: "pi",
          cliAgentSessionId: run1.threadId,
        },
      );
      await flushWaitUntilForTest();

      const afterSecondComplete = await fixture.chat.listThreadEvents(
        actor,
        run1.threadId,
      );
      const promotedSecond = afterSecondComplete.events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === secondQueuedId &&
          event.runId !== undefined
        );
      });
      expect(promotedSecond?.runId).toBeDefined();
      expect(promotedSecond?.runId).not.toBe(run1.runId);
      expect(promotedSecond?.runId).not.toBe(promotedFirst.runId);
      if (!promotedSecond?.runId) {
        throw new Error("Expected second queued follow-up to launch a Run");
      }

      const execution3 = await owner.executionInput(promotedSecond.runId);
      expect(execution3.prompt).toBe(secondPrompt);

      await fixture.completeChatRunOk(
        promotedSecond.runId,
        { authorization: `Bearer ${execution3.sandboxToken}` },
        {
          cliAgentType: "pi",
          cliAgentSessionId: run1.threadId,
        },
      );
      await flushWaitUntilForTest();

      const finalRun = await fixture.api.readRun(actor, promotedSecond.runId);
      expect(finalRun.status).toBe("completed");
    },
  );
});
