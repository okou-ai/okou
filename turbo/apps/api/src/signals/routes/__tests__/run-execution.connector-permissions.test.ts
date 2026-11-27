import { randomUUID } from "node:crypto";
import {
  chatEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { builtinConnectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import {
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
} from "@okouai/api-contracts/contracts/runners";
import {
  webhookClerkContract,
  webhookCompleteContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { builtinConnectorsRoutes } from "../connectors";
import { builtinConnectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { runnersRoutes } from "../runners";
import { runsCancelRoutes } from "../runs-cancel";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksClerkRoutes } from "../webhooks-clerk";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import {
  mockGitHubConnectorOAuth,
  mockSlackConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chatCallbacks = createChatCallbacksApi(context);
const webhooks = createWebhookCallbackApi(context);

const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});
const GITHUB_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "github" as const,
});
const SLACK_TARGET = Object.freeze({
  kind: "builtin" as const,
  connectorSlug: "slack" as const,
});
const HALF_HOUR_MS = 30 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const app = setupApp({
  context,
  routes: [
    ...chatThreadCreateRoutes,
    ...chatEventsRoutes,
    ...builtinConnectorsRoutes,
    ...builtinConnectorsSlugCallbackRoutes,
    ...connectorPermissionsRoutes,
    ...runnersRoutes,
    ...runsCancelRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksClerkRoutes,
  ],
});
const threadsApi = app(chatThreadsContract);
const chatEventsApi = app(chatEventsContract);
const oauthStartApi = app(builtinConnectorOauthStartContract);
const oauthCallbackApi = app(builtinConnectorsSlugCallbackContract);
const permissionsApi = app(connectorPermissionsContract);
const runnerHeartbeatApi = app(runnersHeartbeatContract);
const runnerSyncApi = app(runnersConnectorRuntimeSyncContract);
const runsCancelApi = app(runsCancelContract);
const agentCompleteApi = app(webhookCompleteContract);
const clerkWebhookApi = app(webhookClerkContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const missingId = randomUUID();
  await Promise.all([
    accept(threadsApi.create({ headers: {}, body: { model: null } }), [401]),
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
      oauthStartApi.start({
        headers: {},
        params: { connectorSlug: "github" },
        body: { authMethod: "oauth", account: { intent: "add" } },
      }),
      [401],
    ),
    accept(
      permissionsApi.apply({
        headers: {},
        body: {
          target: GITHUB_TARGET,
          mode: "replace",
          grants: [],
        },
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

interface TrackedRun {
  readonly runId: string;
  readonly sandboxToken: string;
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
  const runnerIdentity = {
    runnerId: randomUUID(),
    heartbeatGeneration: 1,
  };
  const runnerHostname = `runner-${runnerIdentity.runnerId}.okou.app`;

  webhooks.configureClerkWebhookSecret();
  webhooks.verifyNextClerkWebhook({
    type: "organization.created",
    data: { id: actor.orgId, created_by: actor.userId, created_at: now() },
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
            await accept(
              runsCancelApi.cancel({
                headers: ownerHeaders,
                params: { id: tracked.runId },
              }),
              [200],
            );
            await accept(
              agentCompleteApi.complete({
                headers: bearerHeaders(tracked.sandboxToken),
                body: {
                  runId: tracked.runId,
                  exitCode: 1,
                  error: "Run cancelled",
                },
              }),
              [200],
            );
            tracked.completed = true;
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

  async function awaitBootstrap() {
    const [runnerGroup] = await Promise.all([
      runnerGroupPromise,
      orgCreatedPromise,
    ]);
    resolvedRunnerGroup = runnerGroup;
    return runnerGroup;
  }

  async function connectOAuth(connectorSlug: "github" | "slack") {
    if (connectorSlug === "github") {
      mockGitHubConnectorOAuth();
    } else {
      mockSlackConnectorOAuth();
    }
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
    if (!state) {
      throw new Error(`Expected OAuth state for ${connectorSlug}`);
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
  }

  async function refreshRunnerHeartbeat(snapshotSequence: number) {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    await accept(
      runnerHeartbeatApi.heartbeat({
        headers: officialRunnerHeaders(),
        body: {
          runnerId: runnerIdentity.runnerId,
          runnerHostname,
          group: runnerGroup,
          snapshotGeneration: runnerIdentity.heartbeatGeneration,
          snapshotSequence,
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

  async function sendPrompt(threadId: string, prompt: string) {
    await accept(
      chatEventsApi.send({
        headers: signIn(actor),
        body: {
          threadId,
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
  }

  async function runCancelAndQueueNext(
    threadId: string,
    firstPrompt: string,
    queuedPrompt: string,
  ) {
    const runnerGroup = resolvedRunnerGroup ?? (await awaitBootstrap());
    await sendPrompt(threadId, firstPrompt);
    const firstExecution = await runs.nextReceivedExecution(runnerGroup);
    const firstTracked: TrackedRun = {
      runId: firstExecution.runId,
      sandboxToken: firstExecution.sandboxToken,
      completed: false,
    };
    trackedRuns.push(firstTracked);

    await accept(
      runsCancelApi.cancel({
        headers: signIn(actor),
        params: { id: firstExecution.runId },
      }),
      [200],
    );

    await sendPrompt(threadId, queuedPrompt);
    await flushWaitUntilForTest();
    expect(runs.unobservedDispatches(runnerGroup)).toStrictEqual([]);

    return {
      firstExecution,
      async launchQueuedRun() {
        await accept(
          agentCompleteApi.complete({
            headers: bearerHeaders(firstExecution.sandboxToken),
            body: {
              runId: firstExecution.runId,
              exitCode: 1,
              error: "Run cancelled",
            },
          }),
          [200],
        );
        firstTracked.completed = true;
        const execution = await runs.nextReceivedExecution(runnerGroup);
        const tracked: TrackedRun = {
          runId: execution.runId,
          sandboxToken: execution.sandboxToken,
          completed: false,
        };
        trackedRuns.push(tracked);
        return { runId: execution.runId, execution, tracked };
      },
    };
  }

  return {
    actor,
    awaitBootstrap,
    connectOAuth,
    refreshRunnerHeartbeat,
    runCancelAndQueueNext,
  };
}

describe("Execution connector permissions", () => {
  it(
    "run-execution.connector-permissions-004 evaluates active temporary grant before expiry and denies at expiry on runtime sync",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const baseMs = now();
      mockNow(baseMs);
      const envState = prepareRunEnvironment();
      const ownerHeaders = signIn(envState.actor);

      const [, thread] = await Promise.all([
        envState.awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        envState.connectOAuth("slack"),
      ]);

      const granted = await accept(
        permissionsApi.apply({
          headers: signIn(envState.actor),
          body: {
            target: SLACK_TARGET,
            mode: "replace",
            grants: [
              { permission: "chat:write", action: "allow", expiresIn: "1h" },
            ],
          },
        }),
        [200],
      );
      const grantExpiresAt = granted.body.grants[0]?.expiresAt;
      expect(grantExpiresAt).toBeTruthy();
      expect(Date.parse(grantExpiresAt ?? "")).toBe(baseMs + ONE_HOUR_MS);

      const queued = await envState.runCancelAndQueueNext(
        thread.body.id,
        "Run before temporary Slack grant check",
        "Check active temporary Slack grant",
      );

      mockNow(baseMs + HALF_HOUR_MS);
      await envState.refreshRunnerHeartbeat(2);
      const launched = await queued.launchQueuedRun();

      expect(launched.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining(SLACK_TARGET),
      );
      expect(launched.execution.networkPolicies?.slack?.allow).toContain(
        "chat:write",
      );
      expect(launched.execution.networkPolicies?.slack?.deny).not.toContain(
        "chat:write",
      );
      expect(launched.execution.networkPolicyRefreshes?.slack).toStrictEqual({
        nextRefreshAt: grantExpiresAt,
      });

      mockNow(baseMs + ONE_HOUR_MS);
      const synced = await accept(
        runnerSyncApi.sync({
          headers: officialRunnerHeaders(),
          params: { runId: launched.runId },
          body: { targets: launched.execution.connectorRuntimeTargets },
        }),
        [200],
      );
      const slackSync = synced.body.results.find((result) => {
        return (
          result.target.kind === "builtin" &&
          result.target.connectorSlug === "slack"
        );
      });
      expect(slackSync).toMatchObject({
        target: SLACK_TARGET,
        state: "available",
      });
      if (slackSync?.state !== "available") {
        throw new Error(
          "Expected Slack connector runtime sync to be available",
        );
      }
      expect(slackSync.networkPolicy.deny).toContain("chat:write");
      expect(slackSync.networkPolicy.allow).not.toContain("chat:write");
      expect(slackSync.nextSyncAt).toBeUndefined();
    },
  );

  it(
    "run-execution.connector-permissions-002 applies an added deny grant made after the Run was queued",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envState = prepareRunEnvironment();
      const ownerHeaders = signIn(envState.actor);

      const [, thread] = await Promise.all([
        envState.awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        envState.connectOAuth("github"),
      ]);

      const queued = await envState.runCancelAndQueueNext(
        thread.body.id,
        "Run before denying GitHub user:read",
        "Check GitHub policy after post-queue deny",
      );
      expect(queued.firstExecution.networkPolicies?.github?.allow).toContain(
        "user:read",
      );

      await accept(
        permissionsApi.apply({
          headers: signIn(envState.actor),
          body: {
            target: GITHUB_TARGET,
            mode: "patch",
            grants: [{ permission: "user:read", action: "deny" }],
          },
        }),
        [200],
      );

      const launched = await queued.launchQueuedRun();

      expect(launched.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining(GITHUB_TARGET),
      );
      expect(launched.execution.networkPolicies?.github?.deny).toContain(
        "user:read",
      );
      expect(launched.execution.networkPolicies?.github?.allow).not.toContain(
        "user:read",
      );
      expect(launched.execution.networkPolicies?.github?.allow).toContain(
        "notifications:read",
      );
    },
  );

  it(
    "run-execution.connector-permissions-003 applies a revoked deny grant made after the Run was queued",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const envState = prepareRunEnvironment();
      const ownerHeaders = signIn(envState.actor);

      const [, thread] = await Promise.all([
        envState.awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        envState.connectOAuth("github"),
      ]);

      await accept(
        permissionsApi.apply({
          headers: signIn(envState.actor),
          body: {
            target: GITHUB_TARGET,
            mode: "replace",
            grants: [{ permission: "user:read", action: "deny" }],
          },
        }),
        [200],
      );

      const queued = await envState.runCancelAndQueueNext(
        thread.body.id,
        "Run while GitHub user:read is denied",
        "Check GitHub policy after post-queue revoke",
      );
      expect(queued.firstExecution.networkPolicies?.github?.deny).toContain(
        "user:read",
      );

      await accept(
        permissionsApi.apply({
          headers: signIn(envState.actor),
          body: {
            target: GITHUB_TARGET,
            mode: "replace",
            grants: [],
          },
        }),
        [200],
      );

      const launched = await queued.launchQueuedRun();

      expect(launched.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining(GITHUB_TARGET),
      );
      expect(launched.execution.networkPolicies?.github?.allow).toContain(
        "user:read",
      );
      expect(launched.execution.networkPolicies?.github?.deny).not.toContain(
        "user:read",
      );
      expect(launched.execution.networkPolicies?.github?.allow).toContain(
        "notifications:read",
      );
    },
  );

  it(
    "run-execution.connector-permissions-005 denies an expired temporary grant when expiry occurs before queued Run preparation",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const baseMs = now();
      mockNow(baseMs);
      const envState = prepareRunEnvironment();
      const ownerHeaders = signIn(envState.actor);

      const [, thread] = await Promise.all([
        envState.awaitBootstrap(),
        accept(
          threadsApi.create({ headers: ownerHeaders, body: { model: null } }),
          [201],
        ),
        envState.connectOAuth("slack"),
      ]);

      const granted = await accept(
        permissionsApi.apply({
          headers: signIn(envState.actor),
          body: {
            target: SLACK_TARGET,
            mode: "replace",
            grants: [
              { permission: "chat:write", action: "allow", expiresIn: "1h" },
            ],
          },
        }),
        [200],
      );
      expect(Date.parse(granted.body.grants[0]?.expiresAt ?? "")).toBe(
        baseMs + ONE_HOUR_MS,
      );

      const queued = await envState.runCancelAndQueueNext(
        thread.body.id,
        "Run before temporary Slack grant expires",
        "Check expired temporary Slack grant",
      );

      mockNow(baseMs + ONE_HOUR_MS);
      await envState.refreshRunnerHeartbeat(2);
      const launched = await queued.launchQueuedRun();

      expect(launched.execution.connectorRuntimeTargets).toContainEqual(
        expect.objectContaining(SLACK_TARGET),
      );
      expect(launched.execution.networkPolicies?.slack?.allow).not.toContain(
        "chat:write",
      );
      expect(launched.execution.networkPolicies?.slack?.deny).toContain(
        "chat:write",
      );
      expect(launched.execution.networkPolicyRefreshes).toBeUndefined();
    },
  );
});
