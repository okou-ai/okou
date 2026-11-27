import { randomUUID } from "node:crypto";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { codexDeviceAuthContract } from "@okouai/api-contracts/contracts/codex-device-auth";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorManualGrantContract,
  builtinConnectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import {
  runsByIdContract,
  runsCancelContract,
  runsQueueContract,
} from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  runWebhookContract,
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatEventsRoutes } from "../chat-events";
import { codexDeviceAuthRoutes } from "../codex-device-auth";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { onboardingCompleteRoutes } from "../onboarding-complete";
import { runnersRoutes } from "../runners";
import { runsRoutes } from "../runs";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksAgentFirewallAuthRoutes } from "../webhooks-agent-firewall-auth";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { mockSlackConnectorOAuth } from "./helpers/api-bdd-connectors";
import { secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import type { RunnerExecutionInput } from "./helpers/chat-events-fixture";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const X_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "x" as const,
});
const SLACK_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "slack" as const,
});
const LARK_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "lark" as const,
});

const X_OAUTH_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_USERS_ME_URL = "https://api.x.com/2/users/me";

const app = setupApp({
  context,
  routes: [
    ...chatEventsRoutes,
    ...chatConnectorAccessRoutes,
    ...builtinConnectorsRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...connectorAccountRoutes,
    ...codexDeviceAuthRoutes,
    ...meModelProvidersUpsertRoutes,
    ...onboardingCompleteRoutes,
    ...runnersRoutes,
    ...runsRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksAgentFirewallAuthRoutes,
    ...webhooksClerkRoutes,
  ],
});

