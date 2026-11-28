import { randomUUID } from "node:crypto";

import { billingStatusContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import {
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadModelSelectionContract,
  chatThreadUsageContract,
  type ChatRunOptionsRequest,
} from "@okouai/api-contracts/contracts/chat-threads";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  webhookClerkContract,
  webhookCompleteContract,
  webhookEventsContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  workflowAutomationsContract,
  workflowsCollectionContract,
} from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeAll, describe, expect, it } from "vitest";
import { boolean, literal, object as zObject } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { createAppWithRoutes } from "../../../app-factory-core";
import { mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { billingStatusRoutes } from "../billing-status";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadModelSelectionRoutes } from "../chat-threads-model-selection";
import { chatThreadUsageRoutes } from "../chat-threads-usage";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { userPreferencesRoutes } from "../user-preferences";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentEventsRoutes } from "../webhooks-agent-events";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksWorkflowAutomationsRoutes } from "../webhooks-workflow-automations";
import { workflowAutomationsRoutes } from "../workflow-automations";
import { workflowsRoutes } from "../workflows";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const workflows = createWorkflowsBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const routeMocks = createRouteMocks(context);

const billingStatusApi = setupApp({ context, routes: billingStatusRoutes })(
  billingStatusContract,
);
const chatEventsApi = setupApp({ context, routes: chatEventsRoutes })(
  chatEventsContract,
);
const chatThreadEventsApi = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadEventsContract,
);
const chatThreadMetadataApi = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadMetadataContract,
);
const chatThreadModelSelectionApi = setupApp({
  context,
  routes: chatThreadModelSelectionRoutes,
})(chatThreadModelSelectionContract);
const chatThreadUsageApi = setupApp({ context, routes: chatThreadUsageRoutes })(
  chatThreadUsageContract,
);
const codexDeviceAuthApi = setupApp({
  context,
  routes: codexDeviceAuthRoutes,
})(codexDeviceAuthContract);
const onboardingCompleteApi = setupApp({
  context,
  routes: onboardingCompleteRoutes,
})(onboardingCompleteContract);
const personalModelProvidersApi = setupApp({
  context,
  routes: meModelProvidersUpsertRoutes,
})(personalModelProvidersMainContract);
const runnersHeartbeatApi = setupApp({ context, routes: runnersRoutes })(
  runnersHeartbeatContract,
);
const runsByIdApi = setupApp({ context, routes: runsRoutes })(runsByIdContract);
const userModelPreferenceApi = setupApp({
  context,
  routes: userModelPreferenceRoutes,
})(userModelPreferenceContract);
const userPreferencesApi = setupApp({
  context,
  routes: userPreferencesRoutes,
})(userPreferencesContract);
const webhooksAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const webhooksAgentEventsApi = setupApp({
  context,
  routes: webhooksAgentEventsRoutes,
})(webhookEventsContract);
const webhooksClerkApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);
const workflowsCollectionApi = setupApp({ context, routes: workflowsRoutes })(
  workflowsCollectionContract,
);
const workflowAutomationsApi = setupApp({
  context,
  routes: workflowAutomationsRoutes,
})(workflowAutomationsContract);
const featureSwitchesApi = setupApp({
  context,
  routes: featureSwitchesRoutes,
})(featureSwitchesContract);

const automationWebhookResponseSchema = zObject({
  success: literal(true),
  duplicate: boolean(),
});

beforeAll(async () => {
  const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmed = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(
        webhooksClerkApi.post({
          body: "{}",
          extraHeaders: {},
        }),
        [401],
      ),
      accept(billingStatusApi.get({ headers: {} }), [401]),
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
        chatThreadEventsApi.rows({
          headers: {},
          params: { threadId: randomUUID() },
          query: { sinceSeqId: 0 },
        }),
        [401],
      ),
      accept(userModelPreferenceApi.get({ headers: {} }), [401]),
      accept(userPreferencesApi.get({ headers: {} }), [401]),
      accept(
        chatThreadMetadataApi.get({
          headers: {},
          params: { id: randomUUID() },
        }),
        [401],
      ),
      accept(
        chatThreadModelSelectionApi.update({
          headers: {},
          params: { id: randomUUID() },
          body: { model: null },
        }),
        [401],
      ),
      accept(
        codexDeviceAuthApi.start({
          headers: {},
          body: { scope: "personal" },
        }),
        [401],
      ),
      accept(onboardingCompleteApi.complete({ headers: {}, body: {} }), [401]),
      accept(
        personalModelProvidersApi.upsert({
          headers: {},
          body: { type: "claude-code-oauth-token", secret: "warmup" },
        }),
        [401],
      ),
      accept(
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: randomUUID(),
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
        runsByIdApi.getById({ headers: {}, params: { id: randomUUID() } }),
        [401],
      ),
      accept(
        webhooksAgentCompleteApi.complete({
          headers: {},
          body: { runId: randomUUID(), exitCode: 0 },
        }),
        [401],
      ),
      accept(
        webhooksAgentEventsApi.send({
          headers: {},
          body: {
            runId: randomUUID(),
            events: [{ type: "result", sequenceNumber: 1, result: "warmup" }],
          },
        }),
        [401],
      ),
      accept(workflowsCollectionApi.list({ headers: {}, query: {} }), [401]),
      accept(workflowAutomationsApi.listWorkspace({ headers: {} }), [401]),
      accept(
        chatThreadUsageApi.read({
          headers: {},
          params: { id: randomUUID() },
          body: { runIds: [randomUUID()] },
        }),
        [401],
      ),
      accept(featureSwitchesApi.get({ headers: {} }), [401]),
    ]);
  });
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
  if (!warmed.ok) {
    throw warmed.error;
  }
});

