import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, onTestFinished, test } from "vitest";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";
import { insertBuiltInModelMirrorFixture } from "../../../test-fixtures/model-catalog";
import {
  upsertOrgPlanEntitlementFixture,
  deleteOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { clearAllDetached, createDeferredPromise } from "../../utils";
import { readRunUsageEventsFixture } from "../../../test-fixtures/chat-events";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { OrgModelPolicy } from "@okouai/api-contracts/contracts/model-providers";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { holdSubscriptionKmsBatch } from "./helpers/subscription-kms-batch";
import { createFixtureOperationOwner } from "./helpers/fixture-operation-owner";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { setupRawAppRequestWithRoutes } from "../../../__tests__/test-app";
import { chatEventsRoutes } from "../chat-events";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import {
  modelProviderConnectionsMainContract,
  modelProviderConnectionsByIdContract,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { createRouteMocks } from "./helpers/route-test";
import { now, withMockNowForTest } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
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
  cleanupTimedOutRun,
  type TestTerminalRunStatus,
} from "./helpers/api-bdd-run-timeout";
type SubscriptionType = "claude-code-oauth-token" | "codex-oauth-token";
const context = testContext({ connectorCatalog: true });
const runs = createRunsApi(context);
const reads = createRunReadsApi(context);
const support = createAuthDeviceSupportApi(context);
const firewall = createFirewallApi(context);

/** The configured policy, not the fixed default every workspace keeps. */
function configuredPolicy(
  response: { readonly policies: readonly OrgModelPolicy[] },
  model: string,
): OrgModelPolicy | undefined {
  return response.policies.find((policy) => {
    return policy.model === model;
  });
}

async function configureOrganizationApi(
  f: Awaited<ReturnType<typeof fixture>>,
  route: "built-in" | "custom",
) {
  const type =
    f.type === "codex-oauth-token" ? "openai-api-key" : "anthropic-api-key";
  const provider =
    route === "custom"
      ? await runs.createOrgModelProvider(f.actor, {
          type,
          secret: "organization-api-key",
        })
      : null;
  await runs.updateOrgModelPolicies(f.actor, [
    {
      model: f.model,
      preferred: true,
      defaultProviderType: route === "built-in" ? "built-in" : type,
      credentialScope: "org",
      modelProviderId: provider?.providerId ?? null,
    },
  ]);
  return provider;
}

type Claim = Awaited<ReturnType<typeof runs.claimRunnerJob>>;

/**
 * Sends a prompt, lets the background pick run, and returns the rejection the
 * pick appended in place of a run.
 */
async function sendRejectedAtPick(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly model: string;
    readonly prompt: string;
  },
) {
  const chat = createChatFilesBddApi(context);
  const clientEventId = randomUUID();
  const sent = await chat.requestSendEvent(
    actor,
    { ...body, clientEventId },
    [201],
  );
  if (sent.status !== 201) {
    throw new Error("Expected the chat send to be queued");
  }
  expect(sent.body.runId).toBeNull();
  await flushWaitUntilForTest();
  const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
  expect(
    events.filter((event) => {
      return event.runId !== undefined;
    }),
  ).toStrictEqual([]);
  return {
    rejected: events.find((event) => {
      return (
        event.eventType === "input.rejected" &&
        event.revokesEventId === clientEventId
      );
    }),
    guidance: events.find((event) => {
      return event.eventType === "output.error";
    }),
  };
}

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

