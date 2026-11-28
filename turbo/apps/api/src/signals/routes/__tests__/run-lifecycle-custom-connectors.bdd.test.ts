import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import {
  builtinConnectorAutomaticContract,
  builtinConnectorManualGrantContract,
  builtinConnectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorProposalContract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  connectorRuntimeSyncResultSchema,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
import type { infer as zInfer } from "zod";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import {
  UNKNOWN_PERMISSION_GRANT,
  type ExecutionFirewallEntry,
} from "@okouai/connectors/firewall-types";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
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
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatEventsRoutes } from "../chat-events";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsAutomaticRoutes } from "../connectors-automatic";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorsGetRoutes } from "../custom-connectors-get";
import { customConnectorOAuth2Routes } from "../custom-connectors-oauth2";
import { customConnectorProposalRoutes } from "../custom-connectors-proposal";
import { customConnectorsUpdateRoutes } from "../custom-connectors-update";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  mockAutomaticMcpOAuthProvider,
  mockCustomConnectorOAuth2Provider,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  executionEnvironment,
  okouTokenFromExecution,
  type RunnerExecutionInput,
} from "./helpers/chat-events-fixture";
import { mockClerkUsers } from "./helpers/clerk-users";
import { automaticMcpCatalogFixture } from "./helpers/connector-automatic-catalog";
import { createRouteMocks } from "./helpers/route-test";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
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
const ONE_HOUR_MS = 60 * 60 * 1000;
const MCP_PROMPT_INVENTORY_LIMIT = 20;

const SLACK_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "slack" as const,
});
const CLOUDFLARE_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "cloudflare" as const,
});
const GITLAB_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "gitlab" as const,
});
const JIRA_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "jira" as const,
});

const app = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...chatConnectorAccessRoutes,
    ...connectorAccountRoutes,
    ...connectorPermissionsRoutes,
    ...builtinConnectorsRoutes,
    ...builtinConnectorsAutomaticRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...customConnectorsRoutes,
    ...customConnectorsGetRoutes,
    ...customConnectorsUpdateRoutes,
    ...customConnectorsDeleteRoutes,
    ...customConnectorsValuesSetRoutes,
    ...customConnectorOAuth2Routes,
    ...customConnectorProposalRoutes,
    ...mcpConnectorsRoutes,
    ...meModelProvidersUpsertRoutes,
    ...userModelPreferenceRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
    ...webhooksStripeRoutes,
  ],
});

const chatEventsApi = app(chatEventsContract);
const accessApi = app(chatConnectorAccessContract);
const connectorAccountsApi = app(connectorAccountsContract);
const connectorPermissionsApi = app(connectorPermissionsContract);
const builtinManualGrantApi = app(builtinConnectorManualGrantContract);
const builtinOauthStartApi = app(builtinConnectorOauthStartContract);
const builtinOauthCallbackApi = app(builtinConnectorsSlugCallbackContract);
const builtinAutomaticApi = app(builtinConnectorAutomaticContract);
const customConnectorsApi = app(customConnectorsContract);
const customConnectorByIdApi = app(customConnectorByIdContract);
const customConnectorValuesApi = app(customConnectorValuesContract);
const customConnectorOAuth2Api = app(customConnectorOAuth2Contract);
const customConnectorProposalApi = app(customConnectorProposalContract);
const mcpConnectorsApi = app(mcpConnectorsContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const userModelPreferenceApi = app(userModelPreferenceContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runnerSyncApi = app(runnersConnectorRuntimeSyncContract);
const runsByIdApi = app(runsByIdContract);
const runsQueueApi = app(runsQueueContract);
const runsCancelApi = app(runsCancelContract);
const agentCompleteApi = app(webhookCompleteContract);
const firewallAuthApi = app(runWebhookContract);
const clerkWebhookApi = app(webhookClerkContract);
const stripeWebhookApi = app(webhookStripeContract);

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function officialRunnerHeaders() {
  return {
    authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
  };
}

function signIn(
  actor: ApiTestUser,
  directoryActors: readonly ApiTestUser[] = [actor],
) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  mockClerkUsers(
    context,
    directoryActors.map((member) => {
      const emailId = `email_${member.userId}`;
      return {
        id: member.userId,
        emailAddresses: [{ id: emailId, emailAddress: member.email }],
        primaryEmailAddressId: emailId,
        firstName: "BDD",
        lastName: "Connector",
      };
    }),
  );
  const memberships = directoryActors.flatMap((member) => {
    if (!member.orgId) {
      return [];
    }
    return [
      {
        id: `membership-${member.userId}-${member.orgId}`,
        createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
        role: member.orgRole ?? "org:admin",
        organization: { id: member.orgId },
        publicUserData: { userId: member.userId },
      },
    ];
  });
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
  return SESSION_HEADERS;
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state query parameter");
  }
  return state;
}

function acceptAblyBatchPublish() {
  context.mocks.ably.batchPublish.mockImplementation((spec) => {
    const entries = Array.isArray(spec) ? spec : [spec];
    const results = entries.flatMap((entry) => {
      const channels: readonly unknown[] = Array.isArray(entry.channels)
        ? entry.channels
        : [entry.channels];
      return channels.map((channel) => {
        return {
          channel: String(channel),
          messageId: randomUUID(),
          serials: [null],
        };
      });
    });
    return Promise.resolve({
      successCount: results.length,
      failureCount: 0,
      results,
    });
  });
}

function mockCloudflareConnectorOAuth(
  options: {
    readonly accountId?: string;
    readonly email?: string;
  } = {},
) {
  mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_ID", "cf-bdd-client-id");
  mockOptionalEnv("CLOUDFLARE_OAUTH_CLIENT_SECRET", "cf-bdd-client-secret");
  server.use(
    http.post("https://dash.cloudflare.com/oauth2/token", () => {
      return HttpResponse.json({
        access_token: `cf-access-${randomUUID()}`,
        refresh_token: `cf-refresh-${randomUUID()}`,
        expires_in: 3600,
        token_type: "bearer",
        scope: "dns-firewall.read offline_access",
      });
    }),
    http.get("https://dash.cloudflare.com/oauth2/userinfo", () => {
      return HttpResponse.json({
        sub: options.accountId ?? `cf-user-${randomUUID()}`,
        email: options.email ?? "cloudflare@example.test",
        preferred_username: "cloudflare-owner",
      });
    }),
  );
}

type ConnectorRuntimeSyncResult = zInfer<
  typeof connectorRuntimeSyncResultSchema
>;
type CustomAvailableSyncResult = Extract<
  ConnectorRuntimeSyncResult,
  { readonly state: "available"; readonly firewall: unknown }
>;

function requireCustomAvailableSync(
  entry: ConnectorRuntimeSyncResult | undefined,
): CustomAvailableSyncResult {
  if (!entry || entry.state !== "available" || !("firewall" in entry)) {
    throw new Error("Expected available custom connector runtime sync result");
  }
  return entry;
}

function findInlineCustomFirewall(
  firewalls: readonly ExecutionFirewallEntry[] | undefined,
  customConnectorId: string,
) {
  const entry = (firewalls ?? []).find((candidate) => {
    return (
      candidate.kind === "inline" &&
      candidate.customConnectorId === customConnectorId
    );
  });
  if (!entry || entry.kind !== "inline") {
    throw new Error(
      `Expected inline firewall entry for custom connector ${customConnectorId}`,
    );
  }
  return entry;
}

function extractPromptSection(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start === -1) {
    throw new Error(`Missing prompt heading ${heading}`);
  }
  const rest = prompt.slice(start + heading.length);
  const nextHeading = rest.search(/\n# [^\n]+/u);
  return nextHeading === -1
    ? prompt.slice(start)
    : prompt.slice(start, start + heading.length + nextHeading);
}

function expectCustomSyncAvailable(
  results: readonly {
    readonly state: string;
    readonly target: { readonly kind: string };
    readonly firewall?: {
      readonly sourceId?: string;
      readonly firewall: {
        readonly apis: readonly { readonly base: string }[];
      };
    };
  }[],
  expectedSourceId: string,
  expectedBase?: string,
) {
  const result = results[0];
  expect(result?.state).toBe("available");
  if (
    !result ||
    result.state !== "available" ||
    result.target.kind !== "custom" ||
    !result.firewall
  ) {
    throw new Error("Expected available custom sync result");
  }
  expect(result.firewall.sourceId).toBe(expectedSourceId);
  if (expectedBase !== undefined) {
    expect(result.firewall.firewall.apis[0]?.base).toBe(expectedBase);
  }
}