function signIn(actor: ApiTestUser): void {
  routeMocks.clerk.session(actor.userId, actor.orgId ?? null, actor.orgRole);
}

function requireOrgId(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected actor to belong to an organization");
  }
  return actor.orgId;
}

function initRuntimeMocks(): void {
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  chatCallbacks.disableVapid();
}

async function connectPersonalCodex(
  actor: ApiTestUser,
  options: Parameters<typeof mockCodexDeviceAuthProvider>[0] = {},
) {
  const oauth = mockCodexDeviceAuthProvider(options);
  const started = await authDevice.requestCodexStart(actor, "personal", [200], {
    mode: "add",
  });
  if (started.status !== 200) {
    throw new Error("Expected Codex device auth to start");
  }
  const completed = await authDevice.requestCodexComplete(
    actor,
    started.body.sessionToken,
    [200],
  );
  if (!("status" in completed.body) || completed.body.status !== "complete") {
    throw new Error("Expected Codex device auth to complete");
  }
  return { oauth, accountSourceId: completed.body.provider.id };
}

async function connectPersonalClaude(actor: ApiTestUser) {
  mockClaudeCodeTokenEndpoint();
  return await runs.createPersonalModelProvider(actor, {
    type: "claude-code-oauth-token",
    secret: `claude-token-${randomUUID()}`,
  });
}

async function setupFreeMemberWithSubscriptions(options: {
  readonly claude?: boolean;
  readonly codex?: Parameters<typeof mockCodexDeviceAuthProvider>[0] | true;
  readonly featureSwitches?: Readonly<Record<string, boolean>>;
}): Promise<{
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
  readonly codexAccountSourceId?: string;
}> {
  const actor = bdd.user();
  initRuntimeMocks();
  let codexAccountSourceId: string | undefined;
  const tasks: Promise<unknown>[] = [bdd.bootstrapLimitedFreeOnboarding(actor)];
  if (options.claude) {
    tasks.push(connectPersonalClaude(actor));
  }
  if (options.codex) {
    tasks.push(
      connectPersonalCodex(
        actor,
        options.codex === true ? {} : options.codex,
      ).then(({ accountSourceId }) => {
        codexAccountSourceId = accountSourceId;
      }),
    );
  }
  if (options.featureSwitches) {
    tasks.push(
      updateFeatureSwitchesForUser(
        context,
        {
          userId: actor.userId,
          orgId: requireOrgId(actor),
          orgRole: actor.orgRole,
        },
        options.featureSwitches,
      ),
    );
  }
  const [runnerGroup] = await Promise.all([
    runs.configureRunnerGroup(),
    ...tasks,
  ]);
  return { actor, runnerGroup, codexAccountSourceId };
}

async function sendPromptAndClaim(
  actor: ApiTestUser,
  runnerGroup: string,
  body: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: string | null;
    readonly runOptions?: ChatRunOptionsRequest;
    readonly clientEventId?: string;
  },
) {
  const clientEventId = body.clientEventId ?? randomUUID();
  signIn(actor);
  const sent = await accept(
    chatEventsApi.send({
      headers,
      body: {
        prompt: body.prompt,
        hasTextContent: true,
        clientEventId,
        ...(body.threadId === undefined ? {} : { threadId: body.threadId }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.runOptions === undefined
          ? {}
          : { runOptions: body.runOptions }),
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: body.prompt }],
        },
      },
    }),
    [201],
  );
  const execution = await runs.nextReceivedExecution(runnerGroup);
  return {
    execution,
    runId: execution.runId,
    threadId: sent.body.threadId,
    clientEventId,
  };
}

