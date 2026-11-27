import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatEventsContract,
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import {
  customConnectorByIdContract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { builtinConnectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import type { RunnerExecutionInput } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const OPENAI_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "openai" as const,
});
const FIGMA_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "figma" as const,
});

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatEventsRoutes,
    ...chatConnectorAccessRoutes,
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
    ...connectorPermissionsRoutes,
    ...customConnectorsRoutes,
    ...meModelProvidersUpsertRoutes,
    ...onboardingCompleteRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...userModelPreferenceRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
  ],
});

const threadsApi = app(chatThreadsContract);
const threadConnectorSelectionApi = app(chatThreadConnectorSelectionContract);
const chatEventsApi = app(chatEventsContract);
const accessApi = app(chatConnectorAccessContract);
const connectorAccountsApi = app(connectorAccountsContract);
const builtinManualGrantApi = app(builtinConnectorManualGrantContract);
const permissionsApi = app(connectorPermissionsContract);
const customConnectorsApi = app(customConnectorsContract);
const customConnectorByIdApi = app(customConnectorByIdContract);
const customConnectorValuesApi = app(customConnectorValuesContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const onboardingCompleteApi = app(onboardingCompleteContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runsByIdApi = app(runsByIdContract);
const runsCancelApi = app(runsCancelContract);
const userModelPreferenceApi = app(userModelPreferenceContract);
const agentCompleteApi = app(webhookCompleteContract);
const firewallAuthApi = app(runWebhookContract);
const clerkWebhookApi = app(webhookClerkContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  const missingId = randomUUID();
  await Promise.all([
    accept(threadsApi.create({ headers: {}, body: { model: null } }), [401]),
    accept(
      threadConnectorSelectionApi.get({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(
      threadConnectorSelectionApi.update({
        headers: {},
        params: { id: missingId },
        body: { target: OPENAI_TARGET, connectionId: missingId },
      }),
      [401],
    ),
    accept(
      chatEventsApi.send({
        headers: {},
        body: {
          prompt: "warmup",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "warmup" }],
          },
        },
      }),
      [401],
    ),
    accept(
      accessApi.updateAccountDefault({
        headers: {},
        params: { connectionId: missingId },
        body: { target: OPENAI_TARGET, enabled: false },
      }),
      [401],
    ),
    accept(
      connectorAccountsApi.inspect({
        headers: {},
        body: {
          selections: [{ target: OPENAI_TARGET, connectionId: missingId }],
        },
      }),
      [401],
    ),
    accept(
      builtinManualGrantApi.connect({
        headers: {},
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          values: { apiKey: "warmup" },
          account: { intent: "add", displayName: "Warmup" },
        },
      }),
      [401],
    ),
    accept(
      permissionsApi.apply({
        headers: {},
        body: {
          target: FIGMA_TARGET,
          mode: "replace",
          grants: [],
        },
      }),
      [401],
    ),
    accept(
      customConnectorsApi.create({
        headers: {},
        body: {
          displayName: "Warmup HTTP",
          prefixTemplates: ["https://warmup.example.test/api"],
          fields: [
            {
              key: "secret",
              label: "Secret",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.secret}}",
            },
          ],
          queryInjections: [],
        },
      }),
      [401],
    ),
    accept(
      customConnectorByIdApi.update({
        headers: {},
        params: { id: missingId },
        body: {
          displayName: "Warmup HTTP",
          prefixTemplates: ["https://warmup.example.test/api"],
          fields: [
            {
              key: "secret",
              label: "Secret",
              kind: "secret",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.secret}}",
            },
          ],
          queryInjections: [],
        },
      }),
      [401],
    ),
    accept(
      customConnectorValuesApi.set({
        headers: {},
        params: { id: missingId },
        body: {
          values: [{ key: "secret", kind: "secret", value: "warmup" }],
          account: { intent: "add", displayName: "Warmup" },
        },
      }),
      [401],
    ),
    accept(
      personalModelProvidersApi.upsert({
        headers: {},
        body: {
          type: "claude-code-oauth-token",
          secret: "warmup-token",
        },
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
      runnerHeartbeatApi.heartbeat({
        headers: {},
        body: {
          runnerId: missingId,
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
      runsByIdApi.getById({ headers: {}, params: { id: missingId } }),
      [401],
    ),
    accept(
      runsCancelApi.cancel({ headers: {}, params: { id: missingId } }),
      [401],
    ),
    accept(
      userModelPreferenceApi.update({
        headers: {},
        body: { selectedModel: "claude-fable-5-1", serviceTier: null },
      }),
      [401],
    ),
    accept(
      agentCompleteApi.complete({
        headers: {},
        body: { runId: missingId, exitCode: 1, error: "warmup" },
      }),
      [401],
    ),
    accept(
      firewallAuthApi.firewallAuth({
        headers: {},
        body: { authHeaders: {} },
      }),
      [401],
    ),
    accept(
      clerkWebhookApi.post({
        body: "{}",
        extraHeaders: {},
      }),
      [401],
    ),
  ]);
});

function signIn(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return SESSION_HEADERS;
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function connectOpenAiAccount(
  actor: ApiTestUser,
  displayName: string,
  apiKey: string,
): Promise<string> {
  const connected = await accept(
    builtinManualGrantApi.connect({
      headers: signIn(actor),
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey },
        account: { intent: "add", displayName },
      },
    }),
    [200],
  );
  return connected.body.connectionId;
}