async function fixture(type: SubscriptionType, accountsEnabled = true) {
  const bdd = createBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PersonalModelProviderAccounts]: accountsEnabled,
  });
  mockClaudeCodeTokenEndpoint();
  const connected = await connect(actor, type, "identity-a");
  const model: "gpt-6-astra" | "claude-sonnet-5" =
    type === "codex-oauth-token" ? "gpt-6-astra" : "claude-sonnet-5";
  await runs.updateOrgModelPolicies(actor, [
    {
      model,
      preferred: true,
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
    const sent = await createChatFilesBddApi(context).sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "use my selected subscription",
      model,
    });
    return sent.runId;
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

async function finish(
  actor: ApiTestUser,
  runId: string,
  claim: Claim,
  status: TestTerminalRunStatus,
) {
  if (status === "cancelled") {
    await runs.requestCancelRun(actor, runId, [200]);
  } else if (status === "timeout") {
    // Infrastructure exception: runtime timeout has no caller endpoint. The
    // scheduler observes elapsed time; its scoped fixture keeps other runs live.
    await withMockNowForTest(now() + 25 * 60 * 60 * 1000, async () => {
      await cleanupTimedOutRun(context, {
        runId,
        chatThreadId: randomUUID(),
      });
    });
  } else {
    await createWebhookCallbackApi(context).requestAgentComplete(
      {
        runId,
        exitCode: status === "completed" ? 0 : 1,
        ...(status === "completed"
          ? {
              checkpoint: {
                cliAgentType: claim.cliAgentType,
                cliAgentSessionId: `subscription-${runId}`,
                cliAgentSessionHistoryHash: createHash("sha256")
                  .update(`subscription history ${runId}`)
                  .digest("hex"),
              },
            }
          : { error: "Upstream run failed" }),
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
  }
  expect((await runs.readRun(actor, runId)).status).toBe(status);
}

describe("personal subscription run identity", () => {
  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "preserves proven recovery identity for %s pending admission",
    async (type) => {
      const f = await fixture(type);
      const admitted: string[] = [];
      const owner = createFixtureOperationOwner(async () => {
        for (const runId of [...admitted].reverse()) {
          await runs.requestCancelRun(f.actor, runId, [200]);
        }
      });
      await owner.run(async () => {
        admitted.push(await f.start());
        const target = await f.start();
        admitted.push(target);
        await expect(runs.readRun(f.actor, target)).resolves.toMatchObject({
          status: "pending",
          source: { account: { status: "connected", id: f.connected.id } },
        });

        await connect(f.actor, type, "identity-b");
        expect(
          (await runs.readRun(f.actor, target)).source?.account,
        ).toStrictEqual({
          status: "unavailable",
        });
      });
    },
  );

  it("rejects the input without capturing run recovery identity when launch preparation fails", async () => {
    const f = await fixture("codex-oauth-token");
    const preparationError = new Error("Archive signing failed");
    context.mocks.s3.getSignedUrl.mockRejectedValue(preparationError);
    const chat = createChatFilesBddApi(context);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        prompt: "use my selected subscription",
        model: f.model,
        clientEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the chat send to be queued");
    }
    expect(sent.body.runId).toBeNull();
    await expect(clearAllDetached()).rejects.toBe(preparationError);
    const { events } = await chat.listThreadEvents(f.actor, sent.body.threadId);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: clientEventId,
        eventType: "input.prompt",
      }),
    );
    // The picked input ends rejected; no run or recovery identity exists.
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "internal_error",
      }),
    );
    await expect(
      reads.requestListLogs(f.actor, { limit: 100 }, [200]),
    ).resolves.toMatchObject({ body: { data: [] } });
  });

  it.each([
    ["claude-code-oauth-token", "claude-opus-5-5"],
    ["codex-oauth-token", "gpt-6-sol"],
  ] as const)(
    "runs a free-plan member's %s subscription model on its subscription route",
    async (type, model) => {
      const bdd = createBddApi(context);
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped actor");
      }
      bdd.acceptAgentStorageWrites();
      // Run creation requires the member memory that onboarding initializes.
      expect((await bdd.completeOnboarding(actor)).status).toBe(200);
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      // Plan state is infrastructure-owned. The free plan runs only okou-1.0 on
      // Built-in; the member's own subscription is the other way in.
      await seedOrgMetadata({
        orgId: actor.orgId,
        tier: "limited-free-1",
        credits: 0,
      });
      await support.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OkouDebug]: true,
      });
      await runs.updateOrgModelMode(actor, "auto");
      const connected = await connect(actor, type, "identity-auto");
      const agent = await bdd.createAgent(actor, {
        displayName: "Auto subscription",
        visibility: "private",
      });
      const sent = await createChatFilesBddApi(context).sendAndLaunch(actor, {
        agentId: agent.agentId,
        prompt: "use my subscription model",
        model,
      });
      const state = await runs.readRun(actor, sent.runId);
      expect(state.status, JSON.stringify(state)).toBe("pending");
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(sent.runId);
      // The member's own subscription account serves the run, not Built-in.
      expect(accountId(claim, type)).toBe(connected.id);
      await finish(actor, sent.runId, claim, "failed");
    },
  );

  it.each([
    ["claude-code-oauth-token", "claude-opus-5-5"],
    ["codex-oauth-token", "gpt-6-sol"],
  ] as const)(
    "runs a free-plan Custom member's %s subscription policy on the member's account",
    async (type, model) => {
      const bdd = createBddApi(context);
      const actor = bdd.user();
      if (!actor.orgId) {
        throw new Error("Expected an organization-scoped actor");
      }
      bdd.acceptAgentStorageWrites();
      expect((await bdd.completeOnboarding(actor)).status).toBe(200);
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      await seedOrgMetadata({
        orgId: actor.orgId,
        tier: "limited-free-1",
        credits: 0,
      });
      await support.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.OkouDebug]: true,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      });
      await runs.updateOrgModelMode(actor, "custom");
      const connected = await connect(actor, type, "identity-custom");
      // A member-scope policy carries no credential; each member runs it with
      // their own subscription, which the free plan allows.
      await runs.updateOrgModelPolicies(actor, [
        {
          model,
          preferred: true,
          defaultProviderType: type,
          credentialScope: "member",
          modelProviderId: null,
        },
      ]);
      const policies =
        await createMiscRoutesApi(context).listModelPolicies(actor);
      expect(
        policies.policies.find((policy) => {
          return policy.model === model;
        })?.memberEffective,
      ).toMatchObject({
        providerType: type,
        credentialScope: "member",
        availability: "available",
      });
      const agent = await bdd.createAgent(actor, {
        displayName: "Custom subscription",
        visibility: "private",
      });
      const sent = await createChatFilesBddApi(context).sendAndLaunch(actor, {
        agentId: agent.agentId,
        prompt: "use my subscription policy",
        model,
      });
      const state = await runs.readRun(actor, sent.runId);
      expect(state.status, JSON.stringify(state)).toBe("pending");
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(sent.runId);
      expect(accountId(claim, type)).toBe(connected.id);
      await finish(actor, sent.runId, claim, "failed");
    },
  );

  it("preserves proven singleton recovery while both UI switches remain off", async () => {
    const f = await fixture("codex-oauth-token", false);
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    expect(captured).not.toBe(f.connected.id);
    await finish(f.actor, runId, claim, "failed");
    const requests: string[] = [];
    server.use(
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        ({ request }) => {
          requests.push(request.headers.get("chatgpt-account-id") ?? "missing");
          return HttpResponse.json({ code: "reset", windows_reset: 1 });
        },
      ),
    );
    expect(
      (
        await support.readPersonalModelProviderAccount(
          f.actor,
          captured,
          runId,
          [200],
        )
      ).body,
    ).toMatchObject({ id: captured });
    expect(
      (
        await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          randomUUID(),
          [200],
          runId,
        )
      ).body,
    ).toStrictEqual({ outcome: "reset" });
    expect(requests).toStrictEqual(["identity-a"]);
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
    expect(requests).toStrictEqual(["identity-a"]);
  });
  describe.each([false, true])(
    "failed A after active B and API policy changes with accounts UI=%s",
    (accountsEnabled) => {
      async function recoveryFixture() {
        const f = await fixture("codex-oauth-token");
        const runId = await f.start();
        const claim = await f.claim(runId);
        const captured = accountId(claim, f.type);
        await finish(f.actor, runId, claim, "failed");
        const auth = createAuthDeviceApiActions(context);
        mockCodexDeviceAuthProvider({
          tokenScope: "personal",
          accountId: "identity-b",
        });
        const started = await auth.requestCodexStart(
          f.actor,
          "personal",
          [200],
          {
            mode: "add",
          },
        );
        if (started.status !== 200) {
          throw new Error("Expected device auth start");
        }
        const connected = await auth.requestCodexComplete(
          f.actor,
          started.body.sessionToken,
          [200],
        );
        if (
          !("status" in connected.body) ||
          connected.body.status !== "complete"
        ) {
          throw new Error("Expected connected account B");
        }
        await support.activatePersonalModelProviderAccount(
          f.actor,
          connected.body.provider.id,
        );
        await configureOrganizationApi(f, "built-in");
        await support.updateFeatureSwitches(f.actor, {
          [FeatureSwitchKey.PersonalModelProviderAccounts]: accountsEnabled,
        });
        const listed = await support.listPersonalModelProviders(f.actor, [200]);
        if (listed.status !== 200) {
          throw new Error("Expected personal accounts");
        }
        if (!accountsEnabled) {
          expect(listed.body.modelProviders).toHaveLength(1);
          expect(listed.body.modelProviders[0]?.id).not.toBe(captured);
          expect(
            listed.body.modelProviders[0]?.modelProviderId,
          ).toBeUndefined();
        }
        const observed: {
          readonly path: string;
          readonly account: string | null;
        }[] = [];
        for (const path of ["usage", "rate-limit-reset-credits"] as const) {
          server.use(
            http.get(
              `https://chatgpt.com/backend-api/wham/${path}`,
              ({ request }) => {
                observed.push({
                  path,
                  account: request.headers.get("chatgpt-account-id"),
                });
                return HttpResponse.json(
                  path === "usage"
                    ? {
                        plan_type: "plus",
                        rate_limit_reset_credits: { available_count: 1 },
                      }
                    : { credits: [] },
                );
              },
            ),
          );
        }
        const resetKeys: unknown[] = [];
        server.use(
          http.post(
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
            async ({ request }) => {
              observed.push({
                path: "consume",
                account: request.headers.get("chatgpt-account-id"),
              });
              resetKeys.push(await request.json());
              return HttpResponse.json({
                code: resetKeys.length === 1 ? "reset" : "already_redeemed",
                windows_reset: 1,
              });
            },
          ),
        );
        return { f, runId, captured, observed, resetKeys };
      }

      async function expectCapturedAccountRecovery(
        scenario: Awaited<ReturnType<typeof recoveryFixture>>,
      ) {
        const { f, runId, captured, observed } = scenario;
        expect((await runs.readRun(f.actor, runId)).source).toMatchObject({
          providerType: f.type,
          model: f.model,
          credentialScope: "member",
          account: { status: "connected", id: captured },
        });
        const exact = await support.readPersonalModelProviderAccount(
          f.actor,
          captured,
          runId,
          [200],
        );
        expect(exact.body).toMatchObject({
          id: captured,
          subscriptionResetCredits: 1,
        });
        const reset = await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          randomUUID(),
          [200],
          runId,
        );
        expect(reset.body).toMatchObject({ outcome: "reset" });
        expect(
          observed.map(({ account }) => {
            return account;
          }),
        ).not.toContain("identity-b");
      }

      it("recovers the captured account and preserves reset idempotency", async () => {
        const { f, runId, captured, observed, resetKeys } =
          await recoveryFixture();
        expect((await runs.readRun(f.actor, runId)).source).toMatchObject({
          providerType: f.type,
          model: f.model,
          credentialScope: "member",
          account: { status: "connected", id: captured },
        });
        const exact = await support.readPersonalModelProviderAccount(
          f.actor,
          captured,
          runId,
          [200],
        );
        expect(exact.body).toMatchObject({
          id: captured,
          subscriptionResetCredits: 1,
        });
        const idempotencyKey = randomUUID();
        const first = await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          idempotencyKey,
          [200],
          runId,
        );
        expect(first.body).toMatchObject({ outcome: "reset" });
        const second = await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          idempotencyKey,
          [200],
          runId,
        );
        expect(second.body).toMatchObject({ outcome: "alreadyRedeemed" });
        expect(resetKeys[1]).toStrictEqual(resetKeys[0]);
        expect(
          observed.map(({ account }) => {
            return account;
          }),
        ).not.toContain("identity-b");
        expect(
          observed.some(({ path }) => {
            return path === "consume";
          }),
        ).toBeTruthy();
      });

      it("denies another member access to the captured account and reset", async () => {
        const scenario = await recoveryFixture();
        await expectCapturedAccountRecovery(scenario);
        const { f, runId, captured } = scenario;
        const foreign = createBddApi(context).user({ orgId: f.actor.orgId });
        expect(
          (
            await support.readPersonalModelProviderAccount(
              foreign,
              captured,
              runId,
              [404],
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await support.resetPersonalModelProviderAccount(
              foreign,
              captured,
              randomUUID(),
              [404],
              runId,
            )
          ).status,
        ).toBe(404);
      });

      it("removes recovery after the captured account is deleted", async () => {
        const scenario = await recoveryFixture();
        await expectCapturedAccountRecovery(scenario);
        const { f, runId, captured, observed } = scenario;
        await support.updateFeatureSwitches(f.actor, {
          [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
        });
        await support.deletePersonalModelProviderAccount(f.actor, captured);
        expect(
          (await runs.readRun(f.actor, runId)).source?.account,
        ).toStrictEqual({
          status: "unavailable",
        });
        const beforeRejected = observed.length;
        expect(
          (
            await support.readPersonalModelProviderAccount(
              f.actor,
              captured,
              runId,
              [404],
            )
          ).status,
        ).toBe(404);
        expect(
          (
            await support.resetPersonalModelProviderAccount(
              f.actor,
              captured,
              randomUUID(),
              [404],
              runId,
            )
          ).status,
        ).toBe(404);
        expect(observed).toHaveLength(beforeRejected);
      });
    },
  );

  it("admits one canonical run for concurrent idempotent chat sends", async () => {
    const f = await fixture("codex-oauth-token", true);
    const chat = createChatFilesBddApi(context);
    const thread = await chat.createThread(f.actor, { agentId: f.agentId });
    const headId = randomUUID();
    const send = () => {
      return chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          threadId: thread.id,
          clientEventId: headId,
          prompt: "one canonical subscription input",
          model: f.model,
        },
        [201],
      );
    };
    const responses = await Promise.all([send(), send()]);
    expect(responses).toHaveLength(2);
    const responseRunIds = new Set<string>();
    for (const response of responses) {
      if (response.status !== 201) {
        throw new Error("Expected both idempotent sends to be accepted");
      }
      if (response.body.runId !== null) {
        responseRunIds.add(response.body.runId);
      }
    }
    expect(responseRunIds.size).toBeLessThanOrEqual(1);

    await flushWaitUntilForTest();
    const admittedEvents = (await chat.listThreadEvents(f.actor, thread.id))
      .events;
    const claims = admittedEvents.filter((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === headId &&
        event.runId !== null
      );
    });
    expect(claims).toHaveLength(1);
    const claimedRunId = claims[0]?.runId;
    if (!claimedRunId) {
      throw new Error("Expected the input to be claimed by one run");
    }
    expect([...responseRunIds]).toStrictEqual(
      responseRunIds.size === 0 ? [] : [claimedRunId],
    );
    const claim = await f.claim(claimedRunId);
    await finish(f.actor, claimedRunId, claim, "completed");
    const events = (await chat.listThreadEvents(f.actor, thread.id)).events;
    expect(
      events.filter((event) => {
        return (
          event.eventType === "input.prompt" && event.revokesEventId === headId
        );
      }),
    ).toStrictEqual([expect.objectContaining({ runId: claimedRunId })]);
    expect((await runs.readRun(f.actor, claimedRunId)).status).toBe(
      "completed",
    );
  });

  it.each([false, true])(
    "retains pending bindings when a replacement changes the active identity (organization API: %s)",
    async (organizationApi) => {
      const f = await fixture("codex-oauth-token");
      if (organizationApi) {
        await configureOrganizationApi(f, "custom");
      }
      const first = await f.start();
      const pending = await f.start();
      const firstClaim = await f.claim(first);
      const captured = accountId(firstClaim, f.type);
      await connect(f.actor, f.type, "identity-b");
      await expect(resolve(firstClaim, f.type)).resolves.toMatchObject({
        "ChatGPT-Account-ID": "identity-a",
      });
      const pendingClaim = await f.claim(pending);
      expect(accountId(pendingClaim, f.type)).toBe(captured);
      await expect(resolve(pendingClaim, f.type)).resolves.toMatchObject({
        "ChatGPT-Account-ID": "identity-a",
      });
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, pending, [200]);
      expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
        captured,
      );
    },
    20_000,
  );

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
    if (listed.status !== 200) {
      throw new Error("Expected the connected account list");
    }
    expect(
      listed.body.modelProviders.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([accountB]);
    await runs.requestCancelRun(f.actor, first, [200]);
    await runs.requestCancelRun(f.actor, second, [200]);
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({ modelProviders: [{ id: accountB }] });
  }, 20_000);

  it("reuses the same Claude identity across a reconnect", async () => {
    const f = await fixture("claude-code-oauth-token", true);
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    expect((await connect(f.actor, f.type, "identity-a")).id).toBe(captured);
    await support.deletePersonalModelProviderAccount(f.actor, captured);
    expect((await connect(f.actor, f.type, "identity-a")).id).toBe(captured);
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${f.connected.token}`,
    });
    await runs.requestCancelRun(f.actor, runId, [200]);
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({ modelProviders: [{ id: captured }] });
  });

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

  describe.each([
    ["claude-code-oauth-token", false],
    ["claude-code-oauth-token", true],
    ["codex-oauth-token", false],
    ["codex-oauth-token", true],
  ] as const)(
    "%s singleton removal with accounts UI %s",
    (type, accountsEnabled) => {
      async function removedSingletonFixture() {
        const f = await fixture(type, accountsEnabled);
        const admitted: string[] = [];
        const owner = createFixtureOperationOwner(async () => {
          for (const runId of admitted) {
            await runs.requestCancelRun(f.actor, runId, [200]);
          }
        });
        return await owner.run(async () => {
          const runId = await f.start();
          admitted.push(runId);
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
          return { f, admitted, owner, claim, captured };
        });
      }

      it("denies the retained credentials to the replacement sandbox", async () => {
        const { f, admitted, owner, claim, captured } =
          await removedSingletonFixture();
        await owner.run(async () => {
          const next = await connect(f.actor, type, "identity-b");
          const nextRun = await f.start();
          admitted.push(nextRun);
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
        });
      });
    },
  );

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
      await finish(f.actor, first, firstClaim, status);
      await expect(resolve(secondClaim, f.type)).resolves.toMatchObject({
        "ChatGPT-Account-ID": "identity-a",
      });
      await finish(f.actor, second, secondClaim, status);
      const reconnected = await connect(f.actor, f.type, "identity-a");
      expect(reconnected.id).not.toBe(captured);
    },
  );

  it("does not resurrect a retained credential when final cancellation races refresh", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    await connect(f.actor, f.type, "identity-a", true);
    await support.deletePersonalModelProviderAccount(f.actor, captured);
    const started = createDeferredPromise<void>(context.signal);
    const released = createDeferredPromise<void>(context.signal);
    firewall.mockCodexTokenRefresh(async () => {
      started.resolve(undefined);
      await released.promise;
      return HttpResponse.json({
        access_token: "refreshed-before-delete",
        refresh_token: "rotated-before-delete",
        expires_in: 7200,
      });
    });
    const refreshing = firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [200, 403],
    );
    onTestFinished(async () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
      await refreshing;
    });
    await started.promise;
    const cancelling = runs.requestCancelRun(f.actor, runId, [200]);
    onTestFinished(async () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
      await cancelling;
    });
    // Final cancellation commits while the upstream refresh is still held.
    await cancelling;
    released.resolve(undefined);
    await Promise.all([refreshing, cancelling]);
    expect((await runs.readRun(f.actor, runId)).status).toBe("cancelled");
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [400, 403, 424],
    );
    expect(denied.status).not.toBe(200);
    expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
      captured,
    );
  }, 20_000);
});

describe("exact subscription selection", () => {
  it.each([
    ["claude-code-oauth-token", "claude-opus-5", "ANTHROPIC_MODEL"],
    ["codex-oauth-token", "gpt-5.6-sol", "OPENAI_MODEL"],
  ] as const)(
    "preserves the requested model and lazy exact %s authentication",
    async (type, model, modelEnv) => {
      const f = await fixture(type);
      await runs.updateOrgModelPolicies(f.actor, [
        {
          model,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const { runId } = await createChatFilesBddApi(context).sendAndLaunch(
        f.actor,
        { agentId: f.agentId, model, prompt: "use the requested model" },
      );
      onTestFinished(async () => {
        await runs.requestCancelRun(f.actor, runId, [200]);
      });
      const claim = await f.claim(runId);
      expect(claim.environment?.[modelEnv]).toBe(model);
      expect(Object.values(claim.environment ?? {})).not.toContain(
        f.connected.token,
      );
      expect(accountId(claim, type)).toBe(f.connected.id);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
        ...(type === "codex-oauth-token"
          ? { "ChatGPT-Account-ID": "identity-a" }
          : {}),
      });
    },
  );
});

test("keeps a Claude identity shared after a type-wide disconnect and reconnect", async () => {
  const f = await fixture("claude-code-oauth-token");
  const runId = await f.start();
  const claim = await f.claim(runId);
  const captured = accountId(claim, f.type);
  await support.deletePersonalModelProvider(f.actor, f.type, [204]);
  const restored = await connect(f.actor, f.type, "identity-a");
  expect(restored.id).toBe(captured);
  await expect(resolve(claim, f.type)).resolves.toMatchObject({
    Authorization: `Bearer ${restored.token}`,
  });
  await runs.requestCancelRun(f.actor, runId, [200]);
});

describe("personal priority over organization API", () => {
  it.each([
    {
      type: "claude-code-oauth-token",
      accountsEnabled: false,
      route: "custom",
    },
    {
      type: "claude-code-oauth-token",
      accountsEnabled: true,
      route: "built-in",
    },
    { type: "codex-oauth-token", accountsEnabled: false, route: "built-in" },
    { type: "codex-oauth-token", accountsEnabled: true, route: "custom" },
  ] as const)(
    "admits $type over $route with account UI $accountsEnabled and zero model credits",
    async ({ type, accountsEnabled, route }) => {
      const f = await fixture(type, accountsEnabled);
      await configureOrganizationApi(f, route);
      if (!f.actor.orgId) {
        throw new Error("Expected an owned organization");
      }
      // Infrastructure-owned credits have no production mutation endpoint.
      await seedOrgMetadata({ orgId: f.actor.orgId, tier: "pro", credits: 0 });
      const runId = await f.start();
      onTestFinished(async () => {
        await runs.requestCancelRun(f.actor, runId, [200]);
      });
      const claim = await f.claim(runId);
      expect(claim.billableFirewalls).toStrictEqual([]);
      const id = accountId(claim, type);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
        ...(type === "codex-oauth-token"
          ? { "ChatGPT-Account-ID": "identity-a" }
          : {}),
      });
      expect(claim.cliAgentType).toBe(
        type === "codex-oauth-token" ? "codex" : "claude-code",
      );
      // Run admission and operational usage do not have production read APIs
      // exposing these fields. Observe persisted attribution, not logger calls.
      await expect(readRunModelSourceFixture(runId)).resolves.toMatchObject({
        modelProvider: type,
        modelProviderId: id,
        modelProviderCredentialScope: "member",
        selectedModel: f.model,
        creditAdmitted: false,
        builtInModelKeyId: null,
      });
      await expect(readRunUsageEventsFixture(runId)).resolves.toStrictEqual([]);
    },
  );
});

describe("personal priority connection boundaries", () => {
  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "uses supported personal %s after the configured API is actually deleted",
    async (type) => {
      const f = await fixture(type);
      await configureOrganizationApi(f, "custom");
      await createMiscRoutesApi(context).deleteOrgModelProvider(
        f.actor,
        type === "codex-oauth-token" ? "openai-api-key" : "anthropic-api-key",
        [204],
      );
      const policy = configuredPolicy(
        await createMiscRoutesApi(context).listModelPolicies(f.actor),
        f.model,
      );
      expect(policy).toMatchObject({
        modelProviderId: null,
        routeStatus: "missing_provider",
        memberEffective: { providerType: type, credentialScope: "member" },
      });
      const runId = await f.start();
      const claim = await f.claim(runId);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await runs.requestCancelRun(f.actor, runId, [200]);
      await support.deletePersonalModelProvider(f.actor, type, [204]);
      // The unavailable selection falls back to the fixed default route, so
      // the send is accepted instead of failing without a model route.
      await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "missing organization API",
        },
        [201],
      );
    },
  );
});

describe("member-effective model policy contract", () => {
  it("keeps administrative GET and PUT fields identical for two real members", async () => {
    const f = await fixture("claude-code-oauth-token", false);
    await configureOrganizationApi(f, "custom");
    const addableModel = await insertBuiltInModelMirrorFixture(f.model);
    onTestFinished(addableModel.restore);
    const bdd = createBddApi(context);
    const member = bdd.user({ orgId: f.actor.orgId, orgRole: "org:member" });
    await bdd.completeOnboarding(member);
    const misc = createMiscRoutesApi(context);
    const before = await misc.listModelPolicies(f.actor);
    const other = await misc.listModelPolicies(member);
    expect(configuredPolicy(before, f.model)?.memberEffective).toMatchObject({
      providerType: f.type,
      credentialScope: "member",
      accountSelection: "capture_required",
    });
    expect(configuredPolicy(other, f.model)?.memberEffective).toMatchObject({
      providerType: "anthropic-api-key",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    });
    const administrative = (response: typeof before) => {
      return {
        modelMode: response.modelMode,
        revision: response.revision,
        writePreconditionRequired: response.writePreconditionRequired,
        policies: response.policies.map((policy) => {
          return {
            ...policy,
            memberEffective: undefined,
          };
        }),
      };
    };
    expect(administrative(before)).toStrictEqual(administrative(other));
    // Addable choices derive from the live operator catalog, not persisted org
    // policy. Other files may add/remove their own models between these reads.
    // This case owns one catalog identity and verifies it for both members.
    for (const response of [before, other]) {
      expect(response.modelsAvailableToAdd).toContain(addableModel.model);
      expect(response.modelsAvailableToAdd).not.toContain(f.model);
    }
    expect(JSON.stringify(before)).not.toContain(f.connected.id);
    expect(JSON.stringify(before)).not.toContain(f.connected.token);
    const put = await misc.updateModelPolicies(
      f.actor,
      before.policies,
      [200],
      before.revision,
    );
    if (put.status !== 200) {
      throw new Error("Expected the policy replacement to succeed");
    }
    expect(configuredPolicy(put.body, f.model)).toMatchObject({
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      memberEffective: { providerType: f.type, credentialScope: "member" },
    });
    const after = await misc.listModelPolicies(member);
    expect(configuredPolicy(after, f.model)).toMatchObject({
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      memberEffective: configuredPolicy(other, f.model)?.memberEffective,
    });
    expect(administrative(put.body)).toStrictEqual(administrative(after));
    for (const response of [put.body, after]) {
      expect(response.modelsAvailableToAdd).toContain(addableModel.model);
      expect(response.modelsAvailableToAdd).not.toContain(f.model);
    }
    expect(
      (await misc.updateModelPolicies(member, before.policies, [403])).status,
    ).toBe(403);
    const otherAgent = await bdd.createAgent(member, {
      displayName: "Other member",
      visibility: "private",
    });
    // Explicit cancellation owns the run's terminal state in this case.
    const chat = createChatFilesBddApi(context);
    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      member,
      {
        agentId: otherAgent.agentId,
        model: f.model,
        prompt: "use my configured org API",
        clientEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the member send to be accepted");
    }
    // The background pick launches the run.
    await flushWaitUntilForTest();
    const runId = (
      await chat.listThreadEvents(member, sent.body.threadId)
    ).events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === clientEventId
      );
    })?.runId;
    if (runId === undefined) {
      throw new Error("Expected a member run");
    }
    await expect(runs.readRun(member, runId)).resolves.toMatchObject({
      source: {
        providerType: "anthropic-api-key",
        credentialScope: "org",
        model: f.model,
      },
    });
    await runs.requestCancelRun(member, runId, [200]);
    await flushWaitUntilForTest();
    await expect(runs.readRun(member, runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("keeps an unsupported subscription/model pair on the configured API", async () => {
    const f = await fixture("claude-code-oauth-token");
    const configured = await runs.createOrgModelProvider(f.actor, {
      type: "openai-api-key",
      secret: "openai-org-key",
    });
    await runs.updateOrgModelPolicies(f.actor, [
      {
        model: "gpt-5.6-luna",
        preferred: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: configured.providerId,
      },
    ]);
    const sent = await createChatFilesBddApi(context).sendAndLaunch(f.actor, {
      agentId: f.agentId,
      model: "gpt-5.6-luna",
      prompt: "Claude cannot authorize this model",
    });
    await expect(runs.readRun(f.actor, sent.runId)).resolves.toMatchObject({
      source: {
        providerType: "openai-api-key",
        credentialScope: "org",
        model: "gpt-5.6-luna",
      },
    });
    const claim = await f.claim(sent.runId);
    if (!claim.encryptedSecrets) {
      throw new Error("Expected the configured organization credential");
    }
    const resolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      {
        encryptedSecrets: claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("OPENAI_API_KEY")}`,
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    expect(resolved.body).toMatchObject({
      headers: { Authorization: "Bearer openai-org-key" },
    });
    await runs.requestCancelRun(f.actor, sent.runId, [200]);
  });

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "requires the configured %s subscription",
    async (type) => {
      const f = await fixture(type, false);
      await support.deletePersonalModelProvider(f.actor, f.type, [204]);
      const { rejected, guidance } = await sendRejectedAtPick(f.actor, {
        agentId: f.agentId,
        model: f.model,
        prompt: "organization policy requires my subscription",
      });
      expect(rejected).toMatchObject({ error: "conflict" });
      expect(guidance?.content).toContain("subscription");
      const policies = await createMiscRoutesApi(context).listModelPolicies(
        f.actor,
      );
      expect(configuredPolicy(policies, f.model)).toMatchObject({
        defaultProviderType: f.type,
        credentialScope: "member",
      });
    },
  );
});