async function completeNativeRun(args: {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentType: "claude-code" | "codex" | "pi";
  readonly sessionId?: string;
  readonly answer?: string;
}): Promise<void> {
  const sandboxHeaders = { authorization: `Bearer ${args.sandboxToken}` };
  const sessionId = args.sessionId ?? `bdd-session-${args.runId}`;
  let lastEventSequence: number | undefined;
  if (args.answer !== undefined) {
    if (args.cliAgentType === "codex") {
      await webhooks.requestAgentEvents(
        {
          runId: args.runId,
          events: [
            {
              type: "thread.started",
              thread_id: sessionId,
              sequenceNumber: 1,
            },
            {
              type: "item.completed",
              sequenceNumber: 2,
              item: {
                id: `msg_${args.runId}`,
                type: "agent_message",
                text: args.answer,
              },
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      lastEventSequence = 2;
    } else {
      await webhooks.requestAgentEvents(
        {
          runId: args.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              sequenceNumber: 1,
            },
            {
              type: "assistant",
              sequenceNumber: 2,
              message: { content: [{ type: "text", text: args.answer }] },
            },
            {
              type: "result",
              sequenceNumber: 3,
              result: args.answer,
            },
          ],
        },
        sandboxHeaders,
        [200],
      );
      lastEventSequence = 3;
    }
  }
  await webhooks.requestAgentComplete(
    {
      runId: args.runId,
      exitCode: 0,
      ...(lastEventSequence === undefined ? {} : { lastEventSequence }),
      completion: {
        cliAgentType: args.cliAgentType,
        cliAgentSessionId: sessionId,
        cliAgentSessionHistoryDisposition: "native_only",
      },
    },
    sandboxHeaders,
    [200],
  );
  await flushWaitUntilForTest();
}

async function readThreadUsage(
  actor: ApiTestUser,
  threadId: string,
  runId: string,
) {
  signIn(actor);
  const response = await accept(
    chatThreadUsageApi.read({
      headers,
      params: { id: threadId },
      body: { runIds: [runId] },
    }),
    [200],
  );
  return response.body;
}

async function postSignedAutomationWebhook(args: {
  readonly webhookUrl: string;
  readonly webhookSecret: string;
  readonly payload: string;
  readonly timestamp: number;
}) {
  const rawBody = JSON.stringify({ event: args.payload });
  const response = await createAppWithRoutes({
    signal: context.signal,
    routes: webhooksWorkflowAutomationsRoutes,
  }).request(new URL(args.webhookUrl).pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Okou-Timestamp": String(args.timestamp),
      "X-Okou-Signature": computeHmacSignature(
        rawBody,
        args.webhookSecret,
        args.timestamp,
      ),
    },
    body: rawBody,
  });
  expect(response.status).toBe(200);
  return automationWebhookResponseSchema.parse(await response.json());
}

