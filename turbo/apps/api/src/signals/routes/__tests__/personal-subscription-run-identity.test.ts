import { randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished } from "vitest";
import { holdOrgAdmissionLockFixture } from "../../../test-fixtures/chat-events";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { testContext } from "../../../__tests__/test-context";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createAuthDeviceSupportApi } from "./helpers/api-bdd-auth-device-support";
import {
  makeCodexAuthJson,
  makeCodexJwt,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
  createAuthDeviceApiActions,
} from "./helpers/api-bdd-auth-device";
import {
  transitionRunToTerminal,
  cleanupTimedOutRun,
  type TestTerminalRunStatus,
} from "./helpers/api-bdd-run-timeout";

type SubscriptionType = "claude-code-oauth-token" | "codex-oauth-token";
const context = testContext();
const runs = createRunsApi(context);
const support = createAuthDeviceSupportApi(context);
const firewall = createFirewallApi(context);

type Claim = Awaited<ReturnType<typeof runs.claimRunnerJob>>;

async function connect(
  actor: ApiTestUser,
  type: SubscriptionType,
  identity: string,
  expired = false,
) {
  if (type === "claude-code-oauth-token") {
    mockClaudeCodeTokenEndpoint();
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
        const upstreamIdentity = request.headers
          .get("authorization")
          ?.replace("Bearer sk-ant-oat-", "");
        return HttpResponse.json({
          account: {
            uuid: upstreamIdentity,
            email: `${upstreamIdentity}@example.com`,
          },
          organization: {
            uuid: `org-${upstreamIdentity}`,
            name: upstreamIdentity,
          },
        });
      }),
    );
  }
  const token =
    type === "codex-oauth-token"
      ? makeCodexJwt({
          exp: Math.floor(now() / 1000) + (expired ? -60 : 7200),
          identity,
          nonce: randomUUID(),
        })
      : `sk-ant-oat-${identity}`;
  const result = await createMiscRoutesApi(context).upsertPersonalModelProvider(
    actor,
    type === "codex-oauth-token"
      ? {
          type,
          authMethod: "auth_json",
          secrets: {
            CODEX_AUTH_JSON: makeCodexAuthJson({
              accessToken: token,
              accountId: identity,
              refreshToken: `refresh-${identity}`,
            }),
          },
        }
      : { type, secret: token },
    [200, 201],
  );
  if (result.status !== 200 && result.status !== 201) {
    throw new Error("Expected a connected subscription");
  }
  return { id: result.body.provider.id, token };
}

async function fixture(
  type: SubscriptionType,
  accountsEnabled = true,
  priorityEnabled = true,
) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PiLoop]: false,
    [FeatureSwitchKey.PersonalModelProviderAccounts]: accountsEnabled,
    [FeatureSwitchKey.PersonalSubscriptionPriority]: priorityEnabled,
  });
  mockClaudeCodeTokenEndpoint();
  const connected = await connect(actor, type, "identity-a");
  const model =
    type === "codex-oauth-token" ? "gpt-5.6-luna" : "claude-sonnet-5";
  await runs.updateOrgModelPolicies(actor, [
    {
      model,
      isDefault: true,
      defaultProviderType: type,
      credentialScope: "member",
      modelProviderId: null,
    },
  ]);
  const agent = await bdd.createAgent(actor, {
    displayName: "Subscription identity",
    visibility: "private",
  });
  const start = async () => {
    const sent = await createChatFilesBddApi(context).requestSendEvent(
      actor,
      { agentId: agent.agentId, prompt: "use my selected subscription", model },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected an admitted subscription run");
    }
    return sent.body.runId;
  };
  const claim = async (runId: string) => {
    const state = await runs.readRun(actor, runId);
    expect(state.status, JSON.stringify(state)).toBe("pending");
    await runs.heartbeatRunner(runnerGroup);
    return await runs.claimRunnerJob(runId);
  };
  return {
    actor,
    connected,
    start,
    claim,
    agentId: agent.agentId,
    type,
    model,
  };
}

