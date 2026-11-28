import { randomUUID } from "node:crypto";

import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import type { ExecutionFirewallEntry } from "@okouai/connectors/firewall-types";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  createConnectorBddApi,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const runsApi = createRunsApi(context);
const webhooksApi = createWebhookCallbackApi(context);

type RunnerExecutionInput = Awaited<
  ReturnType<typeof runsApi.nextReceivedExecution>
>;

const RUN_SESSION_HEADERS = { authorization: "Bearer run-session" } as const;

const mcpApi = setupApp({ context, routes: mcpConnectorsRoutes })(
  mcpConnectorsContract,
);
const chatEventsApi = setupApp({ context, routes: chatEventsRoutes })(
  chatEventsContract,
);
const chatThreadsApi = setupApp({ context, routes: chatThreadRoutes })(
  chatThreadsContract,
);
const chatConnectorAccessApi = setupApp({
  context,
  routes: chatConnectorAccessRoutes,
})(chatConnectorAccessContract);
const connectorAccountsApi = setupApp({
  context,
  routes: connectorAccountRoutes,
})(connectorAccountsContract);
const customOAuth2Api = setupApp({
  context,
  routes: customConnectorOAuth2Routes,
})(customConnectorOAuth2Contract);
const runByIdApi = setupApp({ context, routes: runsRoutes })(runsByIdContract);
const runCancelApi = setupApp({ context, routes: runsCancelRoutes })(
  runsCancelContract,
);
const runAgentCompleteApi = setupApp({
  context,
  routes: webhooksAgentCompleteRoutes,
})(webhookCompleteContract);
const runFirewallAuthApi = setupApp({
  context,
  routes: webhooksAgentFirewallAuthRoutes,
})(runWebhookContract);
const runClerkWebhookApi = setupApp({
  context,
  routes: webhooksClerkRoutes,
})(webhookClerkContract);

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signInRunActor(actor: ApiTestUser) {
  const mocks = createRouteMocks(context);
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const memberships = actor.orgId
    ? [
        {
          id: `membership-${actor.userId}-${actor.orgId}`,
          createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
          role: actor.orgRole ?? "org:admin",
          organization: { id: actor.orgId },
          publicUserData: { userId: actor.userId },
        },
      ]
    : [];
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: memberships },
  );
  return RUN_SESSION_HEADERS;
}

function acceptRunAblyBatchPublish(): void {
  server.use(
    http.post("https://rest.ably.io/messages", () => {
      return HttpResponse.json([{ channel: "ok", messageId: randomUUID() }], {
        status: 201,
      });
    }),
  );
}

function oauthStateFromUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error(`Expected state parameter in ${authorizationUrl}`);
  }
  return state;
}

function firstInlineCustomFirewallApi(
  firewalls: readonly ExecutionFirewallEntry[] | undefined,
  customConnectorId: string,
) {
  for (const entry of firewalls ?? []) {
    if (
      entry.kind === "inline" &&
      entry.customConnectorId === customConnectorId
    ) {
      const [firstApi] = entry.firewall.apis;
      if (firstApi) {
        return { firewall: entry.firewall, api: firstApi };
      }
    }
  }
  throw new Error(
    `Expected inline firewall API for custom connector ${customConnectorId}`,
  );
}

interface TrackedMcpRun {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly issuedAtMs: number;
  done: boolean;
}

interface StartedMcpRun {
  readonly runId: string;
  readonly threadId: string;
  readonly execution: RunnerExecutionInput;
  readonly okouToken: string;
  readonly tracked: TrackedMcpRun;
}

