import { randomUUID } from "node:crypto";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { runModelsRoutes } from "../run-models";
import { userPreferencesRoutes } from "../user-preferences";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { publicPlanLifecycle } from "./helpers/public-plan-lifecycle";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member",
): void {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

async function listRunModels() {
  const api = setupApp({ context, routes: runModelsRoutes })(
    runModelsMainContract,
  );
  return (await accept(api.list({ headers }), [200])).body.models;
}

async function setupWorkspaceWithOwnerClaude() {
  const orgId = `org_${randomUUID()}`;
  const ownerId = `user_${randomUUID()}`;
  const memberId = `user_${randomUUID()}`;

  signIn(ownerId, orgId, "org:admin");
  mockClaudeCodeTokenEndpoint();
  await accept(
    setupApp({ context, routes: meModelProvidersUpsertRoutes })(
      personalModelProvidersMainContract,
    ).upsert({
      headers,
      body: {
        type: "claude-code-oauth-token",
        secret: "owner-claude-token",
      },
    }),
    [201],
  );

  signIn(memberId, orgId, "org:member");
  await accept(
    setupApp({ context, routes: userPreferencesRoutes })(
      userPreferencesContract,
    ).initialize({
      headers,
      body: { locale: "en-US" },
    }),
    [200],
  );

  return { orgId, ownerId, memberId };
}

describe("member-effective model contract", () => {
  it("personal-subscription-run-identity-031 (1/2) shares Auto and scopes the owner's Claude subscription to the owner", async () => {
    const { orgId, ownerId, memberId } = await setupWorkspaceWithOwnerClaude();

    signIn(ownerId, orgId, "org:admin");
    const ownerInitial = await listRunModels();

    signIn(memberId, orgId, "org:member");
    const memberInitial = await listRunModels();

    const ownerAuto = ownerInitial.find((entry) => {
      return entry.model === "auto";
    });
    const memberAuto = memberInitial.find((entry) => {
      return entry.model === "auto";
    });
    expect(ownerAuto).toBeDefined();
    expect(ownerAuto?.modelLabel).toBe("Auto");
    expect(memberAuto).toStrictEqual(ownerAuto);

    const ownerClaude = ownerInitial.find((entry) => {
      return entry.model === "claude-sonnet-5-5";
    });
    expect(ownerClaude).toBeDefined();
    expect(ownerClaude?.memberEffective).toMatchObject({
      runtimeProviderType: "claude-code-oauth-token",
      credentialScope: "member",
      accountSelection: "capture_required",
    });
    expect(
      memberInitial.some((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toBeFalsy();
  });

  it("personal-subscription-run-identity-031 (2/2) scopes a member's Codex subscription without changing the owner's models", async () => {
    const { orgId, ownerId, memberId } = await setupWorkspaceWithOwnerClaude();

    signIn(ownerId, orgId, "org:admin");
    const ownerBefore = (await listRunModels()).find((entry) => {
      return entry.model === "claude-sonnet-5-5";
    });

    signIn(memberId, orgId, "org:member");
    await accept(
      setupApp({ context, routes: meModelProvidersUpsertRoutes })(
        personalModelProvidersMainContract,
      ).upsert({
        headers,
        body: {
          type: "codex-oauth-token",
          authMethod: "auth_json",
          secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
        },
      }),
      [201],
    );

    const memberAfter = await listRunModels();
    const memberCodex = memberAfter.find((entry) => {
      return entry.model === "gpt-6-astra";
    });
    expect(memberCodex).toBeDefined();
    expect(memberCodex?.memberEffective).toMatchObject({
      runtimeProviderType: "codex-oauth-token",
      credentialScope: "member",
    });
    expect(
      memberAfter.some((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toBeFalsy();

    signIn(ownerId, orgId, "org:admin");
    const ownerAfter = await listRunModels();
    expect(
      ownerAfter.some((entry) => {
        return entry.model === "gpt-6-astra";
      }),
    ).toBeFalsy();
    expect(
      ownerAfter.find((entry) => {
        return entry.model === "claude-sonnet-5-5";
      }),
    ).toStrictEqual(ownerBefore);
  });
});

describe("personal subscription run identity", () => {
  const bdd = createBddApi(context);
  const runsApi = createRunsApi(context);
  const runReads = createRunReadsApi(context);
  const chat = createChatFilesBddApi(context);
  const chatCallbacks = createChatCallbacksApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const authDevice = createAuthDeviceApiActions(context);
  const authDeviceSupport = createAuthDeviceSupportApi(context);
  const firewall = createFirewallApi(context);

  beforeAll(async () => {
    await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
    });
  });

  function registerRunCleanup(
    actor: ApiTestUser,
    tokens: ReadonlyMap<string, string>,
  ): void {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const kmsKey = env("SECRETS_KMS_KEY_ID");
    const runnerGroup = optionalEnv("RUNNER_DEFAULT_GROUP");

    onTestFinished(async () => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
      mockEnv("SECRETS_KMS_KEY_ID", kmsKey);
      if (runnerGroup) {
        mockOptionalEnv("RUNNER_DEFAULT_GROUP", runnerGroup);
      }
      context.mocks.ably.publish.mockResolvedValue(undefined);
      await settleIncludingAbort(flushWaitUntilForTest);
      const logs = await runReads.requestListLogs(actor, { limit: 100 }, [200]);
      for (const run of logs.body.data) {
        if (["queued", "pending", "running"].includes(run.status)) {
          await runsApi.requestCancelRun(actor, run.id, [200, 400]);
        }
        const token = tokens.get(run.id);
        if (token && !["completed", "failed", "timeout"].includes(run.status)) {
          await webhooks.requestAgentComplete(
            { runId: run.id, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${token}` },
            [200],
          );
        }
      }
      await settleIncludingAbort(flushWaitUntilForTest);
    });
  }

  async function setupProMember(
    options: { readonly configureStripeEnv?: boolean } = {},
  ) {
    const actor = bdd.user({ orgRole: "org:admin" });
    chatCallbacks.acceptChatObjectStorage();
    runsApi.acceptStorageDownloads();
    runsApi.acceptTelemetryIngest();
    chatCallbacks.disableVapid();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    if (options.configureStripeEnv) {
      webhooks.configureStripeBillingEnv();
    }
    await runsApi.configureRunnerGroup();
    const entitlement = await runsApi.grantProEntitlement(actor);
    const tokens = new Map<string, string>();
    registerRunCleanup(actor, tokens);
    return { actor, entitlement, tokens };
  }

  async function setupFailedCodexAWithActiveB() {
    const { actor, tokens } = await setupProMember();
    const codexA = await runsApi.createPersonalModelProvider(actor, {
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secrets: {
        CODEX_AUTH_JSON: makeCodexAuthJson({
          accountId: "identity-a",
          refreshToken: `rt_a_${randomUUID()}`,
        }),
      },
    });
    const run = await chat.sendAndLaunch(actor, {
      prompt: "Run on Codex account A",
      model: "gpt-6-astra",
    });
    const execution = await runsApi.executionInput(run.runId);
    tokens.set(run.runId, execution.sandboxToken);
    await webhooks.requestAgentComplete(
      {
        runId: run.runId,
        exitCode: 1,
        error: "Rate limit exceeded",
        failureReason: "usage_limit",
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();

    mockCodexDeviceAuthProvider({ accountId: "identity-b" });
    const startedB = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedB.status !== 200) {
      throw new Error("Expected Codex device auth start for B");
    }
    const completedB = await authDevice.requestCodexComplete(
      actor,
      startedB.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedB.body) ||
      completedB.body.status !== "complete"
    ) {
      throw new Error("Expected Codex device auth completion for B");
    }
    const accountBId = completedB.body.provider.id;
    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      accountBId,
    );

    const seenAccountIds: string[] = [];
    const consumeBodies: string[] = [];
    let consumeCalls = 0;
    let totalChatGptCalls = 0;

    server.use(
      http.get("https://chatgpt.com/backend-api/wham/usage", ({ request }) => {
        totalChatGptCalls += 1;
        const accountHeader = request.headers.get("chatgpt-account-id");
        if (accountHeader) {
          seenAccountIds.push(accountHeader);
        }
        return HttpResponse.json({
          plan_type: "plus",
          rate_limit_reset_credits: { available_count: 1 },
        });
      }),
      http.get(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        ({ request }) => {
          totalChatGptCalls += 1;
          const accountHeader = request.headers.get("chatgpt-account-id");
          if (accountHeader) {
            seenAccountIds.push(accountHeader);
          }
          return HttpResponse.json({ credits: [] });
        },
      ),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        async ({ request }) => {
          totalChatGptCalls += 1;
          consumeCalls += 1;
          const accountHeader = request.headers.get("chatgpt-account-id");
          if (accountHeader) {
            seenAccountIds.push(accountHeader);
          }
          consumeBodies.push(await request.text());
          return HttpResponse.json({
            code: consumeCalls === 1 ? "reset" : "already_redeemed",
          });
        },
      ),
    );

    return {
      actor,
      accountAId: codexA.providerId,
      accountBId,
      runId: run.runId,
      seenAccountIds,
      consumeBodies,
      getTotalChatGptCalls: () => {
        return totalChatGptCalls;
      },
    };
  }

  it(
    "personal-subscription-run-identity-002 preserves proven recovery identity for claude-code-oauth-token pending admission",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      mockClaudeCodeTokenEndpoint({ accountEmail: "identity-a@example.com" });
      const accountA = await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "claude-identity-a-token",
      });

      const first = await chat.sendAndLaunch(actor, {
        prompt: "First Claude run on identity A",
        model: "claude-sonnet-5-5",
      });
      const firstExec = await runsApi.executionInput(first.runId);
      tokens.set(first.runId, firstExec.sandboxToken);

      const second = await chat.sendAndLaunch(actor, {
        prompt: "Second Claude run on identity A",
        model: "claude-sonnet-5-5",
      });
      const secondExec = await runsApi.executionInput(second.runId);
      tokens.set(second.runId, secondExec.sandboxToken);

      const beforeReconnect = await runsApi.readRun(actor, second.runId);
      expect(beforeReconnect.status).toBe("running");
      expect(beforeReconnect.source.account).toStrictEqual({
        status: "connected",
        id: accountA.providerId,
      });

      mockClaudeCodeTokenEndpoint({ accountEmail: "identity-b@example.com" });
      await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "claude-identity-b-token",
      });

      const afterReconnect = await runsApi.readRun(actor, second.runId);
      expect(afterReconnect.source.account).toStrictEqual({
        status: "unavailable",
      });
    },
  );

  it(
    "personal-subscription-run-identity-004 runs a free-plan member's claude-code-oauth-token subscription model on its subscription route",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user({ orgRole: "org:admin" });
      chatCallbacks.acceptChatObjectStorage();
      runsApi.acceptStorageDownloads();
      runsApi.acceptTelemetryIngest();
      chatCallbacks.disableVapid();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      await runsApi.configureRunnerGroup();
      await bdd.bootstrapLimitedFreeOnboarding(actor);

      mockClaudeCodeTokenEndpoint({ accountEmail: "free-claude@example.com" });
      const provider = await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "free-claude-token",
      });

      const tokens = new Map<string, string>();
      registerRunCleanup(actor, tokens);

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Free plan Claude Opus run",
        model: "claude-opus-5-5",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      const running = await runsApi.readRun(actor, launched.runId);
      expect(running.status).toBe("running");
      expect(
        execution.secretConnectorMetadataMap?.CLAUDE_CODE_OAUTH_TOKEN,
      ).toMatchObject({
        sourceType: "model-provider",
        sourceUserId: actor.userId,
        sourceId: provider.providerId,
      });
      expect(execution.billableFirewalls ?? []).toHaveLength(0);

      await webhooks.requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Expected test failure" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const failed = await runsApi.readRun(actor, launched.runId);
      expect(failed.status).toBe("failed");
    },
  );

  it(
    "personal-subscription-run-identity-005 runs a free-plan member's codex-oauth-token subscription model on its subscription route",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const actor = bdd.user({ orgRole: "org:admin" });
      chatCallbacks.acceptChatObjectStorage();
      runsApi.acceptStorageDownloads();
      runsApi.acceptTelemetryIngest();
      chatCallbacks.disableVapid();
      mockOptionalEnv("OPENROUTER_API_KEY", undefined);
      await runsApi.configureRunnerGroup();
      await bdd.bootstrapLimitedFreeOnboarding(actor);

      const provider = await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "free-codex-acct",
          }),
        },
      });

      const tokens = new Map<string, string>();
      registerRunCleanup(actor, tokens);

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Free plan GPT Sol run",
        model: "gpt-6-sol",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      const running = await runsApi.readRun(actor, launched.runId);
      expect(running.status).toBe("running");
      expect(
        execution.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
      ).toMatchObject({
        sourceType: "model-provider",
        sourceUserId: actor.userId,
        sourceId: provider.providerId,
      });
      expect(execution.billableFirewalls ?? []).toHaveLength(0);

      await webhooks.requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Expected test failure" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const failed = await runsApi.readRun(actor, launched.runId);
      expect(failed.status).toBe("failed");
    },
  );

  it(
    "personal-subscription-run-identity-006 recovers the captured account and preserves reset idempotency",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupFailedCodexAWithActiveB();

      const run = await runsApi.readRun(setup.actor, setup.runId);
      expect(run.source).toMatchObject({
        providerType: "codex-oauth-token",
        model: "gpt-6-astra",
        credentialScope: "member",
        account: { status: "connected", id: setup.accountAId },
      });

      const accountRead =
        await authDeviceSupport.readPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          setup.runId,
          [200],
        );
      if (accountRead.status !== 200) {
        throw new Error("Expected failed-run account read to succeed");
      }
      expect(accountRead.body.id).toBe(setup.accountAId);
      expect(accountRead.body.subscriptionResetCredits).toBe(1);

      const idempotencyKey = randomUUID();
      const firstReset =
        await authDeviceSupport.resetPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          idempotencyKey,
          [200],
          setup.runId,
        );
      const secondReset =
        await authDeviceSupport.resetPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          idempotencyKey,
          [200],
          setup.runId,
        );
      if (firstReset.status !== 200 || secondReset.status !== 200) {
        throw new Error("Expected failed-run subscription resets to succeed");
      }
      expect(firstReset.body.outcome).toBe("reset");
      expect(secondReset.body.outcome).toBe("alreadyRedeemed");
      expect(setup.consumeBodies.length).toBeGreaterThanOrEqual(1);
      expect(
        setup.consumeBodies.every((body) => {
          return body === setup.consumeBodies[0];
        }),
      ).toBeTruthy();
      expect(setup.seenAccountIds).not.toContain("identity-b");
    },
  );

  it(
    "personal-subscription-run-identity-007 denies another member access to the captured account and reset",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupFailedCodexAWithActiveB();
      const otherMember = bdd.user({
        orgId: setup.actor.orgId,
        orgRole: "org:member",
      });

      const ownerRead =
        await authDeviceSupport.readPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          setup.runId,
          [200],
        );
      if (ownerRead.status !== 200) {
        throw new Error("Expected owner recovery account read to succeed");
      }
      expect(ownerRead.body.id).toBe(setup.accountAId);
      expect(ownerRead.body.subscriptionResetCredits).toBe(1);

      const ownerReset =
        await authDeviceSupport.resetPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          randomUUID(),
          [200],
          setup.runId,
        );
      if (ownerReset.status !== 200) {
        throw new Error("Expected owner recovery reset to succeed");
      }
      expect(ownerReset.body.outcome).toBe("reset");
      expect(setup.seenAccountIds).not.toContain("identity-b");

      const otherRead =
        await authDeviceSupport.readPersonalModelProviderAccount(
          otherMember,
          setup.accountAId,
          setup.runId,
          [404],
        );
      const otherReset =
        await authDeviceSupport.resetPersonalModelProviderAccount(
          otherMember,
          setup.accountAId,
          randomUUID(),
          [404],
          setup.runId,
        );
      expect(otherRead.status).toBe(404);
      expect(otherReset.status).toBe(404);
    },
  );

  it(
    "personal-subscription-run-identity-009 removes recovery after the captured account is deleted",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const setup = await setupFailedCodexAWithActiveB();

      const beforeDelete =
        await authDeviceSupport.readPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          setup.runId,
          [200],
        );
      expect(beforeDelete.status).toBe(200);

      await authDeviceSupport.deletePersonalModelProviderAccount(
        setup.actor,
        setup.accountAId,
      );
      const callsAfterDelete = setup.getTotalChatGptCalls();

      const runAfterDelete = await runsApi.readRun(setup.actor, setup.runId);
      expect(runAfterDelete.source.account).toStrictEqual({
        status: "unavailable",
      });

      const retryRead =
        await authDeviceSupport.readPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          setup.runId,
          [404],
        );
      const retryReset =
        await authDeviceSupport.resetPersonalModelProviderAccount(
          setup.actor,
          setup.accountAId,
          randomUUID(),
          [404],
          setup.runId,
        );
      expect(retryRead.status).toBe(404);
      expect(retryReset.status).toBe(404);
      expect(setup.getTotalChatGptCalls()).toBe(callsAfterDelete);
    },
  );

  it(
    "personal-subscription-run-identity-010 admits one canonical run for concurrent idempotent chat sends",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "idempotent-codex-acct",
          }),
        },
      });
      const thread = await chat.createThread(actor, { model: "gpt-6-astra" });
      const clientEventId = randomUUID();
      const sendBody = {
        threadId: thread.id,
        prompt: "Idempotent concurrent prompt",
        clientEventId,
      };

      const [firstSend, secondSend] = await Promise.all([
        chat.requestSendEvent(actor, sendBody, [201]),
        chat.requestSendEvent(actor, sendBody, [201]),
      ]);
      expect(firstSend.status).toBe(201);
      expect(secondSend.status).toBe(201);
      await flushWaitUntilForTest();

      const beforeComplete = await chat.listThreadEvents(actor, thread.id);
      const claimedPrompts = beforeComplete.events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      expect(claimedPrompts).toHaveLength(1);
      const runId = claimedPrompts[0]?.runId;
      if (!runId) {
        throw new Error("Expected one claimed run ID");
      }

      const execution = await runsApi.executionInput(runId);
      tokens.set(runId, execution.sandboxToken);
      await webhooks.requestAgentComplete(
        {
          runId,
          exitCode: 0,
          completion: {
            cliAgentType: "codex",
            cliAgentSessionId: `bdd-codex-${runId}`,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const afterComplete = await chat.listThreadEvents(actor, thread.id);
      const finalClaimed = afterComplete.events.filter((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId === runId
        );
      });
      expect(finalClaimed).toHaveLength(1);

      const finalRun = await runsApi.readRun(actor, runId);
      expect(finalRun.status).toBe("completed");
    },
  );

  it(
    "personal-subscription-run-identity-026 preserves the requested model and lazy exact claude-code-oauth-token authentication",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      const exactSecret = "claude-exact-secret-token";
      mockClaudeCodeTokenEndpoint({ accountEmail: "exact-claude@example.com" });
      const provider = await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: exactSecret,
      });
      await runsApi.updateUserModelPreference(actor, "claude-opus-5-5");

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Exact Claude Opus request",
        model: "claude-opus-5-5",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      const logBefore = await runReads.requestReadLogById(
        actor,
        launched.runId,
        [200],
      );
      if (logBefore.status !== 200) {
        throw new Error("Expected log read to succeed");
      }
      expect(logBefore.body).toMatchObject({
        selectedModel: "claude-opus-5-5",
        modelRuntimeProvider: "claude-code-oauth-token",
        modelRuntimeModel: "claude-opus-5-5",
      });
      expect(execution.environment?.ANTHROPIC_MODEL).toBe("claude-opus-5-5");
      expect(JSON.stringify(execution.environment ?? {})).not.toContain(
        exactSecret,
      );
      expect(JSON.stringify(execution.platformEnvironment)).not.toContain(
        exactSecret,
      );
      expect(
        execution.secretConnectorMetadataMap?.CLAUDE_CODE_OAUTH_TOKEN?.sourceId,
      ).toBe(provider.providerId);

      await runsApi.updateUserModelPreference(actor, "claude-sonnet-5-5");
      const logAfter = await runReads.requestReadLogById(
        actor,
        launched.runId,
        [200],
      );
      if (logAfter.status !== 200) {
        throw new Error("Expected second log read to succeed");
      }
      expect(logAfter.body).toStrictEqual(logBefore.body);

      firewall.seedClerkDirectory(actor);
      const authResult = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (authResult.status !== 200) {
        throw new Error("Expected Claude firewall auth resolution");
      }
      expect(authResult.body.headers.Authorization).toBe(
        `Bearer ${exactSecret}`,
      );
    },
  );

  it(
    "personal-subscription-run-identity-027 preserves the requested model and lazy exact codex-oauth-token authentication",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      const exactAccessToken = `codex-exact-access-${randomUUID()}`;
      const provider = await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "identity-a",
            accessToken: exactAccessToken,
          }),
        },
      });
      await runsApi.updateUserModelPreference(actor, "gpt-6-sol");

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Exact GPT Sol request",
        model: "gpt-6-sol",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      const logBefore = await runReads.requestReadLogById(
        actor,
        launched.runId,
        [200],
      );
      if (logBefore.status !== 200) {
        throw new Error("Expected log read to succeed");
      }
      expect(logBefore.body).toMatchObject({
        selectedModel: "gpt-6-sol",
        modelRuntimeProvider: "codex-oauth-token",
        modelRuntimeModel: "gpt-6-sol",
      });
      expect(execution.environment?.OPENAI_MODEL).toBe("gpt-6-sol");
      expect(JSON.stringify(execution.environment ?? {})).not.toContain(
        exactAccessToken,
      );
      expect(JSON.stringify(execution.platformEnvironment)).not.toContain(
        exactAccessToken,
      );
      expect(
        execution.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN?.sourceId,
      ).toBe(provider.providerId);

      await runsApi.updateUserModelPreference(actor, "gpt-6-astra");
      const logAfter = await runReads.requestReadLogById(
        actor,
        launched.runId,
        [200],
      );
      if (logAfter.status !== 200) {
        throw new Error("Expected second log read to succeed");
      }
      expect(logAfter.body).toStrictEqual(logBefore.body);

      firewall.seedClerkDirectory(actor);
      const authResult = await firewall.requestFirewallAuth(
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
      if (authResult.status !== 200) {
        throw new Error("Expected Codex firewall auth resolution");
      }
      expect(authResult.body.headers.Authorization).toBe(
        `Bearer ${exactAccessToken}`,
      );
      expect(authResult.body.headers["ChatGPT-Account-ID"]).toBe("identity-a");
    },
  );

  it(
    "personal-subscription-run-identity-029 lists and runs personal claude-code-oauth-token, then removes it after disconnection",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      const claudeSecret = "claude-boundary-secret";
      mockClaudeCodeTokenEndpoint({
        accountEmail: "boundary-claude@example.com",
      });
      await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: claudeSecret,
      });
      await runsApi.updateUserModelPreference(actor, "claude-sonnet-5-5");

      const modelsBefore = await runsApi.listRunModels(actor);
      const claudeEntry = modelsBefore.models.find((entry) => {
        return entry.model === "claude-sonnet-5-5";
      });
      expect(claudeEntry?.memberEffective).toMatchObject({
        runtimeProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      });

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Claude boundary run",
        model: "claude-sonnet-5-5",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      firewall.seedClerkDirectory(actor);
      const authResult = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CLAUDE_CODE_OAUTH_TOKEN")}`,
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (authResult.status !== 200) {
        throw new Error("Expected Claude firewall auth resolution");
      }
      expect(authResult.body.headers.Authorization).toBe(
        `Bearer ${claudeSecret}`,
      );

      await runsApi.requestCancelRun(actor, launched.runId, [200]);
      await webhooks.requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      await authDeviceSupport.deletePersonalModelProvider(
        actor,
        "claude-code-oauth-token",
        [204],
      );
      const modelsAfter = await runsApi.listRunModels(actor);
      expect(
        modelsAfter.models.some((entry) => {
          return entry.model === "claude-sonnet-5-5";
        }),
      ).toBeFalsy();

      const rejectedThread = await chat.requestCreateThread(
        actor,
        { model: "claude-sonnet-5-5" },
        [400],
      );
      expect(rejectedThread.status).toBe(400);
    },
  );

  it(
    "personal-subscription-run-identity-030 lists and runs personal codex-oauth-token, then removes it after disconnection",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      const codexAccessToken = `codex-boundary-${randomUUID()}`;
      await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "boundary-codex-acct",
            accessToken: codexAccessToken,
          }),
        },
      });
      await runsApi.updateUserModelPreference(actor, "gpt-6-astra");

      const modelsBefore = await runsApi.listRunModels(actor);
      const codexEntry = modelsBefore.models.find((entry) => {
        return entry.model === "gpt-6-astra";
      });
      expect(codexEntry?.memberEffective).toMatchObject({
        runtimeProviderType: "codex-oauth-token",
        credentialScope: "member",
      });

      const launched = await chat.sendAndLaunch(actor, {
        prompt: "Codex boundary run",
        model: "gpt-6-astra",
      });
      const execution = await runsApi.executionInput(launched.runId);
      tokens.set(launched.runId, execution.sandboxToken);

      firewall.seedClerkDirectory(actor);
      const authResult = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${execution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          },
          secretConnectorMap: execution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            execution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (authResult.status !== 200) {
        throw new Error("Expected Codex firewall auth resolution");
      }
      expect(authResult.body.headers.Authorization).toBe(
        `Bearer ${codexAccessToken}`,
      );

      await runsApi.requestCancelRun(actor, launched.runId, [200]);
      await webhooks.requestAgentComplete(
        { runId: launched.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${execution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      await authDeviceSupport.deletePersonalModelProvider(
        actor,
        "codex-oauth-token",
        [204],
      );
      const modelsAfter = await runsApi.listRunModels(actor);
      expect(
        modelsAfter.models.some((entry) => {
          return entry.model === "gpt-6-astra";
        }),
      ).toBeFalsy();

      const rejectedThread = await chat.requestCreateThread(
        actor,
        { model: "gpt-6-astra" },
        [400],
      );
      expect(rejectedThread.status).toBe(400);
    },
  );

  it(
    "personal-subscription-run-identity-034 rejects a suspended entitlement even with org credits and a supported subscription",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, entitlement } = await setupProMember({
        configureStripeEnv: true,
      });
      expect(entitlement.credits).toBeGreaterThan(0);

      mockClaudeCodeTokenEndpoint({
        accountEmail: "suspended-pro@example.com",
      });
      await runsApi.createPersonalModelProvider(actor, {
        type: "claude-code-oauth-token",
        secret: "suspended-pro-claude-secret",
      });

      const plan = publicPlanLifecycle(context, actor, "pro", {
        customerId: entitlement.customerId,
        subscriptionId: entitlement.subscriptionId,
      });
      await plan.update("canceled");

      const sent = await chat.requestSendEvent(
        actor,
        {
          prompt: "Send after Pro cancellation",
          model: "claude-sonnet-5-5",
          clientEventId: randomUUID(),
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected chat send to be accepted");
      }
      await flushWaitUntilForTest();

      const logs = await runReads.requestListLogs(actor, { limit: 10 }, [200]);
      expect(logs.body.data).toHaveLength(0);

      const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
      expect(
        events.some((event) => {
          return event.eventType === "input.rejected";
        }),
      ).toBeTruthy();

      const models = await runsApi.listRunModels(actor);
      const claudeEntry = models.models.find((entry) => {
        return entry.model === "claude-sonnet-5-5";
      });
      expect(claudeEntry?.memberEffective).toMatchObject({
        runtimeProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        availability: "plan_restricted",
      });
    },
  );

  it(
    "personal-subscription-run-identity-041 preserves a Codex session across account changes and resolves uncreated queued messages at promotion",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, tokens } = await setupProMember();
      const accessTokenA = `codex-session-a-${randomUUID()}`;
      const accessTokenB = `codex-session-b-${randomUUID()}`;
      const accountA = await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "identity-a",
            accessToken: accessTokenA,
          }),
        },
      });

      const first = await chat.sendAndLaunch(actor, {
        prompt: "First Codex run on account A",
        model: "gpt-6-astra",
      });
      const firstExecution = await runsApi.executionInput(first.runId);
      tokens.set(first.runId, firstExecution.sandboxToken);
      expect(
        firstExecution.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN
          ?.sourceId,
      ).toBe(accountA.providerId);

      const queuedClientEventId = randomUUID();
      const queuedSend = await chat.requestSendEvent(
        actor,
        {
          threadId: first.threadId,
          prompt: "Queued follow-up after account switch",
          clientEventId: queuedClientEventId,
        },
        [201],
      );
      expect(queuedSend.status).toBe(201);
      await flushWaitUntilForTest();

      const accountB = await runsApi.createPersonalModelProvider(actor, {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secrets: {
          CODEX_AUTH_JSON: makeCodexAuthJson({
            accountId: "identity-b",
            accessToken: accessTokenB,
          }),
        },
      });

      const nativeSessionId = `subscription-${first.runId}`;
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "codex",
            cliAgentSessionId: nativeSessionId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        { authorization: `Bearer ${firstExecution.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();

      const { events } = await chat.listThreadEvents(actor, first.threadId);
      const promotedEvent = events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === queuedClientEventId &&
          event.runId !== undefined
        );
      });
      const promotedRunId = promotedEvent?.runId;
      if (!promotedRunId) {
        throw new Error("Expected queued message to promote to a new Run");
      }

      const promotedExecution = await runsApi.executionInput(promotedRunId);
      tokens.set(promotedRunId, promotedExecution.sandboxToken);
      expect(
        promotedExecution.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN
          ?.sourceId,
      ).toBe(accountB.providerId);
      expect(promotedExecution.cliAgentType).toBe("codex");
      expect(promotedExecution.nativeContinuation.sessionId).toBe(
        nativeSessionId,
      );

      firewall.seedClerkDirectory(actor);
      const authResult = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${promotedExecution.firewallToken}` },
        {
          authHeaders: {
            Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
            "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
          },
          secretConnectorMap: promotedExecution.secretConnectorMap ?? undefined,
          secretConnectorMetadataMap:
            promotedExecution.secretConnectorMetadataMap ?? undefined,
        },
        [200],
      );
      if (authResult.status !== 200) {
        throw new Error("Expected promoted Run firewall auth resolution");
      }
      expect(authResult.body.headers.Authorization).toBe(
        `Bearer ${accessTokenB}`,
      );
      expect(authResult.body.headers["ChatGPT-Account-ID"]).toBe("identity-b");
    },
  );
});