describe("Codex execution switch", () => {
  it(
    "chat-events-codex-execution-007 (1/2) rotates native session and preserves visible context when switching from Pi to native Codex",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        codex: { accountId: "acct-codex-rotate-pi-to-codex" },
      });
      const orgId = requireOrgId(actor);
      const piAnswer = "PI_UNIQUE_ANSWER_ALPHA_719";

      const turn1 = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Turn one on Pi",
        model: "gpt-6-luna",
      });
      expect(turn1.execution.cliAgentType).toBe("pi");

      await Promise.all([
        updateFeatureSwitchesForUser(
          context,
          { userId: actor.userId, orgId, orgRole: actor.orgRole },
          { [FeatureSwitchKey.CodexExecution]: true },
        ),
        completeNativeRun({
          runId: turn1.runId,
          sandboxToken: turn1.execution.sandboxToken,
          cliAgentType: "pi",
          sessionId: turn1.threadId,
          answer: piAnswer,
        }),
      ]);

      const turn2 = await sendPromptAndClaim(actor, runnerGroup, {
        threadId: turn1.threadId,
        prompt: "Turn two on native Codex",
        model: "gpt-6-luna",
      });
      expect(turn2.execution.cliAgentType).toBe("codex");
      expect(turn2.execution.nativeContinuation.sessionId).toBeNull();
      expect(turn2.execution.nativeContinuation.generationRunId).toBeNull();
      expect(turn2.execution.nativeContinuation.recoveryPrompt).toContain(
        "okou chat messages --output-dir /tmp/okou-chat-history",
      );
      expect(turn2.execution.prompt).not.toContain(piAnswer);
      expect(turn2.execution.appendSystemPrompt ?? "").not.toContain(piAnswer);
    },
  );

  it(
    "chat-events-codex-execution-007 (2/2) rotates native session and preserves visible context when switching from native Codex back to Pi",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        codex: { accountId: "acct-codex-rotate-codex-to-pi" },
        featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
      });
      const orgId = requireOrgId(actor);
      const codexAnswer = "CODEX_UNIQUE_ANSWER_BETA_823";

      const turn1 = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Turn one on native Codex",
        model: "gpt-6-luna",
      });
      expect(turn1.execution.cliAgentType).toBe("codex");

      await Promise.all([
        completeNativeRun({
          runId: turn1.runId,
          sandboxToken: turn1.execution.sandboxToken,
          cliAgentType: "codex",
          sessionId: randomUUID(),
          answer: codexAnswer,
        }),
        updateFeatureSwitchesForUser(
          context,
          { userId: actor.userId, orgId, orgRole: actor.orgRole },
          { [FeatureSwitchKey.CodexExecution]: false },
        ),
      ]);

      const [run1Readback, turn2] = await Promise.all([
        runs.readRun(actor, turn1.runId),
        sendPromptAndClaim(actor, runnerGroup, {
          threadId: turn1.threadId,
          prompt: "Turn two back on Pi",
          model: "gpt-6-luna",
        }),
      ]);
      expect(run1Readback.status).toBe("completed");

      expect(turn2.execution.cliAgentType).toBe("pi");
      expect(turn2.execution.nativeContinuation.sessionId).toBeNull();
      expect(turn2.execution.nativeContinuation.generationRunId).toBeNull();
      expect(turn2.execution.nativeContinuation.recoveryPrompt).toContain(
        "okou chat messages --output-dir /tmp/okou-chat-history",
      );
      expect(turn2.execution.prompt).not.toContain(codexAnswer);
      expect(turn2.execution.appendSystemPrompt ?? "").not.toContain(
        codexAnswer,
      );
    },
  );

  it(
    "chat-events-codex-execution-002 routes native Codex for gpt-6.1-sol with tier fast when KMS decryption is unavailable",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const accountId = "acct-codex-sol-fast";
      const { actor, runnerGroup, codexAccountSourceId } =
        await setupFreeMemberWithSubscriptions({
          codex: { accountId },
          featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
        });
      if (!codexAccountSourceId) {
        throw new Error("Expected connected Codex account source ID");
      }

      useSecretKmsProbe(undefined, () => {
        return Promise.reject(new Error("KMS decryption unavailable"));
      });

      const { execution } = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Run fast GPT-6.1 Sol on native Codex",
        model: "gpt-6.1-sol",
        runOptions: { codexServiceTier: "fast", reasoningEffort: "high" },
      });

      expect(execution.cliAgentType).toBe("codex");
      expect(execution.environment).toMatchObject({
        OPENAI_MODEL: "gpt-6.1-sol",
        CODEX_OAUTH_ACCOUNT_ID: accountId,
      });
      expect(execution.platformEnvironment).toMatchObject({
        OKOU_CODEX_SERVICE_TIER: "fast",
        OKOU_REASONING_EFFORT: "high",
      });
      expect(execution.secretConnectorMap).toMatchObject({
        CHATGPT_ACCESS_TOKEN: "codex-oauth-token",
      });
      expect(execution.secretConnectorMetadataMap).toMatchObject({
        CHATGPT_ACCESS_TOKEN: {
          sourceType: "model-provider",
          sourceUserId: actor.userId,
          sourceId: codexAccountSourceId,
          metadataKey: "codex-oauth-token",
        },
      });
      expect(execution.piModelConfig).toBeUndefined();
      expect(execution.piLaunchConfig).toBeUndefined();
      expect(execution.piSessionId).toBeUndefined();
      expect(execution.billableFirewalls).toStrictEqual([]);
    },
  );

  it(
    "chat-events-codex-execution-005 uses the switch when an event-triggered workflow launches a subscription chat",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      const orgId = requireOrgId(actor);
      const accountId = "acct-codex-event-luna";
      initRuntimeMocks();
      const [codex, runnerGroup] = await Promise.all([
        connectPersonalCodex(actor, { accountId }),
        runs.configureRunnerGroup(),
        runs.grantProEntitlement(actor, { tier: "team" }),
        updateFeatureSwitchesForUser(
          context,
          { userId: actor.userId, orgId, orgRole: actor.orgRole },
          { [FeatureSwitchKey.CodexExecution]: true },
        ),
      ]);
      const [, thread] = await Promise.all([
        runs.updateUserModelPreference(actor, "gpt-6-luna"),
        chat.createThread(actor, { model: "gpt-6-luna" }),
      ]);
      const workflowId = await workflows.createWorkflow(actor, {
        name: `event-codex-${randomUUID().slice(0, 8)}`,
        chatThreadId: thread.id,
      });
      signIn(actor);
      const created = await accept(
        workflowAutomationsApi.create({
          headers,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = created.body;
      if (
        automation.kind !== "event" ||
        automation.eventType !== "webhook-received" ||
        !automation.webhookUrl ||
        !automation.webhookSecret
      ) {
        throw new Error("Expected a webhook automation");
      }
      await postSignedAutomationWebhook({
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "trigger codex switch event run",
        timestamp: Math.floor(now() / 1000),
      });
      const execution = await runs.nextReceivedExecution(runnerGroup);

      expect(execution.cliAgentType).toBe("codex");
      expect(execution.environment).toMatchObject({
        OPENAI_MODEL: "gpt-6-luna",
        CODEX_OAUTH_ACCOUNT_ID: accountId,
      });
      expect(execution.secretConnectorMetadataMap).toMatchObject({
        CHATGPT_ACCESS_TOKEN: {
          sourceType: "model-provider",
          sourceUserId: actor.userId,
          sourceId: codex.accountSourceId,
          metadataKey: "codex-oauth-token",
        },
      });
      expect(execution.piLaunchConfig).toBeUndefined();
      expect(execution.piModelConfig).toBeUndefined();
      expect(execution.billableFirewalls).toStrictEqual([]);
    },
  );

  it(
    "chat-events-codex-execution-006 leaves Claude subscriptions on Claude Code",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
        featureSwitches: { [FeatureSwitchKey.CodexExecution]: true },
      });

      const { execution } = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Keep personal Claude Fable on Claude Code",
        model: "claude-fable-5-1",
      });

      expect(execution.cliAgentType).toBe("claude-code");
      expect(execution.environment).toMatchObject({
        ANTHROPIC_MODEL: "claude-fable-5-1",
      });
      expect(execution.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
      expect(execution.piModelConfig).toBeUndefined();
    },
  );
});

