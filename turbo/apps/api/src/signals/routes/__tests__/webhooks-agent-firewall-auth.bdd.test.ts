import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorOauthDeviceAuthSessionContract,
  builtinConnectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import {
  runnersHeartbeatContract,
  type ExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsOauthDeviceAuthRoutes } from "../connectors-oauth-device-auth";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  mockAutomaticMcpOAuthProvider,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
} from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const CLAUDE_MODEL = "claude-fable-5-1";
const TEST_OAUTH_TOKEN_URL =
  "http://localhost:3000/api/test/oauth-provider/token";
const AUTOMATIC_MCP_ENDPOINT = "https://automatic-mcp.example.test/server";
const TEST_OAUTH_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "test-oauth" as const,
});
const TEST_OAUTH_DEVICE_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "test-oauth-device" as const,
});
const AUTOMATIC_MCP_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "automatic-mcp-oauth" as const,
});

const app = setupApp({
  context,
  baseUrl: "https://api.okou.ai",
  routes: [
    ...builtinConnectorsRoutes,
    ...builtinConnectorsAutomaticRoutes,
    ...builtinConnectorsOauthDeviceAuthRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...chatEventsRoutes,
    ...connectorAccountRoutes,
    ...featureSwitchesRoutes,
    ...meModelProvidersUpsertRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
    ...webhooksStripeRoutes,
  ],
});

const automaticApi = app(builtinConnectorAutomaticContract);
const chatEventsApi = app(chatEventsContract);
const connectorAccountsApi = app(connectorAccountsContract);
const deviceAuthApi = app(builtinConnectorOauthDeviceAuthSessionContract);
const featureSwitchesApi = app(featureSwitchesContract);
const oauthCallbackApi = app(builtinConnectorsSlugCallbackContract);
const oauthStartApi = app(builtinConnectorOauthStartContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const runnersHeartbeatApi = app(runnersHeartbeatContract);
const runsByIdApi = app(runsByIdContract);
const runsCancelApi = app(runsCancelContract);
const agentCompleteApi = app(webhookCompleteContract);
const firewallAuthApi = app(runWebhookContract);
const clerkWebhookApi = app(webhookClerkContract);
const stripeWebhookApi = app(webhookStripeContract);

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signIn(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "Firewall",
    },
  ]);
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
  return SESSION_HEADERS;
}

function testOAuthFirewallBody(sourceId: string, forceRefresh?: boolean) {
  return {
    authHeaders: {
      Authorization: `Bearer ${secretTemplate("TEST_OAUTH_TOKEN")}`,
    },
    secretConnectorMap: {
      TEST_OAUTH_TOKEN: "test-oauth",
    },
    secretConnectorMetadataMap: {
      TEST_OAUTH_TOKEN: {
        sourceType: "connector" as const,
        sourceId,
      },
    },
    ...(forceRefresh === undefined ? {} : { forceRefresh }),
  };
}

function testOAuthDeviceFirewallBody(sourceId: string) {
  return {
    authHeaders: {
      Authorization: `Bearer ${secretTemplate("TEST_OAUTH_DEVICE_TOKEN")}`,
    },
    secretConnectorMap: {
      TEST_OAUTH_DEVICE_TOKEN: "test-oauth-device",
    },
    secretConnectorMetadataMap: {
      TEST_OAUTH_DEVICE_TOKEN: {
        sourceType: "connector" as const,
        sourceId,
      },
    },
  };
}