async function connectFigmaAccount(
  actor: ApiTestUser,
  displayName: string,
  accessToken: string,
): Promise<string> {
  const connected = await accept(
    builtinManualGrantApi.connect({
      headers: signIn(actor),
      params: { connectorSlug: "figma" },
      body: {
        authMethod: "api-token",
        values: { accessToken },
        account: { intent: "add", displayName },
      },
    }),
    [200],
  );
  return connected.body.connectionId;
}

interface TrackedRun {
  readonly runId: string;
  completed: boolean;
}

interface StartedRun {
  readonly runId: string;
  readonly execution: RunnerExecutionInput;
  readonly tracked: TrackedRun;
}

function prepareRunEnvironment() {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor with an organization");
  }
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);

  const trackedRuns: TrackedRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
  });

  const runnerGroupPromise = runs.configureRunnerGroup();
  const orgCreatedPromise = accept(
    clerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
    [200],
  );
  let resolvedRunnerGroup: string | undefined;

  onTestFinished(async () => {
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    if (resolvedRunnerGroup !== undefined) {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", resolvedRunnerGroup);
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const result = await settleIncludingAbort(async () => {
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.completed;
      });
      if (activeRuns.length > 0) {
        const ownerHeaders = signIn(actor);
        await Promise.all(
          activeRuns.map(async (tracked) => {
            const current = await accept(
              runsByIdApi.getById({
                headers: ownerHeaders,
                params: { id: tracked.runId },
              }),
              [200],
            );
            if (
              ["queued", "pending", "running"].includes(current.body.status)
            ) {
              await accept(
                runsCancelApi.cancel({
                  headers: ownerHeaders,
                  params: { id: tracked.runId },
                }),
                [200],
              );
            }
          }),
        );
      }
      await flushWaitUntilForTest();
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
    if (!result.ok) {
      throw result.error;
    }
  });

  async function awaitBootstrap() {
    const [runnerGroup] = await Promise.all([
      runnerGroupPromise,
      orgCreatedPromise,
    ]);
    resolvedRunnerGroup = runnerGroup;
    return runnerGroup;
  }

  async function startRun(
    threadId: string,
    prompt: string,
    model: string | null = null,
  ): Promise<StartedRun> {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          threadId,
          prompt,
          model,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
        },
      }),
      [201],
    );
    const execution = await runs.nextReceivedExecution(runnerGroup);
    const tracked: TrackedRun = {
      runId: execution.runId,
      completed: false,
    };
    trackedRuns.push(tracked);
    return { runId: execution.runId, execution, tracked };
  }

  async function completeRunOk(started: StartedRun): Promise<void> {
    const cliAgentType =
      started.execution.cliAgentType === "pi" ||
      started.execution.cliAgentType === "codex" ||
      started.execution.cliAgentType === "claude-code"
        ? started.execution.cliAgentType
        : "claude-code";
    await accept(
      agentCompleteApi.complete({
        headers: bearerHeaders(started.execution.sandboxToken),
        body: {
          runId: started.runId,
          exitCode: 0,
          completion: {
            cliAgentType,
            cliAgentSessionId:
              started.execution.piSessionId ?? `bdd-cli-${started.runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    started.tracked.completed = true;
  }

  return { actor, awaitBootstrap, startRun, completeRunOk };
}

function findInlineFirewall(
  execution: RunnerExecutionInput,
  customConnectorId: string,
) {
  const entry = execution.firewalls?.find((firewall) => {
    return (
      firewall.kind === "inline" &&
      firewall.customConnectorId === customConnectorId
    );
  });
  if (!entry || entry.kind !== "inline") {
    throw new Error(
      `Expected inline firewall for custom connector ${customConnectorId}`,
    );
  }
  return entry;
}

describe("Chat events connectors", () => {
  it(
    "chat-events-connectors-007 uses the default OpenAI account without persisting selection or invalidation and omits it when revoked",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, completeRunOk } =
        prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const openAiSecret = "sk-openai-default-revoke-secret";

      const [, thread, defaultOpenAiId] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectOpenAiAccount(actor, "Default OpenAI", openAiSecret),
      ]);
      const threadId = thread.body.id;

      const firstRun = await startRun(
        threadId,
        "Run with default OpenAI account",
      );
      expect(firstRun.execution.environment?.OPENAI_TOKEN).toBeTruthy();
      expect(firstRun.execution.secretConnectorMap?.OPENAI_TOKEN).toBe(
        "openai",
      );
      expect(
        firstRun.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: defaultOpenAiId,
      });
      expect(JSON.stringify(firstRun.execution)).not.toContain(openAiSecret);

      await completeRunOk(firstRun);
      await flushWaitUntilForTest();

      const selectionsAfterFirst = await accept(
        threadConnectorSelectionApi.get({
          headers: ownerHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(selectionsAfterFirst.body.selections).toStrictEqual([]);
      expect(selectionsAfterFirst.body.selectedConnections).toStrictEqual([]);
      expect(
        context.mocks.ably.publish.mock.calls.filter((call) => {
          return call[0] === `chatThreadDetailChanged:${threadId}`;
        }),
      ).toStrictEqual([]);

      await accept(
        accessApi.updateAccountDefault({
          headers: ownerHeaders,
          params: { connectionId: defaultOpenAiId },
          body: { target: OPENAI_TARGET, enabled: false },
        }),
        [200],
      );

      const secondRun = await startRun(
        threadId,
        "Continue thread after revoking default OpenAI allowance",
      );
      expect(secondRun.execution.environment?.OPENAI_TOKEN).toBeUndefined();
      expect(
        secondRun.execution.secretConnectorMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      expect(
        secondRun.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      expect(JSON.stringify(secondRun.execution)).not.toContain(openAiSecret);
    },
  );

  it(
    "chat-events-connectors-005 omits a disabled selected OpenAI account and restores it after reenabling",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, completeRunOk } =
        prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const openAiSecret = "sk-openai-toggle-secret";

      const [, thread, openAiId] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectOpenAiAccount(actor, "Selected OpenAI", openAiSecret),
      ]);
      const threadId = thread.body.id;

      await accept(
        threadConnectorSelectionApi.update({
          headers: ownerHeaders,
          params: { id: threadId },
          body: { target: OPENAI_TARGET, connectionId: openAiId },
        }),
        [200],
      );

      await accept(
        accessApi.updateAccountDefault({
          headers: ownerHeaders,
          params: { connectionId: openAiId },
          body: { target: OPENAI_TARGET, enabled: false },
        }),
        [200],
      );

      const disabledRun = await startRun(
        threadId,
        "Run while selected OpenAI account is disabled",
      );
      expect(disabledRun.execution.environment?.OPENAI_TOKEN).toBeUndefined();
      expect(
        disabledRun.execution.secretConnectorMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      expect(
        disabledRun.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toBeUndefined();
      expect(JSON.stringify(disabledRun.execution)).not.toContain(openAiSecret);

      await Promise.all([
        completeRunOk(disabledRun),
        accept(
          accessApi.updateAccountDefault({
            headers: ownerHeaders,
            params: { connectionId: openAiId },
            body: { target: OPENAI_TARGET, enabled: true },
          }),
          [200],
        ),
      ]);

      const reenabledRun = await startRun(
        threadId,
        "Run after reenabling selected OpenAI account",
      );
      expect(reenabledRun.execution.environment?.OPENAI_TOKEN).toBeTruthy();
      expect(reenabledRun.execution.secretConnectorMap?.OPENAI_TOKEN).toBe(
        "openai",
      );
      expect(
        reenabledRun.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: openAiId,
      });
      expect(JSON.stringify(reenabledRun.execution)).not.toContain(
        openAiSecret,
      );
    },
  );

  it(
    "chat-events-connectors-002 dispatches placeholders without KMS decrypt before use and resolves OpenAI and Figma headers on demand",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kmsProbe = useSecretKmsProbe();
      mockClaudeCodeTokenEndpoint();
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const openAiSecret = "sk-openai-placeholder-secret";
      const figmaSecret = "figd-placeholder-secret";

      const [, openAiId, figmaId] = await Promise.all([
        awaitBootstrap(),
        connectOpenAiAccount(actor, "OpenAI Primary", openAiSecret),
        connectFigmaAccount(actor, "Figma Primary", figmaSecret),
        accept(
          onboardingCompleteApi.complete({ headers: ownerHeaders, body: {} }),
          [200],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: ownerHeaders,
            body: {
              type: "claude-code-oauth-token",
              secret: "bdd-fable-oauth-token",
            },
          }),
          [200, 201],
        ),
      ]);

      const [, thread] = await Promise.all([
        accept(
          userModelPreferenceApi.update({
            headers: ownerHeaders,
            body: { selectedModel: "claude-fable-5-1", serviceTier: null },
          }),
          [200],
        ),
        accept(
          threadsApi.create({
            headers: ownerHeaders,
            body: { model: "claude-fable-5-1" },
          }),
          [201],
        ),
      ]);

      const { execution } = await startRun(
        thread.body.id,
        "Resolve OpenAI and Figma credentials on demand",
        "claude-fable-5-1",
      );

      expect(kmsProbe.decryptCalls).toBe(0);
      expect(execution.environment?.OPENAI_TOKEN).toBeTruthy();
      expect(execution.environment?.OPENAI_TOKEN).not.toBe(openAiSecret);
      expect(execution.environment?.FIGMA_TOKEN).toBe("fixture-figma-token");
      expect(execution.secretConnectorMap).toMatchObject({
        OPENAI_TOKEN: "openai",
        FIGMA_TOKEN: "figma",
      });
      expect(execution.secretConnectorMetadataMap).toMatchObject({
        OPENAI_TOKEN: {
          sourceType: "connector",
          sourceId: openAiId,
        },
        FIGMA_TOKEN: {
          sourceType: "connector",
          sourceId: figmaId,
        },
      });
      const serializedExecution = JSON.stringify(execution);
      expect(serializedExecution).not.toContain(openAiSecret);
      expect(serializedExecution).not.toContain(figmaSecret);

      const [openAiResolved, figmaResolved] = await Promise.all([
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(execution.firewallToken),
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
              },
              secretConnectorMap: execution.secretConnectorMap ?? undefined,
              secretConnectorMetadataMap:
                execution.secretConnectorMetadataMap ?? undefined,
            },
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(execution.firewallToken),
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("FIGMA_TOKEN")}`,
              },
              secretConnectorMap: execution.secretConnectorMap ?? undefined,
              secretConnectorMetadataMap:
                execution.secretConnectorMetadataMap ?? undefined,
            },
          }),
          [200],
        ),
      ]);

      expect(openAiResolved.body.headers).toStrictEqual({
        Authorization: `Bearer ${openAiSecret}`,
      });
      expect(figmaResolved.body.headers).toStrictEqual({
        Authorization: `Bearer ${figmaSecret}`,
      });
      expect(kmsProbe.decryptCalls).toBeGreaterThan(0);
    },
  );

  it(
    "chat-events-connectors-004 reads and inspects the explicitly selected OpenAI account and dispatches it as the credential source",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const defaultSecret = "sk-openai-default-unselected";
      const selectedSecret = "sk-openai-explicit-selected";

      const [, thread] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectOpenAiAccount(actor, "Default OpenAI", defaultSecret),
      ]);
      const threadId = thread.body.id;

      const selectedOpenAiId = await connectOpenAiAccount(
        actor,
        "Selected OpenAI",
        selectedSecret,
      );

      await accept(
        threadConnectorSelectionApi.update({
          headers: ownerHeaders,
          params: { id: threadId },
          body: { target: OPENAI_TARGET, connectionId: selectedOpenAiId },
        }),
        [200],
      );

      const selectionsRead = await accept(
        threadConnectorSelectionApi.get({
          headers: ownerHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(selectionsRead.body.selections).toStrictEqual([
        { target: OPENAI_TARGET, connectionId: selectedOpenAiId },
      ]);

      const [inspected, started] = await Promise.all([
        accept(
          connectorAccountsApi.inspect({
            headers: ownerHeaders,
            body: { selections: selectionsRead.body.selections },
          }),
          [200],
        ),
        startRun(threadId, "Run with explicitly selected OpenAI account"),
      ]);

      expect(inspected.body.results).toStrictEqual([
        expect.objectContaining({
          kind: "available",
          connectionId: selectedOpenAiId,
          target: OPENAI_TARGET,
          displayName: "Selected OpenAI",
        }),
      ]);
      expect(started.execution.environment?.OPENAI_TOKEN).toBeTruthy();
      expect(started.execution.secretConnectorMap?.OPENAI_TOKEN).toBe("openai");
      expect(
        started.execution.secretConnectorMetadataMap?.OPENAI_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: selectedOpenAiId,
      });
      const serialized = JSON.stringify(started.execution);
      expect(serialized).not.toContain(defaultSecret);
      expect(serialized).not.toContain(selectedSecret);
    },
  );

  it(
    "chat-events-connectors-009 dispatches default custom HTTP and MCP accounts with denied unknown HTTP permissions and no stored overrides",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const httpSecret = "custom-http-default-secret";
      const mcpSecret = "custom-mcp-default-secret";

      const [, thread, httpCreated, mcpCreated] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: ownerHeaders,
            body: {
              displayName: "Custom HTTP API",
              prefixTemplates: ["https://custom-http.example.test/api"],
              fields: [
                {
                  key: "secret",
                  label: "Secret",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.secret}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: ownerHeaders,
            body: {
              kind: "mcp",
              displayName: "Custom MCP Server",
              endpoint: "https://custom-mcp.example.test/mcp",
              transport: "streamable-http",
              authMode: "manual",
              fields: [
                {
                  key: "secret",
                  label: "Secret",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.secret}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
      ]);

      const threadId = thread.body.id;
      const httpConnectorId = httpCreated.body.id;
      const mcpConnectorId = mcpCreated.body.id;

      const [httpAccount, mcpAccount] = await Promise.all([
        accept(
          customConnectorValuesApi.set({
            headers: ownerHeaders,
            params: { id: httpConnectorId },
            body: {
              values: [{ key: "secret", kind: "secret", value: httpSecret }],
              account: { intent: "add", displayName: "Default HTTP" },
            },
          }),
          [200],
        ),
        accept(
          customConnectorValuesApi.set({
            headers: ownerHeaders,
            params: { id: mcpConnectorId },
            body: {
              values: [{ key: "secret", kind: "secret", value: mcpSecret }],
              account: { intent: "add", displayName: "Default MCP" },
            },
          }),
          [200],
        ),
      ]);

      const httpConnectionId = httpAccount.body.connectionId;
      const mcpConnectionId = mcpAccount.body.connectionId;

      await accept(
        permissionsApi.apply({
          headers: ownerHeaders,
          body: {
            target: { kind: "custom", customConnectorId: httpConnectorId },
            mode: "replace",
            grants: [{ permission: UNKNOWN_PERMISSION_GRANT, action: "deny" }],
          },
        }),
        [200],
      );

      const { execution } = await startRun(
        threadId,
        "Run with default custom HTTP and MCP accounts",
      );

      const expectedTargets = [
        {
          kind: "custom" as const,
          customConnectorId: httpConnectorId,
          baseUrlVars: {},
          sourceId: httpConnectionId,
        },
        {
          kind: "custom" as const,
          customConnectorId: mcpConnectorId,
          baseUrlVars: {},
          sourceId: mcpConnectionId,
        },
      ].sort((left, right) => {
        return left.customConnectorId.localeCompare(right.customConnectorId);
      });
      expect(execution.connectorRuntimeTargets).toStrictEqual(expectedTargets);

      const httpInline = findInlineFirewall(execution, httpConnectorId);
      const mcpInline = findInlineFirewall(execution, mcpConnectorId);
      expect(httpInline.sourceId).toBe(httpConnectionId);
      expect(mcpInline.sourceId).toBe(mcpConnectionId);
      expect(
        execution.networkPolicies?.[httpInline.firewall.name]?.unknownPolicy,
      ).toBe("deny");

      const serialized = JSON.stringify(execution);
      expect(serialized).not.toContain(httpSecret);
      expect(serialized).not.toContain(mcpSecret);

      const httpApi = httpInline.firewall.apis[0];
      const mcpApi = mcpInline.firewall.apis[0];
      if (!httpApi || !mcpApi) {
        throw new Error("Expected custom HTTP and MCP inline firewall APIs");
      }

      const [httpResolved, mcpResolved, selectionsRead] = await Promise.all([
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(execution.firewallToken),
            body: {
              authHeaders: httpApi.auth.headers ?? {},
              matchedFirewall: {
                name: httpInline.firewall.name,
                apiId: httpApi.id,
                base: httpApi.base,
                customConnectorId: httpConnectorId,
                sourceId: httpInline.sourceId,
                routingVariables: {},
              },
            },
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(execution.firewallToken),
            body: {
              authHeaders: mcpApi.auth.headers ?? {},
              matchedFirewall: {
                name: mcpInline.firewall.name,
                apiId: mcpApi.id,
                base: mcpApi.base,
                customConnectorId: mcpConnectorId,
                sourceId: mcpInline.sourceId,
                routingVariables: {},
              },
            },
          }),
          [200],
        ),
        accept(
          threadConnectorSelectionApi.get({
            headers: ownerHeaders,
            params: { id: threadId },
          }),
          [200],
        ),
      ]);

      expect(httpResolved.body.headers).toStrictEqual({
        Authorization: `Bearer ${httpSecret}`,
      });
      expect(mcpResolved.body.headers).toStrictEqual({
        Authorization: `Bearer ${mcpSecret}`,
      });
      expect(selectionsRead.body.selections).toStrictEqual([]);
      expect(selectionsRead.body.selectedConnections).toStrictEqual([]);
    },
  );

  it(
    "chat-events-connectors-011 starts the Run omitting an unavailable selected custom connector while retaining the stored thread selection",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      const [, thread, created] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: ownerHeaders,
            body: {
              displayName: "Selected Custom HTTP",
              prefixTemplates: ["https://selected-custom.example.test/api"],
              fields: [
                {
                  key: "secret",
                  label: "Secret",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.secret}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
      ]);

      const threadId = thread.body.id;
      const customConnectorId = created.body.id;
      const customTarget = { kind: "custom" as const, customConnectorId };

      const connected = await accept(
        customConnectorValuesApi.set({
          headers: ownerHeaders,
          params: { id: customConnectorId },
          body: {
            values: [
              {
                key: "secret",
                kind: "secret",
                value: "initial-custom-secret",
              },
            ],
            account: { intent: "add", displayName: "Initial Custom Account" },
          },
        }),
        [200],
      );
      const connectionId = connected.body.connectionId;

      await accept(
        threadConnectorSelectionApi.update({
          headers: ownerHeaders,
          params: { id: threadId },
          body: { target: customTarget, connectionId },
        }),
        [200],
      );

      const initialSelection = await accept(
        threadConnectorSelectionApi.get({
          headers: ownerHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(initialSelection.body.selectedConnections).toContainEqual(
        expect.objectContaining({
          id: connectionId,
          target: customTarget,
          connectionStatus: "connected",
        }),
      );

      await accept(
        customConnectorByIdApi.update({
          headers: ownerHeaders,
          params: { id: customConnectorId },
          body: {
            displayName: "Selected Custom HTTP",
            prefixTemplates: ["https://selected-custom.example.test/api"],
            fields: [
              {
                key: "replacement_secret",
                label: "Replacement Secret",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.replacement_secret}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [200],
      );

      const { execution } = await startRun(
        threadId,
        "Continue chat after selected custom connector loses required credential",
      );

      expect(execution.connectorRuntimeTargets).toStrictEqual([]);
      expect(
        (execution.firewalls ?? []).filter((firewall) => {
          return (
            firewall.kind === "inline" &&
            firewall.customConnectorId === customConnectorId
          );
        }),
      ).toStrictEqual([]);

      const retainedSelection = await accept(
        threadConnectorSelectionApi.get({
          headers: ownerHeaders,
          params: { id: threadId },
        }),
        [200],
      );
      expect(retainedSelection.body.selections).toStrictEqual([
        { target: customTarget, connectionId },
      ]);
      expect(retainedSelection.body.selectedConnections).toContainEqual(
        expect.objectContaining({
          id: connectionId,
          target: customTarget,
          connectionStatus: "reconnect-required",
          missingRequiredFields: ["replacement_secret"],
        }),
      );
    },
  );
});