function prepareMcpRunEnv(actor = bdd.user({ orgRole: "org:admin" })) {
  if (!actor.orgId) {
    throw new Error("Expected org-scoped actor");
  }
  const orgId = actor.orgId;
  chatCallbacks.acceptChatObjectStorage();
  runsApi.acceptStorageDownloads();
  runsApi.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  acceptRunAblyBatchPublish();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);

  const trackedRuns: TrackedMcpRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 1,
  };
  const runnerHostname = `runner-${runnerIdentity.runnerId}.okou.app`;

  webhooksApi.configureClerkWebhookSecret();
  webhooksApi.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: orgId, created_by: actor.userId, created_at: now() },
  });

  const runnerGroupPromise = runsApi.configureRunnerGroup({
    runnerIdentity,
    hostname: runnerHostname,
  });
  const orgCreatedPromise = accept(
    runClerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
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
    acceptRunAblyBatchPublish();
    const result = await settleIncludingAbort(async () => {
      await Promise.allSettled([runnerGroupPromise, orgCreatedPromise]);
      await flushWaitUntilForTest();
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.done;
      });
      if (activeRuns.length > 0) {
        const ownerHeaders = signInRunActor(actor);
        const groupedByTime = new Map<number, TrackedMcpRun[]>();
        for (const tracked of activeRuns) {
          const group = groupedByTime.get(tracked.issuedAtMs) ?? [];
          group.push(tracked);
          groupedByTime.set(tracked.issuedAtMs, group);
        }
        for (const [issuedAtMs, group] of groupedByTime) {
          mockNow(issuedAtMs);
          await Promise.all(
            group.map(async (tracked) => {
              const current = await accept(
                runByIdApi.getById({
                  headers: ownerHeaders,
                  params: { id: tracked.runId },
                }),
                [200],
              );
              if (
                ["queued", "pending", "running"].includes(current.body.status)
              ) {
                await accept(
                  runCancelApi.cancel({
                    headers: ownerHeaders,
                    params: { id: tracked.runId },
                  }),
                  [200],
                );
              }
              if (
                !["completed", "failed", "timeout"].includes(
                  current.body.status,
                )
              ) {
                await accept(
                  runAgentCompleteApi.complete({
                    headers: bearerHeaders(tracked.sandboxToken),
                    body: {
                      runId: tracked.runId,
                      exitCode: 137,
                      error: "Run cancelled by test cleanup",
                    },
                  }),
                  [200],
                );
              }
              tracked.done = true;
            }),
          );
        }
      }
      await flushWaitUntilForTest();
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousRunnerGroup);
    clearMockNow();
    if (!result.ok) {
      throw result.error;
    }
  });

  async function awaitBootstrap(): Promise<string> {
    if (resolvedRunnerGroup !== undefined) {
      return resolvedRunnerGroup;
    }
    const [runnerGroup] = await Promise.all([
      runnerGroupPromise,
      orgCreatedPromise,
    ]);
    resolvedRunnerGroup = runnerGroup;
    return runnerGroup;
  }

  async function createThread(title = "MCP thread"): Promise<string> {
    await awaitBootstrap();
    const created = await accept(
      chatThreadsApi.create({
        headers: signInRunActor(actor),
        body: { title },
      }),
      [201],
    );
    return created.body.id;
  }

  async function startRun(options?: {
    readonly threadId?: string;
    readonly prompt?: string;
  }): Promise<StartedMcpRun> {
    const runnerGroup = await awaitBootstrap();
    const issuedAtMs = now();
    const prompt = options?.prompt ?? "Inspect MCP connectors";
    const sent = await accept(
      chatEventsApi.send({
        headers: signInRunActor(actor),
        body: {
          ...(options?.threadId ? { threadId: options.threadId } : {}),
          prompt,
          model: null,
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
    await flushWaitUntilForTest();
    const execution = await runsApi.nextReceivedExecution(runnerGroup);
    const tracked: TrackedMcpRun = {
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      issuedAtMs,
      done: false,
    };
    trackedRuns.push(tracked);
    return {
      runId: execution.runId,
      threadId: sent.body.threadId,
      execution,
      okouToken: okouTokenFromExecution(execution),
      tracked,
    };
  }

  async function cancelAndAcknowledge(started: StartedMcpRun): Promise<void> {
    await accept(
      runCancelApi.cancel({
        headers: signInRunActor(actor),
        params: { id: started.runId },
      }),
      [200],
    );
    await accept(
      runAgentCompleteApi.complete({
        headers: bearerHeaders(started.execution.sandboxToken),
        body: {
          runId: started.runId,
          exitCode: 137,
          error: "Run cancelled",
        },
      }),
      [200],
    );
    started.tracked.done = true;
  }

  return {
    actor,
    orgId,
    createThread,
    startRun,
    cancelAndAcknowledge,
  };
}

function manualMcpBody(args: {
  readonly displayName: string;
  readonly endpoint: string;
  readonly storageVersion?: number;
}) {
  return {
    kind: "mcp" as const,
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http" as const,
    authMode: "manual" as const,
    fields: [
      {
        key: "secret",
        label: "API Secret",
        kind: "secret" as const,
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
    ...(args.storageVersion === undefined
      ? {}
      : { storageVersion: args.storageVersion }),
  };
}

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const missingId = randomUUID();
  const warmed = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(mcpApi.list({ headers: {} }), [401]),
      accept(
        mcpApi.reauthorizeOAuth({
          headers: {},
          body: {
            target: { kind: "custom", customConnectorId: missingId },
            scopes: ["read"],
          },
        }),
        [401],
      ),
      accept(
        chatThreadsApi.create({ headers: {}, body: { title: "w" } }),
        [401],
      ),
      accept(
        chatConnectorAccessApi.setThreadCurrent({
          headers: {},
          params: { threadId: missingId },
          body: {
            target: { kind: "custom", customConnectorId: missingId },
            connectionId: missingId,
          },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.delete({
          headers: {},
          params: { connectionId: missingId },
          body: { target: { kind: "custom", customConnectorId: missingId } },
        }),
        [401],
      ),
      accept(
        customOAuth2Api.start({
          headers: {},
          params: { id: missingId },
          body: { account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        chatEventsApi.send({
          headers: {},
          body: {
            prompt: "warmup",
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: "warmup" }],
            },
            hasTextContent: true,
          },
        }),
        [401],
      ),
      accept(
        runByIdApi.getById({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(
        runCancelApi.cancel({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(
        runAgentCompleteApi.complete({
          headers: {},
          body: { runId: missingId, exitCode: 0 },
        }),
        [401],
      ),
      accept(
        runFirewallAuthApi.firewallAuth({
          headers: {},
          body: { authHeaders: {} },
        }),
        [401],
      ),
    ]);
  });
  if (!warmed.ok) {
    throw warmed.error;
  }
});

describe("GET /api/mcp-connectors", () => {
  it("mcp-connectors-004 requires an agent token to read connectors", async () => {
    const admin = bdd.user();

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(mcpApi.list({ headers: {} }), [401]);
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      admin.orgRole,
    );
    const session = await accept(
      mcpApi.list({ headers: { authorization: "Bearer clerk-session" } }),
      [403],
    );

    expect(anonymous.status).toBe(401);
    expect(session.status).toBe(403);
  });

  it(
    "mcp-connectors-001 uses the Chat's exact selected account and discovers newly connected MCPs",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareMcpRunEnv();
      const { actor } = envSetup;
      const selectedEndpoint = `https://selected-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;
      const postStartEndpoint = `https://post-start-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;
      const httpPrefix = `https://signed-http-${randomUUID().slice(0, 8)}.example.test/v1`;

      const [selectedMcp, httpConnector, threadId] = await Promise.all([
        connectors.createCustomConnector(
          actor,
          manualMcpBody({
            displayName: "Selected MCP",
            endpoint: selectedEndpoint,
          }),
        ),
        connectors.createCustomConnector(actor, {
          displayName: "Signed HTTP",
          prefixTemplates: [httpPrefix],
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
        }),
        envSetup.createThread("Exact MCP account thread"),
      ]);

      const defaultMcpAccount = await connectors.setCustomConnectorValues(
        actor,
        selectedMcp.id,
        [{ key: "secret", kind: "secret", value: "default-mcp-secret" }],
        { intent: "add", displayName: "Default account" },
      );
      const runMcpAccount = await connectors.setCustomConnectorValues(
        actor,
        selectedMcp.id,
        [{ key: "secret", kind: "secret", value: "run-mcp-secret" }],
        { intent: "add", displayName: "Run account" },
      );
      const httpAccount = await connectors.setCustomConnectorValues(
        actor,
        httpConnector.id,
        [{ key: "secret", kind: "secret", value: "http-secret" }],
        { intent: "add" },
      );

      await Promise.all([
        accept(
          chatConnectorAccessApi.setThreadCurrent({
            headers: signInRunActor(actor),
            params: { threadId },
            body: {
              target: { kind: "custom", customConnectorId: selectedMcp.id },
              connectionId: runMcpAccount.connectionId,
            },
          }),
          [200],
        ),
        accept(
          chatConnectorAccessApi.setThreadCurrent({
            headers: signInRunActor(actor),
            params: { threadId },
            body: {
              target: { kind: "custom", customConnectorId: httpConnector.id },
              connectionId: httpAccount.connectionId,
            },
          }),
          [200],
        ),
      ]);

      const started = await envSetup.startRun({
        threadId,
        prompt: "List exact MCP accounts",
      });

      const firstList = await accept(
        mcpApi.list({ headers: bearerHeaders(started.okouToken) }),
        [200],
      );
      expect(firstList.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "custom", customConnectorId: selectedMcp.id },
          connectionId: runMcpAccount.connectionId,
          slug: selectedMcp.slug,
          endpoint: selectedEndpoint,
          transport: "streamable-http",
          runtimeAvailable: true,
          connectionStatus: "connected",
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        }),
      ]);

      await connectors.updateCustomConnector(
        actor,
        selectedMcp.id,
        manualMcpBody({
          displayName: "Selected MCP",
          endpoint: selectedEndpoint,
          storageVersion: 2,
        }),
      );
      const [postStartMcp] = await Promise.all([
        connectors.createCustomConnector(
          actor,
          manualMcpBody({
            displayName: "Post Start MCP",
            endpoint: postStartEndpoint,
          }),
        ),
        connectors.setCustomConnectorValues(
          actor,
          selectedMcp.id,
          [{ key: "secret", kind: "secret", value: "default-mcp-v2" }],
          { intent: "reconnect", connectionId: defaultMcpAccount.connectionId },
        ),
      ]);
      const postStartAccount = await connectors.setCustomConnectorValues(
        actor,
        postStartMcp.id,
        [{ key: "secret", kind: "secret", value: "post-start-secret" }],
        { intent: "add" },
      );

      const secondList = await accept(
        mcpApi.list({ headers: bearerHeaders(started.okouToken) }),
        [200],
      );
      expect(secondList.body.connectors).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "custom", customConnectorId: postStartMcp.id },
            connectionId: postStartAccount.connectionId,
            endpoint: postStartEndpoint,
            runtimeAvailable: true,
            connectionStatus: "connected",
          }),
          expect.objectContaining({
            target: { kind: "custom", customConnectorId: selectedMcp.id },
            connectionId: runMcpAccount.connectionId,
            runtimeAvailable: false,
            connectionStatus: "reconnect-required",
            reconnectReason: "configuration_invalid",
            missingRequiredFields: ["secret"],
            configuredFieldKeys: [],
          }),
        ]),
      );
      expect(secondList.body.connectors).toHaveLength(2);

      await connectors.updateCustomConnector(
        actor,
        selectedMcp.id,
        manualMcpBody({
          displayName: "Selected MCP",
          endpoint: selectedEndpoint,
          storageVersion: 3,
        }),
      );
      await connectors.setCustomConnectorValues(
        actor,
        selectedMcp.id,
        [{ key: "secret", kind: "secret", value: "run-mcp-v3" }],
        { intent: "reconnect", connectionId: runMcpAccount.connectionId },
      );

      const thirdList = await accept(
        mcpApi.list({ headers: bearerHeaders(started.okouToken) }),
        [200],
      );
      expect(thirdList.body.connectors).toHaveLength(2);
      expect(thirdList.body.connectors).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: { kind: "custom", customConnectorId: postStartMcp.id },
            connectionId: postStartAccount.connectionId,
            runtimeAvailable: true,
            connectionStatus: "connected",
          }),
          expect.objectContaining({
            target: { kind: "custom", customConnectorId: selectedMcp.id },
            connectionId: runMcpAccount.connectionId,
            runtimeAvailable: true,
            connectionStatus: "connected",
            missingRequiredFields: [],
            configuredFieldKeys: ["secret"],
          }),
        ]),
      );
    },
  );

  it(
    "mcp-connectors-003 follows the Chat's allowed replacement when its current account is deleted",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareMcpRunEnv();
      const { actor } = envSetup;
      const endpoint = `https://replacement-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;

      const [mcpConnector, threadId] = await Promise.all([
        connectors.createCustomConnector(
          actor,
          manualMcpBody({ displayName: "Replacement MCP", endpoint }),
        ),
        envSetup.createThread("Replacement MCP thread"),
      ]);

      const exactAccount = await connectors.setCustomConnectorValues(
        actor,
        mcpConnector.id,
        [{ key: "secret", kind: "secret", value: "exact-secret" }],
        { intent: "add", displayName: "Exact account" },
      );
      const siblingAccount = await connectors.setCustomConnectorValues(
        actor,
        mcpConnector.id,
        [{ key: "secret", kind: "secret", value: "sibling-secret" }],
        { intent: "add", displayName: "Healthy sibling" },
      );

      await accept(
        chatConnectorAccessApi.setThreadCurrent({
          headers: signInRunActor(actor),
          params: { threadId },
          body: {
            target: { kind: "custom", customConnectorId: mcpConnector.id },
            connectionId: exactAccount.connectionId,
          },
        }),
        [200],
      );

      const started = await envSetup.startRun({
        threadId,
        prompt: "Follow MCP account replacement",
      });

      await accept(
        connectorAccountsApi.delete({
          headers: signInRunActor(actor),
          params: { connectionId: exactAccount.connectionId },
          body: {
            target: { kind: "custom", customConnectorId: mcpConnector.id },
          },
        }),
        [200],
      );

      const listed = await accept(
        mcpApi.list({ headers: bearerHeaders(started.okouToken) }),
        [200],
      );
      expect(listed.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "custom", customConnectorId: mcpConnector.id },
          connectionId: siblingAccount.connectionId,
          runtimeAvailable: true,
          connectionStatus: "connected",
        }),
      ]);
    },
  );

  it(
    "builtin-mcp-discovery-001 refreshes discovery as Chat accounts become available and are deleted",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareMcpRunEnv();
      const { actor } = envSetup;

      const run1 = await envSetup.startRun({
        prompt: "Discover builtin manual MCP before connection",
      });

      const emptyList = await accept(
        mcpApi.list({ headers: bearerHeaders(run1.okouToken) }),
        [200],
      );
      expect(emptyList.body.connectors).toStrictEqual([]);

      const firstManual = await connectors.requestManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        { apiKey: "builtin-manual-mcp-secret-1" },
        { statuses: [200] },
      );
      if (firstManual.status !== 200) {
        throw new Error("Expected first builtin manual MCP connection");
      }
      const firstId = firstManual.body.connectionId;

      const afterFirstConnect = await accept(
        mcpApi.list({ headers: bearerHeaders(run1.okouToken) }),
        [200],
      );
      expect(afterFirstConnect.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: firstId,
          runtimeAvailable: true,
          connectionStatus: "connected",
        }),
      ]);

      await envSetup.cancelAndAcknowledge(run1);

      const run2 = await envSetup.startRun({
        threadId: run1.threadId,
        prompt: "Discover builtin manual MCP in subsequent run",
      });
      const secondRunInitial = await accept(
        mcpApi.list({ headers: bearerHeaders(run2.okouToken) }),
        [200],
      );
      expect(secondRunInitial.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: firstId,
          runtimeAvailable: true,
          connectionStatus: "connected",
        }),
      ]);

      const siblingManual = await connectors.requestManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        { apiKey: "builtin-manual-mcp-secret-2" },
        {
          statuses: [200],
          account: { intent: "add", displayName: "Backup MCP" },
        },
      );
      if (siblingManual.status !== 200) {
        throw new Error("Expected sibling builtin manual MCP connection");
      }
      const siblingId = siblingManual.body.connectionId;
      expect(siblingId).not.toBe(firstId);

      await accept(
        connectorAccountsApi.delete({
          headers: signInRunActor(actor),
          params: { connectionId: firstId },
          body: { target: { kind: "builtin", connectorSlug: "manual-mcp" } },
        }),
        [200],
      );

      const afterDelete = await accept(
        mcpApi.list({ headers: bearerHeaders(run2.okouToken) }),
        [200],
      );
      expect(afterDelete.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: siblingId,
          runtimeAvailable: true,
          connectionStatus: "connected",
        }),
      ]);
    },
  );
});

describe("POST /api/mcp-connectors/oauth2/reauthorize", () => {
  it("mcp-connectors-011 requires an agent token to reauthorize connector scopes", async () => {
    const admin = bdd.user();
    const body = {
      target: { kind: "custom" as const, customConnectorId: randomUUID() },
      scopes: ["admin"],
    };

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(
      mcpApi.reauthorizeOAuth({ headers: {}, body }),
      [401],
    );
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      admin.orgRole,
    );
    const session = await accept(
      mcpApi.reauthorizeOAuth({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [403],
    );

    expect(anonymous.status).toBe(401);
    expect(session.status).toBe(403);
  });

  it(
    "mcp-connectors-005 reauthorizes the parent-resource cimd account with none and offline access registered=false",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");

      const envSetup = prepareMcpRunEnv();
      const { actor } = envSetup;
      const suffix = randomUUID().slice(0, 8);
      const parentResource = `https://cimd-parent-${suffix}.example.test`;
      const endpoint = `${parentResource}/mcp`;
      const primaryIssuer = `https://cimd-idp-a-${suffix}.example.test`;
      const alternateIssuer = `https://cimd-idp-b-${suffix}.example.test`;

      const provider = mockAutomaticMcpOAuthProvider(context, {
        endpoint,
        resource: parentResource,
        issuer: primaryIssuer,
        registration: "cimd",
        authentication: "oauth",
        challengeScope: "read",
        metadataScopes: ["read", "admin"],
        authorizationServerScopes: ["read", "admin"],
        tokenEndpointAuthMethodsSupported: ["none"],
        authorizationCodeScopes: ["read", "read", "read admin offline_access"],
        initialExpiresIn: 3600,
      });

      const altTokenBodies: URLSearchParams[] = [];
      const altAuthHeaders: (string | null)[] = [];
      server.use(
        http.get(
          `${alternateIssuer}/.well-known/oauth-authorization-server`,
          () => {
            return HttpResponse.json({
              issuer: alternateIssuer,
              authorization_endpoint: `${alternateIssuer}/authorize`,
              token_endpoint: `${alternateIssuer}/token`,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              scopes_supported: ["read", "admin", "owner", "offline_access"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none"],
              authorization_response_iss_parameter_supported: true,
              client_id_metadata_document_supported: true,
            });
          },
        ),
        http.post(`${alternateIssuer}/token`, async ({ request }) => {
          altAuthHeaders.push(request.headers.get("authorization"));
          const body = new URLSearchParams(await request.text());
          altTokenBodies.push(body);
          const isRefresh = body.get("grant_type") === "refresh_token";
          return HttpResponse.json({
            access_token: isRefresh
              ? "alt-issuer-refreshed-token"
              : "alt-issuer-initial-token",
            refresh_token: "alt-issuer-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "read admin owner offline_access",
          });
        }),
      );

      const connector = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: "CIMD Parent Resource MCP",
        endpoint,
        transport: "streamable-http",
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      });

      const pinnedStartUrl = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        { intent: "add", displayName: "Pinned" },
      );
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "cimd-pinned-code",
        state: oauthStateFromUrl(pinnedStartUrl),
        iss: primaryIssuer,
      });

      const siblingStartUrl = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        { intent: "add", displayName: "Sibling" },
      );
      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "cimd-sibling-code",
        state: oauthStateFromUrl(siblingStartUrl),
        iss: primaryIssuer,
      });

      const initialAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      const pinnedAccount = initialAccounts.find((account) => {
        return account.isDefault;
      });
      const siblingAccount = initialAccounts.find((account) => {
        return !account.isDefault;
      });
      if (!pinnedAccount || !siblingAccount) {
        throw new Error("Expected pinned and sibling CIMD accounts");
      }

      const started = await envSetup.startRun({
        prompt: "Reauthorize CIMD parent-resource MCP",
      });

      provider.advertiseAuthorizationServerScopes([
        "read",
        "admin",
        "offline_access",
      ]);

      const firstReauth = await accept(
        mcpApi.reauthorizeOAuth({
          headers: bearerHeaders(started.okouToken),
          body: {
            target: { kind: "custom", customConnectorId: connector.id },
            scopes: ["admin"],
          },
        }),
        [200],
      );
      expect(firstReauth.body.kind).toBe("oauth");
      if (firstReauth.body.kind !== "oauth") {
        throw new Error("Expected oauth reauthorization response");
      }
      expect(Number.isNaN(Date.parse(firstReauth.body.expiresAt))).toBeFalsy();
      const firstReauthUrl = new URL(firstReauth.body.authorizationUrl);
      expect(firstReauthUrl.origin).toBe(primaryIssuer);
      expect(firstReauthUrl.searchParams.get("resource")).toBe(parentResource);
      expect(firstReauthUrl.searchParams.get("scope")).toBe(
        "read admin offline_access",
      );
      expect(provider.registrationBodies).toStrictEqual([]);

      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "cimd-reauth-admin-code",
        state: oauthStateFromUrl(firstReauth.body.authorizationUrl),
        iss: primaryIssuer,
      });

      const afterFirstReauth = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        afterFirstReauth.find((account) => {
          return account.id === pinnedAccount.id;
        }),
      ).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: ["read", "admin", "offline_access"],
      });
      expect(
        afterFirstReauth.find((account) => {
          return account.id === siblingAccount.id;
        }),
      ).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: ["read"],
      });

      const inlineTarget = firstInlineCustomFirewallApi(
        started.execution.firewalls,
        connector.id,
      );
      const firewallBody = {
        authHeaders: inlineTarget.api.auth.headers ?? {},
        forceRefresh: true,
        matchedFirewall: {
          name: inlineTarget.firewall.name,
          apiId: inlineTarget.api.id ?? "api-0",
          base: inlineTarget.api.base,
          customConnectorId: connector.id,
          sourceId: pinnedAccount.id,
          routingVariables: {},
        },
      };
      const firstRefresh = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: firewallBody,
        }),
        [200],
      );
      expect(firstRefresh.body.headers.Authorization).toBe(
        "Bearer automatic-refreshed-access-token",
      );

      provider.advertiseAuthorizationServers([alternateIssuer]);
      const secondReauth = await accept(
        mcpApi.reauthorizeOAuth({
          headers: bearerHeaders(started.okouToken),
          body: {
            target: { kind: "custom", customConnectorId: connector.id },
            scopes: ["owner"],
          },
        }),
        [200],
      );
      expect(secondReauth.body.kind).toBe("oauth");
      if (secondReauth.body.kind !== "oauth") {
        throw new Error("Expected alternate-issuer oauth reauthorization");
      }
      const secondReauthUrl = new URL(secondReauth.body.authorizationUrl);
      expect(secondReauthUrl.origin).toBe(alternateIssuer);

      await connectors.completeCustomConnectorOAuth2CallbackResult({
        code: "cimd-reauth-owner-code",
        state: oauthStateFromUrl(secondReauth.body.authorizationUrl),
        iss: alternateIssuer,
      });

      const secondRefresh = await accept(
        runFirewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: firewallBody,
        }),
        [200],
      );
      expect(secondRefresh.body.headers.Authorization).toBe(
        "Bearer alt-issuer-refreshed-token",
      );
      expect(
        altTokenBodies.some((body) => {
          return body.get("grant_type") === "refresh_token";
        }),
      ).toBeTruthy();
      expect(
        altAuthHeaders.every((header) => {
          return header === null;
        }),
      ).toBeTruthy();

      const afterSecondReauth = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        afterSecondReauth.find((account) => {
          return account.id === pinnedAccount.id;
        }),
      ).toMatchObject({
        connectionStatus: "connected",
      });
      expect(
        afterSecondReauth.find((account) => {
          return account.id === siblingAccount.id;
        }),
      ).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: ["read"],
      });
    },
  );

  it(
    "mcp-connectors-010 discovers Automatic no-auth accounts without offering OAuth reauthorization",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");

      const envSetup = prepareMcpRunEnv();
      const { actor } = envSetup;
      const endpoint = `https://auto-no-auth-mcp-${randomUUID().slice(0, 8)}.example.test/mcp`;
      mockAutomaticMcpOAuthProvider(context, {
        endpoint,
        registration: "cimd",
        authentication: "none",
      });

      const connector = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: "Automatic No-Auth MCP",
        endpoint,
        transport: "streamable-http",
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      });
      const startRes = await connectors.requestStartCustomConnectorOAuth2(
        actor,
        connector.id,
        [200],
        { intent: "add" },
      );
      expect(startRes.body).toMatchObject({ result: "connected" });

      const started = await envSetup.startRun({
        prompt: "Inspect Automatic no-auth MCP",
      });

      const [listed, reauth] = await Promise.all([
        accept(
          mcpApi.list({ headers: bearerHeaders(started.okouToken) }),
          [200],
        ),
        accept(
          mcpApi.reauthorizeOAuth({
            headers: bearerHeaders(started.okouToken),
            body: {
              target: { kind: "custom", customConnectorId: connector.id },
              scopes: ["admin"],
            },
          }),
          [409],
        ),
      ]);
      expect(listed.body.connectors).toStrictEqual([
        expect.objectContaining({
          target: { kind: "custom", customConnectorId: connector.id },
          runtimeAvailable: true,
          connectionStatus: "connected",
        }),
      ]);
      expect(reauth.body.error.code).toBe("CONFLICT");
    },
  );
});