function authBody(claim: Claim, type: SubscriptionType) {
  if (!claim.encryptedSecrets) {
    throw new Error("Expected runtime credential envelope");
  }
  const accessKey =
    type === "codex-oauth-token"
      ? "CHATGPT_ACCESS_TOKEN"
      : "CLAUDE_CODE_OAUTH_TOKEN";
  return {
    encryptedSecrets: claim.encryptedSecrets,
    authHeaders: {
      Authorization: `Bearer ${secretTemplate(accessKey)}`,
      ...(type === "codex-oauth-token"
        ? { "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID") }
        : {}),
    },
    secretConnectorMap: claim.secretConnectorMap ?? undefined,
    secretConnectorMetadataMap: claim.secretConnectorMetadataMap ?? undefined,
  };
}

async function resolve(claim: Claim, type: SubscriptionType) {
  const response = await firewall.requestFirewallAuth(
    { authorization: `Bearer ${claim.sandboxToken}` },
    authBody(claim, type),
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected subscription credentials");
  }
  return response.body.headers;
}

function accountId(claim: Claim, type: SubscriptionType) {
  const key =
    type === "codex-oauth-token"
      ? "CHATGPT_ACCESS_TOKEN"
      : "CLAUDE_CODE_OAUTH_TOKEN";
  const id = claim.secretConnectorMetadataMap?.[key]?.sourceId;
  if (!id) {
    throw new Error("Expected an exact subscription sourceId");
  }
  for (const metadata of Object.values(
    claim.secretConnectorMetadataMap ?? {},
  )) {
    if (metadata.sourceType === "model-provider") {
      expect(metadata.sourceId).toBe(id);
    }
  }
  return id;
}