const chatEventsApi = app(chatEventsContract);
const accessApi = app(chatConnectorAccessContract);
const builtinManualGrantApi = app(builtinConnectorManualGrantContract);
const oauthStartApi = app(builtinConnectorOauthStartContract);
const oauthCallbackApi = app(builtinConnectorsSlugCallbackContract);
const connectorAccountsApi = app(connectorAccountsContract);
const codexDeviceAuthApi = app(codexDeviceAuthContract);
const personalModelProvidersApi = app(personalModelProvidersMainContract);
const onboardingCompleteApi = app(onboardingCompleteContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runnerSyncApi = app(runnersConnectorRuntimeSyncContract);
const runsByIdApi = app(runsByIdContract);
const runsQueueApi = app(runsQueueContract);
const runsCancelApi = app(runsCancelContract);
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
        body: { target: X_TARGET, enabled: false },
      }),
      [401],
    ),
    accept(
      builtinManualGrantApi.connect({
        headers: {},
        params: { connectorSlug: "gitlab" },
        body: {
          authMethod: "api-token",
          values: { accessToken: "warmup" },
          account: { intent: "add", displayName: "Warmup" },
        },
      }),
      [401],
    ),
    accept(
      oauthStartApi.start({
        headers: {},
        params: { connectorSlug: "x" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [401],
    ),
    accept(
      connectorAccountsApi.setDefault({
        headers: {},
        params: { connectionId: missingId },
        body: { target: LARK_TARGET },
      }),
      [401],
    ),
    accept(
      codexDeviceAuthApi.start({
        headers: {},
        body: { scope: "personal", mode: "add" },
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
      runnerSyncApi.sync({
        headers: {},
        params: { runId: missingId },
        body: { targets: [LARK_TARGET] },
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

function mockXOAuthProvider(options: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId?: string;
  readonly username?: string;
}) {
  mockOptionalEnv("X_OAUTH_CLIENT_ID", "x-bdd-client-id");
  mockOptionalEnv("X_OAUTH_CLIENT_SECRET", "x-bdd-client-secret");
  server.use(
    http.post(X_OAUTH_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: options.accessToken,
        refresh_token: options.refreshToken,
        expires_in: 7200,
        token_type: "bearer",
        scope: "tweet.read tweet.write users.read offline.access",
      });
    }),
    http.get(X_USERS_ME_URL, () => {
      return HttpResponse.json({
        data: {
          id: options.userId ?? "x-bdd-user-1",
          username: options.username ?? "xbdduser",
          name: "X BDD User",
        },
      });
    }),
  );
}

async function connectOAuthAccount(
  actor: ApiTestUser,
  connectorSlug: "x" | "slack",
): Promise<string> {
  const started = await accept(
    oauthStartApi.start({
      headers: signIn(actor),
      params: { connectorSlug },
      body: { authMethod: "oauth", account: { intent: "add" } },
    }),
    [200],
  );
  const state = new URL(started.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state || !started.body.connectionId) {
    throw new Error(
      `Expected OAuth state and connectionId for ${connectorSlug}`,
    );
  }
  const completed = await accept(
    oauthCallbackApi.callback({
      headers: {},
      params: { connectorSlug },
      query: {
        code: `oauth-code-${randomUUID()}`,
        state,
        responseMode: "json",
      },
    }),
    [200],
  );
  if (completed.body.status !== "success") {
    throw new Error(`Expected ${connectorSlug} OAuth callback to succeed`);
  }
  return started.body.connectionId;
}

interface TrackedRun {
  readonly runId: string;
  completed: boolean;
}

interface StartedRun {
  readonly runId: string;
  readonly threadId: string;
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

  async function startRun(args: {
    readonly prompt: string;
    readonly model?: string | null;
    readonly runOptions?: {
      readonly reasoningEffort?:
        | "low"
        | "medium"
        | "high"
        | "extra"
        | "xhigh"
        | "max"
        | "ultra"
        | "ultracode";
      readonly codexServiceTier?: "fast" | "ultrafast";
    };
  }): Promise<StartedRun> {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    const sent = await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          prompt: args.prompt,
          model: args.model === undefined ? null : args.model,
          ...(args.runOptions === undefined
            ? {}
            : { runOptions: args.runOptions }),
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
    const execution = await runs.nextReceivedExecution(runnerGroup);
    const tracked: TrackedRun = {
      runId: execution.runId,
      completed: false,
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
    const ownerHeaders = signIn(actor);
    const cancelled = await accept(
      runsCancelApi.cancel({
        headers: ownerHeaders,
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
            exitCode: 1,
            error: "Run cancelled",
          },
        }),
        [200],
      );
    }
    started.tracked.completed = true;
    return cancelled.body;
  }

  return { actor, awaitBootstrap, startRun, cancelRun };
}

describe("RUN-02: stored connector injection into dispatched Runs", () => {
  it(
    "run-lifecycle-connector-injection.bdd-004 injects manual-grant api-token connectors and their optional variables",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, cancelRun } =
        prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const initialToken = "glpat-bdd-initial-secret";
      const reconnectedToken = "glpat-bdd-reconnected-secret";

      const [, connected] = await Promise.all([
        awaitBootstrap(),
        accept(
          builtinManualGrantApi.connect({
            headers: ownerHeaders,
            params: { connectorSlug: "gitlab" },
            body: {
              authMethod: "api-token",
              values: { accessToken: initialToken },
              account: { intent: "add", displayName: "GitLab Primary" },
            },
          }),
          [200],
        ),
      ]);
      const gitlabConnectionId = connected.body.connectionId;

      const firstRun = await startRun({
        prompt: "Inspect GitLab without host",
      });
      expect(firstRun.execution.environment?.GITLAB_TOKEN).toBe(
        "fixture-gitlab-token",
      );
      expect(firstRun.execution.secretConnectorMap?.GITLAB_TOKEN).toBe(
        "gitlab",
      );
      expect(
        firstRun.execution.secretConnectorMetadataMap?.GITLAB_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: gitlabConnectionId,
      });
      expect(firstRun.execution.environment?.GITLAB_HOST).toBeUndefined();
      expect(firstRun.execution.vars?.GITLAB_HOST).toBeUndefined();
      expect(JSON.stringify(firstRun.execution)).not.toContain(initialToken);

      const [firstCancelled] = await Promise.all([
        cancelRun(firstRun, true),
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "gitlab" },
            body: {
              authMethod: "api-token",
              values: {
                accessToken: reconnectedToken,
                host: "gitlab.example.com",
              },
              account: {
                intent: "reconnect",
                connectionId: gitlabConnectionId,
              },
            },
          }),
          [200],
        ),
      ]);
      expect(firstCancelled.status).toBe("cancelled");

      const secondRun = await startRun({
        prompt: "Inspect GitLab with custom host",
      });
      expect(secondRun.execution.environment?.GITLAB_TOKEN).toBe(
        "fixture-gitlab-token",
      );
      expect(secondRun.execution.secretConnectorMap?.GITLAB_TOKEN).toBe(
        "gitlab",
      );
      expect(secondRun.execution.environment?.GITLAB_HOST).toBe(
        "gitlab.example.com",
      );
      expect(secondRun.execution.vars?.GITLAB_HOST).toBe("gitlab.example.com");
      expect(JSON.stringify(secondRun.execution)).not.toContain(
        reconnectedToken,
      );

      const secondCancelled = await cancelRun(secondRun, true);
      expect(secondCancelled.status).toBe("cancelled");

      const queue = await accept(
        runsQueueApi.getQueue({ headers: signIn(actor) }),
        [200],
      );
      expect(queue.body.concurrency.active).toBe(0);
      expect(queue.body.runningTasks).toStrictEqual([]);
    },
  );

  it(
    "run-lifecycle-connector-injection.bdd-001 omits connected stored connectors when the account is disabled for Chats",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockXOAuthProvider({
        accessToken: "x-bdd-disabled-access",
        refreshToken: "x-bdd-disabled-refresh",
      });
      const { actor, awaitBootstrap, startRun, cancelRun } =
        prepareRunEnvironment();

      await Promise.all([
        awaitBootstrap(),
        (async () => {
          const xConnectionId = await connectOAuthAccount(actor, "x");
          await accept(
            accessApi.updateAccountDefault({
              headers: signIn(actor),
              params: { connectionId: xConnectionId },
              body: { target: X_TARGET, enabled: false },
            }),
            [200],
          );
        })(),
      ]);

      const started = await startRun({
        prompt: "Verify disabled X connector is omitted",
      });
      expect(started.execution.environment?.X_TOKEN).toBeUndefined();
      expect(started.execution.secretConnectorMap?.X_TOKEN).toBeUndefined();
      expect(
        started.execution.secretConnectorMetadataMap?.X_TOKEN,
      ).toBeUndefined();
      expect(
        started.execution.firewalls?.find((firewall) => {
          return firewall.kind === "builtin" && firewall.name === "x";
        }),
      ).toBeUndefined();
      expect(started.execution.billableFirewalls).not.toContain("x");
      expect(started.execution.networkPolicies?.x).toBeUndefined();

      const cancelled = await cancelRun(started);
      expect(cancelled.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-connector-injection.bdd-002 injects oauth connector tokens with billable firewalls and resolvable secrets",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockXOAuthProvider({
        accessToken: "x-bdd-access",
        refreshToken: "x-bdd-refresh",
      });
      mockSlackConnectorOAuth();
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();

      const [, xConnectionId] = await Promise.all([
        awaitBootstrap(),
        connectOAuthAccount(actor, "x"),
        (async () => {
          const slackConnectionId = await connectOAuthAccount(actor, "slack");
          await accept(
            accessApi.updateAccountDefault({
              headers: signIn(actor),
              params: { connectionId: slackConnectionId },
              body: { target: SLACK_TARGET, enabled: false },
            }),
            [200],
          );
        })(),
      ]);

      const { execution } = await startRun({
        prompt: "Resolve X OAuth secret while Slack is disabled",
      });

      expect(execution.environment?.X_TOKEN).toBe("fixture-x-token");
      expect(execution.environment?.X_ACCESS_TOKEN).toBeUndefined();
      expect(execution.environment?.X_REFRESH_TOKEN).toBeUndefined();
      expect(JSON.stringify(execution)).not.toContain("x-bdd-access");
      expect(JSON.stringify(execution)).not.toContain("x-bdd-refresh");
      expect(execution.secretConnectorMap?.X_TOKEN).toBe("x");
      expect(execution.secretConnectorMetadataMap?.X_TOKEN).toStrictEqual({
        sourceType: "connector",
        sourceId: xConnectionId,
      });
      expect(execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "x",
          sourceId: xConnectionId,
        }),
      );
      expect(execution.billableFirewalls).toContain("x");
      expect(execution.networkPolicies?.x?.unknownPolicy).toBe("allow");

      expect(execution.environment?.SLACK_TOKEN).toBeUndefined();
      expect(execution.secretConnectorMap?.SLACK_TOKEN).toBeUndefined();
      expect(execution.secretConnectorMetadataMap?.SLACK_TOKEN).toBeUndefined();
      expect(
        execution.firewalls?.find((firewall) => {
          return firewall.kind === "builtin" && firewall.name === "slack";
        }),
      ).toBeUndefined();
      expect(execution.billableFirewalls).not.toContain("slack");
      expect(execution.networkPolicies?.slack).toBeUndefined();

      const resolved = await accept(
        firewallAuthApi.firewallAuth({
          headers: bearerHeaders(execution.firewallToken),
          body: {
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("X_TOKEN")}`,
            },
            secretConnectorMap: execution.secretConnectorMap ?? undefined,
            secretConnectorMetadataMap:
              execution.secretConnectorMetadataMap ?? undefined,
          },
        }),
        [200],
      );
      expect(resolved.body.headers).toStrictEqual({
        Authorization: "Bearer x-bdd-access",
      });
    },
  );

  it(
    "run-lifecycle-connector-injection.bdd-005 keeps prefetched connector credentials behind placeholders in the Runner execution",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const xAccess = "x-bdd-native-access";
      const xRefresh = "x-bdd-native-refresh";
      const gitlabToken = "glpat-bdd-native-secret";
      const figmaToken = "figd_bdd_native_secret";
      mockClaudeCodeTokenEndpoint();
      mockXOAuthProvider({
        accessToken: xAccess,
        refreshToken: xRefresh,
      });
      const { actor, awaitBootstrap, startRun, cancelRun } =
        prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      await Promise.all([
        awaitBootstrap(),
        connectOAuthAccount(actor, "x"),
        accept(
          builtinManualGrantApi.connect({
            headers: ownerHeaders,
            params: { connectorSlug: "gitlab" },
            body: {
              authMethod: "api-token",
              values: { accessToken: gitlabToken },
              account: { intent: "add", displayName: "GitLab Native" },
            },
          }),
          [200],
        ),
        accept(
          builtinManualGrantApi.connect({
            headers: ownerHeaders,
            params: { connectorSlug: "figma" },
            body: {
              authMethod: "api-token",
              values: { accessToken: figmaToken },
              account: { intent: "add", displayName: "Figma Native" },
            },
          }),
          [200],
        ),
        accept(
          onboardingCompleteApi.complete({ headers: ownerHeaders, body: {} }),
          [200],
        ),
        accept(
          personalModelProvidersApi.upsert({
            headers: ownerHeaders,
            body: {
              type: "claude-code-oauth-token",
              secret: "bdd-fable-native-token",
            },
          }),
          [200, 201],
        ),
      ]);

      const started = await startRun({
        prompt:
          "Verify native Runner keeps connector tokens behind placeholders",
        model: "claude-fable-5-1",
      });
      expect(started.execution.cliAgentType).toBe("claude-code");
      expect(started.execution.environment?.X_TOKEN).toBe("fixture-x-token");
      expect(started.execution.environment?.GITLAB_TOKEN).toBe(
        "fixture-gitlab-token",
      );
      expect(started.execution.environment?.FIGMA_TOKEN).toBe(
        "fixture-figma-token",
      );
      expect(started.execution.environment?.X_REFRESH_TOKEN).toBeUndefined();

      const serialized = JSON.stringify(started.execution);
      expect(serialized).not.toContain(xAccess);
      expect(serialized).not.toContain(xRefresh);
      expect(serialized).not.toContain(gitlabToken);
      expect(serialized).not.toContain(figmaToken);

      const cancelled = await cancelRun(started);
      expect(cancelled.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-connector-injection.bdd-007 keeps refresh-owned connector secrets out of the sandbox environment",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, awaitBootstrap, startRun, cancelRun } =
        prepareRunEnvironment();
      const ownerHeaders = signIn(actor);
      const larkAppId = "cli_bdd_lark_primary";
      const larkAppSecret = "lark-bdd-secret-primary";
      const figmaToken = "figd_bdd_unrelated";

      const [, larkPrimary, figmaConnected] = await Promise.all([
        awaitBootstrap(),
        accept(
          builtinManualGrantApi.connect({
            headers: ownerHeaders,
            params: { connectorSlug: "lark" },
            body: {
              authMethod: "api-token",
              values: { appId: larkAppId, appSecret: larkAppSecret },
              account: { intent: "add", displayName: "Lark Primary" },
            },
          }),
          [200],
        ),
        accept(
          builtinManualGrantApi.connect({
            headers: ownerHeaders,
            params: { connectorSlug: "figma" },
            body: {
              authMethod: "api-token",
              values: { accessToken: figmaToken },
              account: { intent: "add", displayName: "Figma Unrelated" },
            },
          }),
          [200],
        ),
      ]);
      const larkPrimaryId = larkPrimary.body.connectionId;
      const figmaConnectionId = figmaConnected.body.connectionId;

      const started = await startRun({
        prompt: "Sync refresh-owned Lark connector across default switch",
      });
      expect(started.execution.environment?.LARK_TOKEN).toBe(
        "fixture-lark-token",
      );
      expect(started.execution.environment?.LARK_APP_ID).toBeUndefined();
      expect(started.execution.environment?.LARK_APP_SECRET).toBeUndefined();
      expect(started.execution.environment?.LARK_ACCESS_TOKEN).toBeUndefined();
      expect(JSON.stringify(started.execution)).not.toContain(larkAppId);
      expect(JSON.stringify(started.execution)).not.toContain(larkAppSecret);
      expect(
        started.execution.secretConnectorMetadataMap?.LARK_TOKEN,
      ).toStrictEqual({
        sourceType: "connector",
        sourceId: larkPrimaryId,
      });
      expect(started.execution.firewalls).toContainEqual(
        expect.objectContaining({
          kind: "builtin",
          name: "lark",
          sourceId: larkPrimaryId,
        }),
      );
      const larkTarget = started.execution.connectorRuntimeTargets.find(
        (target) => {
          return target.kind === "builtin" && target.connectorSlug === "lark";
        },
      );
      expect(larkTarget).toStrictEqual({
        kind: "builtin",
        connectorSlug: "lark",
        sourceId: larkPrimaryId,
      });
      if (!larkTarget) {
        throw new Error("Expected Lark connector runtime target");
      }

      const [firstSync, larkSibling] = await Promise.all([
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: started.runId },
            body: { targets: [larkTarget] },
          }),
          [200],
        ),
        accept(
          builtinManualGrantApi.connect({
            headers: signIn(actor),
            params: { connectorSlug: "lark" },
            body: {
              authMethod: "api-token",
              values: {
                appId: "cli_bdd_lark_sibling",
                appSecret: "lark-bdd-secret-sibling",
              },
              account: { intent: "add", displayName: "Lark Sibling" },
            },
          }),
          [200],
        ),
      ]);
      expect(firstSync.body.results).toStrictEqual([
        expect.objectContaining({
          target: LARK_TARGET,
          state: "available",
          accountBinding: {
            connectionId: larkPrimaryId,
            baseUrlVars: {},
          },
        }),
      ]);

      const larkSiblingId = larkSibling.body.connectionId;
      const promoted = await accept(
        connectorAccountsApi.setDefault({
          headers: signIn(actor),
          params: { connectionId: larkSiblingId },
          body: { target: LARK_TARGET },
        }),
        [200],
      );
      expect(promoted.body.isDefault).toBeTruthy();

      const [exactSync, sourceLessSync, wrongSourceSync] = await Promise.all([
        accept(
          runnerSyncApi.sync({
            headers: officialRunnerHeaders(),
            params: { runId: started.runId },
            body: {
              targets: [
                {
                  kind: "builtin",
                  connectorSlug: "lark",
                  sourceId: larkPrimaryId,
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
            body: { targets: [LARK_TARGET] },
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
                  kind: "builtin",
                  connectorSlug: "lark",
                  sourceId: figmaConnectionId,
                },
              ],
            },
          }),
          [200],
        ),
      ]);

      expect(exactSync.body.results).toStrictEqual([
        expect.objectContaining({
          target: LARK_TARGET,
          state: "available",
          accountBinding: {
            connectionId: larkSiblingId,
            baseUrlVars: {},
          },
        }),
      ]);
      expect(sourceLessSync.body.results).toStrictEqual(exactSync.body.results);
      expect(wrongSourceSync.body.results).toStrictEqual(
        exactSync.body.results,
      );

      const cancelled = await cancelRun(started);
      expect(cancelled.status).toBe("cancelled");
    },
  );

  it(
    "run-lifecycle-connector-injection.bdd-012 dispatches a public Codex subscription generation 3 with its captured tier",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockCodexDeviceAuthProvider({
        accountId: "ws_acct_bdd_codex_gen3",
      });
      const { actor, awaitBootstrap, startRun } = prepareRunEnvironment();
      const ownerHeaders = signIn(actor);

      const [codexStart] = await Promise.all([
        accept(
          codexDeviceAuthApi.start({
            headers: ownerHeaders,
            body: { scope: "personal", mode: "add" },
          }),
          [200],
        ),
        awaitBootstrap(),
        accept(
          onboardingCompleteApi.complete({ headers: ownerHeaders, body: {} }),
          [200],
        ),
      ]);

      const codexCompleted = await accept(
        codexDeviceAuthApi.complete({
          headers: signIn(actor),
          body: { sessionToken: codexStart.body.sessionToken },
        }),
        [200],
      );
      expect(codexCompleted.body.status).toBe("complete");

      const started = await startRun({
        prompt: "Dispatch Codex subscription generation 3 with fast tier",
        model: "gpt-6-luna",
        runOptions: {
          reasoningEffort: "high",
          codexServiceTier: "fast",
        },
      });

      expect(started.execution.cliAgentType).toBe("pi");
      expect(started.execution.piSessionId).toBe(started.threadId);
      expect(started.execution.piModelConfig).toStrictEqual({
        schemaVersion: 3,
        dialect: "openai-codex-responses",
        transport: "sse",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        model: "gpt-6-luna",
        thinkingLevel: "high",
        serviceTier: "fast",
        credentialBindings: [
          {
            kind: "access-token",
            environment: "CHATGPT_ACCESS_TOKEN",
            secretName: "CHATGPT_ACCESS_TOKEN",
          },
          {
            kind: "account-id",
            environment: "CHATGPT_ACCOUNT_ID",
            secretName: "CHATGPT_ACCOUNT_ID",
          },
        ],
      });
    },
  );
});
