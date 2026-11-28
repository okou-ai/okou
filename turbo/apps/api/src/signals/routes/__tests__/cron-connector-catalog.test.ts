import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorExternalCodeSessionContract,
  builtinConnectorManualGrantContract,
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { getCustomConnectorSkillName } from "@okouai/core/storage-names";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished, test } from "vitest";
import { object, string } from "zod";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsExternalCodeRoutes } from "../connectors-external-code";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClaudeCodeTokenEndpoint } from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockSlackConnectorOAuth,
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
const connectors = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooksApi = createWebhookCallbackApi(context);
const routeMocks = createRouteMocks(context);

type RunnerExecutionInput = Awaited<
  ReturnType<typeof runsApi.nextReceivedExecution>
>;

const RUN_SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
const STEAM_OPENID_NS = "http://specs.openid.net/auth/2.0";
const AWS_SIGNIN_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";
const AWS_FIREWALL_BASE = "https://{awsHost+}.amazonaws.com";

const awsTokenRequestBodySchema = object({
  clientId: string().min(1),
  grantType: string().min(1),
  code: string().optional(),
  refreshToken: string().optional(),
});

const app = setupApp({
  context,
  routes: [
    ...builtinConnectorsRoutes,
    ...builtinConnectorsExternalCodeRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...chatEventsRoutes,
    ...connectorAccountRoutes,
    ...meModelProvidersUpsertRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
  ],
});