beforeAll(async () => {
  const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  const warmupId = randomUUID();
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_stripe_warmup");

  const warmed = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(
        firewallAuthApi.firewallAuth({
          headers: {},
          body: { authHeaders: {} },
        }),
        [401],
      ),
      accept(
        automaticApi.start({
          headers: {},
          params: { connectorSlug: "automatic-mcp-oauth" },
          body: { authMethod: "smart-connect", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        oauthStartApi.start({
          headers: {},
          params: { connectorSlug: "test-oauth" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        deviceAuthApi.create({
          headers: {},
          params: { connectorSlug: "test-oauth-device" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connections({
          headers: {},
          query: TEST_OAUTH_TARGET,
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.scopeDiff({
          headers: {},
          params: { connectionId: warmupId },
          query: { connectorSlug: "test-oauth" },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.delete({
          headers: {},
          params: { connectionId: warmupId },
          body: { target: TEST_OAUTH_DEVICE_TARGET },
        }),
        [401],
      ),
      accept(
        featureSwitchesApi.update({
          headers: {},
          body: { switches: { [FeatureSwitchKey.TestOauthConnector]: true } },
        }),
        [401],
      ),
      accept(
        personalModelProvidersApi.upsert({
          headers: {},
          body: { type: "claude-code-oauth-token", secret: "warmup" },
        }),
        [401],
      ),
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
        runnersHeartbeatApi.heartbeat({
          headers: {},
          body: {
            runnerId: warmupId,
            runnerHostname: `runner-${warmupId}.okou.app`,
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
            ingressServiceActive: true,
          },
        }),
        [401],
      ),
      accept(
        runsByIdApi.getById({ headers: {}, params: { id: warmupId } }),
        [401],
      ),
      accept(
        runsCancelApi.cancel({ headers: {}, params: { id: warmupId } }),
        [401],
      ),
      accept(
        agentCompleteApi.complete({
          headers: {},
          body: { runId: warmupId, exitCode: 1, error: "warmup" },
        }),
        [401],
      ),
      accept(clerkWebhookApi.post({ body: "{}", extraHeaders: {} }), [401]),
      accept(stripeWebhookApi.post({ body: "{}", extraHeaders: {} }), [401]),
    ]);
  });

  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
  if (!warmed.ok) {
    throw warmed.error;
  }
});

interface TrackedRun {
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

function createFirewallRunHarness(
  options: { readonly proTier?: boolean } = {},
) {
  const actor = bdd.user({ orgRole: "org:admin" });
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor with an orgId");
  }
  const orgId: string = actor.orgId;
  const group = `vm0/fw-${randomUUID().slice(0, 8)}`;
  const runnerId = randomUUID();
  const hostname = `runner-${runnerId}.okou.app`;
  const acceptedOrder: string[] = [];
  const acceptedByRunId = new Map<string, ExecutionContext>();
  const trackedRuns: TrackedRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  mockClaudeCodeTokenEndpoint();

  server.use(
    http.post(
      `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
      async ({ request, params }) => {
        const encoding = request.headers.get("content-encoding");
        const rawBytes = Buffer.from(await request.arrayBuffer());
        const text =
          encoding === "gzip"
            ? gunzipSync(rawBytes).toString("utf8")
            : rawBytes.toString("utf8");
        const envelope = runnerDispatchEnvelopeSchema.parse(JSON.parse(text));
        if (
          envelope.runnerId !== runnerId ||
          envelope.executionContext.runId !== params.runId
        ) {
          throw new Error("Unexpected direct Runner dispatch identity");
        }
        acceptedByRunId.set(
          envelope.executionContext.runId,
          envelope.executionContext,
        );
        acceptedOrder.push(envelope.executionContext.runId);
        return HttpResponse.json({
          runnerId,
          heartbeatGeneration: 1,
          runId: envelope.executionContext.runId,
          disposition: "accepted",
        });
      },
    ),
  );

  let lastClockMs = now();

  onTestFinished(async () => {
    const previousGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockNow(lastClockMs);
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
    context.mocks.ably.publish.mockResolvedValue(undefined);
    const cleaned = await settleIncludingAbort(async () => {
      await flushWaitUntilForTest();
      const active = trackedRuns.filter((entry) => {
        return !entry.done;
      });
      if (active.length > 0) {
        signIn(actor);
        for (const entry of active) {
          const current = await accept(
            runsByIdApi.getById({
              headers: SESSION_HEADERS,
              params: { id: entry.runId },
            }),
            [200],
          );
          if (["queued", "pending", "running"].includes(current.body.status)) {
            await accept(
              runsCancelApi.cancel({
                headers: SESSION_HEADERS,
                params: { id: entry.runId },
              }),
              [200],
            );
          }
          if (
            !["completed", "failed", "timeout"].includes(current.body.status)
          ) {
            await accept(
              agentCompleteApi.complete({
                headers: bearerHeaders(entry.sandboxToken),
                body: {
                  runId: entry.runId,
                  exitCode: 137,
                  error: "Run cancelled by test cleanup",
                },
              }),
              [200],
            );
          }
          entry.done = true;
        }
      }
      await flushWaitUntilForTest();
    });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", previousGroup);
    if (!cleaned.ok) {
      throw cleaned.error;
    }
  });

  async function registerRunner(): Promise<void> {
    lastClockMs = now();
    await accept(
      runnersHeartbeatApi.heartbeat({
        headers: {
          authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
        },
        body: {
          runnerId,
          runnerHostname: hostname,
          group,
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 16,
          totalMemoryMb: 32_768,
          maxConcurrent: 4,
          allocatedVcpu: 0,
          allocatedMemoryMb: 0,
          runningCount: 0,
          admittableProfiles: ["vm0/default"],
          heldSandboxStates: [],
          heldHomeStates: [],
          activeReuseProducers: [],
          mode: "running",
          ingressServiceActive: true,
        },
      }),
      [200],
    );
  }

  async function provisionMember(): Promise<void> {
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({
      type: "organization.created",
      data: { id: orgId, created_by: actor.userId, created_at: now() },
    });
    await accept(clerkWebhookApi.post({ body: "{}", extraHeaders: {} }), [200]);
    await flushWaitUntilForTest();

    const tasks: Promise<unknown>[] = [
      accept(
        featureSwitchesApi.update({
          headers: signIn(actor),
          body: {
            switches: { [FeatureSwitchKey.TestOauthConnector]: true },
          },
        }),
        [200],
      ),
      accept(
        personalModelProvidersApi.upsert({
          headers: signIn(actor),
          body: {
            type: "claude-code-oauth-token",
            secret: `claude-token-${randomUUID()}`,
          },
        }),
        [201],
      ),
    ];
    if (options.proTier) {
      const periodEnd = nowDate();
      periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
      tasks.push(
        postSubscriptionInvoicePaid(context.signal, {
          orgId,
          userId: actor.userId,
          tier: "pro",
          customerId: generatedStripeCustomerId(),
          subscriptionId: generatedStripeSubscriptionId(),
          currentPeriodEnd: periodEnd,
        }),
      );
    }
    await Promise.all(tasks);
  }

  async function connectTestOAuth(args: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
    readonly scope?: string;
  }): Promise<string> {
    mockTestOAuthAuthCodeProvider({
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresIn: args.expiresIn,
      scope: args.scope ?? "read",
      userId: `test-oauth-user-${randomUUID().slice(0, 8)}`,
      username: "bdd-test-oauth",
      email: "bdd-test-oauth@example.test",
    });
    const started = await accept(
      oauthStartApi.start({
        headers: signIn(actor),
        params: { connectorSlug: "test-oauth" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    );
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected state from test-oauth OAuth start");
    }
    const callback = await accept(
      oauthCallbackApi.callback({
        params: { connectorSlug: "test-oauth" },
        query: {
          code: `code-${randomUUID()}`,
          state,
          responseMode: "json",
        },
      }),
      [200],
    );
    if (callback.body.status !== "success") {
      throw new Error("Expected test-oauth callback to succeed");
    }
    const listed = await accept(
      connectorAccountsApi.connections({
        headers: signIn(actor),
        query: TEST_OAUTH_TARGET,
      }),
      [200],
    );
    const conn = listed.body.connections[0];
    if (!conn) {
      throw new Error("Expected connected test-oauth account");
    }
    return conn.id;
  }

  async function connectAutomaticMcp(issuer: string): Promise<string> {
    const started = await accept(
      automaticApi.start({
        headers: signIn(actor),
        params: { connectorSlug: "automatic-mcp-oauth" },
        body: { authMethod: "smart-connect", account: { intent: "add" } },
      }),
      [200],
    );
    if (started.body.result !== "authorization") {
      throw new Error("Expected authorization handoff for automatic-mcp-oauth");
    }
    const state = new URL(started.body.authorizationUrl).searchParams.get(
      "state",
    );
    if (!state) {
      throw new Error("Expected state from automatic-mcp-oauth start");
    }
    const completed = await accept(
      automaticApi.callback({
        query: {
          code: `auto-code-${randomUUID()}`,
          state,
          iss: issuer,
          responseMode: "json",
        },
      }),
      [200],
    );
    if (completed.body.status !== "success") {
      throw new Error(
        `Expected automatic-mcp-oauth callback to succeed, got ${JSON.stringify(completed.body)}`,
      );
    }
    const listed = await accept(
      connectorAccountsApi.connections({
        headers: signIn(actor),
        query: AUTOMATIC_MCP_TARGET,
      }),
      [200],
    );
    const conn = listed.body.connections[0];
    if (!conn) {
      throw new Error("Expected connected automatic-mcp-oauth account");
    }
    return conn.id;
  }

  async function connectTestOAuthDevice(args: {
    readonly accessToken: string;
    readonly expiresIn: number;
  }): Promise<string> {
    mockTestOAuthDeviceConnectorProvider();
    server.use(
      http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        if (
          body.get("grant_type") !==
          "urn:ietf:params:oauth:grant-type:device_code"
        ) {
          throw new Error(
            "Expected device_code grant during test-oauth-device",
          );
        }
        return HttpResponse.json({
          access_token: args.accessToken,
          expires_in: args.expiresIn,
          token_type: "Bearer",
          scope: "read",
        });
      }),
    );
    const started = await accept(
      deviceAuthApi.create({
        headers: signIn(actor),
        params: { connectorSlug: "test-oauth-device" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    );
    const polled = await accept(
      deviceAuthApi.poll({
        headers: signIn(actor),
        params: {
          connectorSlug: "test-oauth-device",
          sessionId: started.body.sessionId,
        },
        body: { sessionToken: started.body.sessionToken },
      }),
      [200],
    );
    if (polled.body.status !== "complete") {
      throw new Error("Expected test-oauth-device poll to complete");
    }
    return polled.body.connectionId;
  }

  async function launchRun(prompt: string) {
    lastClockMs = now();
    const before = acceptedOrder.length;
    await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          prompt,
          model: CLAUDE_MODEL,
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const runId = acceptedOrder[before];
    if (!runId) {
      throw new Error("Expected direct Runner dispatch");
    }
    const execution = acceptedByRunId.get(runId);
    if (!execution) {
      throw new Error(`Missing execution context for ${runId}`);
    }
    const trackedEntry: TrackedRun = {
      runId,
      sandboxToken: execution.sandboxToken,
      done: false,
    };
    trackedRuns.push(trackedEntry);
    return { runId, execution, trackedEntry };
  }

  return {
    actor,
    registerRunner,
    provisionMember,
    connectTestOAuth,
    connectAutomaticMcp,
    connectTestOAuthDevice,
    launchRun,
  };
}

describe("webhooks-agent-firewall-auth.bdd", () => {
  it(
    "webhooks-agent-firewall-auth.bdd-025 maintains authoritative and unknown OAuth grants across refresh",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const harness = createFirewallRunHarness({ proTier: true });
      const { actor } = harness;
      const autoProvider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        endpoint: AUTOMATIC_MCP_ENDPOINT,
        challengeScope: null,
        metadataScopes: [],
        initialExpiresIn: 3600,
      });
      const automaticGrantTypes: string[] = [];
      server.use(
        http.post(`${autoProvider.issuer}/token`, async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          const grantType = form.get("grant_type") ?? "";
          automaticGrantTypes.push(grantType);
          if (grantType === "refresh_token") {
            return HttpResponse.json({
              access_token: "automatic-refreshed-access-token",
              refresh_token: "automatic-rotated-refresh-token",
              token_type: "Bearer",
              expires_in: 3600,
            });
          }
          return HttpResponse.json({
            access_token: "automatic-initial-access-token",
            refresh_token: "automatic-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }),
      );

      await Promise.all([harness.provisionMember(), harness.registerRunner()]);
      const [autoConnectionId, testOAuthConnectionId] = await Promise.all([
        harness.connectAutomaticMcp(autoProvider.issuer),
        harness.connectTestOAuth({
          accessToken: "initial-wide-access",
          refreshToken: "initial-refresh-token",
          expiresIn: 3600,
          scope: "read provider-added",
        }),
      ]);

      const launched = await harness.launchRun(
        "Verify authoritative and unknown OAuth grant scopes across refresh",
      );

      expect(launched.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          connectorSlug: "automatic-mcp-oauth",
          sourceId: autoConnectionId,
        }),
      );
      expect(launched.execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "automatic-mcp-oauth",
        }),
      );

      let testOAuthRefreshCount = 0;
      server.use(
        http.post(TEST_OAUTH_TOKEN_URL, async ({ request }) => {
          const form = new URLSearchParams(await request.text());
          if (form.get("grant_type") !== "refresh_token") {
            throw new Error("Expected refresh_token grant for test-oauth");
          }
          testOAuthRefreshCount += 1;
          if (testOAuthRefreshCount === 1) {
            return HttpResponse.json({
              access_token: "narrow-scoped-access",
              refresh_token: "rotated-refresh-1",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "provider-added",
            });
          }
          return HttpResponse.json({
            access_token: "omitted-scope-access",
            refresh_token: "rotated-refresh-2",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );

      const firstRefresh = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(launched.execution.firewallToken),
          body: testOAuthFirewallBody(testOAuthConnectionId, true),
        }),
        [200],
      );
      expect(firstRefresh.body.headers.Authorization).toBe(
        "Bearer narrow-scoped-access",
      );

      const [accountAfterFirst, scopeDiffAfterFirst] = await Promise.all([
        accept(
          connectorAccountsApi.connection({
            headers: signIn(actor),
            params: { connectionId: testOAuthConnectionId },
            query: TEST_OAUTH_TARGET,
          }),
          [200],
        ),
        accept(
          connectorAccountsApi.scopeDiff({
            headers: signIn(actor),
            params: { connectionId: testOAuthConnectionId },
            query: { connectorSlug: "test-oauth" },
          }),
          [200],
        ),
      ]);
      expect(accountAfterFirst.body).toMatchObject({
        connectionStatus: "connected",
        oauthScopes: ["provider-added"],
      });
      expect(scopeDiffAfterFirst.body).toMatchObject({
        currentScopes: ["read"],
        storedScopes: ["read"],
        addedScopes: [],
        removedScopes: [],
      });

      const secondRefresh = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(launched.execution.firewallToken),
          body: testOAuthFirewallBody(testOAuthConnectionId, true),
        }),
        [200],
      );
      expect(secondRefresh.body.headers.Authorization).toBe(
        "Bearer omitted-scope-access",
      );

      const accountAfterSecond = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId: testOAuthConnectionId },
          query: TEST_OAUTH_TARGET,
        }),
        [200],
      );
      expect(accountAfterSecond.body.oauthScopes).toStrictEqual([
        "provider-added",
      ]);

      const automaticRefresh = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(launched.execution.firewallToken),
          body: {
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("MCP_ACCESS_TOKEN")}`,
            },
            matchedFirewall: {
              name: "automatic-mcp-oauth",
              apiId: "api-0",
              base: AUTOMATIC_MCP_ENDPOINT,
              connectorSlug: "automatic-mcp-oauth",
              sourceId: autoConnectionId,
              routingVariables: {},
            },
            forceRefresh: true,
          },
        }),
        [200],
      );
      expect(automaticRefresh.body.headers.Authorization).toBe(
        "Bearer automatic-refreshed-access-token",
      );
      expect(automaticRefresh.body.refreshedConnectors).toStrictEqual([]);
      expect(automaticGrantTypes).toStrictEqual([
        "authorization_code",
        "refresh_token",
      ]);

      const automaticAccount = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId: autoConnectionId },
          query: AUTOMATIC_MCP_TARGET,
        }),
        [200],
      );
      expect(automaticAccount.body.oauthScopes).toBeNull();
    },
  );

  it(
    "webhooks-agent-firewall-auth.bdd-057 requires reconnect for expired static tokens and syncs current ones",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const harness = createFirewallRunHarness();
      const { actor } = harness;

      await harness.provisionMember();
      const firstConnectionId = await harness.connectTestOAuthDevice({
        accessToken: "expired-device-token",
        expiresIn: 3600,
      });

      mockNow(startMs + 3_660_000);
      await harness.registerRunner();
      const launched = await harness.launchRun(
        "Verify expired static device token requires reconnect and new token resolves",
      );

      const expiredResponse = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(launched.execution.firewallToken),
          body: testOAuthDeviceFirewallBody(firstConnectionId),
        }),
        [502],
      );
      expect(expiredResponse.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
        connectors: ["test-oauth-device"],
      });

      await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor),
          params: { connectionId: firstConnectionId },
          body: { target: TEST_OAUTH_DEVICE_TARGET },
        }),
        [200],
      );
      const secondConnectionId = await harness.connectTestOAuthDevice({
        accessToken: "current-device",
        expiresIn: 3600,
      });

      const currentResponse = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(launched.execution.firewallToken),
          body: testOAuthDeviceFirewallBody(secondConnectionId),
        }),
        [200],
      );
      expect(currentResponse.body.headers.Authorization).toBe(
        "Bearer current-device",
      );
      expect(currentResponse.body.refreshedConnectors).toStrictEqual([]);
    },
  );

  it(
    "webhooks-agent-firewall-auth.bdd-053 rejects a completed run before connector refresh",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const harness = createFirewallRunHarness({ proTier: true });
      const { actor } = harness;

      await harness.provisionMember();
      const connectionId = await harness.connectTestOAuth({
        accessToken: "expired-before-complete",
        refreshToken: "refresh-should-not-run",
        expiresIn: 60,
      });

      mockNow(startMs + 120_000);
      await harness.registerRunner();
      const launched = await harness.launchRun(
        "Complete run before testing terminal firewall rejection",
      );

      let refreshCalls = 0;
      server.use(
        http.post(TEST_OAUTH_TOKEN_URL, () => {
          refreshCalls += 1;
          return HttpResponse.json({
            access_token: "unexpected-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );

      await accept(
        agentCompleteApi.complete({
          headers: bearerHeaders(launched.execution.sandboxToken),
          body: {
            runId: launched.runId,
            exitCode: 0,
            completion: {
              cliAgentType: "claude-code",
              cliAgentSessionId: `completed-session-${launched.runId}`,
              cliAgentSessionHistoryDisposition: "native_only",
              storageOutputs: [],
            },
          },
        }),
        [200],
      );
      launched.trackedEntry.done = true;
      await flushWaitUntilForTest();

      const [runAfterComplete, rejectedAuth] = await Promise.all([
        accept(
          runsByIdApi.getById({
            headers: signIn(actor),
            params: { id: launched.runId },
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(launched.execution.firewallToken),
            body: testOAuthFirewallBody(connectionId),
          }),
          [403],
        ),
      ]);

      expect(runAfterComplete.body.status).toBe("completed");
      expect(rejectedAuth.body.error.code).toBe("FORBIDDEN");
      expect(refreshCalls).toBe(0);
    },
  );

  it(
    "webhooks-agent-firewall-auth.bdd-055 rejects a cancelled run before connector refresh",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startMs = Date.parse("2026-06-01T12:00:00.000Z");
      mockNow(startMs);
      const harness = createFirewallRunHarness({ proTier: true });
      const { actor } = harness;

      await harness.provisionMember();
      const connectionId = await harness.connectTestOAuth({
        accessToken: "expired-before-cancel",
        refreshToken: "refresh-should-not-run",
        expiresIn: 60,
      });

      mockNow(startMs + 120_000);
      await harness.registerRunner();
      const launched = await harness.launchRun(
        "Cancel run before testing terminal firewall rejection",
      );

      let refreshCalls = 0;
      server.use(
        http.post(TEST_OAUTH_TOKEN_URL, () => {
          refreshCalls += 1;
          return HttpResponse.json({
            access_token: "unexpected-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }),
      );

      await accept(
        runsCancelApi.cancel({
          headers: signIn(actor),
          params: { id: launched.runId },
        }),
        [200],
      );

      const [runAfterCancel, rejectedAuth] = await Promise.all([
        accept(
          runsByIdApi.getById({
            headers: signIn(actor),
            params: { id: launched.runId },
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(launched.execution.firewallToken),
            body: testOAuthFirewallBody(connectionId),
          }),
          [403],
        ),
      ]);

      expect(runAfterCancel.body.status).toBe("cancelled");
      expect(rejectedAuth.body.error.code).toBe("FORBIDDEN");
      expect(refreshCalls).toBe(0);
    },
  );

  it("webhooks-agent-firewall-auth.bdd-001 rejects missing and malformed firewall auth requests", async () => {
    const [missingHeader, malformedBearer] = await Promise.all([
      accept(
        firewallAuthApi.firewallAuth({
          headers: {},
          body: { authHeaders: {} },
        }),
        [401],
      ),
      accept(
        firewallAuthApi.firewallAuth({
          headers: { authorization: "Bearer junk" },
          body: { authHeaders: {} },
        }),
        [401],
      ),
    ]);

    expect(missingHeader.body.error.code).toBe("UNAUTHORIZED");
    expect(malformedBearer.body.error.code).toBe("UNAUTHORIZED");
  });
});