beforeAll(async () => {
  const previousClerkSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  const previousStripeSecret = optionalEnv("STRIPE_WEBHOOK_SECRET");
  const missingId = randomUUID();
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  context.mocks.clerk.verifyWebhook.mockRejectedValueOnce(new Error("warmup"));
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_warmup");
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_stripe_warmup");

  const warmupResult = await settleIncludingAbort(async () => {
    await Promise.all([
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
          body: { target: GITLAB_TARGET, enabled: false },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connections({
          headers: {},
          query: { kind: "custom", customConnectorId: missingId },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connection({
          headers: {},
          params: { connectionId: missingId },
          query: { kind: "custom", customConnectorId: missingId },
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
        connectorPermissionsApi.apply({
          headers: {},
          body: { target: SLACK_TARGET, mode: "replace", grants: [] },
        }),
        [401],
      ),
      accept(
        builtinManualGrantApi.connect({
          headers: {},
          params: { connectorSlug: "figma" },
          body: {
            authMethod: "api-token",
            values: { accessToken: "warmup" },
            account: { intent: "add" },
          },
        }),
        [401],
      ),
      accept(
        builtinOauthStartApi.start({
          headers: {},
          params: { connectorSlug: "slack" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        builtinAutomaticApi.start({
          headers: {},
          params: { connectorSlug: "automatic-mcp-oauth" },
          body: { authMethod: "smart-connect", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        customConnectorsApi.list({
          headers: {},
        }),
        [401],
      ),
      accept(
        customConnectorsApi.create({
          headers: {},
          body: {
            kind: "mcp",
            displayName: "Warmup MCP",
            endpoint: "https://warmup-mcp.example.test/mcp",
            transport: "streamable-http",
            authMode: "none",
            fields: [],
            headerInjections: [],
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
            kind: "mcp",
            displayName: "Warmup MCP",
            endpoint: "https://warmup-mcp.example.test/mcp",
            transport: "streamable-http",
            authMode: "none",
            fields: [],
            headerInjections: [],
            queryInjections: [],
          },
        }),
        [401],
      ),
      accept(
        customConnectorByIdApi.delete({
          headers: {},
          params: { id: missingId },
        }),
        [401],
      ),
      accept(
        customConnectorValuesApi.set({
          headers: {},
          params: { id: missingId },
          body: { values: [], account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        customConnectorOAuth2Api.start({
          headers: {},
          params: { id: missingId },
          body: { account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        customConnectorProposalApi.save({
          headers: {},
          body: {
            proposal: {
              operation: "create",
              displayName: "Warmup",
              prefixTemplates: ["https://warmup.example.test/"],
              fields: [],
              headerInjections: [],
              queryInjections: [],
            },
            values: [],
          },
        }),
        [401],
      ),
      accept(mcpConnectorsApi.list({ headers: {} }), [401]),
      accept(
        personalModelProvidersApi.upsert({
          headers: {},
          body: { type: "claude-code-oauth-token", secret: "warmup" },
        }),
        [401],
      ),
      accept(
        userModelPreferenceApi.update({
          headers: {},
          body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
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
        runnerSyncApi.sync({
          headers: {},
          params: { runId: missingId },
          body: { targets: [SLACK_TARGET] },
        }),
        [401],
      ),
      accept(
        runsByIdApi.getById({ headers: {}, params: { id: missingId } }),
        [401],
      ),
      accept(runsQueueApi.getQueue({ headers: {} }), [401]),
      accept(
        runsCancelApi.cancel({ headers: {}, params: { id: missingId } }),
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
      accept(clerkWebhookApi.post({ body: "{}", extraHeaders: {} }), [401]),
      accept(
        stripeWebhookApi.post({
          body: "{}",
          extraHeaders: {},
        }),
        [401],
      ),
    ]);
  });

  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", previousClerkSecret);
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", previousStripeSecret);
  if (!warmupResult.ok) {
    throw warmupResult.error;
  }
});

interface TrackedRun {
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

interface StartedRun {
  readonly runId: string;
  readonly threadId: string;
  readonly execution: RunnerExecutionInput;
  readonly tracked: TrackedRun;
}

function prepareRunEnvironment(
  options: {
    readonly nativeClaude?: boolean;
    readonly proSubscription?: boolean;
  } = {},
) {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected a workspace actor with an organization");
  }
  const orgId = actor.orgId;
  chatCallbacks.acceptChatObjectStorage();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  chatCallbacks.disableVapid();
  acceptAblyBatchPublish();
  mockOptionalEnv("OPENROUTER_API_KEY", undefined);
  if (options.nativeClaude || options.proSubscription) {
    mockClaudeCodeTokenEndpoint();
  }

  const trackedRuns: TrackedRun[] = [];
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const kmsKey = env("SECRETS_KMS_KEY_ID");

  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 1,
  };
  const runnerHostname = `runner-${runnerIdentity.runnerId}.okou.app`;

  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: orgId, created_by: actor.userId, created_at: now() },
  });

  const runnerGroupPromise = runs.configureRunnerGroup({
    runnerIdentity,
    hostname: runnerHostname,
  });
  const orgCreatedPromise = accept(
    clerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
    [200],
  );
  let resolvedRunnerGroup: string | undefined;
  let heartbeatSequence = 1;
  let extraReadyPromise: Promise<void> | undefined;

  onTestFinished(async () => {
    const previousRunnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
    if (resolvedRunnerGroup !== undefined) {
      mockOptionalEnv("RUNNER_DEFAULT_GROUP", resolvedRunnerGroup);
    }
    context.mocks.ably.publish.mockResolvedValue(undefined);
    acceptAblyBatchPublish();
    const result = await settleIncludingAbort(async () => {
      await flushWaitUntilForTest();
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.done;
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
            if (
              !["completed", "failed", "timeout"].includes(current.body.status)
            ) {
              await accept(
                agentCompleteApi.complete({
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
    if (
      !extraReadyPromise &&
      (options.nativeClaude || options.proSubscription)
    ) {
      extraReadyPromise = (async () => {
        const tasks: Promise<unknown>[] = [];
        if (options.proSubscription) {
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
        if (options.nativeClaude || options.proSubscription) {
          tasks.push(
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
          );
        }
        await Promise.all(tasks);
      })();
    }
    if (extraReadyPromise) {
      await extraReadyPromise;
    }
    return runnerGroup;
  }

  async function startRun(
    args: {
      readonly prompt?: string;
      readonly model?: string | null;
      readonly threadId?: string;
    } = {},
  ): Promise<StartedRun> {
    const runnerGroup = await awaitBootstrap();
    const prompt = args.prompt ?? "Run custom connector verification";
    const model =
      args.model !== undefined
        ? args.model
        : options.nativeClaude
          ? CLAUDE_MODEL
          : null;
    const sent = await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          prompt,
          model,
          ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
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
    const execution = await runs.nextReceivedExecution(runnerGroup);
    const tracked: TrackedRun = {
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      done: false,
    };
    trackedRuns.push(tracked);
    return {
      runId: execution.runId,
      threadId: sent.body.threadId,
      execution,
      tracked,
    };
  }

  async function cancelRun(started: StartedRun, acknowledge = false) {
    await accept(
      runsCancelApi.cancel({
        headers: signIn(actor),
        params: { id: started.runId },
      }),
      [200],
    );
    if (acknowledge) {
      await accept(
        agentCompleteApi.complete({
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
  }

  async function completeRunOk(started: StartedRun, sessionId: string) {
    await accept(
      agentCompleteApi.complete({
        headers: bearerHeaders(started.execution.sandboxToken),
        body: {
          runId: started.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: sessionId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    started.tracked.done = true;
  }

  async function failRun(started: StartedRun, errorMessage: string) {
    await accept(
      agentCompleteApi.complete({
        headers: bearerHeaders(started.execution.sandboxToken),
        body: {
          runId: started.runId,
          exitCode: 1,
          error: errorMessage,
        },
      }),
      [200],
    );
    started.tracked.done = true;
  }

  async function connectBuiltinOAuth(
    connectorSlug: "slack" | "cloudflare",
  ): Promise<string> {
    if (connectorSlug === "slack") {
      mockSlackConnectorOAuth();
    } else {
      mockCloudflareConnectorOAuth();
    }
    const started = await accept(
      builtinOauthStartApi.start({
        headers: signIn(actor),
        params: { connectorSlug },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [200],
    );
    const state = stateOf(started.body.authorizationUrl);
    const completed = await accept(
      builtinOauthCallbackApi.callback({
        headers: {},
        params: { connectorSlug },
        query: {
          code: `code-${randomUUID()}`,
          state,
          responseMode: "json",
        },
      }),
      [200],
    );
    if (completed.body.status !== "success") {
      throw new Error(`Expected ${connectorSlug} OAuth callback to succeed`);
    }
    if (!started.body.connectionId) {
      const listed = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "builtin", connectorSlug },
        }),
        [200],
      );
      const id = listed.body.connections[0]?.id;
      if (!id) {
        throw new Error(`Expected connected ${connectorSlug} account`);
      }
      return id;
    }
    return started.body.connectionId;
  }

  async function connectCustomOAuth(
    connectorId: string,
    account:
      | { readonly intent: "add" }
      | { readonly intent: "reconnect"; readonly connectionId: string } = {
      intent: "add",
    },
  ): Promise<string> {
    const started = await accept(
      customConnectorOAuth2Api.start({
        headers: signIn(actor),
        params: { id: connectorId },
        body: { account },
      }),
      [200],
    );
    if (started.body.result !== "authorization") {
      throw new Error("Expected custom OAuth authorization redirect");
    }
    const state = stateOf(started.body.authorizationUrl);
    const completed = await accept(
      customConnectorOAuth2Api.callback({
        query: {
          state,
          code: `custom-oauth-code-${randomUUID()}`,
          responseMode: "json",
        },
      }),
      [200],
    );
    if (completed.body.status !== "success") {
      throw new Error("Expected custom OAuth callback to succeed");
    }
    const listed = await accept(
      connectorAccountsApi.connections({
        headers: signIn(actor),
        query: { kind: "custom", customConnectorId: connectorId },
      }),
      [200],
    );
    const id =
      account.intent === "reconnect"
        ? account.connectionId
        : listed.body.connections[0]?.id;
    if (!id) {
      throw new Error("Expected connected custom OAuth account");
    }
    return id;
  }

  async function refreshRunnerHeartbeat(): Promise<void> {
    const runnerGroup = await awaitBootstrap();
    heartbeatSequence += 1;
    await accept(
      runnerHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: {
          runnerId: runnerIdentity.runnerId,
          runnerHostname,
          group: runnerGroup,
          snapshotGeneration: runnerIdentity.heartbeatGeneration,
          snapshotSequence: heartbeatSequence,
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
      [200],
    );
  }

  return {
    actor,
    orgId,
    awaitBootstrap,
    refreshRunnerHeartbeat,
    startRun,
    cancelRun,
    completeRunOk,
    failRun,
    connectBuiltinOAuth,
    connectCustomOAuth,
  };
}

describe("RUN-02: custom connectors, grants, and network policies", () => {
  it(
    "run-lifecycle-custom-connectors.bdd-006 admits MCP connectors with exact synchronized runtime state",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      const mcpHost = `mcp-runtime-${randomUUID()}.example.test`;
      const initialEndpoint = `https://${mcpHost}/v1/mcp?token=query-secret&env=prod`;
      const movedEndpoint = `https://${mcpHost}/v2/mcp?env=staging`;
      const skillText = "# Runtime MCP Skill\nUse tools safely.";
      const mcpToken = "mcp-runtime-token";

      await envSetup.awaitBootstrap();

      const [mcpCreated, httpCreated] = await Promise.all([
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "mcp",
              displayName: "Unique Runtime MCP Display",
              endpoint: initialEndpoint,
              transport: "streamable-http",
              authMode: "manual",
              fields: [
                {
                  key: "token",
                  label: "MCP Token",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.token}}",
                },
              ],
              queryInjections: [],
              skillMarkdown: skillText,
            },
          }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "http",
              displayName: "Sibling HTTP Connector",
              prefixTemplates: [
                `https://sibling-http-${randomUUID()}.example.test/api/`,
              ],
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

      const [mcpConn, httpConn] = await Promise.all([
        accept(
          customConnectorValuesApi.set({
            headers: signIn(actor),
            params: { id: mcpCreated.body.id },
            body: {
              values: [{ key: "token", kind: "secret", value: mcpToken }],
              account: { intent: "add", displayName: "Primary MCP" },
            },
          }),
          [200],
        ),
        accept(
          customConnectorValuesApi.set({
            headers: signIn(actor),
            params: { id: httpCreated.body.id },
            body: {
              values: [
                { key: "secret", kind: "secret", value: "http-only-secret" },
              ],
              account: { intent: "add", displayName: "Primary HTTP" },
            },
          }),
          [200],
        ),
      ]);

      const firstRun = await envSetup.startRun({
        prompt: "Inspect custom MCP runtime state",
      });
      const okouToken = okouTokenFromExecution(firstRun.execution);
      const mcpListed = await accept(
        mcpConnectorsApi.list({ headers: bearerHeaders(okouToken) }),
        [200],
      );

      expect(mcpListed.body.connectors).toContainEqual(
        expect.objectContaining({
          endpoint: initialEndpoint,
          connectionId: mcpConn.body.connectionId,
          target: { kind: "custom", customConnectorId: mcpCreated.body.id },
        }),
      );
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: mcpCreated.body.id,
          sourceId: mcpConn.body.connectionId,
        }),
      );
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: httpCreated.body.id,
          sourceId: httpConn.body.connectionId,
        }),
      );

      const mcpPromptSection = extractPromptSection(
        firstRun.execution.appendSystemPrompt ?? "",
        "# MCP Connectors",
      );
      expect(mcpPromptSection).toContain(`\`${mcpCreated.body.slug}\``);
      expect(mcpPromptSection).toContain("okou mcp list --json");
      expect(mcpPromptSection).toContain(
        "okou mcp list-tools <connector-slug> --json",
      );
      expect(mcpPromptSection).toContain(
        "okou mcp call <connector-slug> <tool-name>",
      );
      expect(mcpPromptSection).not.toContain(httpCreated.body.slug);
      expect(mcpPromptSection).not.toContain("Unique Runtime MCP Display");
      expect(mcpPromptSection).not.toContain(mcpHost);
      expect(mcpPromptSection).not.toContain("Runtime MCP Skill");
      expect(mcpPromptSection).not.toContain(mcpToken);

      const mcpFirewall = findInlineCustomFirewall(
        firstRun.execution.firewalls,
        mcpCreated.body.id,
      );
      const mcpApi = mcpFirewall.firewall.apis[0];
      if (!mcpApi) {
        throw new Error("Expected MCP firewall API");
      }
      expect(mcpApi.base).toBe(`https://${mcpHost}/v1/mcp`);
      expect(mcpApi.hostPolicy).toStrictEqual({ kind: "publicDestination" });
      expect(mcpApi.permissions ?? []).toStrictEqual([]);
      expect(mcpApi.auth.headers?.Authorization).toMatch(
        /^Bearer \$\{\{ secrets\..+ \}\}$/u,
      );
      expect(
        firstRun.execution.networkPolicies?.[mcpFirewall.firewall.name]
          ?.unknownPolicy,
      ).toBe("allow");

      const expectedSkillName = getCustomConnectorSkillName(
        mcpCreated.body.slug,
        mcpCreated.body.id,
      );
      expect(
        firstRun.execution.startupInputs.contentBundles.skills,
      ).toContainEqual(expect.objectContaining({ name: expectedSkillName }));

      const [authResolved, syncExact, syncNoSource, syncWrongSource] =
        await Promise.all([
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(firstRun.execution.firewallToken),
              body: {
                authHeaders: mcpApi.auth.headers ?? {},
                matchedFirewall: {
                  name: mcpFirewall.firewall.name,
                  apiId: mcpApi.id ?? "api-0",
                  base: mcpApi.base,
                  customConnectorId: mcpCreated.body.id,
                  sourceId: mcpConn.body.connectionId,
                  routingVariables: {},
                },
              },
            }),
            [200],
          ),
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: firstRun.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                    sourceId: mcpConn.body.connectionId,
                  },
                ],
              },
            }),
            [200],
          ),
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: firstRun.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                  },
                ],
              },
            }),
            [200],
          ),
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: firstRun.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                    sourceId: randomUUID(),
                  },
                ],
              },
            }),
            [200],
          ),
        ]);

      expect(authResolved.body.headers).toStrictEqual({
        Authorization: `Bearer ${mcpToken}`,
      });
      for (const synced of [syncExact, syncNoSource, syncWrongSource]) {
        expectCustomSyncAvailable(
          synced.body.results,
          mcpConn.body.connectionId,
        );
      }

      await accept(
        customConnectorByIdApi.update({
          headers: signIn(actor),
          params: { id: mcpCreated.body.id },
          body: {
            kind: "mcp",
            displayName: "Unique Runtime MCP Display",
            endpoint: movedEndpoint,
            transport: "streamable-http",
            authMode: "manual",
            fields: [
              {
                key: "token",
                label: "MCP Token",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.token}}",
              },
            ],
            queryInjections: [],
            skillMarkdown: skillText,
          },
        }),
        [200],
      );

      const [syncMoved, syncUnexpectedVars] = await Promise.all([
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: firstRun.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: mcpCreated.body.id,
                  baseUrlVars: {},
                  sourceId: mcpConn.body.connectionId,
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: firstRun.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: mcpCreated.body.id,
                  baseUrlVars: { unexpected: "ignored-var" },
                  sourceId: mcpConn.body.connectionId,
                },
              ],
            },
          }),
          [200],
        ),
      ]);

      for (const synced of [syncMoved, syncUnexpectedVars]) {
        expectCustomSyncAvailable(
          synced.body.results,
          mcpConn.body.connectionId,
          `https://${mcpHost}/v2/mcp`,
        );
      }

      await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor),
          params: { connectionId: mcpConn.body.connectionId },
          body: {
            target: { kind: "custom", customConnectorId: mcpCreated.body.id },
          },
        }),
        [200],
      );

      const [syncAfterDisconnect, authAfterDisconnect, secondRun] =
        await Promise.all([
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: firstRun.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                    sourceId: mcpConn.body.connectionId,
                  },
                ],
              },
            }),
            [200],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(firstRun.execution.firewallToken),
              body: {
                authHeaders: mcpApi.auth.headers ?? {},
                matchedFirewall: {
                  name: mcpFirewall.firewall.name,
                  apiId: mcpApi.id ?? "api-0",
                  base: mcpApi.base,
                  customConnectorId: mcpCreated.body.id,
                  sourceId: mcpConn.body.connectionId,
                  routingVariables: {},
                },
              },
            }),
            [424],
          ),
          envSetup.startRun({ prompt: "Verify disconnected MCP is omitted" }),
        ]);

      expect(syncAfterDisconnect.body.results[0]).toMatchObject({
        state: "absent",
        reason: "connector-unavailable",
      });
      expect(authAfterDisconnect.body.error.code).toBe(
        "CONNECTOR_NOT_CONFIGURED",
      );
      expect(
        secondRun.execution.connectorRuntimeTargets.some((target) => {
          return (
            target.kind === "custom" &&
            target.customConnectorId === mcpCreated.body.id
          );
        }),
      ).toBeFalsy();

      await accept(
        customConnectorByIdApi.delete({
          headers: signIn(actor),
          params: { id: mcpCreated.body.id },
        }),
        [204],
      );
      const syncAfterDelete = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: firstRun.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: mcpCreated.body.id,
                baseUrlVars: {},
                sourceId: mcpConn.body.connectionId,
              },
            ],
          },
        }),
        [200],
      );
      expect(syncAfterDelete.body.results[0]).toMatchObject({
        state: "absent",
        reason: "connector-unavailable",
      });
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-001 runs connected no-auth HTTP and MCP custom connectors without credentials",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      const suffix = randomUUID();
      const mcpNoAuthEndpoint = `https://mcp-noauth-${suffix}.example.test/mcp`;
      const autoEndpoint = `https://mcp-auto-noauth-${suffix}.example.test/mcp`;
      mockAutomaticMcpOAuthProvider(context, {
        registration: "none",
        authentication: "none",
        endpoint: autoEndpoint,
      });

      await envSetup.awaitBootstrap();

      const [httpCreated, mcpCreated, autoCreated] = await Promise.all([
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "http",
              displayName: "No-Auth HTTP",
              prefixTemplates: [
                `https://{{variables.region}}.public-${suffix}.example.test/api/`,
                `http://{{variables.region}}.public-${suffix}.example.test/api/`,
              ],
              authMode: "none",
              fields: [
                {
                  key: "region",
                  label: "Region",
                  kind: "variable",
                  required: true,
                },
              ],
              headerInjections: [],
              queryInjections: [],
            },
          }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "mcp",
              displayName: "No-Auth MCP",
              endpoint: mcpNoAuthEndpoint,
              transport: "streamable-http",
              authMode: "none",
              fields: [],
              headerInjections: [],
              queryInjections: [],
            },
          }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "mcp",
              displayName: "Auto No-Auth MCP",
              endpoint: autoEndpoint,
              transport: "streamable-http",
              authMode: "automatic",
              fields: [],
              headerInjections: [],
              queryInjections: [],
            },
          }),
          [201],
        ),
      ]);

      const [httpConn, mcpConn, autoConn] = await Promise.all([
        accept(
          customConnectorValuesApi.set({
            headers: signIn(actor),
            params: { id: httpCreated.body.id },
            body: {
              values: [{ key: "region", kind: "variable", value: "us-east" }],
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        accept(
          customConnectorValuesApi.set({
            headers: signIn(actor),
            params: { id: mcpCreated.body.id },
            body: {
              values: [],
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        accept(
          customConnectorOAuth2Api.start({
            headers: signIn(actor),
            params: { id: autoCreated.body.id },
            body: { account: { intent: "add" } },
          }),
          [200],
        ),
      ]);
      expect(autoConn.body.result).toBe("connected");
      if (autoConn.body.result !== "connected") {
        throw new Error("Expected immediate Automatic no-auth connection");
      }

      const started = await envSetup.startRun({
        prompt: "Inspect no-auth custom connectors",
      });
      const httpFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        httpCreated.body.id,
      );
      const mcpFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        mcpCreated.body.id,
      );
      const autoFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        autoCreated.body.id,
      );

      expect(
        httpFirewall.firewall.apis.map((api) => {
          return api.base;
        }),
      ).toStrictEqual([
        `https://us-east.public-${suffix}.example.test/api/`,
        `http://us-east.public-${suffix}.example.test/api/`,
      ]);
      expect(mcpFirewall.firewall.apis[0]?.base).toBe(mcpNoAuthEndpoint);
      expect(autoFirewall.firewall.apis[0]?.base).toBe(autoEndpoint);

      for (const fw of [httpFirewall, mcpFirewall, autoFirewall]) {
        for (const api of fw.firewall.apis) {
          expect(api.auth.headers).toStrictEqual({});
          expect(api.auth.query ?? {}).toStrictEqual({});
        }
      }

      expect(started.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: httpCreated.body.id,
        baseUrlVars: { region: "us-east" },
        sourceId: httpConn.body.connectionId,
      });
      expect(started.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: mcpCreated.body.id,
        baseUrlVars: {},
        sourceId: mcpConn.body.connectionId,
      });
      expect(started.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: autoCreated.body.id,
        baseUrlVars: {},
        sourceId: autoConn.body.connectionId,
      });

      const synced = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: started.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: httpCreated.body.id,
                baseUrlVars: { region: "us-east" },
                sourceId: httpConn.body.connectionId,
              },
              {
                kind: "custom",
                customConnectorId: mcpCreated.body.id,
                baseUrlVars: {},
                sourceId: mcpConn.body.connectionId,
              },
              {
                kind: "custom",
                customConnectorId: autoCreated.body.id,
                baseUrlVars: {},
                sourceId: autoConn.body.connectionId,
              },
            ],
          },
        }),
        [200],
      );

      expect(synced.body.results).toHaveLength(3);
      expect(
        synced.body.results.map((entry) => {
          return entry.target;
        }),
      ).toStrictEqual([
        { kind: "custom", customConnectorId: httpCreated.body.id },
        { kind: "custom", customConnectorId: mcpCreated.body.id },
        { kind: "custom", customConnectorId: autoCreated.body.id },
      ]);
      for (const entry of synced.body.results) {
        const customEntry = requireCustomAvailableSync(entry);
        expect(customEntry.state).toBe("available");
        for (const api of customEntry.firewall.firewall.apis) {
          expect(api.auth.headers ?? {}).toStrictEqual({});
          expect(api.auth.query ?? {}).toStrictEqual({});
        }
      }
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-003 admits overlapping custom and built-in connector targets",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const [figmaConn, customCreated] = await Promise.all([
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "figma" },
            body: {
              authMethod: "api-token",
              values: { accessToken: "figd_overlap_secret" },
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "http",
              displayName: "Custom Figma Overlap",
              prefixTemplates: ["https://api.figma.com/"],
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
                  name: "X-Custom-Figma",
                  valueTemplate: "{{secrets.secret}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
      ]);
      const customConn = await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            values: [
              { key: "secret", kind: "secret", value: "custom-figma-secret" },
            ],
            account: { intent: "add" },
          },
        }),
        [200],
      );

      const started = await envSetup.startRun({
        prompt: "Inspect overlapping Figma targets",
      });

      expect(started.execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "figma",
          sourceId: figmaConn.body.connectionId,
        }),
      );
      const customFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        customCreated.body.id,
      );
      expect(customFirewall.firewall.apis[0]?.base).toBe(
        "https://api.figma.com/",
      );
      expect(started.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          connectorSlug: "figma",
          sourceId: figmaConn.body.connectionId,
        }),
      );
      expect(started.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: customCreated.body.id,
          sourceId: customConn.body.connectionId,
        }),
      );
      expect(started.execution.networkPolicies?.figma).toBeDefined();
      expect(
        started.execution.networkPolicies?.[customFirewall.firewall.name]
          ?.unknownPolicy,
      ).toBe("allow");

      await envSetup.cancelRun(started);
      const afterCancel = await accept(
        runsByIdApi.getById({
          headers: signIn(actor),
          params: { id: started.runId },
        }),
        [200],
      );
      expect(afterCancel.body.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-005 injects enabled custom connector firewalls with resolvable org secrets",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const envSetup = prepareRunEnvironment({ nativeClaude: true });
      const { actor } = envSetup;
      const runnerGroup = await envSetup.awaitBootstrap();

      await accept(
        userModelPreferenceApi.update({
          headers: signIn(actor),
          body: { selectedModel: CLAUDE_MODEL, serviceTier: null },
        }),
        [200],
      );

      const [customCreated] = await Promise.all([
        accept(
          customConnectorsApi.create({
            headers: signIn(actor),
            body: {
              kind: "http",
              displayName: "Org Secret Custom HTTP",
              prefixTemplates: [
                "http://{{variables.tenant}}.internal.example.com:8080/api/",
              ],
              authMode: "manual",
              fields: [
                {
                  key: "secret",
                  label: "Secret",
                  kind: "secret",
                  required: true,
                },
                {
                  key: "tenant",
                  label: "Tenant",
                  kind: "variable",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.secret}}",
                },
              ],
              queryInjections: [
                {
                  name: "api_key",
                  valueTemplate: "{{secrets.secret}}",
                },
              ],
            },
          }),
          [201],
        ),
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "figma" },
            body: {
              authMethod: "api-token",
              values: { accessToken: "figd_sibling_secret" },
              account: { intent: "add" },
            },
          }),
          [200],
        ),
      ]);

      const customConn = await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            values: [
              { key: "secret", kind: "secret", value: "custom-secret-value" },
              { key: "tenant", kind: "variable", value: "acme" },
            ],
            account: { intent: "add" },
          },
        }),
        [200],
      );
      expect(kms.generateDataKeyCalls).toBeGreaterThan(0);

      const started = await envSetup.startRun({
        prompt: "Resolve org-encrypted custom secrets",
        model: CLAUDE_MODEL,
      });
      const customFirewall = findInlineCustomFirewall(
        started.execution.firewalls,
        customCreated.body.id,
      );
      const customApi = customFirewall.firewall.apis[0];
      if (!customApi) {
        throw new Error("Expected custom firewall API entry");
      }
      const customAuthHeaders = customApi.auth.headers ?? {};
      const customApiId = customApi.id ?? "api-0";
      const customAuthBody = {
        authHeaders: customAuthHeaders,
        authQuery: customApi.auth.query,
        matchedFirewall: {
          name: customFirewall.firewall.name,
          apiId: customApiId,
          base: customApi.base,
          customConnectorId: customCreated.body.id,
          sourceId: customConn.body.connectionId,
          routingVariables: { tenant: "acme" },
        },
      };
      expect(
        started.execution.networkPolicies?.[customFirewall.firewall.name]
          ?.unknownPolicy,
      ).toBe("allow");
      expect(JSON.stringify(started.execution)).not.toContain(
        "custom-secret-value",
      );
      expect(started.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: customCreated.body.id,
        baseUrlVars: { tenant: "acme" },
        sourceId: customFirewall.sourceId,
      });

      const [
        syncedExact,
        syncedMissingSource,
        syncedWrongSource,
        authOk,
        authMissingSource,
        authWrongSource,
        authUnknownAlias,
      ] = await Promise.all([
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: started.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: customCreated.body.id,
                  baseUrlVars: { tenant: "acme" },
                  sourceId: customConn.body.connectionId,
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: started.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: customCreated.body.id,
                  baseUrlVars: { tenant: "acme" },
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: started.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: customCreated.body.id,
                  baseUrlVars: { tenant: "acme" },
                  sourceId: randomUUID(),
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(started.execution.firewallToken),
            body: customAuthBody,
          }),
          [200],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: customAuthHeaders,
              authQuery: customApi.auth.query,
              matchedFirewall: {
                name: customFirewall.firewall.name,
                apiId: customApiId,
                base: customApi.base,
                customConnectorId: customCreated.body.id,
                routingVariables: { tenant: "acme" },
              },
            },
          }),
          [424],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: customAuthHeaders,
              authQuery: customApi.auth.query,
              matchedFirewall: {
                name: customFirewall.firewall.name,
                apiId: customApiId,
                base: customApi.base,
                customConnectorId: customCreated.body.id,
                sourceId: randomUUID(),
                routingVariables: { tenant: "acme" },
              },
            },
          }),
          [424],
        ),
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(started.execution.firewallToken),
            body: {
              authHeaders: {
                Authorization: `Bearer ${secretTemplate("NON_EXISTENT_ALIAS")}`,
              },
              matchedFirewall: {
                name: customFirewall.firewall.name,
                apiId: customApiId,
                base: customApi.base,
                customConnectorId: customCreated.body.id,
                sourceId: customConn.body.connectionId,
                routingVariables: { tenant: "acme" },
              },
            },
          }),
          [424],
        ),
      ]);

      for (const synced of [
        syncedExact,
        syncedMissingSource,
        syncedWrongSource,
      ]) {
        const entry = requireCustomAvailableSync(synced.body.results[0]);
        expect(entry.baseUrlVars).toStrictEqual({ tenant: "acme" });
        expect(entry.firewall.firewall.apis[0]?.base).toBe(
          "http://acme.internal.example.com:8080/api/",
        );
        expect(entry.firewall.sourceId).toBe(customConn.body.connectionId);
      }
      expect(authOk.body.headers).toStrictEqual({
        Authorization: "Bearer custom-secret-value",
      });
      expect(authOk.body.query).toStrictEqual({
        api_key: "custom-secret-value",
      });
      expect(authMissingSource.body.error.code).toBe(
        "CONNECTOR_NOT_CONFIGURED",
      );
      expect(authWrongSource.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");
      expect(authUnknownAlias.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

      // Rotate and restore secret: resolves immediately.
      await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            values: [
              { key: "secret", kind: "secret", value: "rotated-secret-value" },
              { key: "tenant", kind: "variable", value: "acme" },
            ],
            account: {
              intent: "reconnect",
              connectionId: customConn.body.connectionId,
            },
          },
        }),
        [200],
      );
      const authRotated = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: customAuthBody,
        }),
        [200],
      );
      expect(authRotated.body.headers).toStrictEqual({
        Authorization: "Bearer rotated-secret-value",
      });

      await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            values: [
              { key: "secret", kind: "secret", value: "custom-secret-value" },
              { key: "tenant", kind: "variable", value: "acme" },
            ],
            account: {
              intent: "reconnect",
              connectionId: customConn.body.connectionId,
            },
          },
        }),
        [200],
      );
      const authRestored = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: customAuthBody,
        }),
        [200],
      );
      expect(authRestored.body.headers).toStrictEqual({
        Authorization: "Bearer custom-secret-value",
      });

      // Update prefix & header while runtime wake-up notification fails.
      context.mocks.ably.batchPublish.mockClear();
      context.mocks.ably.batchPublish.mockRejectedValueOnce(
        new Error("Ably wakeup publish failed"),
      );
      await accept(
        customConnectorByIdApi.update({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            kind: "http",
            displayName: "Org Secret Custom HTTP",
            prefixTemplates: [
              "http://{{variables.tenant}}.internal.example.com:8080/v2/",
            ],
            authMode: "manual",
            fields: [
              {
                key: "secret",
                label: "Secret",
                kind: "secret",
                required: true,
              },
              {
                key: "tenant",
                label: "Tenant",
                kind: "variable",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "X-Updated-Auth",
                valueTemplate: "Token {{secrets.secret}}",
              },
            ],
            queryInjections: [
              {
                name: "api_key",
                valueTemplate: "{{secrets.secret}}",
              },
            ],
          },
        }),
        [200],
      );

      expect(context.mocks.ably.batchPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          channels: [`runner-group:${runnerGroup}`],
          messages: expect.arrayContaining([
            expect.objectContaining({ name: "connector-runtime-sync" }),
          ]),
        }),
      );
      const authAfterFailedWakeup = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: customAuthBody,
        }),
        [200],
      );
      expect(authAfterFailedWakeup.body.headers).toStrictEqual({
        Authorization: "Bearer custom-secret-value",
      });

      // Replace auth fields (removing `secret`) -> 424 CONNECTOR_NOT_CONFIGURED.
      await accept(
        customConnectorByIdApi.update({
          headers: signIn(actor),
          params: { id: customCreated.body.id },
          body: {
            kind: "http",
            displayName: "Org Secret Custom HTTP",
            prefixTemplates: [
              "http://{{variables.tenant}}.internal.example.com:8080/v2/",
            ],
            authMode: "manual",
            fields: [
              {
                key: "replacement_token",
                label: "Replacement Token",
                kind: "secret",
                required: true,
              },
              {
                key: "tenant",
                label: "Tenant",
                kind: "variable",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.replacement_token}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [200],
      );
      const authRemovedField = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: customAuthBody,
        }),
        [424],
      );
      expect(authRemovedField.body.error.code).toBe("CONNECTOR_NOT_CONFIGURED");

      // Delete connection -> sync reports absent (connector-unavailable).
      await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor),
          params: { connectionId: customConn.body.connectionId },
          body: {
            target: {
              kind: "custom",
              customConnectorId: customCreated.body.id,
            },
          },
        }),
        [200],
      );
      const syncAfterDelete = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: started.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: customCreated.body.id,
                baseUrlVars: { tenant: "acme" },
                sourceId: customConn.body.connectionId,
              },
            ],
          },
        }),
        [200],
      );
      expect(syncAfterDelete.body.results[0]).toMatchObject({
        state: "absent",
        reason: "connector-unavailable",
      });
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-007 rejects a deleted custom credential and synchronizes its replacement",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const mcpCreated = await accept(
        customConnectorsApi.create({
          headers: signIn(actor),
          body: {
            kind: "mcp",
            displayName: "Replaceable MCP",
            endpoint: `https://replace-mcp-${randomUUID()}.example.test/mcp`,
            transport: "streamable-http",
            authMode: "manual",
            fields: [
              { key: "token", label: "Token", kind: "secret", required: true },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.token}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [201],
      );
      const firstConn = await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: mcpCreated.body.id },
          body: {
            values: [{ key: "token", kind: "secret", value: "first-secret" }],
            account: { intent: "add" },
          },
        }),
        [200],
      );

      const started = await envSetup.startRun({
        prompt: "Verify deleted credential rejection and replacement sync",
      });
      const initialSync = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: started.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: mcpCreated.body.id,
                baseUrlVars: {},
                sourceId: firstConn.body.connectionId,
              },
            ],
          },
        }),
        [200],
      );
      const initialEntry = requireCustomAvailableSync(
        initialSync.body.results[0],
      );
      const initialApi = initialEntry.firewall.firewall.apis[0];
      if (!initialApi) {
        throw new Error("Expected synced firewall API");
      }
      const originalAuthBody = {
        authHeaders: initialApi.auth.headers ?? {},
        matchedFirewall: {
          name: initialEntry.firewall.firewall.name,
          apiId: initialApi.id,
          base: initialApi.base,
          customConnectorId: mcpCreated.body.id,
          sourceId: firstConn.body.connectionId,
          routingVariables: {},
        },
      };

      await accept(
        connectorAccountsApi.delete({
          headers: signIn(actor),
          params: { connectionId: firstConn.body.connectionId },
          body: {
            target: { kind: "custom", customConnectorId: mcpCreated.body.id },
          },
        }),
        [200],
      );
      const replacementConn = await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: mcpCreated.body.id },
          body: {
            values: [
              { key: "token", kind: "secret", value: "replacement-secret" },
            ],
            account: { intent: "add" },
          },
        }),
        [200],
      );
      expect(replacementConn.body.connectionId).not.toBe(
        firstConn.body.connectionId,
      );

      const [syncOriginal, replayOriginalAuth, syncReplacement] =
        await Promise.all([
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: started.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                    sourceId: firstConn.body.connectionId,
                  },
                ],
              },
            }),
            [200],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(started.execution.firewallToken),
              body: originalAuthBody,
            }),
            [424],
          ),
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: started.runId },
              body: {
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: mcpCreated.body.id,
                    baseUrlVars: {},
                    sourceId: replacementConn.body.connectionId,
                  },
                ],
              },
            }),
            [200],
          ),
        ]);

      const origSynced = requireCustomAvailableSync(
        syncOriginal.body.results[0],
      );
      expect(origSynced.firewall.sourceId).toBe(
        replacementConn.body.connectionId,
      );
      expect(replayOriginalAuth.body.error.code).toBe(
        "CONNECTOR_NOT_CONFIGURED",
      );
      const replSynced = requireCustomAvailableSync(
        syncReplacement.body.results[0],
      );
      expect(replSynced.firewall.sourceId).toBe(
        replacementConn.body.connectionId,
      );
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-008 bounds authorized MCP awareness for an initial Claude run",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment({ nativeClaude: true });
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const totalConnected = MCP_PROMPT_INVENTORY_LIMIT + 1;
      const connectedIndices = Array.from(
        { length: totalConnected },
        (_, idx) => {
          return String(idx + 1).padStart(2, "0");
        },
      );
      const headers = signIn(actor);

      const allCreated = await Promise.all([
        ...connectedIndices.map((label, idx) => {
          const isManual = idx === 0;
          return accept(
            customConnectorsApi.create({
              headers,
              body: {
                kind: "mcp",
                slug: `_bound-mcp-${label}`,
                displayName: `BoundedDisplayName-${label}`,
                endpoint: `https://bound-mcp-${label}.example.test/mcp`,
                transport: "streamable-http",
                authMode: isManual ? "manual" : "none",
                fields: isManual
                  ? [
                      {
                        key: "token",
                        label: "Token",
                        kind: "secret",
                        required: true,
                      },
                    ]
                  : [],
                headerInjections: isManual
                  ? [
                      {
                        name: "Authorization",
                        valueTemplate: "Bearer {{secrets.token}}",
                      },
                    ]
                  : [],
                queryInjections: [],
              },
            }),
            [201],
          );
        }),
        accept(
          customConnectorsApi.create({
            headers,
            body: {
              kind: "mcp",
              slug: "_bound-unconnected-mcp",
              displayName: "UnconnectedDisplayName",
              endpoint: "https://bound-unconnected.example.test/mcp",
              transport: "streamable-http",
              authMode: "manual",
              fields: [
                {
                  key: "token",
                  label: "Token",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.token}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
        accept(
          customConnectorsApi.create({
            headers,
            body: {
              kind: "mcp",
              slug: "_bound-disabled-mcp",
              displayName: "DisabledDisplayName",
              endpoint: "https://bound-disabled.example.test/mcp",
              transport: "streamable-http",
              authMode: "manual",
              fields: [
                {
                  key: "token",
                  label: "Token",
                  kind: "secret",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.token}}",
                },
              ],
              queryInjections: [],
            },
          }),
          [201],
        ),
      ]);
      const createdConnected = allCreated.slice(0, totalConnected);
      const unconnectedCreated = allCreated[totalConnected];
      const disabledCreated = allCreated[totalConnected + 1];
      if (!unconnectedCreated || !disabledCreated) {
        throw new Error("Expected unconnected and disabled MCP connectors");
      }

      const [disabledConn] = await Promise.all([
        accept(
          customConnectorValuesApi.set({
            headers,
            params: { id: disabledCreated.body.id },
            body: {
              values: [
                {
                  key: "token",
                  kind: "secret",
                  value: "bound-disabled-secret-val",
                },
              ],
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        ...createdConnected.map((created, idx) => {
          return accept(
            customConnectorValuesApi.set({
              headers,
              params: { id: created.body.id },
              body: {
                values:
                  idx === 0
                    ? [
                        {
                          key: "token",
                          kind: "secret",
                          value: `bound-secret-val-${idx}`,
                        },
                      ]
                    : [],
                account: { intent: "add" },
              },
            }),
            [200],
          );
        }),
      ]);

      await accept(
        accessApi.updateAccountDefault({
          headers,
          params: { connectionId: disabledConn.body.connectionId },
          body: {
            target: {
              kind: "custom",
              customConnectorId: disabledCreated.body.id,
            },
            enabled: false,
          },
        }),
        [200],
      );

      const started = await envSetup.startRun({
        prompt: "Check bounded MCP prompt inventory",
        model: CLAUDE_MODEL,
      });

      expect(started.execution.cliAgentType).toBe("claude-code");
      const prompt = started.execution.appendSystemPrompt ?? "";
      expect(prompt).toContain("# Agent Tools");
      const mcpSection = extractPromptSection(prompt, "# MCP Connectors");

      const sortedSlugs = createdConnected
        .map((entry) => {
          return entry.body.slug;
        })
        .sort();
      const includedSlugs = sortedSlugs.slice(0, MCP_PROMPT_INVENTORY_LIMIT);
      const omittedSlug = sortedSlugs[MCP_PROMPT_INVENTORY_LIMIT];
      if (!omittedSlug) {
        throw new Error("Expected one omitted MCP slug");
      }

      const listedLines = mcpSection.split("\n").filter((line) => {
        return line.startsWith("- `");
      });
      expect(listedLines).toStrictEqual(
        includedSlugs.map((slug) => {
          return `- \`${slug}\``;
        }),
      );
      expect(mcpSection).toContain(
        "- 1 additional authorized MCP connector was omitted from this prompt",
      );
      expect(mcpSection).not.toContain(omittedSlug);
      expect(mcpSection).not.toContain(unconnectedCreated.body.slug);
      expect(mcpSection).not.toContain(disabledCreated.body.slug);
      expect(mcpSection).not.toContain("BoundedDisplayName-");
      expect(mcpSection).not.toContain("example.test");
      expect(mcpSection).not.toContain("bound-secret-val-");
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-012 fails expired custom OAuth without a refresh token at matched auth",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = now();
      mockNow(startTime);
      const provider = mockCustomConnectorOAuth2Provider(context, {
        initialExpiresIn: 30,
        initialRefreshToken: null,
      });
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const created = await accept(
        customConnectorsApi.create({
          headers: signIn(actor),
          body: {
            kind: "http",
            displayName: "Short-Lived OAuth",
            prefixTemplates: [
              `https://short-oauth-${randomUUID()}.example.test/api/`,
            ],
            authMode: "oauth",
            fields: [],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{oauth.access_token}}",
              },
            ],
            queryInjections: [],
            oauthConfig: {
              providerAdapter: "standard",
              clientId: "short-oauth-client",
              clientSecret: "short-oauth-secret",
              authorizationUrl: provider.authorizationUrl,
              tokenUrl: provider.tokenUrl,
              tokenEndpointAuthMethod: "client_secret_post",
              pkceMethod: "S256",
              scopes: ["read"],
              authorizationParams: {},
            },
          },
        }),
        [201],
      );
      const connectionId = await envSetup.connectCustomOAuth(created.body.id);

      const initialAccounts = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "custom", customConnectorId: created.body.id },
        }),
        [200],
      );
      expect(initialAccounts.body.connections[0]?.connectionStatus).toBe(
        "connected",
      );

      const firstRun = await envSetup.startRun({
        prompt: "Run with valid short-lived custom OAuth token",
      });
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: created.body.id,
          sourceId: connectionId,
        }),
      );
      expect(provider.tokenBodies).toHaveLength(1);
      await envSetup.cancelRun(firstRun, true);

      mockNow(startTime + 31_000);
      const expiredAccounts = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "custom", customConnectorId: created.body.id },
        }),
        [200],
      );
      expect(expiredAccounts.body.connections[0]).toMatchObject({
        connectionStatus: "reconnect-required",
        reconnectReason: "credential_expired",
      });

      const secondRun = await envSetup.startRun({
        prompt: "Run after short-lived custom OAuth token expiry",
      });
      expect(secondRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: created.body.id,
          sourceId: connectionId,
        }),
      );
      const firewall = findInlineCustomFirewall(
        secondRun.execution.firewalls,
        created.body.id,
      );
      const api = firewall.firewall.apis[0];
      if (!api) {
        throw new Error("Expected custom OAuth firewall API");
      }

      const authRes = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(secondRun.execution.firewallToken),
          body: {
            authHeaders: api.auth.headers ?? {},
            matchedFirewall: {
              name: firewall.firewall.name,
              apiId: api.id ?? "api-0",
              base: api.base,
              customConnectorId: created.body.id,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
        }),
        [502],
      );
      expect(authRes.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      expect(authRes.body.error.connectors).toContain(created.body.id);
      expect(provider.tokenBodies).toHaveLength(1);
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-014 retries custom OAuth quietly across runs and supports reconnect",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = now();
      mockNow(startTime);
      let refreshShouldSucceed = false;
      const seenRefreshTokens: string[] = [];
      const provider = mockCustomConnectorOAuth2Provider(context, {
        initialExpiresIn: 3600,
        initialRefreshToken: "initial-revoked-refresh-token",
        refreshResponse: () => {
          const latest = provider.tokenBodies[provider.tokenBodies.length - 1];
          const refreshToken = latest?.get("refresh_token") ?? "";
          seenRefreshTokens.push(refreshToken);
          if (!refreshShouldSucceed) {
            return HttpResponse.json(
              { error: "invalid_grant" },
              { status: 400 },
            );
          }
          return HttpResponse.json({
            access_token: "reconnected-refreshed-access-token",
            refresh_token: "reconnected-rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      });
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const created = await accept(
        customConnectorsApi.create({
          headers: signIn(actor),
          body: {
            kind: "http",
            displayName: "Quiet Retry OAuth",
            prefixTemplates: [
              `https://quiet-oauth-${randomUUID()}.example.test/api/`,
            ],
            authMode: "oauth",
            fields: [],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{oauth.access_token}}",
              },
            ],
            queryInjections: [],
            oauthConfig: {
              providerAdapter: "standard",
              clientId: "quiet-oauth-client",
              clientSecret: "quiet-oauth-secret",
              authorizationUrl: provider.authorizationUrl,
              tokenUrl: provider.tokenUrl,
              tokenEndpointAuthMethod: "client_secret_post",
              pkceMethod: "S256",
              scopes: ["read"],
              authorizationParams: {},
            },
          },
        }),
        [201],
      );
      const connectionId = await envSetup.connectCustomOAuth(created.body.id);

      const firstRun = await envSetup.startRun({
        prompt: "First run before OAuth expiry",
      });
      const firstFirewall = findInlineCustomFirewall(
        firstRun.execution.firewalls,
        created.body.id,
      );
      const firstApi = firstFirewall.firewall.apis[0];
      if (!firstApi) {
        throw new Error("Expected first custom OAuth firewall API");
      }

      mockNow(startTime + 2 * ONE_HOUR_MS);
      await envSetup.refreshRunnerHeartbeat();
      const firstAuthFail = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(firstRun.execution.firewallToken),
          body: {
            authHeaders: firstApi.auth.headers ?? {},
            matchedFirewall: {
              name: firstFirewall.firewall.name,
              apiId: firstApi.id ?? "api-0",
              base: firstApi.base,
              customConnectorId: created.body.id,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
        }),
        [502],
      );
      expect(firstAuthFail.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });

      const [resynced, accountsAfterFirst] = await Promise.all([
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: firstRun.runId },
            body: {
              targets: [
                {
                  kind: "custom",
                  customConnectorId: created.body.id,
                  baseUrlVars: {},
                  sourceId: connectionId,
                },
              ],
            },
          }),
          [200],
        ),
        accept(
          connectorAccountsApi.connections({
            headers: signIn(actor),
            query: { kind: "custom", customConnectorId: created.body.id },
          }),
          [200],
        ),
      ]);
      const resyncEntry = requireCustomAvailableSync(resynced.body.results[0]);
      expect(resyncEntry.firewall.firewall.name).toBe(
        firstFirewall.firewall.name,
      );
      expect(resyncEntry.networkPolicy).toStrictEqual(
        firstRun.execution.networkPolicies?.[firstFirewall.firewall.name],
      );
      expect(accountsAfterFirst.body.connections[0]?.connectionStatus).toBe(
        "reconnect-required",
      );

      const secondRun = await envSetup.startRun({
        prompt: "Second run still admits reconnect-required custom OAuth",
      });
      const secondFirewall = findInlineCustomFirewall(
        secondRun.execution.firewalls,
        created.body.id,
      );
      const secondApi = secondFirewall.firewall.apis[0];
      if (!secondApi) {
        throw new Error("Expected second custom OAuth firewall API");
      }
      expect(
        secondRun.execution.networkPolicies?.[secondFirewall.firewall.name],
      ).toBeDefined();
      expect(secondRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: created.body.id,
          sourceId: connectionId,
        }),
      );

      const refreshAttemptsBeforeSecond = seenRefreshTokens.length;
      const secondAuthFail = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(secondRun.execution.firewallToken),
          body: {
            authHeaders: secondApi.auth.headers ?? {},
            matchedFirewall: {
              name: secondFirewall.firewall.name,
              apiId: secondApi.id ?? "api-0",
              base: secondApi.base,
              customConnectorId: created.body.id,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
        }),
        [502],
      );
      expect(secondAuthFail.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      expect(seenRefreshTokens).toHaveLength(refreshAttemptsBeforeSecond + 1);

      const accountsAfterSecond = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "custom", customConnectorId: created.body.id },
        }),
        [200],
      );
      expect(accountsAfterSecond.body.connections[0]).toMatchObject({
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      });

      // Reconnect through OAuth with fresh refresh token, then force refresh.
      const reconnectedProvider = mockCustomConnectorOAuth2Provider(context, {
        initialExpiresIn: 3600,
        initialRefreshToken: "reconnected-fresh-refresh-token",
        refreshResponse: () => {
          const latest =
            reconnectedProvider.tokenBodies[
              reconnectedProvider.tokenBodies.length - 1
            ];
          seenRefreshTokens.push(latest?.get("refresh_token") ?? "");
          return HttpResponse.json({
            access_token: "reconnected-refreshed-access-token",
            refresh_token: "reconnected-rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          });
        },
      });
      refreshShouldSucceed = true;
      await envSetup.connectCustomOAuth(created.body.id, {
        intent: "reconnect",
        connectionId,
      });

      const accountsReconnected = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "custom", customConnectorId: created.body.id },
        }),
        [200],
      );
      expect(accountsReconnected.body.connections[0]).toMatchObject({
        connectionStatus: "connected",
        reconnectReason: null,
      });

      const forcedAfterReconnect = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(secondRun.execution.firewallToken),
          body: {
            authHeaders: secondApi.auth.headers ?? {},
            forceRefresh: true,
            matchedFirewall: {
              name: secondFirewall.firewall.name,
              apiId: secondApi.id ?? "api-0",
              base: secondApi.base,
              customConnectorId: created.body.id,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
        }),
        [200],
      );
      expect(forcedAfterReconnect.body.headers).toStrictEqual({
        Authorization: "Bearer reconnected-refreshed-access-token",
      });
      expect(seenRefreshTokens[seenRefreshTokens.length - 1]).toBe(
        "reconnected-fresh-refresh-token",
      );
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-015 resolves current OAuth credentials for admitted MCP connectors",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const provider = mockCustomConnectorOAuth2Provider(context, {
        initialExpiresIn: 3600,
      });
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const endpoint = "https://mcp-oauth.example.test/oauth/mcp";
      const created = await accept(
        customConnectorsApi.create({
          headers: signIn(actor),
          body: {
            kind: "mcp",
            displayName: "OAuth MCP Connector",
            endpoint,
            transport: "streamable-http",
            authMode: "oauth",
            fields: [],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{oauth.access_token}}",
              },
            ],
            queryInjections: [],
            oauthConfig: {
              providerAdapter: "standard",
              clientId: "mcp-oauth-client",
              clientSecret: "mcp-oauth-secret",
              authorizationUrl: provider.authorizationUrl,
              tokenUrl: provider.tokenUrl,
              tokenEndpointAuthMethod: "client_secret_post",
              pkceMethod: "S256",
              scopes: ["mcp.read"],
              authorizationParams: {},
            },
          },
        }),
        [201],
      );
      const connectionId = await envSetup.connectCustomOAuth(created.body.id);

      const started = await envSetup.startRun({
        prompt: "Resolve OAuth credentials for MCP connector",
      });
      expect(JSON.stringify(started.execution)).not.toContain(
        "custom-oauth-initial-access-token",
      );

      const synced = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: started.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: created.body.id,
                baseUrlVars: {},
                sourceId: connectionId,
              },
            ],
          },
        }),
        [200],
      );
      const syncedEntry = requireCustomAvailableSync(synced.body.results[0]);
      const api = syncedEntry.firewall.firewall.apis[0];
      if (!api) {
        throw new Error("Expected synced MCP OAuth API");
      }
      expect(api.base).toBe(endpoint);
      expect(api.permissions ?? []).toStrictEqual([]);

      const authRes = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: {
            authHeaders: api.auth.headers ?? {},
            matchedFirewall: {
              name: syncedEntry.firewall.firewall.name,
              apiId: api.id,
              base: api.base,
              customConnectorId: created.body.id,
              sourceId: connectionId,
              routingVariables: {},
            },
          },
        }),
        [200],
      );
      expect(authRes.body.headers).toStrictEqual({
        Authorization: "Bearer custom-oauth-initial-access-token",
      });
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-017 rotates expired builtin Automatic credentials and requires reconnect after revocation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      const startTime = now();
      mockNow(startTime);

      const fixture = automaticMcpCatalogFixture("oauth");
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration: "cimd",
        authentication: "oauth",
        endpoint: fixture.endpoint,
        initialExpiresIn: 120,
        initialRefreshToken: "builtin-auto-initial-refresh",
        refreshResponse: (attempt) => {
          if (attempt === 1) {
            return HttpResponse.json({
              access_token: "builtin-rotated-access-1",
              refresh_token: "builtin-rotated-refresh-1",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "read write",
            });
          }
          if (attempt === 2) {
            return HttpResponse.json({
              access_token: "builtin-rotated-access-2",
              refresh_token: "builtin-rotated-refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "read write",
            });
          }
          return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
        },
      });

      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const startedAuth = await accept(
        builtinAutomaticApi.start({
          headers: signIn(actor),
          params: { connectorSlug: fixture.slug },
          body: { authMethod: fixture.methodId, account: { intent: "add" } },
        }),
        [200],
      );
      if (startedAuth.body.result !== "authorization") {
        throw new Error("Expected builtin Automatic OAuth authorization URL");
      }
      const callback = await accept(
        builtinAutomaticApi.callback({
          query: {
            state: stateOf(startedAuth.body.authorizationUrl),
            code: `auto-code-${randomUUID()}`,
            iss: provider.issuer,
            responseMode: "json",
          },
        }),
        [200],
      );
      expect(callback.body.status).toBe("success");

      const accounts = await accept(
        connectorAccountsApi.connections({
          headers: signIn(actor),
          query: { kind: "builtin", connectorSlug: fixture.slug },
        }),
        [200],
      );
      const connectionId = accounts.body.connections[0]?.id;
      if (!connectionId) {
        throw new Error("Expected connected builtin Automatic account");
      }

      const startedRun = await envSetup.startRun({
        prompt: "Rotate builtin Automatic MCP credentials",
      });

      mockNow(startTime + 180_000);
      const baseAuthBody = {
        authHeaders: fixture.firewallAuthHeaders,
        matchedFirewall: {
          name: fixture.slug,
          apiId: "api-0",
          base: fixture.firewallBase,
          connectorSlug: fixture.slug,
          sourceId: connectionId,
          routingVariables: {},
        },
      };

      const firstRefresh = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(startedRun.execution.firewallToken),
          body: baseAuthBody,
        }),
        [200],
      );
      expect(firstRefresh.body.headers).toStrictEqual({
        Authorization: "Bearer builtin-rotated-access-1",
      });
      expect(provider.tokenBodies[1]?.get("refresh_token")).toBe(
        "builtin-auto-initial-refresh",
      );

      const reusedCall = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(startedRun.execution.firewallToken),
          body: baseAuthBody,
        }),
        [200],
      );
      expect(reusedCall.body.headers).toStrictEqual({
        Authorization: "Bearer builtin-rotated-access-1",
      });
      expect(provider.tokenBodies).toHaveLength(2);

      const forcedRotation = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(startedRun.execution.firewallToken),
          body: { ...baseAuthBody, forceRefresh: true },
        }),
        [200],
      );
      expect(forcedRotation.body.headers).toStrictEqual({
        Authorization: "Bearer builtin-rotated-access-2",
      });
      expect(provider.tokenBodies[2]?.get("refresh_token")).toBe(
        "builtin-rotated-refresh-1",
      );

      const revokedRefresh = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(startedRun.execution.firewallToken),
          body: { ...baseAuthBody, forceRefresh: true },
        }),
        [502],
      );
      expect(revokedRefresh.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      const tokenCallsAfterRevoke = provider.tokenBodies.length;

      const [accountsAfterRevoke, repeatAfterRevoke, syncedBuiltin] =
        await Promise.all([
          accept(
            connectorAccountsApi.connections({
              headers: signIn(actor),
              query: { kind: "builtin", connectorSlug: fixture.slug },
            }),
            [200],
          ),
          accept(
            firewallAuthApi.firewallAuth({
              headers: bearerHeaders(startedRun.execution.firewallToken),
              body: baseAuthBody,
            }),
            [502],
          ),
          accept(
            runnerSyncApi.sync({
              headers: officialRunnerHeaders(),
              params: { runId: startedRun.runId },
              body: {
                targets: [
                  {
                    kind: "builtin",
                    connectorSlug: fixture.slug,
                    sourceId: connectionId,
                  },
                ],
              },
            }),
            [200],
          ),
        ]);

      expect(accountsAfterRevoke.body.connections[0]?.connectionStatus).toBe(
        "reconnect-required",
      );
      expect(repeatAfterRevoke.body.error).toMatchObject({
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      });
      expect(provider.tokenBodies).toHaveLength(tokenCallsAfterRevoke);
      expect(syncedBuiltin.body.results[0]?.state).toBe("available");
      expect("firewall" in (syncedBuiltin.body.results[0] ?? {})).toBeFalsy();
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-020 injects proposed custom connector fields into headers, query, and host templates",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const kms = useSecretKmsProbe();
      const envSetup = prepareRunEnvironment({ nativeClaude: true });
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const suffix = randomUUID();
      const saved = await accept(
        customConnectorProposalApi.save({
          headers: signIn(actor),
          body: {
            proposal: {
              operation: "create",
              displayName: "Proposed IDN Connector",
              prefixTemplates: [
                `https://{{variables.subdomain}}.tenant-${suffix}.example.test/api/`,
              ],
              fields: [
                {
                  key: "api_key",
                  label: "API Key",
                  kind: "secret",
                  required: true,
                },
                {
                  key: "subdomain",
                  label: "Subdomain",
                  kind: "variable",
                  required: true,
                },
                {
                  key: "scope",
                  label: "Scope",
                  kind: "variable",
                  required: true,
                },
              ],
              headerInjections: [
                {
                  name: "Authorization",
                  valueTemplate: "Bearer {{secrets.api_key}}",
                },
              ],
              queryInjections: [
                {
                  name: "tenant",
                  valueTemplate: "{{variables.subdomain}}",
                },
                {
                  name: "scope",
                  valueTemplate: "{{variables.scope}}",
                },
              ],
            },
            values: [
              {
                key: "api_key",
                kind: "secret",
                value: "proposal-initial-secret",
              },
              { key: "subdomain", kind: "variable", value: "münich" },
              { key: "scope", kind: "variable", value: "initial-scope" },
            ],
          },
        }),
        [200],
      );
      const connectorId = saved.body.connector.id;
      const connectionId = saved.body.connectionId;
      if (!connectionId) {
        throw new Error("Expected proposal save to create a connection");
      }

      const decryptsBeforeRun = kms.decryptCalls;
      const firstRun = await envSetup.startRun({
        prompt: "Inspect proposed custom connector injection",
        model: CLAUDE_MODEL,
      });
      expect(kms.decryptCalls).toBe(decryptsBeforeRun);

      const firewall = findInlineCustomFirewall(
        firstRun.execution.firewalls,
        connectorId,
      );
      const api = firewall.firewall.apis[0];
      if (!api) {
        throw new Error("Expected proposed custom firewall API");
      }
      expect(api.base).toBe(
        `https://xn--mnich-kva.tenant-${suffix}.example.test/api/`,
      );
      expect(firstRun.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: connectorId,
        baseUrlVars: { subdomain: "münich" },
        sourceId: connectionId,
      });
      expect(api.auth.headers?.Authorization).toMatch(
        /^Bearer \$\{\{ secrets\..+ \}\}$/u,
      );
      expect(api.auth.query?.tenant).toMatch(/^\$\{\{ secrets\..+ \}\}$/u);
      expect(api.auth.query?.scope).toMatch(/^\$\{\{ secrets\..+ \}\}$/u);

      const authFirst = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(firstRun.execution.firewallToken),
          body: {
            authHeaders: api.auth.headers ?? {},
            authQuery: api.auth.query,
            matchedFirewall: {
              name: firewall.firewall.name,
              apiId: api.id ?? "api-0",
              base: api.base,
              customConnectorId: connectorId,
              sourceId: connectionId,
              routingVariables: { subdomain: "münich" },
            },
          },
        }),
        [200],
      );
      expect(kms.decryptCalls).toBe(decryptsBeforeRun + 1);
      expect(authFirst.body.headers).toStrictEqual({
        Authorization: "Bearer proposal-initial-secret",
      });
      expect(authFirst.body.query).toStrictEqual({
        tenant: "münich",
        scope: "initial-scope",
      });

      // Reconnecting with new variable values publishes no runtime notification.
      context.mocks.ably.batchPublish.mockClear();
      await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: connectorId },
          body: {
            values: [
              {
                key: "api_key",
                kind: "secret",
                value: "proposal-updated-secret",
              },
              { key: "subdomain", kind: "variable", value: "later-run" },
              { key: "scope", kind: "variable", value: "later-scope" },
            ],
            account: { intent: "reconnect", connectionId },
          },
        }),
        [200],
      );
      expect(context.mocks.ably.batchPublish).not.toHaveBeenCalled();

      const resynced = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: firstRun.runId },
          body: {
            targets: [
              {
                kind: "custom",
                customConnectorId: connectorId,
                baseUrlVars: { subdomain: "münich" },
                sourceId: connectionId,
              },
            ],
          },
        }),
        [200],
      );
      const resyncEntry = requireCustomAvailableSync(resynced.body.results[0]);
      const resyncApi = resyncEntry.firewall.firewall.apis[0];
      if (!resyncApi) {
        throw new Error("Expected resynced API entry");
      }
      expect(resyncEntry.baseUrlVars).toStrictEqual({ subdomain: "later-run" });
      expect(resyncApi.base).toBe(
        `https://later-run.tenant-${suffix}.example.test/api/`,
      );

      const [authSecond, secondRun] = await Promise.all([
        accept(
          firewallAuthApi.firewallAuth({
            headers: bearerHeaders(firstRun.execution.firewallToken),
            body: {
              authHeaders: resyncApi.auth.headers ?? {},
              authQuery: resyncApi.auth.query,
              matchedFirewall: {
                name: resyncEntry.firewall.firewall.name,
                apiId: resyncApi.id,
                base: resyncApi.base,
                customConnectorId: connectorId,
                sourceId: connectionId,
                routingVariables: { subdomain: "later-run" },
              },
            },
          }),
          [200],
        ),
        envSetup.startRun({
          prompt: "Verify later run targets updated subdomain",
          model: CLAUDE_MODEL,
        }),
      ]);
      expect(authSecond.body.headers).toStrictEqual({
        Authorization: "Bearer proposal-updated-secret",
      });
      expect(authSecond.body.query).toStrictEqual({
        tenant: "later-run",
        scope: "later-scope",
      });
      expect(secondRun.execution.connectorRuntimeTargets).toContainEqual({
        kind: "custom",
        customConnectorId: connectorId,
        baseUrlVars: { subdomain: "later-run" },
        sourceId: connectionId,
      });
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-023 omits incompatible custom connectors until required credentials are rewritten",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const prefix = `https://incompat-${randomUUID()}.example.test/api/`;
      const created = await accept(
        customConnectorsApi.create({
          headers: signIn(actor),
          body: {
            kind: "http",
            displayName: "Storage Incompatible Connector",
            prefixTemplates: [prefix],
            authMode: "manual",
            fields: [
              {
                key: "api_key",
                label: "API Key",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.api_key}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [201],
      );
      const initialConn = await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: created.body.id },
          body: {
            values: [
              { key: "api_key", kind: "secret", value: "old-api-key-val" },
            ],
            account: { intent: "add" },
          },
        }),
        [200],
      );
      const connectionId = initialConn.body.connectionId;

      await accept(
        customConnectorByIdApi.update({
          headers: signIn(actor),
          params: { id: created.body.id },
          body: {
            kind: "http",
            displayName: "Storage Incompatible Connector",
            prefixTemplates: [prefix],
            authMode: "manual",
            fields: [
              {
                key: "replacement_key",
                label: "Replacement Key",
                kind: "secret",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.replacement_key}}",
              },
            ],
            queryInjections: [],
          },
        }),
        [200],
      );

      const [beforeAccounts, firstRun] = await Promise.all([
        accept(
          connectorAccountsApi.connections({
            headers: signIn(actor),
            query: { kind: "custom", customConnectorId: created.body.id },
          }),
          [200],
        ),
        envSetup.startRun({
          prompt: "Verify incompatible custom connector is omitted",
        }),
      ]);

      expect(beforeAccounts.body.connections[0]).toMatchObject({
        id: connectionId,
        connectionStatus: "reconnect-required",
        reconnectReason: "configuration_invalid",
        configuredFieldKeys: [],
        missingRequiredFields: ["replacement_key"],
      });
      expect(
        (firstRun.execution.firewalls ?? []).some((fw) => {
          return (
            fw.kind === "inline" && fw.customConnectorId === created.body.id
          );
        }),
      ).toBeFalsy();
      expect(
        firstRun.execution.connectorRuntimeTargets.some((target) => {
          return (
            target.kind === "custom" &&
            target.customConnectorId === created.body.id
          );
        }),
      ).toBeFalsy();

      await accept(
        customConnectorValuesApi.set({
          headers: signIn(actor),
          params: { id: created.body.id },
          body: {
            values: [
              {
                key: "replacement_key",
                kind: "secret",
                value: "fresh-replacement-key",
              },
            ],
            account: { intent: "reconnect", connectionId },
          },
        }),
        [200],
      );

      const [afterAccounts, secondRun] = await Promise.all([
        accept(
          connectorAccountsApi.connections({
            headers: signIn(actor),
            query: { kind: "custom", customConnectorId: created.body.id },
          }),
          [200],
        ),
        envSetup.startRun({
          prompt: "Verify rewritten custom connector is admitted",
        }),
      ]);

      expect(afterAccounts.body.connections[0]).toMatchObject({
        id: connectionId,
        connectionStatus: "connected",
        reconnectReason: null,
        configuredFieldKeys: ["replacement_key"],
        missingRequiredFields: [],
      });
      const admittedFirewall = findInlineCustomFirewall(
        secondRun.execution.firewalls,
        created.body.id,
      );
      expect(
        secondRun.execution.networkPolicies?.[admittedFirewall.firewall.name],
      ).toBeDefined();
      expect(secondRun.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "custom",
          customConnectorId: created.body.id,
          sourceId: connectionId,
        }),
      );
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-027 isolates stored connector base URL vars outside their host policy (GitLab enabled true)",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const attackerDomain = "attacker.evil.example.test";
      const [jiraConn, gitlabConn] = await Promise.all([
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "jira" },
            body: {
              authMethod: "api-token",
              values: {
                apiToken: "jira-secret-token",
                domain: attackerDomain,
                email: "jira-owner@example.test",
              },
              account: { intent: "add" },
            },
          }),
          [200],
        ),
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "gitlab" },
            body: {
              authMethod: "api-token",
              values: {
                accessToken: "gitlab-secret-token",
                host: "gitlab.example.com",
              },
              account: { intent: "add" },
            },
          }),
          [200],
        ),
      ]);

      await accept(
        accessApi.updateAccountDefault({
          headers: signIn(actor),
          params: { connectionId: gitlabConn.body.connectionId },
          body: { target: GITLAB_TARGET, enabled: true },
        }),
        [200],
      );

      const started = await envSetup.startRun({
        prompt: "Unrelated chat prompt verifying host-policy isolation",
      });
      const execution = started.execution;
      const mergedEnv = executionEnvironment(execution);

      expect(
        (execution.firewalls ?? []).some((fw) => {
          return fw.kind === "builtin" && fw.name === "jira";
        }),
      ).toBeFalsy();
      expect(execution.billableFirewalls).not.toContain("jira");
      expect(execution.networkPolicies?.jira).toBeUndefined();
      expect(
        execution.connectorRuntimeTargets.some((target) => {
          return target.kind === "builtin" && target.connectorSlug === "jira";
        }),
      ).toBeFalsy();
      expect(mergedEnv.JIRA_API_TOKEN).toBeUndefined();
      expect(mergedEnv.JIRA_DOMAIN).toBeUndefined();
      expect(execution.vars?.JIRA_DOMAIN).toBeUndefined();
      expect(execution.secretConnectorMap?.JIRA_API_TOKEN).toBeUndefined();
      expect(JSON.stringify(execution)).not.toContain(
        jiraConn.body.connectionId,
      );
      expect(JSON.stringify(execution)).not.toContain(attackerDomain);

      expect(execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "gitlab",
          sourceId: gitlabConn.body.connectionId,
        }),
      );
      expect(execution.networkPolicies?.gitlab).toBeDefined();
      expect(execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          connectorSlug: "gitlab",
          sourceId: gitlabConn.body.connectionId,
        }),
      );
      expect(mergedEnv.GITLAB_TOKEN).toBe("fixture-gitlab-token");
      expect(execution.secretConnectorMap?.GITLAB_TOKEN).toBe("gitlab");
      expect(execution.secretConnectorMetadataMap?.GITLAB_TOKEN?.sourceId).toBe(
        gitlabConn.body.connectionId,
      );
      expect(mergedEnv.GITLAB_HOST).toBe("gitlab.example.com");
      expect(execution.vars?.GITLAB_HOST).toBe("gitlab.example.com");

      const jiraRead = await accept(
        connectorAccountsApi.connection({
          headers: signIn(actor),
          params: { connectionId: jiraConn.body.connectionId },
          query: JIRA_TARGET,
        }),
        [200],
      );
      expect(jiraRead.body.id).toBe(jiraConn.body.connectionId);

      await envSetup.cancelRun(started, true);
      const queue = await accept(
        runsQueueApi.getQueue({ headers: signIn(actor) }),
        [200],
      );
      expect(queue.body.concurrency.active).toBe(0);
      expect(queue.body.runningTasks).toStrictEqual([]);
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-029 applies expired and revoked connector grants before dispatch",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const startTime = now();
      mockNow(startTime);
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      await envSetup.connectBuiltinOAuth("slack");
      await accept(
        connectorPermissionsApi.apply({
          headers: signIn(actor),
          body: {
            target: SLACK_TARGET,
            mode: "patch",
            grants: [
              { permission: "chat:write", action: "allow", expiresIn: "1h" },
            ],
          },
        }),
        [200],
      );

      mockNow(startTime + 2 * ONE_HOUR_MS);
      await envSetup.refreshRunnerHeartbeat();
      const firstRun = await envSetup.startRun({
        prompt: "Verify expired Slack chat:write grant is denied",
      });
      const firstSlackPolicy = firstRun.execution.networkPolicies?.slack;
      expect(firstSlackPolicy?.deny).toContain("chat:write");
      expect(firstSlackPolicy?.allow).not.toContain("chat:write");

      await accept(
        connectorPermissionsApi.apply({
          headers: signIn(actor),
          body: {
            target: SLACK_TARGET,
            mode: "patch",
            grants: [
              {
                permission: "chat:write",
                action: "allow",
                expiresIn: "always",
              },
            ],
          },
        }),
        [200],
      );
      await accept(
        connectorPermissionsApi.apply({
          headers: signIn(actor),
          body: {
            target: SLACK_TARGET,
            mode: "replace",
            grants: [],
          },
        }),
        [200],
      );

      const secondRun = await envSetup.startRun({
        prompt: "Verify revoked Slack chat:write grant is denied",
      });
      const secondSlackPolicy = secondRun.execution.networkPolicies?.slack;
      expect(secondSlackPolicy?.deny).toContain("chat:write");
      expect(secondSlackPolicy?.allow).not.toContain("chat:write");
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-031 distinguishes terminal connector runtime sync from missing runs",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment({ nativeClaude: true });
      const { actor, orgId } = envSetup;
      const colleague = bdd.user({ orgId, orgRole: "org:member" });
      await envSetup.awaitBootstrap();

      const completedRun = await envSetup.startRun({
        prompt: "Run that completes cleanly",
        model: CLAUDE_MODEL,
      });
      await envSetup.completeRunOk(completedRun, `cli-ok-${randomUUID()}`);

      const failedRun = await envSetup.startRun({
        prompt: "Run that fails",
        model: CLAUDE_MODEL,
      });
      await envSetup.failRun(failedRun, "Deliberate BDD terminal run failure");

      const memberPat = await runs.createCliToken(actor);
      const colleaguePat = await runs.createCliToken(colleague);

      const [memberCompleted, colleagueCompleted, memberMissing, memberFailed] =
        await Promise.all([
          accept(
            runnerSyncApi.sync({
              headers: bearerHeaders(memberPat.token),
              params: { runId: completedRun.runId },
              body: { targets: [SLACK_TARGET] },
            }),
            [409],
          ),
          accept(
            runnerSyncApi.sync({
              headers: bearerHeaders(colleaguePat.token),
              params: { runId: completedRun.runId },
              body: { targets: [SLACK_TARGET] },
            }),
            [404],
          ),
          accept(
            runnerSyncApi.sync({
              headers: bearerHeaders(memberPat.token),
              params: { runId: randomUUID() },
              body: { targets: [SLACK_TARGET] },
            }),
            [404],
          ),
          accept(
            runnerSyncApi.sync({
              headers: bearerHeaders(memberPat.token),
              params: { runId: failedRun.runId },
              body: { targets: [SLACK_TARGET] },
            }),
            [409],
          ),
        ]);

      expect(memberCompleted.body.error).toMatchObject({
        code: CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
        message: "Run is terminal",
      });
      expect(colleagueCompleted.body.error.code).toBe("NOT_FOUND");
      expect(memberMissing.body.error.code).toBe("NOT_FOUND");
      expect(memberFailed.body.error.code).toBe(
        CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
      );
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-032 resumes a session while refreshing its network policy",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment({ nativeClaude: true });
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      await envSetup.connectBuiltinOAuth("slack");

      const firstRun = await envSetup.startRun({
        prompt: "First turn with Slack connected",
        model: CLAUDE_MODEL,
      });
      expect(firstRun.execution.networkPolicies?.slack).toBeDefined();

      const sessionId = `session-${randomUUID().replaceAll("-", "")}`;
      await envSetup.completeRunOk(firstRun, sessionId);

      const firstStatus = await accept(
        runsByIdApi.getById({
          headers: signIn(actor),
          params: { id: firstRun.runId },
        }),
        [200],
      );
      expect(firstStatus.body.status).toBe("completed");

      const continuation = await envSetup.startRun({
        prompt: "Second turn resuming session",
        threadId: firstRun.threadId,
        model: CLAUDE_MODEL,
      });
      expect(continuation.execution.nativeContinuation.sessionId).toBe(
        sessionId,
      );
      expect(continuation.execution.nativeContinuation.generationRunId).toBe(
        firstRun.runId,
      );
      expect(continuation.execution.networkPolicies?.slack).toBeDefined();
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-033 applies Cloudflare permission overrides without changing the sibling Slack policy",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment();
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      await envSetup.connectBuiltinOAuth("cloudflare");
      await envSetup.connectBuiltinOAuth("slack");

      const firstRun = await envSetup.startRun({
        prompt: "Check default Cloudflare and Slack policies",
      });
      const defaultCloudflare = firstRun.execution.networkPolicies?.cloudflare;
      const defaultSlack = firstRun.execution.networkPolicies?.slack;
      expect(defaultCloudflare?.allow).toContain("dns-firewall.read");
      expect(defaultCloudflare?.deny).toContain("dns-firewall.write");
      expect(defaultCloudflare?.unknownPolicy).toBe("deny");
      expect(defaultSlack).toBeDefined();

      await accept(
        connectorPermissionsApi.apply({
          headers: signIn(actor),
          body: {
            target: CLOUDFLARE_TARGET,
            mode: "patch",
            grants: [
              {
                permission: "dns-firewall.write",
                action: "allow",
                expiresIn: "always",
              },
              {
                permission: UNKNOWN_PERMISSION_GRANT,
                action: "allow",
                expiresIn: "always",
              },
            ],
          },
        }),
        [200],
      );

      const secondRun = await envSetup.startRun({
        prompt: "Check overridden Cloudflare policy and untouched Slack policy",
      });
      const updatedCloudflare = secondRun.execution.networkPolicies?.cloudflare;
      expect(updatedCloudflare?.allow).toContain("dns-firewall.read");
      expect(updatedCloudflare?.allow).toContain("dns-firewall.write");
      expect(updatedCloudflare?.deny).not.toContain("dns-firewall.write");
      expect(updatedCloudflare?.unknownPolicy).toBe("allow");
      expect(secondRun.execution.networkPolicies?.slack).toStrictEqual(
        defaultSlack,
      );
    },
  );

  it(
    "run-lifecycle-custom-connectors.bdd-034 loads stored connectors and applies default named policies to runs without explicit policies",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareRunEnvironment({ proSubscription: true });
      await envSetup.awaitBootstrap();

      const cloudflareConnectionId =
        await envSetup.connectBuiltinOAuth("cloudflare");

      const started = await envSetup.startRun({
        prompt: "Inspect default Cloudflare policy for Pro member",
        model: CLAUDE_MODEL,
      });
      const mergedEnv = executionEnvironment(started.execution);
      expect(mergedEnv.CLOUDFLARE_TOKEN).toBe("fixture-cloudflare-token");
      expect(started.execution.secretConnectorMap?.CLOUDFLARE_TOKEN).toBe(
        "cloudflare",
      );
      expect(started.execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "cloudflare",
          sourceId: cloudflareConnectionId,
        }),
      );
      const policy = started.execution.networkPolicies?.cloudflare;
      expect(policy?.allow).toContain("dns-firewall.read");
      expect(policy?.deny).toContain("dns-firewall.write");
      expect(policy?.unknownPolicy).toBe("deny");
    },
  );
});