const openIdStartApi = app(builtinConnectorOpenIdStartContract);
const oauthStartApi = app(builtinConnectorOauthStartContract);
const manualGrantApi = app(builtinConnectorManualGrantContract);
const connectorCallbackApi = app(builtinConnectorsSlugCallbackContract);
const externalCodeApi = app(builtinConnectorExternalCodeSessionContract);
const chatEventsApi = app(chatEventsContract);
const connectorAccountsApi = app(connectorAccountsContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const runByIdApi = app(runsByIdContract);
const runCancelApi = app(runsCancelContract);
const agentCompleteApi = app(webhookCompleteContract);
const firewallAuthApi = app(runWebhookContract);
const clerkWebhookApi = app(webhookClerkContract);

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function signInRunActor(actor: ApiTestUser) {
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const emailId = `email_${actor.userId}`;
  mockClerkUsers(context, [
    {
      id: actor.userId,
      emailAddresses: [{ id: emailId, emailAddress: actor.email }],
      primaryEmailAddressId: emailId,
      firstName: "BDD",
      lastName: "Catalog",
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

function codexAuthJson(accountId = randomUUID()): string {
  const jwt = (payload: Record<string, unknown>) => {
    return `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  };
  const token = jwt({
    exp: Math.floor(now() / 1000) + 7200,
    jti: randomUUID(),
  });
  return JSON.stringify({
    tokens: {
      access_token: token,
      refresh_token: `refresh-${randomUUID()}`,
      account_id: accountId,
      id_token: jwt({
        email: "codex-bdd@example.test",
        "https://api.openai.com/auth": {
          chatgpt_account_id: accountId,
          chatgpt_plan_type: "plus",
        },
      }),
    },
  });
}

function findCustomSkillBundle(
  execution: RunnerExecutionInput,
  connectorSlug: string,
  connectorId: string,
) {
  const skillName = getCustomConnectorSkillName(connectorSlug, connectorId);
  return execution.startupInputs?.contentBundles?.skills.find((skill) => {
    return skill.name === skillName;
  });
}

interface TrackedCatalogRun {
  readonly runId: string;
  readonly sandboxToken: string;
  readonly issuedAtMs: number;
  done: boolean;
}

interface StartedCatalogRun {
  readonly runId: string;
  readonly threadId: string;
  readonly execution: RunnerExecutionInput;
  readonly tracked: TrackedCatalogRun;
}

function prepareCatalogRunEnv(options?: {
  readonly plan?: "limited-free" | "pro";
}) {
  const actor = bdd.user({ orgRole: "org:admin" });
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

  const trackedRuns: TrackedCatalogRun[] = [];
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
    clerkWebhookApi.post({ body: "{}", extraHeaders: {} }),
    [200],
  );
  const proEntitlementPromise =
    options?.plan === "pro"
      ? (async () => {
          await orgCreatedPromise;
          const periodEnd = nowDate();
          periodEnd.setTime(now() + 30 * 24 * 60 * 60 * 1000);
          return await postSubscriptionInvoicePaid(context.signal, {
            orgId,
            userId: actor.userId,
            tier: "pro",
            customerId: generatedStripeCustomerId(),
            subscriptionId: generatedStripeSubscriptionId(),
            currentPeriodEnd: periodEnd,
          });
        })()
      : Promise.resolve(undefined);

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
      await Promise.allSettled([
        runnerGroupPromise,
        orgCreatedPromise,
        proEntitlementPromise,
      ]);
      await flushWaitUntilForTest();
      const activeRuns = trackedRuns.filter((tracked) => {
        return !tracked.done;
      });
      if (activeRuns.length > 0) {
        const ownerHeaders = signInRunActor(actor);
        const groupedByTime = new Map<number, TrackedCatalogRun[]>();
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
      proEntitlementPromise,
    ]);
    resolvedRunnerGroup = runnerGroup;
    return runnerGroup;
  }

  async function sendChatEvent(args: {
    readonly prompt: string;
    readonly threadId?: string;
    readonly model?: string | null;
  }) {
    await awaitBootstrap();
    return await accept(
      chatEventsApi.send({
        headers: signInRunActor(actor),
        body: {
          ...(args.threadId ? { threadId: args.threadId } : {}),
          prompt: args.prompt,
          model: args.model === undefined ? null : args.model,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: args.prompt }],
          },
          hasTextContent: true,
        },
      }),
      [201],
    );
  }

  async function nextDispatchedRun(
    threadId: string,
  ): Promise<StartedCatalogRun> {
    const runnerGroup = await awaitBootstrap();
    await flushWaitUntilForTest();
    const execution = await runsApi.nextReceivedExecution(runnerGroup);
    const tracked: TrackedCatalogRun = {
      runId: execution.runId,
      sandboxToken: execution.sandboxToken,
      issuedAtMs: now(),
      done: false,
    };
    trackedRuns.push(tracked);
    return {
      runId: execution.runId,
      threadId,
      execution,
      tracked,
    };
  }

  async function startRun(args?: {
    readonly prompt?: string;
    readonly threadId?: string;
    readonly model?: string | null;
  }): Promise<StartedCatalogRun> {
    const sent = await sendChatEvent({
      prompt: args?.prompt ?? "Run catalog verification",
      threadId: args?.threadId,
      model: args?.model,
    });
    return await nextDispatchedRun(sent.body.threadId);
  }

  async function completeRunOk(started: StartedCatalogRun): Promise<void> {
    const cliAgentType =
      started.execution.cliAgentType === "pi"
        ? "pi"
        : started.execution.cliAgentType === "codex"
          ? "codex"
          : "claude-code";
    const cliAgentSessionId =
      cliAgentType === "pi"
        ? (started.execution.piSessionId ?? started.threadId)
        : `bdd-${cliAgentType}-${started.runId}`;
    await accept(
      agentCompleteApi.complete({
        headers: bearerHeaders(started.execution.sandboxToken),
        body: {
          runId: started.runId,
          exitCode: 0,
          completion: {
            cliAgentType,
            cliAgentSessionId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
      }),
      [200],
    );
    started.tracked.done = true;
    await flushWaitUntilForTest();
  }

  return {
    actor,
    orgId,
    awaitBootstrap,
    sendChatEvent,
    nextDispatchedRun,
    startRun,
    completeRunOk,
  };
}

beforeAll(async () => {
  const missingId = randomUUID();
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const warmed = await settleIncludingAbort(async () => {
    await Promise.all([
      accept(
        openIdStartApi.start({
          headers: {},
          params: { connectorSlug: "steam" },
          body: { authMethod: "openid", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        oauthStartApi.start({
          headers: {},
          params: { connectorSlug: "slack" },
          body: { authMethod: "oauth", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        manualGrantApi.connect({
          headers: {},
          params: { connectorSlug: "gitlab" },
          body: {
            authMethod: "api-token",
            account: { intent: "add" },
            values: { accessToken: "warmup" },
          },
        }),
        [401],
      ),
      accept(
        externalCodeApi.create({
          headers: {},
          params: { connectorSlug: "aws" },
          body: { authMethod: "cli", account: { intent: "add" } },
        }),
        [401],
      ),
      accept(
        connectorAccountsApi.connections({
          headers: {},
          query: { kind: "builtin", connectorSlug: "aws" },
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
        agentCompleteApi.complete({
          headers: {},
          body: { runId: missingId, exitCode: 0 },
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
    ]);
  });
  if (!warmed.ok) {
    throw warmed.error;
  }
});

/** Holds Slack's token exchange until the case releases it. */
function holdSlackTokenExchange() {
  const releasedDeferred = createDeferredPromise<void>(context.signal);
  const startedDeferred = createDeferredPromise<void>(context.signal);
  const released = releasedDeferred.promise;
  const started = startedDeferred.promise;
  const release = (): void => {
    if (!releasedDeferred.settled()) {
      releasedDeferred.resolve();
    }
  };
  const markStarted = (): void => {
    if (!startedDeferred.settled()) {
      startedDeferred.resolve();
    }
  };
  server.use(
    http.post("https://slack.com/api/oauth.v2.access", async () => {
      markStarted();
      await released;
      return HttpResponse.json({
        ok: true,
        authed_user: {
          id: "U012AB3CD",
          access_token: `xoxp-${randomUUID()}`,
          scope: "channels:read,chat:write",
        },
      });
    }),
    http.post("https://slack.com/api/auth.revoke", () => {
      return HttpResponse.json({ ok: true, revoked: true });
    }),
  );
  return { started, release };
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Slack authorization state");
  }
  return state;
}

/** Starts Slack OAuth and completes its callback while the exchange is held. */
async function connectSlackInFlight(admin: ApiTestUser) {
  mockSlackConnectorOAuth();
  const exchange = holdSlackTokenExchange();
  const started = await connectors.startOauth(admin, "slack", "oauth");
  const callback = connectors.completeOauthCallback("slack", {
    code: `code-${randomUUID()}`,
    state: stateOf(started.authorizationUrl),
  });
  await exchange.started;
  exchange.release();
  await callback;
  return await connectors.listBuiltinConnectorAccounts(admin, "slack");
}

test("cron-connector-catalog-010 (1/2) connects the Slack account once the held exchange is released", async () => {
  const admin = bdd.user({ orgRole: "org:admin" });

  const accounts = await connectSlackInFlight(admin);

  expect(accounts).toStrictEqual([
    expect.objectContaining({
      authMethod: "oauth",
      externalId: "U012AB3CD",
      connectionStatus: "connected",
    }),
  ]);
});

test("cron-connector-catalog-010 (2/2) reconnects exactly the same Slack account", async () => {
  const admin = bdd.user({ orgRole: "org:admin" });
  const [connected] = await connectSlackInFlight(admin);
  if (!connected) {
    throw new Error("Expected the connected Slack account");
  }

  const reconnect = await connectors.startOauth(admin, "slack", "oauth", {
    intent: "reconnect",
    connectionId: connected.id,
  });
  await connectors.completeOauthCallback("slack", {
    code: `code-${randomUUID()}`,
    state: stateOf(reconnect.authorizationUrl),
  });

  await expect(
    connectors.listBuiltinConnectorAccounts(admin, "slack"),
  ).resolves.toStrictEqual([
    expect.objectContaining({
      id: connected.id,
      authMethod: "oauth",
      externalId: "U012AB3CD",
      connectionStatus: "connected",
    }),
  ]);
});

describe("connector catalog valid lifecycle Run flows", () => {
  it(
    "cron-connector-catalog-004 uses a manual GitLab credential in a Run without optional host configuration",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareCatalogRunEnv();
      const { actor } = envSetup;

      const granted = await connectors.requestManualGrant(
        actor,
        "gitlab",
        "api-token",
        { accessToken: "manual-gitlab-secret" },
        { statuses: [200] },
      );
      if (granted.status !== 200) {
        throw new Error("Expected GitLab manual grant to succeed");
      }
      const gitlabConnectionId = granted.body.connectionId;

      const [accounts, started] = await Promise.all([
        connectors.listBuiltinConnectorAccounts(actor, "gitlab"),
        envSetup.startRun({ prompt: "Resolve manual GitLab token" }),
      ]);
      expect(accounts).toStrictEqual([
        expect.objectContaining({
          id: gitlabConnectionId,
          authMethod: "api-token",
          connectionStatus: "connected",
        }),
      ]);
      expect(JSON.stringify(accounts)).not.toContain("manual-gitlab-secret");
      expect(started.execution.environment?.GITLAB_HOST).toBeUndefined();
      expect(started.execution.vars?.GITLAB_HOST).toBeUndefined();

      const resolved = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(started.execution.firewallToken),
          body: {
            authHeaders: {
              "PRIVATE-TOKEN": secretTemplate("GITLAB_TOKEN"),
            },
            secretConnectorMap: { GITLAB_TOKEN: "gitlab" },
            secretConnectorMetadataMap: {
              GITLAB_TOKEN: {
                sourceType: "connector",
                sourceId: gitlabConnectionId,
              },
            },
          },
        }),
        [200],
      );
      expect(resolved.body.headers).toStrictEqual({
        "PRIVATE-TOKEN": "manual-gitlab-secret",
      });
    },
  );

  it(
    "cron-connector-catalog-006 loads the current published connector skill when a queued Run is prepared",
    { timeout: TEST_WITH_FOUR_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envSetup = prepareCatalogRunEnv({ plan: "pro" });
      const { actor } = envSetup;
      const prefix = `https://queued-skill-${randomUUID().slice(0, 8)}.example.test/v1`;
      const initialMarkdown = "# Queued Skill v1\nInitial connector guidance.";
      const updatedMarkdown = "# Queued Skill v2\nUpdated connector guidance.";

      await envSetup.awaitBootstrap();
      const [connector] = await Promise.all([
        connectors.createCustomConnector(actor, {
          displayName: "Queued Skill Connector",
          prefixTemplates: [prefix],
          authMode: "manual",
          skillMarkdown: initialMarkdown,
          fields: [
            {
              key: "api_key",
              label: "API key",
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
        }),
        accept(
          personalModelProvidersApi.upsert({
            headers: signInRunActor(actor),
            body: {
              type: "codex-oauth-token",
              authMethod: "auth_json",
              secrets: { CODEX_AUTH_JSON: codexAuthJson() },
            },
          }),
          [200, 201],
        ),
      ]);

      await connectors.setCustomConnectorValues(actor, connector.id, [
        { key: "api_key", kind: "secret", value: "queued-skill-secret" },
      ]);

      const run1 = await envSetup.startRun({
        prompt: "Hold thread slot while next run queues",
        model: "gpt-6-luna",
      });
      const initialSkill = findCustomSkillBundle(
        run1.execution,
        connector.slug,
        connector.id,
      );
      expect(initialSkill?.bundle.sha256).toBeTruthy();

      await envSetup.sendChatEvent({
        threadId: run1.threadId,
        prompt: "Queued run should load updated skill",
        model: "gpt-6-luna",
      });

      await connectors.updateCustomConnector(actor, connector.id, {
        displayName: "Queued Skill Connector",
        prefixTemplates: [prefix],
        authMode: "manual",
        skillMarkdown: updatedMarkdown,
        fields: [
          { key: "api_key", label: "API key", kind: "secret", required: true },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
        storageVersion: connector.storageVersion,
      });

      await envSetup.completeRunOk(run1);
      const queuedRun = await envSetup.nextDispatchedRun(run1.threadId);
      const queuedSkill = findCustomSkillBundle(
        queuedRun.execution,
        connector.slug,
        connector.id,
      );
      expect(queuedSkill?.bundle.sha256).toBeTruthy();
      expect(queuedSkill?.bundle.sha256).not.toBe(initialSkill?.bundle.sha256);
      expect(queuedSkill?.bundle.archiveBytes).toBeGreaterThan(0);
      expect(queuedSkill?.bundle.downloadUrl).toBeTruthy();

      await envSetup.completeRunOk(queuedRun);
      const laterRun = await envSetup.startRun({
        threadId: run1.threadId,
        prompt: "Later run reuses updated skill",
        model: "gpt-6-luna",
      });
      const laterSkill = findCustomSkillBundle(
        laterRun.execution,
        connector.slug,
        connector.id,
      );
      expect(laterSkill?.bundle.sha256).toBe(queuedSkill?.bundle.sha256);
      expect(laterSkill?.bundle.archiveBytes).toBe(
        queuedSkill?.bundle.archiveBytes,
      );
      expect(laterSkill?.bundle.downloadUrl).toBeTruthy();
    },
  );

  it(
    "cron-connector-catalog-007 makes a verified Steam OpenID identity available to its Run",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
      mockEnv("OKOU_WEB_URL", "https://www.okou.ai");
      mockEnv("APP_URL", "https://app.okou.ai");
      mockOptionalEnv("STEAM_WEB_API_KEY", "bdd-steam-web-api-key");

      const steamId = "76561198000000000";
      const claimedId = `https://steamcommunity.com/openid/id/${steamId}`;
      server.use(
        http.post(STEAM_OPENID_ENDPOINT, () => {
          return new HttpResponse(`ns:${STEAM_OPENID_NS}\nis_valid:true\n`, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
        }),
      );

      const envSetup = prepareCatalogRunEnv();
      const { actor } = envSetup;

      const startedOpenId = await accept(
        openIdStartApi.start({
          headers: signInRunActor(actor),
          params: { connectorSlug: "steam" },
          body: { authMethod: "openid", account: { intent: "add" } },
        }),
        [200],
      );
      const authUrl = new URL(startedOpenId.body.authorizationUrl);
      const returnTo = authUrl.searchParams.get("openid.return_to");
      const realm = authUrl.searchParams.get("openid.realm");
      if (!returnTo || !realm) {
        throw new Error("Expected Steam OpenID return_to and realm parameters");
      }
      const state = new URL(returnTo).searchParams.get("state");
      if (!state) {
        throw new Error("Expected state parameter in Steam return_to");
      }

      const callbackRes = await accept(
        connectorCallbackApi.callback({
          params: { connectorSlug: "steam" },
          query: {
            state,
            "openid.ns": STEAM_OPENID_NS,
            "openid.mode": "id_res",
            "openid.op_endpoint": STEAM_OPENID_ENDPOINT,
            "openid.return_to": returnTo,
            "openid.realm": realm,
            "openid.response_nonce": "2026-11-28T00:00:00Zbdd-nonce",
            "openid.assoc_handle": "bdd-assoc-handle",
            "openid.claimed_id": claimedId,
            "openid.identity": claimedId,
            "openid.signed":
              "op_endpoint,return_to,response_nonce,assoc_handle,claimed_id,identity",
            "openid.sig": "bdd-steam-signature",
          },
        }),
        [307],
      );
      expect(callbackRes.status).toBe(307);

      const [steamAccount, startedRun] = await Promise.all([
        connectors.readDefaultBuiltinAccount(actor, "steam"),
        envSetup.startRun({ prompt: "Read Steam ID from run environment" }),
      ]);
      expect(steamAccount).toMatchObject({
        authMethod: "openid",
        externalId: steamId,
        connectionStatus: "connected",
      });
      expect(
        startedRun.execution.environment?.STEAM_ID ??
          startedRun.execution.vars?.STEAM_ID,
      ).toBe(steamId);
    },
  );

  it(
    "cron-connector-catalog-008 refreshes AWS credentials in a Run after external-code authorization",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockClaudeCodeTokenEndpoint();
      const tokenRequests: {
        readonly grantType: string;
        readonly refreshToken?: string;
      }[] = [];

      server.use(
        http.post(AWS_SIGNIN_TOKEN_URL, async ({ request }) => {
          const parsed = awsTokenRequestBodySchema.parse(await request.json());
          tokenRequests.push({
            grantType: parsed.grantType,
            refreshToken: parsed.refreshToken,
          });
          if (parsed.grantType === "refresh_token") {
            return HttpResponse.json({
              tokenOutput: {
                accessToken: {
                  accessKeyId: "aws-external-code-credential-id",
                  secretAccessKey: "aws-external-code-secret-key",
                  sessionToken: "aws-external-code-session-token",
                },
                expiresIn: 900,
                refreshToken: "aws-rotated-refresh-token",
                tokenType: "aws_sigv4",
                idToken: "aws-id-token",
              },
            });
          }
          return HttpResponse.json({
            tokenOutput: {
              accessToken: {
                accessKeyId: "aws-initial-key",
                secretAccessKey: "aws-initial-secret",
                sessionToken: "aws-initial-session",
              },
              expiresIn: 900,
              refreshToken: "aws-login-refresh-token",
              tokenType: "aws_sigv4",
              idToken: "aws-id-token",
            },
          });
        }),
        http.get(AWS_STS_URL, () => {
          return HttpResponse.xml(
            [
              "<GetCallerIdentityResponse>",
              "<GetCallerIdentityResult>",
              "<UserId>AIDABDDTESTUSER</UserId>",
              "<Account>123456789012</Account>",
              "<Arn>arn:aws:iam::123456789012:user/bdd-admin</Arn>",
              "</GetCallerIdentityResult>",
              "</GetCallerIdentityResponse>",
            ].join(""),
          );
        }),
      );

      const envSetup = prepareCatalogRunEnv({ plan: "pro" });
      const { actor } = envSetup;
      await envSetup.awaitBootstrap();

      const [sessionStart] = await Promise.all([
        accept(
          externalCodeApi.create({
            headers: signInRunActor(actor),
            params: { connectorSlug: "aws" },
            body: { authMethod: "cli", account: { intent: "add" } },
          }),
          [200],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: signInRunActor(actor),
            body: {
              type: "claude-code-oauth-token",
              secret: "bdd-claude-oauth-token",
            },
          }),
          [200, 201],
        ),
      ]);

      const completed = await accept(
        externalCodeApi.complete({
          headers: signInRunActor(actor),
          params: {
            connectorSlug: "aws",
            sessionId: sessionStart.body.sessionId,
          },
          body: {
            sessionToken: sessionStart.body.sessionToken,
            code: awsVerificationCode(
              sessionStart.body.authorizationUrl,
              "aws-external-code-1",
            ),
          },
        }),
        [200],
      );
      const awsConnectionId = completed.body.connectionId;

      const [awsAccounts, startedRun] = await Promise.all([
        accept(
          connectorAccountsApi.connections({
            headers: signInRunActor(actor),
            query: { kind: "builtin", connectorSlug: "aws" },
          }),
          [200],
        ),
        envSetup.startRun({
          prompt: "Refresh AWS SigV4 credentials",
          model: "claude-fable-5-1",
        }),
      ]);
      expect(awsAccounts.body.connections).toStrictEqual([
        expect.objectContaining({
          id: awsConnectionId,
          authMethod: "cli",
          externalId: "123456789012",
          oauthScopes: ["openid"],
          connectionStatus: "connected",
        }),
      ]);

      const metadata = {
        sourceType: "connector" as const,
        sourceId: awsConnectionId,
      };
      const resolved = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(startedRun.execution.firewallToken),
          body: {
            authHeaders: {},
            authAwsSigv4: {
              accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
              secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
              sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
            },
            secretConnectorMap: {
              AWS_ACCESS_KEY_ID: "aws",
              AWS_SECRET_ACCESS_KEY: "aws",
              AWS_SESSION_TOKEN: "aws",
            },
            secretConnectorMetadataMap: {
              AWS_ACCESS_KEY_ID: metadata,
              AWS_SECRET_ACCESS_KEY: metadata,
              AWS_SESSION_TOKEN: metadata,
            },
            matchedFirewall: {
              name: "aws",
              apiId: "api-0",
              base: AWS_FIREWALL_BASE,
              connectorSlug: "aws",
              sourceId: awsConnectionId,
              routingVariables: {},
            },
            forceRefresh: true,
          },
        }),
        [200],
      );
      expect(resolved.body.awsSigv4).toStrictEqual({
        accessKeyId: "aws-external-code-credential-id",
        secretAccessKey: "aws-external-code-secret-key",
        sessionToken: "aws-external-code-session-token",
      });
      expect(tokenRequests).toStrictEqual([
        { grantType: "authorization_code", refreshToken: undefined },
        {
          grantType: "refresh_token",
          refreshToken: "aws-login-refresh-token",
        },
      ]);
    },
  );
});