describe("personal subscription run identity", () => {
  it("fails captured admission when disconnect commits before run insertion", async () => {
    const f = await fixture("codex-oauth-token");
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const lock = await holdOrgAdmissionLockFixture({
      orgId: f.actor.orgId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      lock.release();
      await lock.done;
    });
    const sending = createChatFilesBddApi(context).requestSendEvent(
      f.actor,
      { agentId: f.agentId, prompt: "admission race", model: f.model },
      [409],
    );
    await expect.poll(lock.waiterCount).toBe(1);
    await support.deletePersonalModelProviderAccount(f.actor, f.connected.id);
    await connect(f.actor, f.type, "identity-b");
    lock.release();
    const denied = await sending;
    expect(denied.status).toBe(409);
    expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
  });
  it("retains pending and queued bindings when a replacement changes the active identity", async () => {
    const f = await fixture("codex-oauth-token");
    const first = await f.start();
    const pending = await f.start();
    const queued = await f.start();
    expect((await runs.readRun(f.actor, queued)).status).toBe("queued");
    const firstClaim = await f.claim(first);
    const captured = accountId(firstClaim, f.type);
    await connect(f.actor, f.type, "identity-b");
    await expect(resolve(firstClaim, f.type)).resolves.toMatchObject({
      "ChatGPT-Account-ID": "identity-a",
    });
    const pendingClaim = await f.claim(pending);
    expect(accountId(pendingClaim, f.type)).toBe(captured);
    await runs.requestCancelRun(f.actor, first, [200]);
    await expect
      .poll(async () => {
        return (await runs.readRun(f.actor, queued)).status;
      })
      .toBe("pending");
    const queuedClaim = await f.claim(queued);
    expect(accountId(queuedClaim, f.type)).toBe(captured);
    await expect(resolve(queuedClaim, f.type)).resolves.toMatchObject({
      "ChatGPT-Account-ID": "identity-a",
    });
    await runs.requestCancelRun(f.actor, pending, [200]);
    await runs.requestCancelRun(f.actor, queued, [200]);
    expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
      captured,
    );
  }, 20_000);

  it("keeps both admitted identities when reconnect merges a duplicate account", async () => {
    const f = await fixture("codex-oauth-token");
    const first = await f.start();
    const firstClaim = await f.claim(first);
    const accountA = accountId(firstClaim, f.type);
    const auth = createAuthDeviceApiActions(context);
    async function oauth(mode: "add" | "reconnect", modelProviderId?: string) {
      mockCodexDeviceAuthProvider({
        tokenScope: "personal",
        accountId: "identity-b",
      });
      const started = await auth.requestCodexStart(f.actor, "personal", [200], {
        mode,
        modelProviderId,
      });
      if (started.status !== 200) {
        throw new Error("Expected device auth start");
      }
      const result = await auth.requestCodexComplete(
        f.actor,
        started.body.sessionToken,
        [200],
      );
      if (!("status" in result.body) || result.body.status !== "complete") {
        throw new Error("Expected device auth completion");
      }
      return result.body.provider.id;
    }
    const accountB = await oauth("add");
    await support.activatePersonalModelProviderAccount(f.actor, accountB);
    const second = await f.start();
    const secondClaim = await f.claim(second);
    await support.activatePersonalModelProviderAccount(f.actor, accountA);
    await expect(oauth("reconnect", accountA)).resolves.toBe(accountB);
    await expect(resolve(firstClaim, f.type)).resolves.toMatchObject({
      "ChatGPT-Account-ID": "identity-a",
    });
    await expect(resolve(secondClaim, f.type)).resolves.toMatchObject({
      "ChatGPT-Account-ID": "identity-b",
    });
    const listed = await support.listPersonalModelProviders(f.actor, [200]);
    expect(
      listed.body.modelProviders.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([accountB]);
    await runs.requestCancelRun(f.actor, first, [200]);
    await runs.requestCancelRun(f.actor, second, [200]);
  }, 20_000);

  it("cleans the last retained account when its queued run expires", async () => {
    const f = await fixture("codex-oauth-token");
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = f.actor.orgId;
    const first = await f.start();
    const second = await f.start();
    const queued = await f.start();
    expect((await runs.readRun(f.actor, queued)).status).toBe("queued");
    await support.deletePersonalModelProviderAccount(f.actor, f.connected.id);
    await transitionRunToTerminal(context, first, "cancelled");
    await transitionRunToTerminal(context, second, "cancelled");
    await withMockNowForTest(now() + 25 * 60 * 60 * 1000, async () => {
      await cleanupTimedOutRun(context, {
        runId: queued,
        orgId,
        chatThreadId: randomUUID(),
      });
    });
    expect((await runs.readRun(f.actor, queued)).status).toBe("timeout");
    expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
      f.connected.id,
    );
  }, 20_000);

  it.each([false, true])(
    "reuses the same Claude identity with initial priority %s",
    async (priority) => {
      const f = await fixture("claude-code-oauth-token", true, priority);
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, f.type);
      expect((await connect(f.actor, f.type, "identity-a")).id).toBe(captured);
      await support.updateFeatureSwitches(f.actor, {
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
      });
      await support.deletePersonalModelProviderAccount(f.actor, captured);
      expect((await connect(f.actor, f.type, "identity-a")).id).toBe(captured);
      await expect(resolve(claim, f.type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await runs.requestCancelRun(f.actor, runId, [200]);
    },
  );

  it.each([
    "user.banned",
    "user.deleted",
    "organization.deleted",
    "organizationMembership.deleted",
  ] as const)(
    "keeps %s as a hard revocation for a retained subscription",
    async (eventType) => {
      const f = await fixture("codex-oauth-token");
      const runId = await f.start();
      const claim = await f.claim(runId);
      await support.deletePersonalModelProviderAccount(
        f.actor,
        accountId(claim, f.type),
      );
      const webhooks = createWebhookCallbackApi(context);
      webhooks.configureClerkWebhookSecret();
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [],
        has_more: false,
      });
      context.mocks.stripe.subscriptions.update.mockResolvedValue({});
      webhooks.verifyNextClerkWebhook({
        type: eventType,
        data: {
          id:
            eventType === "organization.deleted"
              ? f.actor.orgId
              : f.actor.userId,
          organization_id: f.actor.orgId,
          user_id: f.actor.userId,
        },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
      const denied = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        authBody(claim, f.type),
        [400, 401, 403, 424],
      );
      expect(denied.status).not.toBe(200);
    },
  );

  it.each([
    ["claude-code-oauth-token", false],
    ["claude-code-oauth-token", true],
    ["codex-oauth-token", false],
    ["codex-oauth-token", true],
  ] as const)(
    "keeps %s runtime credentials through singleton removal with accounts UI %s",
    async (type, accountsEnabled) => {
      const f = await fixture(type, accountsEnabled);
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, type);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await support.deletePersonalModelProvider(f.actor, type, [204]);
      expect(
        (await support.listPersonalModelProviders(f.actor, [200])).body,
      ).toMatchObject({ modelProviders: [] });
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      const next = await connect(f.actor, type, "identity-b");
      const nextRun = await f.start();
      const nextClaim = await f.claim(nextRun);
      expect(accountId(nextClaim, type)).not.toBe(captured);
      await expect(resolve(nextClaim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${next.token}`,
      });
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      const denied = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${nextClaim.sandboxToken}` },
        authBody(claim, type),
        [424],
      );
      expect(denied.status).toBe(424);
      await runs.requestCancelRun(f.actor, runId, [200]);
      await runs.requestCancelRun(f.actor, nextRun, [200]);
    },
  );

  it("writes exact bindings while priority is off and preserves the old hard disconnect", async () => {
    const f = await fixture("codex-oauth-token", false, false);
    const runId = await f.start();
    const claim = await f.claim(runId);
    expect(accountId(claim, f.type)).toBeTruthy();
    await support.deletePersonalModelProvider(f.actor, f.type, [204]);
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [424],
    );
    expect(denied.status).toBe(424);
    await runs.requestCancelRun(f.actor, runId, [200]);
  });

  it.each([
    "completed",
    "failed",
    "cancelled",
    "timeout",
  ] as const satisfies readonly TestTerminalRunStatus[])(
    "cleans up only after the final %s transition",
    async (status) => {
      const f = await fixture("codex-oauth-token");
      const first = await f.start();
      const second = await f.start();
      const firstClaim = await f.claim(first);
      const secondClaim = await f.claim(second);
      const captured = accountId(firstClaim, f.type);
      await support.deletePersonalModelProviderAccount(f.actor, captured);
      await transitionRunToTerminal(context, first, status);
      await expect(resolve(secondClaim, f.type)).resolves.toMatchObject({
        "ChatGPT-Account-ID": "identity-a",
      });
      await transitionRunToTerminal(context, second, status);
      const reconnected = await connect(f.actor, f.type, "identity-a");
      expect(reconnected.id).not.toBe(captured);
    },
  );

  it("shares same-identity reconnect and serializes retained-account refresh", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    const reconnected = await connect(f.actor, f.type, "identity-a", true);
    expect(reconnected.id).toBe(captured);
    await support.deletePersonalModelProviderAccount(f.actor, captured);
    let refreshes = 0;
    firewall.mockCodexTokenRefresh(() => {
      refreshes += 1;
      return HttpResponse.json({
        access_token: "refreshed-a",
        refresh_token: "rotated-a",
        expires_in: 7200,
      });
    });
    const responses = await Promise.all([
      resolve(claim, f.type),
      resolve(claim, f.type),
    ]);
    for (const headers of responses) {
      expect(headers.Authorization).toBe("Bearer refreshed-a");
    }
    expect(refreshes).toBe(1);
    expect(
      (
        await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          randomUUID(),
          [404],
        )
      ).status,
    ).toBe(404);
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({ modelProviders: [] });
    await runs.requestCancelRun(f.actor, runId, [200]);
  });
});