describe("new chat event member defaults", () => {
  it(
    "chat-events-member-defaults-002 (1/2) captures saved high effort and cloud browser true on the first thread and retains them on continuation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
      });

      signIn(actor);
      await accept(
        userModelPreferenceApi.update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: {
              model: "claude-fable-5-1",
              effort: "high",
            },
          },
        }),
        [200],
      );
      await accept(
        userPreferencesApi.update({
          headers,
          body: { cloudBrowserEnabledByDefault: true },
        }),
        [200],
      );

      const first = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "First turn with saved defaults",
      });
      const firstMetadata = await chat.readThreadMetadata(
        actor,
        first.threadId,
      );
      expect(firstMetadata).toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "high" } },
        cloudBrowserEnabled: true,
      });

      await completeNativeRun({
        runId: first.runId,
        sandboxToken: first.execution.sandboxToken,
        cliAgentType: "claude-code",
      });

      signIn(actor);
      await accept(
        userModelPreferenceApi.update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: {
              model: "claude-fable-5-1",
              effort: "low",
            },
          },
        }),
        [200],
      );
      await accept(
        userPreferencesApi.update({
          headers,
          body: { cloudBrowserEnabledByDefault: false },
        }),
        [200],
      );

      await sendPromptAndClaim(actor, runnerGroup, {
        threadId: first.threadId,
        prompt: "Continue original thread after default change",
      });
      const continuedMetadata = await chat.readThreadMetadata(
        actor,
        first.threadId,
      );

      expect(continuedMetadata).toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "high" } },
        cloudBrowserEnabled: true,
      });
    },
  );

  it(
    "chat-events-member-defaults-001 uses empty model settings and enables cloud browser without a saved member preference",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const owner = bdd.user();
      const orgId = requireOrgId(owner);
      initRuntimeMocks();
      const [runnerGroup] = await Promise.all([
        runs.configureRunnerGroup(),
        runs.grantProEntitlement(owner, { tier: "pro" }),
      ]);

      const member = bdd.user({ orgId, orgRole: "org:member" });
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "organizationMembership.created",
        data: {
          organization: { id: orgId },
          public_user_data: { user_id: member.userId },
          created_at: now(),
        },
      });
      await Promise.all([
        webhooks.requestClerkWebhook("{}", {}, [200]),
        connectPersonalClaude(member),
      ]);
      await flushWaitUntilForTest();

      signIn(member);
      const preference = await accept(
        userModelPreferenceApi.get({ headers }),
        [200],
      );
      expect(preference.status).toBe(200);
      expect(preference.body.updatedAt).toBeNull();

      const { threadId } = await sendPromptAndClaim(member, runnerGroup, {
        prompt: "Create thread with unsaved defaults",
        model: "claude-fable-5-1",
      });
      const metadata = await chat.readThreadMetadata(member, threadId);

      expect(metadata).toMatchObject({
        modelSettings: {},
        cloudBrowserEnabled: true,
      });
    },
  );

  it(
    "chat-events-member-defaults-002 (2/2) captures updated low effort and cloud browser false on a newly created thread",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
      });

      signIn(actor);
      await accept(
        userModelPreferenceApi.update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: {
              model: "claude-fable-5-1",
              effort: "high",
            },
          },
        }),
        [200],
      );
      await accept(
        userPreferencesApi.update({
          headers,
          body: { cloudBrowserEnabledByDefault: true },
        }),
        [200],
      );
      await accept(
        userModelPreferenceApi.update({
          headers,
          body: {
            selectedModel: "claude-fable-5-1",
            serviceTier: null,
            modelSettingsPatch: {
              model: "claude-fable-5-1",
              effort: "low",
            },
          },
        }),
        [200],
      );
      await accept(
        userPreferencesApi.update({
          headers,
          body: { cloudBrowserEnabledByDefault: false },
        }),
        [200],
      );

      const nextThread = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Start a fresh thread with updated defaults",
      });
      const nextMetadata = await chat.readThreadMetadata(
        actor,
        nextThread.threadId,
      );

      expect(nextMetadata).toMatchObject({
        modelSettings: { "claude-fable-5-1": { effort: "low" } },
        cloudBrowserEnabled: false,
      });
    },
  );
});