describe("personal effective provider entitlement", () => {
  it.each(["suspended", "byok-disabled"] as const)(
    "rejects %s with org credits and a supported subscription",
    async (state) => {
      const f = await fixture("claude-code-oauth-token");
      await configureOrganizationApi(f, "built-in");
      if (!f.actor.orgId) {
        throw new Error("Expected an owned organization");
      }
      // Infrastructure-only divergent entitlement snapshot, as in chat-events.
      await upsertOrgPlanEntitlementFixture({
        orgId: f.actor.orgId,
        status: state === "suspended" ? "suspended" : "active",
        supportByok: state !== "byok-disabled",
        restrictedBuiltInModels: false,
      });
      const restricted = await sendRejectedAtPick(f.actor, {
        agentId: f.agentId,
        model: f.model,
        prompt: "personal requires plan authority",
      });
      expect(restricted.rejected).toBeDefined();
      const policies = await createMiscRoutesApi(context).listModelPolicies(
        f.actor,
      );
      expect(
        policies.policies.find((policy) => {
          return policy.model === f.model;
        })?.memberEffective,
      ).toMatchObject({
        providerType: f.type,
        credentialScope: "member",
        availability: "plan_restricted",
      });
      await deleteOrgPlanEntitlementFixture(f.actor.orgId);
      // Missing canonical entitlement fails model selection before a thread,
      // input or run can be created. Use raw HTTP for the invariant 500 status.
      const clientThreadId = randomUUID();
      createRouteMocks(context).clerk.session(
        f.actor.userId,
        f.actor.orgId,
        f.actor.orgRole,
      );
      const missing = await setupRawAppRequestWithRoutes({
        context,
        routes: chatEventsRoutes,
      })("/api/chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: f.agentId,
          model: f.model,
          clientThreadId,
          prompt: "missing plan authority",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "missing plan authority" }],
          },
          hasTextContent: true,
        }),
      });
      expect(missing).toStrictEqual({
        status: 500,
        body: { error: "Internal server error" },
      });
      await createChatFilesBddApi(context).requestReadThreadMetadata(
        f.actor,
        clientThreadId,
        [404],
      );
    },
  );
});

