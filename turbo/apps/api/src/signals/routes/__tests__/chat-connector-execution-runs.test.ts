import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatEventsContract,
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
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
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { builtinConnectorsRoutes } from "../connectors";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runConnectorAccountRoutes } from "../run-connector-accounts";
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
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const MANUAL_MCP_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "manual-mcp" as const,
});
const RUNTIME_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "runtime" as const,
});
const MANUAL_MCP_ENDPOINT = "https://manual-mcp.example.test/server";

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatEventsRoutes,
    ...chatConnectorAccessRoutes,
    ...builtinConnectorsRoutes,
    ...connectorPermissionsRoutes,
    ...mcpConnectorsRoutes,
    ...meModelProvidersUpsertRoutes,
    ...onboardingCompleteRoutes,
    ...runConnectorAccountRoutes,
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
const builtinManualGrantApi = app(builtinConnectorManualGrantContract);
const permissionsApi = app(connectorPermissionsContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const onboardingCompleteApi = app(onboardingCompleteContract);
const runConnectorAccountsApi = app(runConnectorAccountsContract);
const mcpConnectorsApi = app(mcpConnectorsContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runnerSyncApi = app(runnersConnectorRuntimeSyncContract);
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
      accessApi.getThread({
        headers: {},
        params: { threadId: missingId },
        query: MANUAL_MCP_TARGET,
      }),
      [401],
    ),
    accept(
      builtinManualGrantApi.connect({
        headers: {},
        params: { connectorSlug: "manual-mcp" },
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
          target: MANUAL_MCP_TARGET,
          mode: "replace",
          grants: [],
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
    accept(runConnectorAccountsApi.list({ headers: {}, query: {} }), [401]),
    accept(mcpConnectorsApi.list({ headers: {} }), [401]),
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
      runnerSyncApi.sync({
        headers: {},
        params: { runId: missingId },
        body: { targets: [MANUAL_MCP_TARGET] },
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

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

async function connectManualBuiltinAccount(
  actor: ApiTestUser,
  connectorSlug: "manual-mcp" | "openai" | "runtime",
  displayName: string,
  apiKey: string,
): Promise<string> {
  const connected = await accept(
    builtinManualGrantApi.connect({
      headers: signIn(actor),
      params: { connectorSlug },
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

interface TrackedRun {
  readonly runId: string;
  completed: boolean;
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
  ) {
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

  function trackRun(runId: string): TrackedRun {
    const tracked: TrackedRun = { runId, completed: false };
    trackedRuns.push(tracked);
    return tracked;
  }

  return { actor, awaitBootstrap, startRun, trackRun };
}

describe("Chat connector execution runs", () => {
  it(
    "chat-connector-execution-005 (2/2) persists the switched account as the Chat's current account for the next Run",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      const [, thread, accountA] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectManualBuiltinAccount(actor, "manual-mcp", "A", "key-A"),
      ]);
      const threadId = thread.body.id;
      const accountB = await connectManualBuiltinAccount(
        actor,
        "manual-mcp",
        "B",
        "key-B",
      );

      await accept(
        accessApi.setThreadCurrent({
          headers: ownerHeaders,
          params: { threadId },
          body: { target: MANUAL_MCP_TARGET, connectionId: accountB },
        }),
        [200],
      );

      const firstRun = await startRun(threadId, "Start on account B");
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: accountB,
      });

      const agentHeaders = bearerHeaders(
        okouTokenFromExecution(firstRun.execution),
      );
      await accept(
        runConnectorAccountsApi.select({
          headers: agentHeaders,
          body: { target: MANUAL_MCP_TARGET, connectionId: accountA },
        }),
        [200],
      );

      const cliAgentType =
        firstRun.execution.cliAgentType === "pi" ||
        firstRun.execution.cliAgentType === "codex" ||
        firstRun.execution.cliAgentType === "claude-code"
          ? firstRun.execution.cliAgentType
          : "claude-code";
      await accept(
        agentCompleteApi.complete({
          headers: bearerHeaders(firstRun.execution.sandboxToken),
          body: {
            runId: firstRun.runId,
            exitCode: 0,
            completion: {
              cliAgentType,
              cliAgentSessionId:
                firstRun.execution.piSessionId ?? `bdd-cli-${firstRun.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
            },
          },
        }),
        [200],
      );
      firstRun.tracked.completed = true;

      const secondRun = await startRun(
        threadId,
        "Verify persisted account A on next Run",
      );
      expect(secondRun.execution.connectorRuntimeTargets).toContainEqual({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: accountA,
      });
    },
  );

  it(
    "chat-connector-execution-005 (1/2) switches HTTP identity, applies unknown-deny policy, updates MCP list and reconnects the switched account",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      const [, thread, accountA] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectManualBuiltinAccount(actor, "manual-mcp", "A", "key-A"),
      ]);
      const threadId = thread.body.id;
      const accountB = await connectManualBuiltinAccount(
        actor,
        "manual-mcp",
        "B",
        "key-B",
      );

      await accept(
        accessApi.setThreadCurrent({
          headers: ownerHeaders,
          params: { threadId },
          body: { target: MANUAL_MCP_TARGET, connectionId: accountB },
        }),
        [200],
      );

      const firstRun = await startRun(threadId, "Use manual MCP account B");
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: accountB,
      });

      const agentHeaders = bearerHeaders(
        okouTokenFromExecution(firstRun.execution),
      );
      const [initialInventory, initialMcp] = await Promise.all([
        accept(
          runConnectorAccountsApi.list({
            headers: agentHeaders,
            query: { includeApprovalScope: "true" },
          }),
          [200],
        ),
        accept(mcpConnectorsApi.list({ headers: agentHeaders }), [200]),
      ]);

      expect(initialInventory.body.chatThreadId).toBe(threadId);
      expect(initialInventory.body.approvalScope).toBe("chat");
      expect(initialInventory.body.accounts).toContainEqual({
        target: MANUAL_MCP_TARGET,
        connectionId: accountB,
        displayName: "B",
        enabled: true,
        isCurrent: true,
        isDefault: false,
      });
      expect(JSON.stringify(initialInventory.body)).not.toContain("key-B");
      expect(JSON.stringify(initialInventory.body)).not.toContain("key-A");
      expect(initialMcp.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: MANUAL_MCP_TARGET,
          connectionId: accountB,
          runtimeAvailable: true,
        }),
      ]);

      const [, switched] = await Promise.all([
        accept(
          permissionsApi.apply({
            headers: signIn(actor),
            body: {
              target: MANUAL_MCP_TARGET,
              mode: "replace",
              grants: [
                { permission: UNKNOWN_PERMISSION_GRANT, action: "deny" },
              ],
            },
          }),
          [200],
        ),
        accept(
          runConnectorAccountsApi.select({
            headers: agentHeaders,
            body: { target: MANUAL_MCP_TARGET, connectionId: accountA },
          }),
          [200],
        ),
      ]);
      expect(switched.body).toStrictEqual({
        target: MANUAL_MCP_TARGET,
        connectionId: accountA,
      });

      const [syncResponse, firewallAuth, updatedMcp, reauth, chatAccess] =
        await Promise.all([
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: firstRun.runId },
              body: { targets: firstRun.execution.connectorRuntimeTargets },
            }),
            [200],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(firstRun.execution.firewallToken),
              body: {
                authHeaders: {
                  Authorization: `Bearer ${secretTemplate("MCP_API_KEY")}`,
                },
                matchedFirewall: {
                  name: "manual-mcp",
                  apiId: "api-0",
                  base: MANUAL_MCP_ENDPOINT,
                  connectorSlug: "manual-mcp",
                  sourceId: accountA,
                  routingVariables: {},
                },
              },
            }),
            [200],
          ),
          accept(mcpConnectorsApi.list({ headers: agentHeaders }), [200]),
          accept(
            mcpConnectorsApi.reauthorizeOAuth({
              headers: agentHeaders,
              body: { target: MANUAL_MCP_TARGET, scopes: ["read"] },
            }),
            [200],
          ),
          accept(
            accessApi.getThread({
              headers: signIn(actor),
              params: { threadId },
              query: MANUAL_MCP_TARGET,
            }),
            [200],
          ),
        ]);

      expect(syncResponse.body.results).toContainEqual(
        expect.objectContaining({
          target: MANUAL_MCP_TARGET,
          state: "available",
          accountBinding: {
            connectionId: accountA,
            baseUrlVars: {},
          },
          networkPolicy: expect.objectContaining({
            unknownPolicy: "deny",
          }),
        }),
      );
      expect(firewallAuth.body.headers).toStrictEqual({
        Authorization: "Bearer key-A",
      });
      expect(updatedMcp.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: MANUAL_MCP_TARGET,
          connectionId: accountA,
          runtimeAvailable: true,
        }),
      ]);
      expect(reauth.body.kind).toBe("reconnect");
      if (reauth.body.kind === "reconnect") {
        expect(reauth.body.connectionId).toBe(accountA);
        expect(new URL(reauth.body.authorizationUrl).pathname).toContain(
          `/reconnect/${accountA}`,
        );
      }
      expect(chatAccess.body.currentConnectionId).toBe(accountA);
    },
  );

  it(
    "chat-connector-execution-004 resolves the Chat's selected native credentials alongside a registered MCP account",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      const [, thread, , mcpAccount] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectManualBuiltinAccount(
          actor,
          "runtime",
          "Default Native",
          "default-native-key",
        ),
        connectManualBuiltinAccount(
          actor,
          "manual-mcp",
          "Registered MCP",
          "registered-mcp-key",
        ),
      ]);
      const threadId = thread.body.id;
      const [selectedNative] = await Promise.all([
        connectManualBuiltinAccount(
          actor,
          "runtime",
          "Selected Native",
          "selected-native-key",
        ),
        accept(
          accessApi.setThreadCurrent({
            headers: ownerHeaders,
            params: { threadId },
            body: { target: MANUAL_MCP_TARGET, connectionId: mcpAccount },
          }),
          [200],
        ),
      ]);

      await accept(
        accessApi.setThreadCurrent({
          headers: ownerHeaders,
          params: { threadId },
          body: { target: RUNTIME_TARGET, connectionId: selectedNative },
        }),
        [200],
      );

      const { execution } = await startRun(
        threadId,
        "Resolve selected native credentials",
      );

      expect(execution.environment?.RUNTIME_API_KEY).toBeTruthy();
      expect(execution.environment?.RUNTIME_API_KEY).not.toBe(
        "selected-native-key",
      );
      expect(JSON.stringify(execution)).not.toContain("selected-native-key");
      expect(JSON.stringify(execution)).not.toContain("default-native-key");
      expect(execution.secretConnectorMap?.RUNTIME_API_KEY).toBe("runtime");
      expect(
        execution.secretConnectorMetadataMap?.RUNTIME_API_KEY,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: selectedNative,
      });
      expect(execution.connectorRuntimeTargets).toContainEqual({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: mcpAccount,
      });

      const resolved = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: {
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
            },
            secretConnectorMap: execution.secretConnectorMap ?? undefined,
            secretConnectorMetadataMap:
              execution.secretConnectorMetadataMap ?? undefined,
          },
        }),
        [200],
      );
      expect(resolved.body.headers).toStrictEqual({
        Authorization: "Bearer selected-native-key",
      });
    },
  );

  it(
    "chat-connector-execution-007 shows denied accounts, rejects self-grants and foreign ownership, and accepts exact owner confirmation only in that Chat",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const foreign = bdd.user();
      const ownerHeaders = signIn(actor);

      const [, thread, otherThread, accountA] = await Promise.all([
        awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        connectManualBuiltinAccount(actor, "manual-mcp", "A", "key-A"),
      ]);
      const threadId = thread.body.id;
      const otherThreadId = otherThread.body.id;
      const accountB = await connectManualBuiltinAccount(
        actor,
        "manual-mcp",
        "B",
        "key-B",
      );

      await accept(
        accessApi.setThreadOverride({
          headers: ownerHeaders,
          params: { threadId, connectionId: accountB },
          body: { target: MANUAL_MCP_TARGET, enabled: false },
        }),
        [200],
      );

      const foreignAccount = await connectManualBuiltinAccount(
        foreign,
        "manual-mcp",
        "Foreign",
        "key-foreign",
      );

      const { execution } = await startRun(
        threadId,
        "Inspect denied and foreign accounts",
      );
      expect(execution.connectorRuntimeTargets).toContainEqual({
        kind: "builtin",
        connectorSlug: "manual-mcp",
        sourceId: accountA,
      });

      const agentHeaders = bearerHeaders(okouTokenFromExecution(execution));
      const [inventory] = await Promise.all([
        accept(
          runConnectorAccountsApi.list({
            headers: agentHeaders,
            query: {},
          }),
          [200],
        ),
        accept(
          runConnectorAccountsApi.select({
            headers: agentHeaders,
            body: { target: MANUAL_MCP_TARGET, connectionId: accountB },
          }),
          [400],
        ),
        accept(
          runConnectorAccountsApi.select({
            headers: agentHeaders,
            body: { target: MANUAL_MCP_TARGET, connectionId: foreignAccount },
          }),
          [400],
        ),
        accept(
          runConnectorAccountsApi.approve({
            headers: agentHeaders,
            params: { threadId },
            body: { target: MANUAL_MCP_TARGET, connectionId: accountB },
          }),
          [403],
        ),
        accept(
          runConnectorAccountsApi.approve({
            headers: signIn(foreign),
            params: { threadId },
            body: { target: MANUAL_MCP_TARGET, connectionId: foreignAccount },
          }),
          [404],
        ),
      ]);

      expect(inventory.body.accounts).toContainEqual({
        target: MANUAL_MCP_TARGET,
        connectionId: accountB,
        displayName: "B",
        enabled: false,
        isCurrent: false,
        isDefault: false,
      });

      const approved = await accept(
        runConnectorAccountsApi.approve({
          headers: signIn(actor),
          params: { threadId },
          body: { target: MANUAL_MCP_TARGET, connectionId: accountB },
        }),
        [200],
      );
      expect(approved.body).toStrictEqual({
        target: MANUAL_MCP_TARGET,
        connectionId: accountB,
      });

      const [threadAccess, otherThreadAccess] = await Promise.all([
        accept(
          accessApi.getThread({
            headers: signIn(actor),
            params: { threadId },
            query: MANUAL_MCP_TARGET,
          }),
          [200],
        ),
        accept(
          accessApi.getThread({
            headers: signIn(actor),
            params: { threadId: otherThreadId },
            query: MANUAL_MCP_TARGET,
          }),
          [200],
        ),
      ]);

      expect(threadAccess.body.currentConnectionId).toBe(accountB);
      expect(threadAccess.body.accounts).toContainEqual({
        connectionId: accountB,
        displayName: "B",
        defaultEnabled: true,
        overrideEnabled: true,
        enabled: true,
        isDefault: false,
      });
      expect(otherThreadAccess.body.currentConnectionId).toBe(accountA);
    },
  );

  describe("thread connector selection", () => {
    async function prepareSelectedOpenAiAndRuntimeThread() {
      mockClaudeCodeTokenEndpoint();
      const envState = prepareRunEnvironment();
      const { actor, awaitBootstrap } = envState;
      const ownerHeaders = signIn(actor);

      const openAiDefaultSecret = "sk-openai-default-secret";
      const openAiSelectedSecret = "sk-openai-selected-secret";
      const runtimeInitialSecret = "runtime-initial-secret";

      const [runnerGroup, openAiDefaultId, runtimeAccountId] =
        await Promise.all([
          awaitBootstrap(),
          connectManualBuiltinAccount(
            actor,
            "openai",
            "Default OpenAI",
            openAiDefaultSecret,
          ),
          connectManualBuiltinAccount(
            actor,
            "runtime",
            "Selected Runtime",
            runtimeInitialSecret,
          ),
          accept(
            onboardingCompleteApi.complete({
              headers: ownerHeaders,
              body: {},
            }),
            [200],
          ),
          accept(
            personalModelProvidersApi.upsert({
              headers: ownerHeaders,
              body: {
                type: "claude-code-oauth-token",
                secret: "bdd-personal-claude-token",
              },
            }),
            [200, 201],
          ),
        ]);

      const [, openAiSelectedId, thread] = await Promise.all([
        accept(
          userModelPreferenceApi.update({
            headers: ownerHeaders,
            body: { selectedModel: "claude-fable-5-1", serviceTier: null },
          }),
          [200],
        ),
        connectManualBuiltinAccount(
          actor,
          "openai",
          "Selected OpenAI",
          openAiSelectedSecret,
        ),
        accept(
          threadsApi.create({
            headers: ownerHeaders,
            body: { model: "claude-fable-5-1" },
          }),
          [201],
        ),
      ]);
      const threadId = thread.body.id;

      await Promise.all([
        accept(
          threadConnectorSelectionApi.update({
            headers: ownerHeaders,
            params: { id: threadId },
            body: {
              target: { kind: "builtin", connectorSlug: "openai" },
              connectionId: openAiSelectedId,
            },
          }),
          [200],
        ),
        accept(
          threadConnectorSelectionApi.update({
            headers: ownerHeaders,
            params: { id: threadId },
            body: {
              target: { kind: "builtin", connectorSlug: "runtime" },
              connectionId: runtimeAccountId,
            },
          }),
          [200],
        ),
      ]);

      return {
        ...envState,
        runnerGroup,
        ownerHeaders,
        threadId,
        openAiDefaultId,
        openAiSelectedId,
        runtimeAccountId,
        openAiDefaultSecret,
        openAiSelectedSecret,
        runtimeInitialSecret,
      };
    }

    it(
      "chat-events-connector-selection-001 (1/2) binds selected OpenAI and Runtime accounts on the active Run and omits raw secrets",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const {
          ownerHeaders,
          threadId,
          openAiDefaultId,
          openAiSelectedId,
          runtimeAccountId,
          openAiDefaultSecret,
          openAiSelectedSecret,
          runtimeInitialSecret,
          startRun,
        } = await prepareSelectedOpenAiAndRuntimeThread();

        const initialSelections = await accept(
          threadConnectorSelectionApi.get({
            headers: ownerHeaders,
            params: { id: threadId },
          }),
          [200],
        );
        expect(initialSelections.body.selections).toStrictEqual(
          expect.arrayContaining([
            {
              target: { kind: "builtin", connectorSlug: "openai" },
              connectionId: openAiSelectedId,
            },
            {
              target: { kind: "builtin", connectorSlug: "runtime" },
              connectionId: runtimeAccountId,
            },
          ]),
        );

        const firstRun = await startRun(
          threadId,
          "First run with selected OpenAI and Runtime accounts",
          "claude-fable-5-1",
        );

        const firstEnv = firstRun.execution.environment ?? {};
        expect(firstEnv.OPENAI_TOKEN).toBeTruthy();
        expect(firstEnv.RUNTIME_API_KEY).toBeTruthy();
        expect(firstRun.execution.secretConnectorMetadataMap).toMatchObject({
          OPENAI_TOKEN: {
            sourceType: "connector",
            sourceId: openAiSelectedId,
          },
          RUNTIME_API_KEY: {
            sourceType: "connector",
            sourceId: runtimeAccountId,
          },
        });
        const firstSerialized = JSON.stringify(firstRun.execution);
        expect(firstSerialized).not.toContain(openAiDefaultSecret);
        expect(firstSerialized).not.toContain(openAiSelectedSecret);
        expect(firstSerialized).not.toContain(runtimeInitialSecret);

        const [firstResolved, disabledOpenAi] = await Promise.all([
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(firstRun.execution.firewallToken),
              body: {
                authHeaders: {
                  "x-openai": `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
                  "x-runtime": `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
                },
                secretConnectorMap:
                  firstRun.execution.secretConnectorMap ?? undefined,
                secretConnectorMetadataMap:
                  firstRun.execution.secretConnectorMetadataMap ?? undefined,
              },
            }),
            [200],
          ),
          accept(
            accessApi.setThreadOverride({
              headers: ownerHeaders,
              params: { threadId, connectionId: openAiSelectedId },
              body: {
                target: { kind: "builtin", connectorSlug: "openai" },
                enabled: false,
              },
            }),
            [200],
          ),
        ]);
        expect(firstResolved.body.headers).toStrictEqual({
          "x-openai": `Bearer ${openAiSelectedSecret}`,
          "x-runtime": `Bearer ${runtimeInitialSecret}`,
        });
        expect(disabledOpenAi.body.currentConnectionId).toBe(openAiDefaultId);

        const [updatedSelections, activeRunAfterDisable] = await Promise.all([
          accept(
            threadConnectorSelectionApi.get({
              headers: ownerHeaders,
              params: { id: threadId },
            }),
            [200],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(firstRun.execution.firewallToken),
              body: {
                authHeaders: {
                  "x-openai": `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
                  "x-runtime": `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
                },
                secretConnectorMap:
                  firstRun.execution.secretConnectorMap ?? undefined,
                secretConnectorMetadataMap:
                  firstRun.execution.secretConnectorMetadataMap ?? undefined,
              },
            }),
            [200],
          ),
        ]);
        expect(updatedSelections.body.selections).not.toContainEqual({
          target: { kind: "builtin", connectorSlug: "openai" },
          connectionId: openAiSelectedId,
        });
        expect(updatedSelections.body.selections).toStrictEqual(
          expect.arrayContaining([
            {
              target: { kind: "builtin", connectorSlug: "runtime" },
              connectionId: runtimeAccountId,
            },
          ]),
        );
        expect(activeRunAfterDisable.body.headers).toStrictEqual({
          "x-openai": `Bearer ${openAiSelectedSecret}`,
          "x-runtime": `Bearer ${runtimeInitialSecret}`,
        });
      },
    );

    it(
      "chat-events-connector-selection-001 (2/2) promotes queued input onto the fallback OpenAI and reconnected Runtime accounts",
      { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
      async () => {
        const {
          runnerGroup,
          ownerHeaders,
          threadId,
          openAiDefaultId,
          openAiSelectedId,
          runtimeAccountId,
          openAiDefaultSecret,
          openAiSelectedSecret,
          runtimeInitialSecret,
          startRun,
          trackRun,
        } = await prepareSelectedOpenAiAndRuntimeThread();

        const runtimeReconnectedSecret = "runtime-reconnected-secret";
        const firstRun = await startRun(
          threadId,
          "First run occupying the thread slot",
          "claude-fable-5-1",
        );

        const queuedPrompt =
          "Queued run using fallback OpenAI and reconnected Runtime";
        const [, disabledOpenAi] = await Promise.all([
          accept(
            chatEventsApi.send({
              headers: ownerHeaders,
              body: {
                threadId,
                prompt: queuedPrompt,
                model: "claude-fable-5-1",
                clientEventId: randomUUID(),
                userMessage: {
                  version: 1,
                  parts: [{ type: "text", text: queuedPrompt }],
                },
                hasTextContent: true,
              },
            }),
            [201],
          ),
          accept(
            accessApi.setThreadOverride({
              headers: ownerHeaders,
              params: { threadId, connectionId: openAiSelectedId },
              body: {
                target: { kind: "builtin", connectorSlug: "openai" },
                enabled: false,
              },
            }),
            [200],
          ),
          accept(
            builtinManualGrantApi.connect({
              headers: ownerHeaders,
              params: { connectorSlug: "runtime" },
              body: {
                authMethod: "api-token",
                values: { apiKey: runtimeReconnectedSecret },
                account: {
                  intent: "reconnect",
                  connectionId: runtimeAccountId,
                },
              },
            }),
            [200],
          ),
        ]);
        expect(disabledOpenAi.body.currentConnectionId).toBe(openAiDefaultId);

        const [updatedSelections] = await Promise.all([
          accept(
            threadConnectorSelectionApi.get({
              headers: ownerHeaders,
              params: { id: threadId },
            }),
            [200],
          ),
          accept(
            runsCancelApi.cancel({
              headers: ownerHeaders,
              params: { id: firstRun.runId },
            }),
            [200],
          ),
        ]);
        expect(updatedSelections.body.selections).not.toContainEqual({
          target: { kind: "builtin", connectorSlug: "openai" },
          connectionId: openAiSelectedId,
        });
        expect(updatedSelections.body.selections).toStrictEqual(
          expect.arrayContaining([
            {
              target: { kind: "builtin", connectorSlug: "runtime" },
              connectionId: runtimeAccountId,
            },
          ]),
        );

        await accept(
          agentCompleteApi.complete({
            headers: bearerHeaders(firstRun.execution.sandboxToken),
            body: {
              runId: firstRun.runId,
              exitCode: 1,
              error: "Run cancelled",
            },
          }),
          [200],
        );
        firstRun.tracked.completed = true;
        await flushWaitUntilForTest();

        const secondExecution = await runs.nextReceivedExecution(runnerGroup);
        trackRun(secondExecution.runId);
        expect(secondExecution.runId).not.toBe(firstRun.runId);
        expect(secondExecution.prompt).toBe(queuedPrompt);

        const secondEnv = secondExecution.environment ?? {};
        expect(secondEnv.OPENAI_TOKEN).toBeTruthy();
        expect(secondEnv.RUNTIME_API_KEY).toBeTruthy();
        expect(secondExecution.secretConnectorMetadataMap).toMatchObject({
          OPENAI_TOKEN: {
            sourceType: "connector",
            sourceId: openAiDefaultId,
          },
          RUNTIME_API_KEY: {
            sourceType: "connector",
            sourceId: runtimeAccountId,
          },
        });
        const secondSerialized = JSON.stringify(secondExecution);
        expect(secondSerialized).not.toContain(openAiDefaultSecret);
        expect(secondSerialized).not.toContain(openAiSelectedSecret);
        expect(secondSerialized).not.toContain(runtimeInitialSecret);
        expect(secondSerialized).not.toContain(runtimeReconnectedSecret);

        const secondResolved = await accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(secondExecution.firewallToken),
            body: {
              authHeaders: {
                "x-openai": `Bearer ${secretTemplate("OPENAI_TOKEN")}`,
                "x-runtime": `Bearer ${secretTemplate("RUNTIME_API_KEY")}`,
              },
              secretConnectorMap:
                secondExecution.secretConnectorMap ?? undefined,
              secretConnectorMetadataMap:
                secondExecution.secretConnectorMetadataMap ?? undefined,
            },
          }),
          [200],
        );
        expect(secondResolved.body.headers).toStrictEqual({
          "x-openai": `Bearer ${openAiDefaultSecret}`,
          "x-runtime": `Bearer ${runtimeReconnectedSecret}`,
        });
      },
    );
  });
});