describe("CHAT effort: thread configuration", () => {
  it(
    "chat-events-effort-001 dispatches gpt-6-luna with xhigh as the default Pi effort",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        codex: true,
      });

      const { execution } = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Use default reasoning effort for GPT-6 Luna",
        model: "gpt-6-luna",
      });

      expect(execution.cliAgentType).toBe("pi");
      expect(execution.platformEnvironment.OKOU_REASONING_EFFORT).toBe("xhigh");
      expect(execution.piModelConfig).toMatchObject({
        provider: "openai-codex",
        model: "gpt-6-luna",
        thinkingLevel: "xhigh",
      });
    },
  );

  it(
    "chat-events-effort-002 (1/2) applies saved Fable high effort and defaults Astra override to max while retaining Fable high",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
        codex: true,
      });
      const thread = await chat.createThread(actor, {
        model: "claude-fable-5-1",
      });
      await chat.updateThreadModelSelection(
        actor,
        thread.id,
        "claude-fable-5-1",
        { reasoningEffort: "high" },
      );

      const fableTurn = await sendPromptAndClaim(actor, runnerGroup, {
        threadId: thread.id,
        prompt: "Send on Fable thread with saved high effort",
      });
      expect(fableTurn.execution.cliAgentType).toBe("claude-code");
      expect(
        fableTurn.execution.platformEnvironment.OKOU_REASONING_EFFORT,
      ).toBe("high");

      await completeNativeRun({
        runId: fableTurn.runId,
        sandboxToken: fableTurn.execution.sandboxToken,
        cliAgentType: "claude-code",
      });

      const astraTurn = await sendPromptAndClaim(actor, runnerGroup, {
        threadId: thread.id,
        prompt: "Override original thread model to Astra",
        model: "gpt-6-astra",
      });
      const metadata = await chat.readThreadMetadata(actor, thread.id);

      expect(astraTurn.execution.cliAgentType).toBe("codex");
      expect(astraTurn.execution.environment?.OPENAI_MODEL).toBe("gpt-6-astra");
      expect(
        astraTurn.execution.platformEnvironment.OKOU_REASONING_EFFORT,
      ).toBe("max");
      expect(metadata.selectedModel).toBe("gpt-6-astra");
      expect(metadata.modelSettings).toStrictEqual({
        "claude-fable-5-1": { effort: "high" },
      });
    },
  );

  it(
    "chat-events-effort-002 (2/2) applies explicit Fable extra effort and stores it on the new thread",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
      });

      const { execution, threadId } = await sendPromptAndClaim(
        actor,
        runnerGroup,
        {
          prompt: "Start a Fable thread with explicit extra effort",
          model: "claude-fable-5-1",
          runOptions: { reasoningEffort: "extra" },
        },
      );
      const metadata = await chat.readThreadMetadata(actor, threadId);

      expect(execution.cliAgentType).toBe("claude-code");
      expect(execution.platformEnvironment.OKOU_REASONING_EFFORT).toBe("extra");
      expect(metadata.selectedModel).toBe("claude-fable-5-1");
      expect(metadata.modelSettings).toStrictEqual({
        "claude-fable-5-1": { effort: "extra" },
      });
    },
  );

  it(
    "chat-events-effort-003 falls back from unavailable gpt-6-sol ultra without deleting the preference",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        codex: true,
      });

      const first = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "First Sol turn requesting unsupported ultra effort",
        model: "gpt-6-sol",
        runOptions: { reasoningEffort: "ultra" },
      });
      const firstMetadata = await chat.readThreadMetadata(
        actor,
        first.threadId,
      );
      expect(first.execution.cliAgentType).toBe("pi");
      expect(first.execution.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        "max",
      );
      expect(first.execution.piModelConfig).toMatchObject({
        model: "gpt-6-sol",
        thinkingLevel: "max",
      });
      expect(firstMetadata.modelSettings).toStrictEqual({
        "gpt-6-sol": { effort: "ultra" },
      });

      await completeNativeRun({
        runId: first.runId,
        sandboxToken: first.execution.sandboxToken,
        cliAgentType: "pi",
        sessionId: first.threadId,
      });

      const second = await sendPromptAndClaim(actor, runnerGroup, {
        threadId: first.threadId,
        prompt: "Second Sol turn using saved ultra preference",
      });
      const secondMetadata = await chat.readThreadMetadata(
        actor,
        first.threadId,
      );

      expect(second.execution.cliAgentType).toBe("pi");
      expect(second.execution.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        "max",
      );
      expect(second.execution.piModelConfig).toMatchObject({
        model: "gpt-6-sol",
        thinkingLevel: "max",
      });
      expect(secondMetadata.modelSettings).toStrictEqual({
        "gpt-6-sol": { effort: "ultra" },
      });
    },
  );

  it(
    "chat-events-effort-005 preserves enqueued settings after thread edits and retries with Pi false and high effort",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, runnerGroup } = await setupFreeMemberWithSubscriptions({
        claude: true,
      });

      const active = await sendPromptAndClaim(actor, runnerGroup, {
        prompt: "Active Fable high run",
        model: "claude-fable-5-1",
        runOptions: { reasoningEffort: "high" },
      });
      const queuedEventId = randomUUID();
      signIn(actor);
      const queuedFirst = await accept(
        chatEventsApi.send({
          headers,
          body: {
            threadId: active.threadId,
            clientEventId: queuedEventId,
            prompt: "Queued follow-up while Fable high is active",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Queued follow-up while Fable high is active",
                },
              ],
            },
          },
        }),
        [201],
      );
      expect(queuedFirst.status).toBe(201);

      await chat.updateThreadModelSelection(
        actor,
        active.threadId,
        "claude-fable-5-1",
        { reasoningEffort: "extra" },
      );

      signIn(actor);
      const queuedRetry = await accept(
        chatEventsApi.send({
          headers,
          body: {
            threadId: active.threadId,
            clientEventId: queuedEventId,
            prompt: "Queued follow-up while Fable high is active",
            model: "claude-fable-5-1",
            runOptions: { reasoningEffort: "extra" },
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "text",
                  text: "Queued follow-up while Fable high is active",
                },
              ],
            },
          },
        }),
        [201],
      );
      expect(queuedRetry.status).toBe(201);

      await runs.requestCancelRun(actor, active.runId, [200]);
      await webhooks.requestAgentComplete(
        { runId: active.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${active.execution.sandboxToken}` },
        [200],
      );
      const promotedExecution = await runs.nextReceivedExecution(runnerGroup);

      const [history, metadata] = await Promise.all([
        chat.listThreadEvents(actor, active.threadId),
        chat.readThreadMetadata(actor, active.threadId),
      ]);
      const queuedInputs = history.events.filter((event) => {
        return event.eventType === "input.prompt" && event.id === queuedEventId;
      });
      const promotedInputs = history.events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === queuedEventId
        );
      });
      expect(queuedInputs).toHaveLength(1);
      expect(queuedInputs[0]?.runId).toBeUndefined();
      expect(promotedInputs).toHaveLength(1);
      const promoted = promotedInputs[0];
      if (promoted?.eventType !== "input.prompt" || !promoted.runId) {
        throw new Error("Expected promoted replacement with a Run ID");
      }
      expect(promoted.runId).toBe(promotedExecution.runId);
      expect(promoted.runId).not.toBe(active.runId);
      const modelPart = promoted.userMessage.parts.find((part) => {
        return part.type === "model";
      });
      expect(modelPart).toStrictEqual({
        type: "model",
        selectedModel: "claude-fable-5-1",
      });

      expect(promotedExecution.cliAgentType).toBe("claude-code");
      expect(promotedExecution.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        "high",
      );
      expect(
        promotedExecution.platformEnvironment.OKOU_CODEX_SERVICE_TIER,
      ).toBeUndefined();
      expect(metadata.selectedModel).toBe("claude-fable-5-1");
      expect(metadata.modelSettings).toStrictEqual({
        "claude-fable-5-1": { effort: "extra" },
      });
      expect(metadata.serviceTier).toBeNull();
    },
  );
});

describe("personal native subscription activation", () => {
  it(
    "chat-events-native-routes-001 uses the personal Claude schedule Automation handoff and completion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      initRuntimeMocks();
      const [runnerGroup, billing] = await Promise.all([
        runs.configureRunnerGroup(),
        runs.grantProEntitlement(actor, { tier: "pro" }),
        connectPersonalClaude(actor),
      ]);
      const [, workflowId] = await Promise.all([
        runs.updateUserModelPreference(actor, "claude-fable-5-1"),
        workflows.createWorkflow(actor, {
          name: `loop-claude-${randomUUID().slice(0, 8)}`,
          instruction: "Run hourly check on personal Claude subscription.",
        }),
      ]);
      signIn(actor);
      const createdAutomation = await accept(
        workflowAutomationsApi.create({
          headers,
          params: { workflowId },
          body: {
            kind: "schedule",
            schedule: { type: "loop", intervalSeconds: 3600 },
          },
        }),
        [201],
      );

      signIn(actor);
      const launched = await accept(
        workflowAutomationsApi.run({
          headers,
          params: { id: createdAutomation.body.id },
        }),
        [201],
      );
      expect(launched.status).toBe(201);
      expect(launched.body.chatThreadId).toBeTruthy();

      const threadId = launched.body.chatThreadId;
      const execution = await runs.nextReceivedExecution(runnerGroup);
      const runId = execution.runId;

      expect(execution.cliAgentType).toBe("claude-code");
      expect(execution.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
      expect(execution.piModelConfig).toBeUndefined();
      expect(execution.billableFirewalls).toStrictEqual([]);

      await completeNativeRun({
        runId,
        sandboxToken: execution.sandboxToken,
        cliAgentType: "claude-code",
      });

      const [run, threadPage, threadUsage, billingAfter] = await Promise.all([
        runs.readRun(actor, runId),
        chat.listThreadEvents(actor, threadId),
        readThreadUsage(actor, threadId, runId),
        runs.readBillingStatus(actor),
      ]);

      expect(run.status).toBe("completed");
      expect(run.source).toMatchObject({
        providerType: "claude-code-oauth-token",
        credentialScope: "member",
      });
      expect(
        threadPage.events
          .filter((event) => {
            return (
              event.runId === runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual(["run.completed"]);
      expect(threadUsage.runs).toStrictEqual([]);
      expect(billingAfter.credits).toBe(billing.credits);
    },
  );

  it(
    "chat-events-native-routes-002 uses the personal Claude event Automation handoff and completion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user();
      initRuntimeMocks();
      const [runnerGroup, billing] = await Promise.all([
        runs.configureRunnerGroup(),
        runs.grantProEntitlement(actor, { tier: "team" }),
        connectPersonalClaude(actor),
      ]);
      const [, workflowId] = await Promise.all([
        runs.updateUserModelPreference(actor, "claude-fable-5-1"),
        workflows.createWorkflow(actor, {
          name: `event-claude-${randomUUID().slice(0, 8)}`,
          instruction: "Handle webhook event on personal Claude subscription.",
        }),
      ]);
      signIn(actor);
      const createdAutomation = await accept(
        workflowAutomationsApi.create({
          headers,
          params: { workflowId },
          body: { kind: "event", eventType: "webhook-received" },
        }),
        [201],
      );
      const automation = createdAutomation.body;
      if (
        automation.kind !== "event" ||
        automation.eventType !== "webhook-received" ||
        !automation.webhookUrl ||
        !automation.webhookSecret ||
        !automation.chatThreadId
      ) {
        throw new Error("Expected a thread-bound webhook automation");
      }

      const timestamp = Math.floor(now() / 1000);
      const deliveryArgs = {
        webhookUrl: automation.webhookUrl,
        webhookSecret: automation.webhookSecret,
        payload: "signed-provider-event-once",
        timestamp,
      };
      const firstDelivery = await postSignedAutomationWebhook(deliveryArgs);
      const replayDelivery = await postSignedAutomationWebhook(deliveryArgs);

      expect(firstDelivery).toStrictEqual({ success: true, duplicate: false });
      expect(replayDelivery).toStrictEqual({ success: true, duplicate: true });

      const threadId = automation.chatThreadId;
      const execution = await runs.nextReceivedExecution(runnerGroup);
      const runId = execution.runId;

      expect(execution.cliAgentType).toBe("claude-code");
      expect(execution.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
      expect(execution.piModelConfig).toBeUndefined();
      expect(execution.billableFirewalls).toStrictEqual([]);

      await completeNativeRun({
        runId,
        sandboxToken: execution.sandboxToken,
        cliAgentType: "claude-code",
      });

      const [run, threadPage, threadUsage, billingAfter] = await Promise.all([
        runs.readRun(actor, runId),
        chat.listThreadEvents(actor, threadId),
        readThreadUsage(actor, threadId, runId),
        runs.readBillingStatus(actor),
      ]);

      expect(run.status).toBe("completed");
      expect(run.source).toMatchObject({
        providerType: "claude-code-oauth-token",
        credentialScope: "member",
      });
      expect(
        threadPage.events
          .filter((event) => {
            return (
              event.runId === runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual(["run.completed"]);
      expect(threadUsage.runs).toStrictEqual([]);
      expect(billingAfter.credits).toBe(billing.credits);
    },
  );
});