describe("subscription bundle decryption ownership", () => {
  it.each([
    "reconnect",
    "activation",
    "disconnect",
    "membership",
    "final-cancel",
  ] as const)(
    "preserves exact authority when %s commits during delayed bundle decrypts",
    async (mutation) => {
      const f = await fixture("codex-oauth-token");
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, f.type);
      if (!f.actor.orgId) {
        throw new Error("Expected an organization");
      }
      const orgId = f.actor.orgId;
      let accountB: string | undefined;
      if (mutation === "activation") {
        const auth = createAuthDeviceApiActions(context);
        mockCodexDeviceAuthProvider({
          tokenScope: "personal",
          accountId: "identity-b",
        });
        const started = await auth.requestCodexStart(
          f.actor,
          "personal",
          [200],
          { mode: "add" },
        );
        if (started.status !== 200) {
          throw new Error("Expected device auth start");
        }
        const connected = await auth.requestCodexComplete(
          f.actor,
          started.body.sessionToken,
          [200],
        );
        if (
          !("status" in connected.body) ||
          connected.body.status !== "complete"
        ) {
          throw new Error("Expected connected account B");
        }
        accountB = connected.body.provider.id;
      }
      if (mutation === "final-cancel") {
        await support.deletePersonalModelProviderAccount(f.actor, captured);
      }
      const webhooks = createWebhookCallbackApi(context);
      if (mutation === "membership") {
        webhooks.configureClerkWebhookSecret();
        webhooks.verifyNextClerkWebhook({
          type: "organizationMembership.deleted",
          data: {
            id: f.actor.userId,
            organization_id: orgId,
            user_id: f.actor.userId,
          },
        });
      }
      const batch = holdSubscriptionKmsBatch(context.signal);
      const requests: Promise<unknown>[] = [];
      onTestFinished(async () => {
        batch.release();
        await Promise.allSettled(requests);
        useSecretKmsProbe();
        if (mutation !== "membership") {
          await runs.requestCancelRun(f.actor, runId, [200]);
        }
      });
      const reading = firewall.requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        authBody(claim, f.type),
        [200, 400, 403, 424],
      );
      requests.push(reading);
      await batch.entered;
      let replacement: Awaited<ReturnType<typeof connect>> | undefined;
      const mutate = async () => {
        if (mutation === "reconnect") {
          replacement = await connect(f.actor, f.type, "identity-a");
        } else if (mutation === "activation" && accountB) {
          await support.activatePersonalModelProviderAccount(f.actor, accountB);
        } else if (mutation === "disconnect") {
          await support.deletePersonalModelProviderAccount(f.actor, captured);
        } else if (mutation === "membership") {
          await webhooks.requestClerkWebhook("{}", {}, [200]);
        } else {
          await runs.requestCancelRun(f.actor, runId, [200]);
        }
      };
      const writing = mutate();
      requests.push(writing);
      // Reads take no lifecycle lock: the mutation commits while the
      // firewall request still holds its credential bundle decrypts.
      await writing;
      batch.release();
      const observed = await reading;
      await writing;
      await flushWaitUntilForTest();
      expect(batch.active).toBe(0);
      if (observed.status === 200) {
        expect(observed.body.headers["ChatGPT-Account-ID"]).toBe("identity-a");
        expect([
          `Bearer ${f.connected.token}`,
          ...(replacement ? [`Bearer ${replacement.token}`] : []),
        ]).toContain(observed.body.headers.Authorization);
      }
      if (mutation === "membership" || mutation === "final-cancel") {
        const denied = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${claim.sandboxToken}` },
          authBody(claim, f.type),
          [400, 401, 403, 424],
        );
        expect(denied.status).not.toBe(200);
        if (mutation === "final-cancel") {
          expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
            captured,
          );
        }
      } else {
        expect(observed.status).toBe(200);
        await expect(resolve(claim, f.type)).resolves.toMatchObject({
          Authorization: `Bearer ${replacement?.token ?? f.connected.token}`,
          "ChatGPT-Account-ID": "identity-a",
        });
        if (mutation === "activation") {
          const next = await f.start();
          onTestFinished(async () => {
            await runs.requestCancelRun(f.actor, next, [200]);
          });
          const nextClaim = await f.claim(next);
          expect(accountId(nextClaim, f.type)).toBe(accountB);
          await expect(resolve(nextClaim, f.type)).resolves.toMatchObject({
            "ChatGPT-Account-ID": "identity-b",
          });
        }
      }
    },
  );
});

describe("personal priority gateway and session boundaries", () => {
  it("keeps a selected subscription personal when credential decryption fails", async () => {
    const f = await fixture("codex-oauth-token");
    await configureOrganizationApi(f, "custom");
    const billingBefore = await runs.readBillingStatus(f.actor);
    const runId = await f.start();
    const claim = await f.claim(runId);
    onTestFinished(async () => {
      useSecretKmsProbe();
      await finish(f.actor, runId, claim, "cancelled");
      await flushWaitUntilForTest();
    });
    const kms = useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("owned KMS transport unavailable"));
    });
    const projected = await createMiscRoutesApi(context).listModelPolicies(
      f.actor,
    );
    expect(configuredPolicy(projected, f.model)?.memberEffective).toMatchObject(
      {
        providerType: f.type,
        credentialScope: "member",
      },
    );
    expect(kms.decryptCalls).toBe(0);
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [400],
    );
    expect(denied.body).toMatchObject({
      error: { message: "Failed to decrypt secrets" },
    });
    expect(kms.decryptCalls).toBeGreaterThan(0);
    expect(claim.billableFirewalls).toStrictEqual([]);
    await expect(runs.readRun(f.actor, runId)).resolves.toMatchObject({
      source: {
        providerType: f.type,
        credentialScope: "member",
        account: { status: "connected", id: f.connected.id },
      },
    });
    await expect(runs.readBillingStatus(f.actor)).resolves.toMatchObject({
      credits: billingBefore.credits,
    });
  });

  it.each(["deleted", "unmapped"] as const)(
    "keeps personal authority when the configured gateway is %s",
    async (loss) => {
      const f = await fixture("claude-code-oauth-token");
      const headers = { authorization: "Bearer clerk-session" };
      createRouteMocks(context).clerk.session(f.actor.userId, f.actor.orgId);
      const surface = {
        protocol: "anthropic-messages" as const,
        apiBaseUrl: "https://gateway.example.com/anthropic",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {{secret}}",
        modelMappings: { [f.model]: "company-sonnet" },
      };
      const created = await accept(
        setupApp({ context, routes: modelProviderGatewayRoutes })(
          modelProviderConnectionsMainContract,
        ).create({
          headers,
          body: {
            displayName: "Company API",
            secret: "unused-gateway-secret",
            surfaces: [surface],
          },
        }),
        [201],
      );
      const surfaceId = created.body.surfaces[0]?.id;
      if (!surfaceId) {
        throw new Error("Expected a configured surface");
      }
      await runs.updateOrgModelPolicies(f.actor, [
        {
          model: f.model,
          preferred: true,
          defaultProviderType: "custom-anthropic-messages",
          credentialScope: "org",
          modelProviderId: null,
          modelProviderSurfaceId: surfaceId,
        },
      ]);
      const client = setupApp({ context, routes: modelProviderGatewayRoutes })(
        modelProviderConnectionsByIdContract,
      );
      if (loss === "deleted") {
        await accept(
          client.delete({ headers, params: { id: created.body.id } }),
          [204],
        );
      } else {
        await accept(
          client.update({
            headers,
            params: { id: created.body.id },
            body: {
              displayName: "Company API",
              surfaces: [{ ...surface, modelMappings: {} }],
            },
          }),
          [200],
        );
      }
      const policies = await createMiscRoutesApi(context).listModelPolicies(
        f.actor,
      );
      expect(
        configuredPolicy(policies, f.model)?.memberEffective,
      ).toMatchObject({
        providerType: f.type,
        credentialScope: "member",
      });
      if (loss === "deleted") {
        expect(
          configuredPolicy(policies, f.model)?.modelProviderSurfaceId,
        ).toBeNull();
      }
      const run = await f.start();
      const claim = await f.claim(run);
      onTestFinished(async () => {
        return await finish(f.actor, run, claim, "cancelled");
      });
      expect((await resolve(claim, f.type)).Authorization).toBe(
        `Bearer ${f.connected.token}`,
      );
      await support.deletePersonalModelProvider(f.actor, f.type, [204]);
      // The unavailable selection falls back to the fixed default route, so
      // the send is accepted instead of failing without a model route.
      await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "the selected organization route must be valid",
        },
        [201],
      );
    },
  );

  it("preserves a Codex session across account changes and resolves uncreated queued messages at promotion", async () => {
    const f = await fixture("codex-oauth-token");
    await configureOrganizationApi(f, "custom");
    const chat = createChatFilesBddApi(context);
    const sent = await chat.sendAndLaunch(f.actor, {
      agentId: f.agentId,
      model: f.model,
      prompt: "first account",
    });
    const first = await f.claim(sent.runId);
    const queued = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        threadId: sent.threadId,
        clientEventId: randomUUID(),
        prompt: "resolve my next account when the queued message becomes a run",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    const replacement = await connect(f.actor, f.type, "identity-b");
    const history = Buffer.from(`subscription history ${sent.runId}`);
    const hash = createHash("sha256").update(history).digest("hex");
    context.sessionHistoryBlobs.set(hash, history);
    await createWebhookCallbackApi(
      context,
    ).requestAgentCheckpointPrepareHistory(
      {
        runId: sent.runId,
        hash,
        rawSize: history.length,
        encodedSize: history.length,
        encoding: "identity",
      },
      { authorization: `Bearer ${first.sandboxToken}` },
      [200],
    );
    await finish(f.actor, sent.runId, first, "completed");
    let nextRunId: string | undefined;
    await flushWaitUntilForTest();
    await expect(
      (async () => {
        const events = await chat.listThreadEvents(f.actor, sent.threadId);
        nextRunId = events.events.find((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.runId &&
            event.runId !== sent.runId
          );
        })?.runId;
        return nextRunId;
      })(),
    ).resolves.toBeTruthy();
    if (!nextRunId) {
      throw new Error("Expected the queued message to be promoted");
    }
    const promotedRunId = nextRunId;
    const second = await f.claim(promotedRunId);
    onTestFinished(async () => {
      await finish(f.actor, promotedRunId, second, "cancelled");
      await flushWaitUntilForTest();
    });
    expect(accountId(first, f.type)).toBe(f.connected.id);
    expect(accountId(second, f.type)).toBe(replacement.id);
    expect((await resolve(second, f.type)).Authorization).toBe(
      `Bearer ${replacement.token}`,
    );
    expect(second.cliAgentType).toBe("codex");
    expect(second.resumeSession?.sessionId).toBe(`subscription-${sent.runId}`);
    const thread = await chat.readThread(f.actor, sent.threadId);
    expect(thread).not.toHaveProperty("modelProviderId");
    expect(thread).not.toHaveProperty("modelProviderType");
  });
});
