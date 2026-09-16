import { convertPiInferenceFixture } from "../../../test-fixtures/pi-inference-lifecycle";
import {
  createHistoricalPinnedSubscriptionRunFixture,
  historicalClaudeSecretFirstFixture,
  historicalCodexReconnectFixture,
  historicalCodexRefreshFixture,
  historicalDeleteSubscriptionFixture,
  reencryptSubscriptionStoresFixture,
  restorePreRecoveryRunIdentityFixture,
} from "../../../test-fixtures/historical-subscription-writer";
import { createHash, randomUUID } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, onTestFinished, test } from "vitest";
import {
  countBlockedPersonalSubscriptionMutationsFixture,
  countWaitingPersonalSubscriptionMutationsFixture,
  observePreparedLaunchAdmissionFixture,
} from "../../../test-fixtures/personal-subscription";
import { seedBuiltInModelCandidateKeys } from "./helpers/runtime-state";
import { readRunModelSourceFixture } from "../../../test-fixtures/agent-runs";
import {
  upsertOrgPlanEntitlementFixture,
  deleteOrgPlanEntitlementFixture,
} from "../../../test-fixtures/org-plan-entitlement";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { readPiMemoryStage1DayFixture } from "../../../test-fixtures/pi-memory-stage1-candidates";
import { createDeferredPromise } from "../../utils";
import {
  holdAgentRunRowLockFixture,
  holdOrgAdmissionLockFixture,
  readRunUsageEventsFixture,
} from "../../../test-fixtures/chat-events";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { apiTestS3PresignedUrl } from "../../../__tests__/mocks";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { holdSubscriptionKmsBatch } from "./helpers/subscription-kms-batch";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
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
const context = testContext();
const runs = createRunsApi(context);
const support = createAuthDeviceSupportApi(context);
const firewall = createFirewallApi(context);

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
      isDefault: true,
      defaultProviderType: route === "built-in" ? "built-in" : type,
      credentialScope: "org",
      modelProviderId: provider?.providerId ?? null,
    },
  ]);
  return provider;
}

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
  historicalFirst = false,
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
    [FeatureSwitchKey.PersonalSubscriptionPriority]: false,
  });
  mockClaudeCodeTokenEndpoint();
  const connected = historicalFirst
    ? await writeHistoricalSubscription(actor, type, "identity-a", 1)
    : await connect(actor, type, "identity-a");
  const model: "gpt-5.6-luna" | "claude-sonnet-5" =
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
  await support.updateFeatureSwitches(actor, {
    [FeatureSwitchKey.PersonalSubscriptionPriority]: priorityEnabled,
  });
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

async function finish(
  actor: ApiTestUser,
  runId: string,
  claim: Claim,
  status: TestTerminalRunStatus,
) {
  if (status === "cancelled") {
    await runs.requestCancelRun(actor, runId, [200]);
  } else if (status === "timeout") {
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = actor.orgId;
    // Infrastructure exception: runtime timeout has no caller endpoint. The
    // scheduler observes elapsed time; its scoped fixture keeps other runs live.
    await withMockNowForTest(now() + 25 * 60 * 60 * 1000, async () => {
      await cleanupTimedOutRun(context, {
        runId,
        orgId,
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
  it("preserves proven singleton recovery while both UI switches remain off", async () => {
    const f = await fixture("codex-oauth-token", false, false);
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
  it("rejects a recovery reset after a legacy writer replaces the already-read account", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    await finish(f.actor, runId, claim, "failed");
    expect((await runs.readRun(f.actor, runId)).source?.account).toStrictEqual({
      status: "connected",
      id: captured,
    });
    await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
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
        await support.resetPersonalModelProviderAccount(
          f.actor,
          captured,
          randomUUID(),
          [404],
          runId,
        )
      ).status,
    ).toBe(404);
    expect(requests).toStrictEqual([]);
  });
  it.each([false, true])(
    "keeps historical account identity unknown, source-less=%s",
    async (sourceLess) => {
      const f = await fixture("codex-oauth-token");
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, f.type);
      await finish(f.actor, runId, claim, "failed");
      await restorePreRecoveryRunIdentityFixture(f.actor, runId, sourceLess);
      expect((await runs.readRun(f.actor, runId)).source).toMatchObject({
        providerType: f.type,
        model: f.model,
        credentialScope: "member",
        account: { status: "unknown" },
      });
      const requests: string[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          ({ request }) => {
            requests.push(request.url);
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
      expect(requests).toStrictEqual([]);
      const wrongMember = createBddApi(context).user({ orgId: f.actor.orgId });
      expect(
        (await runs.requestReadRun(wrongMember, runId, [404])).status,
      ).toBe(404);
      const wrongOrg = createBddApi(context).user();
      expect((await runs.requestReadRun(wrongOrg, runId, [404])).status).toBe(
        404,
      );
    },
  );
  it.each([false, true])(
    "recovers failed A after active B and API policy changes with accounts UI=%s",
    async (accountsEnabled) => {
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
      const started = await auth.requestCodexStart(f.actor, "personal", [200], {
        mode: "add",
      });
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
        expect(listed.body.modelProviders[0]?.modelProviderId).toBeUndefined();
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
    },
  );

  it.each([
    [false, "completed"],
    [true, "completed"],
    [false, "timeout"],
    [true, "timeout"],
  ] as const)(
    "settles the canonical run with priority %s and %s while a second dispatcher prepares the same head",
    async (priority, terminalStatus) => {
      const f = await fixture("codex-oauth-token", true, priority);
      const chat = createChatFilesBddApi(context);
      const thread = await chat.createThread(f.actor, { agentId: f.agentId });
      const firstPrepared = createDeferredPromise<void>(context.signal);
      const secondPrepared = createDeferredPromise<void>(context.signal);
      const releaseFirst = createDeferredPromise<void>(context.signal);
      const releaseSecond = createDeferredPromise<void>(context.signal);
      onTestFinished(() => {
        if (!releaseFirst.settled()) {
          releaseFirst.resolve(undefined);
        }
        if (!releaseSecond.settled()) {
          releaseSecond.resolve(undefined);
        }
      });
      let archiveKey: string | undefined;
      let preparations = 0;
      // The external storage signer suspends real launch preparation. Both
      // dispatchers must capture the same unclaimed head before either commits.
      context.mocks.s3.getSignedUrl.mockImplementation(
        async (_client, command) => {
          if (
            command instanceof GetObjectCommand &&
            command.input.Key?.endsWith("/archive.tar.gz")
          ) {
            archiveKey ??= command.input.Key;
            if (command.input.Key === archiveKey) {
              preparations += 1;
              if (preparations === 1) {
                firstPrepared.resolve(undefined);
                await releaseFirst.promise;
              } else if (preparations === 2) {
                secondPrepared.resolve(undefined);
                await releaseSecond.promise;
              }
            }
          }
          return apiTestS3PresignedUrl(command);
        },
      );
      const headId = randomUUID();
      const sending = chat.requestSendEvent(
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
      await firstPrepared.promise;
      const tailId = randomUUID();
      const draining = chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          threadId: thread.id,
          clientEventId: tailId,
          prompt: "wake another dispatcher",
          model: f.model,
        },
        [201],
      );
      const drainSettled = Promise.allSettled([draining]);
      await secondPrepared.promise;
      // Recall only the wake-up message; the second dispatcher is already
      // preparing the first message through the production queue drainer.
      await chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          threadId: thread.id,
          clientEventId: randomUUID(),
          revokesEventId: tailId,
        },
        [201],
      );
      releaseFirst.resolve(undefined);
      const admitted = await sending;
      if (admitted.status !== 201 || admitted.body.runId === null) {
        throw new Error("Expected the first dispatcher to admit the head");
      }
      const runId = admitted.body.runId;
      const claim = await f.claim(runId);
      // Infrastructure exception: hold the run row so completion first owns
      // the thread and waits here. The stale admission must then wait behind
      // completion without holding its provider lock. No endpoint exposes this
      // PostgreSQL scheduling boundary; all product assertions use APIs.
      const runLock = await holdAgentRunRowLockFixture({
        runId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        runLock.release();
        await runLock.done;
      });
      const completing = finish(f.actor, runId, claim, terminalStatus);
      const completionSettled = Promise.allSettled([completing]);
      await expect.poll(runLock.waiterCount).toBe(1);
      releaseSecond.resolve(undefined);
      await expect.poll(runLock.waiterCount).toBe(2);
      runLock.release();
      await completionSettled;
      await completing;
      await drainSettled;
      expect((await draining).body).toMatchObject({ runId: null });
      await flushWaitUntilForTest();
      const events = (await chat.listThreadEvents(f.actor, thread.id)).events;
      expect(
        events.filter((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.revokesEventId === headId
          );
        }),
      ).toStrictEqual([expect.objectContaining({ runId })]);
      expect((await runs.readRun(f.actor, runId)).status).toBe(terminalStatus);
      expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
    },
    20_000,
  );

  it.each(
    [false, true].flatMap((pi) => {
      return [false, true].map((organizationApi) => {
        return { pi, organizationApi };
      });
    }),
  )(
    "fails captured admission when disconnect commits before run insertion (Pi: $pi, organization API: $organizationApi)",
    async ({ pi, organizationApi }) => {
      const f = await fixture("codex-oauth-token");
      if (organizationApi) {
        await configureOrganizationApi(f, "custom");
      }
      await support.updateFeatureSwitches(f.actor, {
        [FeatureSwitchKey.PiLoop]: pi,
        [FeatureSwitchKey.PiMemory]: true,
      });
      if (!f.actor.orgId) {
        throw new Error("Expected an organization");
      }
      // Infrastructure exception: the API cannot pause a transaction at its
      // admission lock; the fixture only orders competing production requests.
      const lock = await holdOrgAdmissionLockFixture({
        orgId: f.actor.orgId,
        signal: context.signal,
      });
      const holdingSettled = Promise.allSettled([lock.done]);
      const admission = observePreparedLaunchAdmissionFixture({
        orgId: f.actor.orgId,
        signal: context.signal,
      });
      const sending = admission.track(() => {
        return createChatFilesBddApi(context).requestSendEvent(
          f.actor,
          { agentId: f.agentId, prompt: "admission race", model: f.model },
          [409],
        );
      });
      const sendingSettled = Promise.allSettled([sending]);
      onTestFinished(async () => {
        lock.release();
        await Promise.all([holdingSettled, sendingSettled]);
      });
      // The held PostgreSQL lock prevents final validation/insertion after
      // this request finishes preparation, even before its waiter is visible.
      // Surface early HTTP errors instead of timing out waiting for admission.
      await Promise.race([
        admission.attempted,
        (async () => {
          const early = await sending;
          throw new Error(
            `Chat request completed before final admission: ${early.status}`,
          );
        })(),
      ]);
      await support.deletePersonalModelProviderAccount(f.actor, f.connected.id);
      await connect(f.actor, f.type, "identity-b");
      lock.release();
      await lock.done;
      const denied = await sending;
      expect(denied.status).toBe(409);
      expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
      // Infrastructure exception: no endpoint exposes the persistent daily
      // decision. A rejected captured account must leave this budget unconsumed.
      await expect(
        readPiMemoryStage1DayFixture(f.actor.userId),
      ).resolves.toBeNull();
    },
  );
  it.each([false, true])(
    "retains pending and queued bindings when a replacement changes the active identity (organization API: %s)",
    async (organizationApi) => {
      const f = await fixture("codex-oauth-token");
      if (organizationApi) {
        await configureOrganizationApi(f, "custom");
      }
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
  }, 20_000);

  it("cleans the last retained account when its queued run expires", async () => {
    const f = await fixture("codex-oauth-token");
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = f.actor.orgId;
    await connect(f.actor, f.type, "identity-b");
    const first = await f.start();
    const second = await f.start();
    const queuedAccount = await connect(f.actor, f.type, "identity-a");
    const queued = await f.start();
    expect((await runs.readRun(f.actor, queued)).status).toBe("queued");
    await support.deletePersonalModelProviderAccount(f.actor, queuedAccount.id);
    // Infrastructure exception: only the scheduler can advance wall-clock
    // expiry. Invoke its scoped cleanup, then observe the production run API.
    await withMockNowForTest(now() + 25 * 60 * 60 * 1000, async () => {
      await cleanupTimedOutRun(context, {
        runId: queued,
        orgId,
        chatThreadId: randomUUID(),
      });
    });
    expect((await runs.readRun(f.actor, queued)).status).toBe("timeout");
    expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
      queuedAccount.id,
    );
    await runs.requestCancelRun(f.actor, first, [200]);
    await runs.requestCancelRun(f.actor, second, [200]);
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

  it.each(
    (
      [
        "user.banned",
        "user.deleted",
        "organization.deleted",
        "organizationMembership.deleted",
      ] as const
    ).flatMap((eventType) => {
      return (["legacy", "ready", "sandbox_waiting"] as const).map((phase) => {
        return {
          eventType,
          phase,
        };
      });
    }),
  )(
    "keeps $eventType as a hard revocation for a retained $phase subscription",
    async ({ eventType, phase }) => {
      const f = await fixture("codex-oauth-token");
      const runId = await f.start();
      const claim = await f.claim(runId);
      if (phase !== "legacy") {
        await convertPiInferenceFixture(runId, phase);
      }
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

  it.each(["ready", "sandbox_waiting"] as const)(
    "retains the captured account for %s until its final terminal reference",
    async (phase) => {
      const f = await fixture("codex-oauth-token");
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, f.type);
      await convertPiInferenceFixture(runId, phase);
      expect((await runs.readRun(f.actor, runId)).source).toMatchObject({
        providerType: f.type,
        credentialScope: "member",
        account: { status: "connected", id: captured },
      });
      await support.deletePersonalModelProviderAccount(f.actor, captured);
      await expect(resolve(claim, f.type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await expect(runs.readRun(f.actor, runId)).resolves.toMatchObject({
        status: "pending",
        source: {
          providerType: f.type,
          credentialScope: "member",
          account: { status: "unavailable" },
        },
      });
      await runs.requestCancelRun(f.actor, runId, [200]);
      expect(
        (await runs.readRun(f.actor, runId)).source?.account,
      ).toStrictEqual({
        status: "unavailable",
      });
      expect((await connect(f.actor, f.type, "identity-a")).id).not.toBe(
        captured,
      );
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
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = f.actor.orgId;
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
    // Infrastructure exception: no API exposes PostgreSQL lock timing. Observe
    // only the waiter to prove cancellation overlaps the held upstream refresh.
    await expect
      .poll(async () => {
        return await countWaitingPersonalSubscriptionMutationsFixture({
          orgId,
          userId: f.actor.userId,
          type: f.type,
        });
      })
      .toBeGreaterThan(0);
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
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = f.actor.orgId;
    const batch = holdSubscriptionKmsBatch(context.signal);
    const requests: Promise<unknown>[] = [];
    onTestFinished(async () => {
      batch.release();
      await Promise.allSettled(requests);
      useSecretKmsProbe();
      await runs.requestCancelRun(f.actor, runId, [200]);
    });
    const first = resolve(claim, f.type);
    requests.push(first);
    await batch.entered;
    const second = resolve(claim, f.type);
    requests.push(second);
    await expect
      .poll(async () => {
        return await countWaitingPersonalSubscriptionMutationsFixture({
          orgId,
          userId: f.actor.userId,
          type: f.type,
        });
      })
      .toBeGreaterThan(0);
    batch.release();
    const responses = await Promise.all([first, second]);
    for (const headers of responses) {
      expect(headers.Authorization).toBe("Bearer refreshed-a");
      expect(headers["ChatGPT-Account-ID"]).toBe("identity-a");
    }
    expect(batch.active).toBe(0);
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

function historicalClaudeProfiles() {
  server.use(
    http.get("https://api.anthropic.com/api/oauth/profile", ({ request }) => {
      const identity = request.headers
        .get("authorization")
        ?.replace("Bearer sk-ant-oat-", "")
        .replace(/-v[0-9]+$/, "");
      return HttpResponse.json({
        account: { uuid: identity, email: `${identity}@example.com` },
        organization: { uuid: `org-${identity}`, name: identity },
      });
    }),
  );
}

async function writeHistoricalSubscription(
  actor: ApiTestUser,
  type: SubscriptionType,
  identity: string,
  version: number,
) {
  if (type === "claude-code-oauth-token") {
    historicalClaudeProfiles();
    const token = `sk-ant-oat-${identity}-v${version}`;
    const writer = await historicalClaudeSecretFirstFixture(actor, {
      accessToken: token,
      workspaceName: identity,
    });
    return { id: await writer.completeProviderWrite(), token };
  }
  const token = makeCodexJwt({
    exp: Math.floor(now() / 1000) + 7200,
    identity,
    version,
    nonce: randomUUID(),
  });
  const id = await historicalCodexReconnectFixture(actor, {
    accessToken: token,
    accountId: identity,
    refreshToken: `refresh-${identity}-v${version}`,
    idToken: makeCodexJwt({ email: `${identity}@example.com` }),
    expiresAt: new Date(now() + 7_200_000),
  });
  return { id, token };
}

describe("actual historical subscription writers", () => {
  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "converges first %s initialization from concurrent runs and settings",
    async (type) => {
      // Only an actual historical writer can leave a singleton without a
      // concrete account. All observations below use production APIs.
      const f = await fixture(type, true, false, true);
      const [first, second, listed] = await Promise.all([
        f.start(),
        f.start(),
        support.listPersonalModelProviders(f.actor, [200]),
      ]);
      const firstClaim = await f.claim(first);
      const secondClaim = await f.claim(second);
      const captured = accountId(firstClaim, type);
      expect(captured).not.toBe(f.connected.id);
      expect(accountId(secondClaim, type)).toBe(captured);
      expect(listed.body).toMatchObject({
        modelProviders: [
          {
            id: captured,
            isActive: true,
            ...(type === "codex-oauth-token"
              ? { accountEmail: "identity-a@example.com" }
              : {}),
          },
        ],
      });
      for (const claim of [firstClaim, secondClaim]) {
        await expect(resolve(claim, type)).resolves.toMatchObject({
          Authorization: `Bearer ${f.connected.token}`,
          ...(type === "codex-oauth-token"
            ? { "ChatGPT-Account-ID": "identity-a" }
            : {}),
        });
      }
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );

  it.each([false, true])(
    "returns 404 when exact reset itself imports a different old identity, priority=%s",
    async (priority) => {
      const f = await fixture("codex-oauth-token", true, priority);
      const first = await f.start();
      const a = await f.claim(first);
      const captured = accountId(a, f.type);
      const consumeRequests: (string | null)[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
          ({ request }) => {
            consumeRequests.push(request.headers.get("chatgpt-account-id"));
            return HttpResponse.json({ code: "reset", windows_reset: 1 });
          },
        ),
      );
      const b = await writeHistoricalSubscription(
        f.actor,
        f.type,
        "identity-b",
        2,
      );
      // No list, admission or auth between the old write and reset: this very
      // request passes the connected check, imports B and retires/deletes A.
      const idempotencyKey = randomUUID();
      const reset = await support.resetPersonalModelProviderAccount(
        f.actor,
        captured,
        idempotencyKey,
        [404],
      );
      expect(reset.status).toBe(404);
      expect(consumeRequests).toStrictEqual([]);
      expect(
        (
          await support.resetPersonalModelProviderAccount(
            f.actor,
            captured,
            idempotencyKey,
            [404],
          )
        ).status,
      ).toBe(404);
      if (priority) {
        await expect(resolve(a, f.type)).resolves.toMatchObject({
          Authorization: `Bearer ${f.connected.token}`,
          "ChatGPT-Account-ID": "identity-a",
        });
      } else {
        const denied = await firewall.requestFirewallAuth(
          { authorization: `Bearer ${a.sandboxToken}` },
          authBody(a, f.type),
          [424],
        );
        expect(denied.status).toBe(424);
      }
      const second = await f.start();
      const selected = await f.claim(second);
      expect(accountId(selected, f.type)).not.toBe(captured);
      await expect(resolve(selected, f.type)).resolves.toMatchObject({
        Authorization: `Bearer ${b.token}`,
        "ChatGPT-Account-ID": "identity-b",
      });
      expect(consumeRequests).toStrictEqual([]);
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );

  it("does not expose a retained terminal refresh state to the reset that imports its replacement", async () => {
    const f = await fixture("codex-oauth-token");
    const first = await f.start();
    const a = await f.claim(first);
    await connect(f.actor, f.type, "identity-a", true);
    const refreshRequests: string[] = [];
    const consumeRequests: string[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", ({ request }) => {
        refreshRequests.push(request.url);
        return HttpResponse.json(
          { error: { code: "refresh_token_expired" } },
          { status: 401 },
        );
      }),
      http.post(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
        ({ request }) => {
          consumeRequests.push(request.url);
          return HttpResponse.json({ code: "reset" });
        },
      ),
    );
    expect(
      (
        await support.resetPersonalModelProviderAccount(
          f.actor,
          accountId(a, f.type),
          randomUUID(),
          [500],
        )
      ).status,
    ).toBe(500);
    expect(refreshRequests).toHaveLength(1);
    await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
    expect(
      (
        await support.resetPersonalModelProviderAccount(
          f.actor,
          accountId(a, f.type),
          randomUUID(),
          [404],
        )
      ).status,
    ).toBe(404);
    expect(refreshRequests).toHaveLength(1);
    expect(consumeRequests).toStrictEqual([]);
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${a.sandboxToken}` },
      authBody(a, f.type),
      [502],
    );
    expect(denied.status).toBe(502);
    expect(denied.body).toMatchObject({
      error: { failureReason: "reconnect_required" },
    });
    await runs.requestCancelRun(f.actor, first, [200]);
  });

  it("fences the replaced account's expiry when an old writer reuses a retained identity", async () => {
    const f = await fixture("codex-oauth-token");
    const first = await f.start();
    const a = await f.claim(first);
    const b = await connect(f.actor, f.type, "identity-b");
    const second = await f.start();
    const bClaim = await f.claim(second);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Response>(context.signal);
    const detailsUrl =
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
    server.use(
      http.get(detailsUrl, ({ request }) => {
        expect(request.headers.get("chatgpt-account-id")).toBe("identity-b");
        entered.resolve();
        return release.promise;
      }),
    );
    const oldRead = support.listPersonalModelProviders(f.actor, [200]);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(HttpResponse.json({ credits: [] }));
      }
      await oldRead;
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    });
    await entered.promise;
    const restored = await writeHistoricalSubscription(
      f.actor,
      f.type,
      "identity-a",
      3,
    );
    const freshExpiry = new Date(now() + 7_200_000).toISOString();
    server.use(
      http.get(detailsUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${restored.token}`,
        );
        expect(request.headers.get("chatgpt-account-id")).toBe("identity-a");
        return HttpResponse.json({
          credits: [{ status: "available", expires_at: freshExpiry }],
        });
      }),
    );
    const listed = await support.listPersonalModelProviders(f.actor, [200]);
    expect(listed.body).toMatchObject({
      modelProviders: [
        {
          id: accountId(a, f.type),
          isActive: true,
          subscriptionResetCreditsNextExpiresAt: freshExpiry,
        },
      ],
    });
    expect((await oldRead).body).toMatchObject({
      modelProviders: [
        {
          id: b.id,
          subscriptionResetCreditsNextExpiresAt: null,
        },
      ],
    });
    release.resolve(
      HttpResponse.json({
        credits: [
          {
            status: "available",
            expires_at: new Date(now() + 3_600_000).toISOString(),
          },
        ],
      }),
    );
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({
      modelProviders: [
        {
          id: accountId(a, f.type),
          subscriptionResetCreditsNextExpiresAt: freshExpiry,
        },
      ],
    });
    await expect(resolve(a, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${restored.token}`,
      "ChatGPT-Account-ID": "identity-a",
    });
    await expect(resolve(bClaim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${b.token}`,
      "ChatGPT-Account-ID": "identity-b",
    });
  });

  it.each([
    ["claude-code-oauth-token", false, false],
    ["claude-code-oauth-token", true, false],
    ["codex-oauth-token", false, false],
    ["codex-oauth-token", true, false],
    ["claude-code-oauth-token", false, true],
    ["claude-code-oauth-token", true, true],
    ["codex-oauth-token", false, true],
    ["codex-oauth-token", true, true],
  ] as const)(
    "uses the old %s same-identity update without visiting settings (accounts %s, priority %s)",
    async (type, accounts, priority) => {
      // Infrastructure exception: only the named fixture can manufacture an old
      // server artifact's singleton SQL after today's API seeds the concrete row.
      const f = await fixture(type, accounts, priority, true);
      const first = await f.start();
      const firstClaim = await f.claim(first);
      const captured = accountId(firstClaim, type);
      const updated = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-a",
        2,
      );
      const second = await f.start();
      const secondClaim = await f.claim(second);
      expect(accountId(secondClaim, type)).toBe(captured);
      for (const claim of [firstClaim, secondClaim]) {
        await expect(resolve(claim, type)).resolves.toMatchObject({
          Authorization: `Bearer ${updated.token}`,
          ...(type === "codex-oauth-token"
            ? { "ChatGPT-Account-ID": "identity-a" }
            : {}),
        });
      }
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "never redirects an existing exact %s source to a legacy different identity",
    async (type) => {
      const f = await fixture(type);
      const first = await f.start();
      const oldClaim = await f.claim(first);
      const captured = accountId(oldClaim, type);
      const replacement = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-b",
        2,
      );
      const second = await f.start();
      const newClaim = await f.claim(second);
      expect(accountId(newClaim, type)).not.toBe(captured);
      await expect(resolve(newClaim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${replacement.token}`,
      });
      await expect(resolve(oldClaim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
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
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );

  it("imports a real old source-less rotation before a concurrent exact request consumes the rotating input", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const submitted: string[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        const body = await request.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("refresh_token" in body)
        ) {
          throw new Error("Expected a refresh request");
        }
        submitted.push(String(body.refresh_token));
        entered.resolve(undefined);
        await release.promise;
        return HttpResponse.json({
          access_token: "historically-refreshed-a",
          refresh_token: "historically-rotated-a",
          expires_in: 3600,
        });
      }),
    );
    const oldRefresh = historicalCodexRefreshFixture(f.actor, context.signal);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
      await oldRefresh;
    });
    await entered.promise;
    const current = resolve(claim, f.type);
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
      await current;
    });
    await expect
      .poll(() => {
        return countWaitingPersonalSubscriptionMutationsFixture({
          orgId: f.actor.orgId ?? "",
          userId: f.actor.userId,
          type: f.type,
        });
      })
      .toBeGreaterThan(0);
    release.resolve(undefined);
    await oldRefresh;
    await expect(current).resolves.toMatchObject({
      Authorization: "Bearer historically-refreshed-a",
      "ChatGPT-Account-ID": "identity-a",
    });
    expect(submitted).toStrictEqual(["refresh-identity-a"]);
    const cached = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [200],
    );
    if (cached.status !== 200) {
      throw new Error("Expected current auth cache metadata");
    }
    expect(cached.body.expiresAt).toBeGreaterThan(
      Math.floor(now() / 1000) + 3590,
    );
    expect(cached.body.expiresAt).toBeLessThanOrEqual(
      Math.floor(now() / 1000) + 3600,
    );
    await runs.requestCancelRun(f.actor, runId, [200]);
  });

  it("reflects old reconnect-required state and keeps a later canonical recovery", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    firewall.mockCodexTokenRefresh(() => {
      return HttpResponse.json(
        { error: { code: "refresh_token_reused" } },
        { status: 400 },
      );
    });
    await historicalCodexRefreshFixture(f.actor, context.signal);
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [502],
    );
    expect(denied.body).toMatchObject({
      error: {
        code: "TOKEN_REFRESH_FAILED",
        failureReason: "reconnect_required",
      },
    });
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({
      modelProviders: [
        expect.objectContaining({
          needsReconnect: true,
          lastRefreshErrorCode: "refresh_token_reused",
        }),
      ],
    });
    const recovered = await connect(f.actor, f.type, "identity-a");
    expect(recovered.id).toBe(accountId(claim, f.type));
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${recovered.token}`,
      "ChatGPT-Account-ID": "identity-a",
    });
    await runs.requestCancelRun(f.actor, runId, [200]);
  });

  it("keeps canonical C when old Claude B completes its second autocommit late", async () => {
    const f = await fixture("claude-code-oauth-token");
    const writer = await historicalClaudeSecretFirstFixture(f.actor, {
      accessToken: "sk-ant-oat-identity-b",
      workspaceName: "identity-b",
    });
    const c = await connect(f.actor, f.type, "identity-c");
    await writer.completeProviderWrite();
    const runId = await f.start();
    const claim = await f.claim(runId);
    expect(accountId(claim, f.type)).toBe(c.id);
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${c.token}`,
    });
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({
      modelProviders: [
        expect.objectContaining({ id: c.id, workspaceName: "identity-c" }),
      ],
    });
    await runs.requestCancelRun(f.actor, runId, [200]);
  });

  it.each(["connect", "delete"] as const)(
    "discards delayed Claude identity proof when %s wins",
    async (winner) => {
      const f = await fixture("claude-code-oauth-token");
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
      server.use(
        http.get(
          "https://api.anthropic.com/api/oauth/profile",
          async ({ request }) => {
            if (
              request.headers.get("authorization") ===
              "Bearer sk-ant-oat-identity-b-v2"
            ) {
              entered.resolve(undefined);
              await release.promise;
            }
            return HttpResponse.json({
              account: { uuid: "identity-b", email: "b@example.com" },
              organization: { uuid: "org-b", name: "b" },
            });
          },
        ),
      );
      const sending = createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        { agentId: f.agentId, model: f.model, prompt: "capture the old write" },
        [409],
      );
      onTestFinished(async () => {
        if (!release.settled()) {
          release.resolve(undefined);
        }
        await sending;
      });
      await entered.promise;
      if (winner === "connect") {
        await connect(f.actor, f.type, "identity-c");
      } else {
        await historicalDeleteSubscriptionFixture(f.actor, f.type);
      }
      release.resolve(undefined);
      expect((await sending).status).toBe(409);
      const listed = await support.listPersonalModelProviders(f.actor, [200]);
      expect(listed.body).toMatchObject({
        modelProviders:
          winner === "delete"
            ? []
            : [expect.objectContaining({ workspaceName: "identity-c" })],
      });
    },
  );

  it("fails opaque identity ambiguity even when usage metadata succeeds", async () => {
    const f = await fixture("claude-code-oauth-token", false, false, true);
    const first = await f.start();
    const claim = await f.claim(first);
    await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
    server.use(
      http.get("https://api.anthropic.com/api/oauth/profile", () => {
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const denied = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${claim.sandboxToken}` },
      authBody(claim, f.type),
      [424],
    );
    expect(denied.status).toBe(424);
    const next = await createChatFilesBddApi(context).requestSendEvent(
      f.actor,
      { agentId: f.agentId, model: f.model, prompt: "unknown identity" },
      [409],
    );
    expect(next.status).toBe(409);
    await runs.requestCancelRun(f.actor, first, [200]);
  });

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "fails a pre-stability %s context after actual old hard deletion and recovers a fresh selection",
    async (type) => {
      const f = await fixture(type, true, false);
      const first = await f.start();
      const original = await f.claim(first);
      await historicalDeleteSubscriptionFixture(f.actor, type);
      const replacement = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-b",
        2,
      );
      const next = await f.start();
      const current = await f.claim(next);
      expect(accountId(current, type)).not.toBe(accountId(original, type));
      await expect(resolve(current, type)).resolves.toMatchObject({
        Authorization: `Bearer ${replacement.token}`,
      });
      expect(
        (
          await firewall.requestFirewallAuth(
            { authorization: `Bearer ${original.sandboxToken}` },
            authBody(original, type),
            [424],
          )
        ).status,
      ).toBe(424);
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, next, [200]);
    },
  );
});

describe("historical writer consumer fences", () => {
  it.each([
    ["claude-code-oauth-token", "unchanged"],
    ["codex-oauth-token", "unchanged"],
    ["claude-code-oauth-token", "reconnect"],
    ["codex-oauth-token", "reencrypt"],
    ["claude-code-oauth-token", "delete"],
    ["codex-oauth-token", "revoke"],
  ] as const)(
    "keeps %s proof decryption outside lifecycle locks and fences a winning %s",
    async (type, winner) => {
      const f = await fixture(type);
      const captured = f.connected.id;
      const kmsEntered = createDeferredPromise<void>(context.signal);
      const releaseKms = createDeferredPromise<Uint8Array>(context.signal);
      let holdNextDecrypt = false;
      useSecretKmsProbe(undefined, () => {
        if (holdNextDecrypt) {
          holdNextDecrypt = false;
          kmsEntered.resolve(undefined);
          return releaseKms.promise;
        }
        return undefined;
      });
      let rotateAtSigner = true;
      // The real external signer is after environment materialization. Make
      // the two stores independently encrypted before admission prepares its
      // proof, then hold the next external decrypt of that equivalent bundle.
      context.mocks.s3.getSignedUrl.mockImplementation(
        async (_client, command) => {
          if (
            rotateAtSigner &&
            command instanceof GetObjectCommand &&
            command.input.Key?.endsWith("/archive.tar.gz")
          ) {
            rotateAtSigner = false;
            await reencryptSubscriptionStoresFixture(f.actor, type);
            holdNextDecrypt = true;
          }
          return apiTestS3PresignedUrl(command);
        },
      );
      const sending = createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "prove without lifecycle locks",
        },
        winner === "unchanged" ? [201] : [409],
      );
      const sendingSettled = Promise.allSettled([sending]);
      onTestFinished(async () => {
        holdNextDecrypt = false;
        if (!releaseKms.settled()) {
          releaseKms.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        await sendingSettled;
      });
      await expect(
        Promise.race([
          kmsEntered.promise.then(() => {
            return "kms";
          }),
          sending.then(() => {
            return "settled";
          }),
        ]),
      ).resolves.toBe("kms");
      // These real writers must finish while the proof's KMS response is held.
      // They need the provider/credential locks, which preparation has released.
      if (winner === "reconnect") {
        expect((await connect(f.actor, type, "identity-a")).id).toBe(captured);
      } else if (winner === "reencrypt") {
        await reencryptSubscriptionStoresFixture(f.actor, type);
      } else if (winner === "delete") {
        await historicalDeleteSubscriptionFixture(f.actor, type);
      } else if (winner === "revoke") {
        const webhooks = createWebhookCallbackApi(context);
        webhooks.configureClerkWebhookSecret();
        webhooks.verifyNextClerkWebhook({
          type: "organizationMembership.deleted",
          data: { organization_id: f.actor.orgId, user_id: f.actor.userId },
        });
        await webhooks.requestClerkWebhook("{}", {}, [200]);
        await flushWaitUntilForTest();
      }
      releaseKms.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
      const result = await sending;
      if (winner === "unchanged") {
        if (result.status !== 201 || result.body.runId === null) {
          throw new Error(
            "Expected an unchanged proof to admit the captured account",
          );
        }
        const claim = await f.claim(result.body.runId);
        expect(accountId(claim, type)).toBe(captured);
        await expect(resolve(claim, type)).resolves.toMatchObject({
          Authorization: `Bearer ${f.connected.token}`,
        });
        await runs.requestCancelRun(f.actor, result.body.runId, [200]);
      } else {
        expect(result.status).toBe(409);
        if (winner === "reencrypt" || winner === "reconnect") {
          // A stale proof is rejected, but a fresh request can prove the new
          // encrypted snapshot. Rotation must never strand a valid account.
          const next = await f.start();
          const claim = await f.claim(next);
          expect(accountId(claim, type)).toBe(captured);
          await expect(resolve(claim, type)).resolves.toMatchObject({
            Authorization: `Bearer ${f.connected.token}`,
          });
          await runs.requestCancelRun(f.actor, next, [200]);
        }
      }
    },
    20_000,
  );

  it.each([
    ["claude-code-oauth-token", false, "chat"],
    ["codex-oauth-token", true, "chat"],
    ["claude-code-oauth-token", true, "direct"],
    ["codex-oauth-token", false, "direct"],
    ["claude-code-oauth-token", false, "queued"],
    ["codex-oauth-token", true, "queued"],
    ["claude-code-oauth-token", true, "session"],
    ["codex-oauth-token", false, "session"],
  ] as const)(
    "admits equivalent reencrypted %s bundles with priority %s through %s without final KMS",
    async (type, priority, mode) => {
      const f = await fixture(type, priority, priority);
      const initial = await createHistoricalPinnedSubscriptionRunFixture(
        {
          owner: f.actor,
          agentId: f.agentId,
          accountId: f.connected.id,
          type,
          model: f.model,
        },
        context.signal,
      );
      if (initial.status !== 201) {
        throw new Error("Expected an initial subscription session");
      }
      const first = initial.body;
      const firstClaim = await f.claim(first.runId);
      const captured = accountId(firstClaim, type);
      const firstSessionId = first.sessionId;
      await createWebhookCallbackApi(context).requestAgentComplete(
        {
          runId: first.runId,
          exitCode: 0,
          checkpoint: {
            cliAgentType: firstClaim.cliAgentType,
            cliAgentSessionId: `subscription-${first.runId}`,
            cliAgentSessionHistoryDisposition: "discarded_oversized",
          },
        },
        { authorization: `Bearer ${firstClaim.sandboxToken}` },
        [200],
      );
      const occupied: string[] = [];
      let sessionId: string | undefined;
      if (mode === "queued") {
        occupied.push(await f.start(), await f.start());
      } else if (mode === "session") {
        sessionId = firstSessionId;
      }
      await reencryptSubscriptionStoresFixture(f.actor, type);
      if (!f.actor.orgId) {
        throw new Error("Expected an organization");
      }
      const lock = await holdOrgAdmissionLockFixture({
        orgId: f.actor.orgId,
        signal: context.signal,
      });
      const kmsEntered = createDeferredPromise<void>(context.signal);
      const releaseKms = createDeferredPromise<Uint8Array>(context.signal);
      let holdKms = false;
      const kms = useSecretKmsProbe(undefined, () => {
        if (holdKms) {
          if (!kmsEntered.settled()) {
            kmsEntered.resolve(undefined);
          }
          return releaseKms.promise;
        }
        return undefined;
      });
      const sending =
        mode === "direct" || mode === "session"
          ? createHistoricalPinnedSubscriptionRunFixture(
              {
                owner: f.actor,
                agentId: f.agentId,
                accountId: captured,
                sessionId,
                type,
                model: f.model,
              },
              context.signal,
            )
          : createChatFilesBddApi(context).requestSendEvent(
              f.actor,
              {
                agentId: f.agentId,
                model: f.model,
                prompt: "equivalent independently encrypted subscription",
              },
              [201],
            );
      const sendingSettled = Promise.allSettled([sending]);
      onTestFinished(async () => {
        holdKms = false;
        if (!releaseKms.settled()) {
          releaseKms.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        lock.release();
        await lock.done;
        await sendingSettled;
      });
      await expect.poll(lock.waiterCount).toBe(1);
      const preparedDecrypts = kms.decryptCalls;
      holdKms = true;
      lock.release();
      await expect(
        Promise.race([
          sending.then(() => {
            return "settled";
          }),
          kmsEntered.promise.then(() => {
            return "kms";
          }),
        ]),
      ).resolves.toBe("settled");
      expect(kms.decryptCalls).toBe(preparedDecrypts);
      const result = await sending;
      if (result.status !== 201 || result.body.runId === null) {
        throw new Error("Expected the same reencrypted account to be admitted");
      }
      holdKms = false;
      const runId = result.body.runId;
      if (mode === "session") {
        expect(result.body).toMatchObject({ sessionId: firstSessionId });
      }
      if (mode === "queued") {
        expect((await runs.readRun(f.actor, runId)).status).toBe("queued");
        for (const occupiedId of occupied) {
          await runs.requestCancelRun(f.actor, occupiedId, [200]);
        }
        await expect
          .poll(async () => {
            return (await runs.readRun(f.actor, runId)).status;
          })
          .toBe("pending");
      }
      const claim = await f.claim(runId);
      expect(accountId(claim, type)).toBe(captured);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await runs.requestCancelRun(f.actor, runId, [200]);
    },
    20_000,
  );

  it.each([
    [false, "completed"],
    [true, "completed"],
    [false, "timeout"],
    [true, "timeout"],
  ] as const)(
    "rejects a late old Codex writer without waiting for KMS or blocking %s/%s cleanup",
    async (priority, terminalStatus) => {
      const f = await fixture("codex-oauth-token", true, priority);
      const runId = await f.start();
      const claim = await f.claim(runId);
      if (!f.actor.orgId) {
        throw new Error("Expected an organization");
      }
      const lock = await holdOrgAdmissionLockFixture({
        orgId: f.actor.orgId,
        signal: context.signal,
      });
      const kmsEntered = createDeferredPromise<void>(context.signal);
      const releaseKms = createDeferredPromise<Uint8Array>(context.signal);
      let holdKms = false;
      const kms = useSecretKmsProbe(undefined, () => {
        if (holdKms) {
          if (!kmsEntered.settled()) {
            kmsEntered.resolve(undefined);
          }
          return releaseKms.promise;
        }
        return undefined;
      });
      const sending = createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "late old writer with held KMS",
        },
        [409],
      );
      const sendingSettled = Promise.allSettled([sending]);
      onTestFinished(async () => {
        holdKms = false;
        if (!releaseKms.settled()) {
          releaseKms.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        lock.release();
        await lock.done;
        await sendingSettled;
      });
      // Actual PostgreSQL admission waiter: capture and all outside-lock
      // preparation have finished. Replay the immutable old transaction now.
      await expect.poll(lock.waiterCount).toBe(1);
      await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
      const preparedDecrypts = kms.decryptCalls;
      holdKms = true;
      lock.release();
      const boundary = await Promise.race([
        sending.then(() => {
          return "settled" as const;
        }),
        kmsEntered.promise.then(() => {
          return "kms" as const;
        }),
      ]);
      let terminalSettled = false;
      const completing = finish(f.actor, runId, claim, terminalStatus).then(
        () => {
          terminalSettled = true;
        },
      );
      const completingSettled = Promise.allSettled([completing]);
      onTestFinished(async () => {
        holdKms = false;
        if (!releaseKms.settled()) {
          releaseKms.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        await completingSettled;
      });
      // On the old implementation the external decrypt owns the provider lock
      // and real terminal cleanup waits behind it. Observe that exact wait,
      // rather than using a timeout or an arbitrary sleep as proof of blocking.
      await expect
        .poll(async () => {
          if (terminalSettled) {
            return "settled";
          }
          return (await countWaitingPersonalSubscriptionMutationsFixture({
            orgId: f.actor.orgId!,
            userId: f.actor.userId,
            type: f.type,
          })) > 0
            ? "blocked"
            : "pending";
        })
        .not.toBe("pending");
      expect(terminalSettled).toBeTruthy();
      expect(boundary).toBe("settled");
      expect(kms.decryptCalls).toBe(preparedDecrypts);
      expect((await sending).status).toBe(409);
      expect((await runs.readRun(f.actor, runId)).status).toBe(terminalStatus);
      expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
    },
    20_000,
  );

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "rejects the original %s capture when the old writer wins final admission",
    async (type) => {
      const f = await fixture(type);
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
        { agentId: f.agentId, model: f.model, prompt: "late old write" },
        [409],
      );
      onTestFinished(async () => {
        lock.release();
        await sending;
      });
      await expect.poll(lock.waiterCount).toBe(1);
      await writeHistoricalSubscription(f.actor, type, "identity-b", 2);
      lock.release();
      expect((await sending).status).toBe(409);
      expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
    },
  );

  it("refreshes retained A without importing active B or republishing over B's legacy update", async () => {
    const f = await fixture("codex-oauth-token");
    const first = await f.start();
    const a = await f.claim(first);
    await connect(f.actor, f.type, "identity-a", true);
    await connect(f.actor, f.type, "identity-b");
    const currentB = await writeHistoricalSubscription(
      f.actor,
      f.type,
      "identity-b",
      2,
    );
    const submitted: string[] = [];
    server.use(
      http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
        const input = await request.json();
        if (
          typeof input !== "object" ||
          input === null ||
          !("refresh_token" in input)
        ) {
          throw new Error("Expected refresh input");
        }
        submitted.push(String(input.refresh_token));
        return HttpResponse.json({
          access_token: "inactive-refreshed-a",
          refresh_token: "inactive-rotated-a",
          expires_in: 7200,
        });
      }),
    );
    await expect(resolve(a, f.type)).resolves.toMatchObject({
      Authorization: "Bearer inactive-refreshed-a",
      "ChatGPT-Account-ID": "identity-a",
    });
    expect(submitted).toStrictEqual(["refresh-identity-a"]);
    const second = await f.start();
    const b = await f.claim(second);
    await expect(resolve(b, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${currentB.token}`,
      "ChatGPT-Account-ID": "identity-b",
    });
    await runs.requestCancelRun(f.actor, first, [200]);
    await runs.requestCancelRun(f.actor, second, [200]);
  });

  it("uses the updated complete Codex bundle for settings usage and account reset", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    const updated = await writeHistoricalSubscription(
      f.actor,
      f.type,
      "identity-a",
      2,
    );
    const requests: {
      path: string;
      token: string | null;
      account: string | null;
    }[] = [];
    for (const [method, path] of [
      ["get", "usage"],
      ["post", "rate-limit-reset-credits/consume"],
    ] as const) {
      server.use(
        http[method](
          `https://chatgpt.com/backend-api/wham/${path}`,
          ({ request }) => {
            requests.push({
              path,
              token: request.headers.get("authorization"),
              account: request.headers.get("chatgpt-account-id"),
            });
            return HttpResponse.json(
              method === "post"
                ? { code: "reset", windows_reset: 1 }
                : {
                    plan_type: "plus",
                    rate_limit_reset_credits: { available_count: 1 },
                  },
            );
          },
        ),
      );
    }
    const reset = await support.resetPersonalModelProviderAccount(
      f.actor,
      captured,
      randomUUID(),
      [200],
    );
    expect(reset.status).toBe(200);
    await support.listPersonalModelProviders(f.actor, [200]);
    expect(requests).toStrictEqual(
      expect.arrayContaining([
        {
          path: "usage",
          token: `Bearer ${updated.token}`,
          account: "identity-a",
        },
        {
          path: "rate-limit-reset-credits/consume",
          token: `Bearer ${updated.token}`,
          account: "identity-a",
        },
      ]),
    );
    expect(
      requests.every((request) => {
        return (
          request.token === `Bearer ${updated.token}` &&
          request.account === "identity-a"
        );
      }),
    ).toBeTruthy();
    await runs.requestCancelRun(f.actor, runId, [200]);
  });
});

describe("historical exact selection and retained-only parent", () => {
  it.each([
    ["claude-code-oauth-token", "identity-a"],
    ["claude-code-oauth-token", "identity-b"],
    ["codex-oauth-token", "identity-a"],
    ["codex-oauth-token", "identity-b"],
  ] as const)(
    "resolves a legacy %s %s write between capture and environment preparation",
    async (type, identity) => {
      const f = await fixture(type);
      await reencryptSubscriptionStoresFixture(f.actor, f.type);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<Uint8Array>(context.signal);
      let holdCaptureProof = true;
      useSecretKmsProbe(undefined, () => {
        if (holdCaptureProof) {
          holdCaptureProof = false;
          entered.resolve();
          return release.promise;
        }
        return undefined;
      });
      // This captured-ID fixture has no queued-input decryption. Its first
      // KMS read proves the independently reencrypted capture bundle while
      // owning the provider/credential locks. Queue the real old writer there
      // so environment preparation, not capture, must import its new bundle.
      const admitting = createHistoricalPinnedSubscriptionRunFixture(
        {
          owner: f.actor,
          agentId: f.agentId,
          accountId: f.connected.id,
          type: f.type,
          model: f.model,
        },
        context.signal,
      );
      const admissionSettled = Promise.allSettled([admitting]);
      onTestFinished(async () => {
        if (!release.settled()) {
          release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        const [result] = await admissionSettled;
        if (result?.status === "fulfilled" && result.value.status === 201) {
          await runs.requestCancelRun(f.actor, result.value.body.runId, [200]);
        }
      });
      await expect(
        Promise.race([
          entered.promise.then(() => {
            return "capture";
          }),
          admitting.then(() => {
            return "settled";
          }),
        ]),
      ).resolves.toBe("capture");
      historicalClaudeProfiles();
      const claudeToken = `sk-ant-oat-${identity}-v2`;
      // Keep Claude's second autocommit pending until preparation finishes.
      // This exercises its actual secret-first writer without adding an
      // advisory lock or racing a later metadata write against admission.
      const writing =
        type === "claude-code-oauth-token"
          ? historicalClaudeSecretFirstFixture(f.actor, {
              accessToken: claudeToken,
              workspaceName: identity,
            })
          : writeHistoricalSubscription(f.actor, type, identity, 2);
      const writerSettled = Promise.allSettled([writing]);
      onTestFinished(async () => {
        if (!release.settled()) {
          release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
        }
        await writerSettled;
      });
      if (!f.actor.orgId) {
        throw new Error("Expected an owned organization");
      }
      const orgId = f.actor.orgId;
      await expect
        .poll(() => {
          return countBlockedPersonalSubscriptionMutationsFixture({
            orgId,
            userId: f.actor.userId,
            type: f.type,
          });
        })
        .toBe(1);
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
      const updated = await writing;
      const result = await admitting;
      if ("completeProviderWrite" in updated) {
        await updated.completeProviderWrite();
      }
      if (identity === "identity-b") {
        expect(result.status).toBe(503);
        expect(result.body).toMatchObject({
          error: { code: "PROVIDER_UNAVAILABLE" },
        });
        expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
        return;
      }
      if (result.status !== 201) {
        throw new Error("Expected same-identity environment preparation");
      }
      const claim = await f.claim(result.body.runId);
      expect(accountId(claim, f.type)).toBe(f.connected.id);
      const modelEnv =
        type === "claude-code-oauth-token" ? "ANTHROPIC_MODEL" : "OPENAI_MODEL";
      expect(claim.environment?.[modelEnv]).toBe(f.model);
      await expect(resolve(claim, f.type)).resolves.toMatchObject({
        Authorization: `Bearer ${"token" in updated ? updated.token : claudeToken}`,
        ...(type === "codex-oauth-token"
          ? { "ChatGPT-Account-ID": "identity-a" }
          : {}),
      });
    },
  );

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
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const sent = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        { agentId: f.agentId, model, prompt: "use the requested model" },
        [201],
      );
      if (sent.status !== 201 || sent.body.runId === null) {
        throw new Error("Expected an admitted subscription run");
      }
      const runId = sent.body.runId;
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

  it.each([
    ["claude-code-oauth-token", false],
    ["claude-code-oauth-token", true],
    ["codex-oauth-token", false],
    ["codex-oauth-token", true],
  ] as const)(
    "rejects a captured %s source replaced by an old writer, priority=%s",
    async (type, priority) => {
      const f = await fixture(type, true, priority);
      const replacement = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-b",
        2,
      );
      // Only the historical adapter can submit a concrete captured ID; public
      // model-first requests would deliberately capture the current account.
      const rejected = await createHistoricalPinnedSubscriptionRunFixture(
        {
          owner: f.actor,
          agentId: f.agentId,
          accountId: f.connected.id,
          type,
          model: f.model,
        },
        context.signal,
      );
      expect(rejected.status).toBe(409);
      expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
      const next = await f.start();
      onTestFinished(async () => {
        await runs.requestCancelRun(f.actor, next, [200]);
      });
      const claim = await f.claim(next);
      expect(accountId(claim, type)).not.toBe(f.connected.id);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${replacement.token}`,
        ...(type === "codex-oauth-token"
          ? { "ChatGPT-Account-ID": "identity-b" }
          : {}),
      });
    },
  );

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "rejects missing and foreign %s sources without selecting the owned account",
    async (type) => {
      const f = await fixture(type);
      const foreign = await fixture(type);
      for (const sourceId of [randomUUID(), foreign.connected.id]) {
        const rejected = await createHistoricalPinnedSubscriptionRunFixture(
          {
            owner: f.actor,
            agentId: f.agentId,
            accountId: sourceId,
            type,
            model: f.model,
          },
          context.signal,
        );
        expect(rejected.status).toBe(409);
      }
      const next = await f.start();
      const claim = await f.claim(next);
      expect(accountId(claim, type)).toBe(f.connected.id);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await runs.requestCancelRun(f.actor, next, [200]);
    },
  );

  it("admits a captured connected account while another account is active", async () => {
    const f = await fixture("codex-oauth-token");
    const auth = createAuthDeviceApiActions(context);
    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "identity-b",
    });
    const started = await auth.requestCodexStart(f.actor, "personal", [200], {
      mode: "add",
    });
    if (started.status !== 200) {
      throw new Error("Expected device auth start");
    }
    const completed = await auth.requestCodexComplete(
      f.actor,
      started.body.sessionToken,
      [200],
    );
    if (!("status" in completed.body) || completed.body.status !== "complete") {
      throw new Error("Expected device auth completion");
    }
    const accountB = completed.body.provider.id;
    await support.activatePersonalModelProviderAccount(f.actor, accountB);
    const listed = await support.listPersonalModelProviders(f.actor, [200]);
    expect(listed.body).toMatchObject({
      modelProviders: expect.arrayContaining([
        expect.objectContaining({ id: f.connected.id, isActive: false }),
        expect.objectContaining({ id: accountB, isActive: true }),
      ]),
    });

    // The documented historical fixture carries an already captured concrete
    // ID, which current model-first public input cannot select directly.
    const admitted = await createHistoricalPinnedSubscriptionRunFixture(
      {
        owner: f.actor,
        agentId: f.agentId,
        accountId: f.connected.id,
        type: f.type,
        model: f.model,
      },
      context.signal,
    );
    if (admitted.status !== 201) {
      throw new Error("Expected the connected captured account to be admitted");
    }
    expect(
      (await runs.readRun(f.actor, admitted.body.runId)).source,
    ).toMatchObject({
      providerType: f.type,
      credentialScope: "member",
      account: { status: "connected", id: f.connected.id },
    });
    const claim = await f.claim(admitted.body.runId);
    expect(accountId(claim, f.type)).toBe(f.connected.id);
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${f.connected.token}`,
      "ChatGPT-Account-ID": "identity-a",
    });
    await runs.requestCancelRun(f.actor, admitted.body.runId, [200]);
  });

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "coordinates a direct concrete %s admission before environment materialization",
    async (type) => {
      const f = await fixture(type);
      const updated = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-a",
        2,
      );
      const result = await createHistoricalPinnedSubscriptionRunFixture(
        {
          owner: f.actor,
          agentId: f.agentId,
          accountId: f.connected.id,
          type,
          model: f.model,
        },
        context.signal,
      );
      if (result.status !== 201) {
        throw new Error("Expected pinned subscription admission");
      }
      const claim = await f.claim(result.body.runId);
      expect(accountId(claim, type)).toBe(f.connected.id);
      await expect(resolve(claim, type)).resolves.toMatchObject({
        Authorization: `Bearer ${updated.token}`,
      });
      await runs.requestCancelRun(f.actor, result.body.runId, [200]);
    },
  );

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "recognizes an old %s reconnect after the last connected account was retired",
    async (type) => {
      const f = await fixture(type);
      const first = await f.start();
      const a = await f.claim(first);
      await support.deletePersonalModelProviderAccount(
        f.actor,
        accountId(a, type),
      );
      const b = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-b",
        2,
      );
      const second = await f.start();
      const selected = await f.claim(second);
      expect(accountId(selected, type)).not.toBe(accountId(a, type));
      await expect(resolve(a, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await expect(resolve(selected, type)).resolves.toMatchObject({
        Authorization: `Bearer ${b.token}`,
      });
      await runs.requestCancelRun(f.actor, first, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );

  it("does not probe profile or usage for an already coherent Claude runtime bundle", async () => {
    const f = await fixture("claude-code-oauth-token");
    const sameBytes = await historicalClaudeSecretFirstFixture(f.actor, {
      accessToken: f.connected.token,
      workspaceName: "late display metadata",
    });
    await sameBytes.completeProviderWrite();
    const requested: string[] = [];
    server.use(
      http.get("https://api.anthropic.com/api/oauth/:path", ({ request }) => {
        requested.push(request.url);
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const runId = await f.start();
    const claim = await f.claim(runId);
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${f.connected.token}`,
    });
    expect(requested).toStrictEqual([]);
    await runs.requestCancelRun(f.actor, runId, [200]);
  });
});

test("discards a delayed legacy Claude profile when explicit account activation wins", async () => {
  const f = await fixture("claude-code-oauth-token");
  const auth = createAuthDeviceApiActions(context);
  mockClaudeCodeTokenEndpoint({
    accountEmail: "c@example.com",
    organizationName: "Workspace C",
  });
  const started = await auth.requestClaudeCodeStart(
    f.actor,
    "personal",
    [200],
    { mode: "add" },
  );
  if (started.status !== 200) {
    throw new Error("Expected OAuth start");
  }
  const state = new URL(started.body.browserUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const completed = await auth.requestClaudeCodeComplete(
    f.actor,
    started.body.sessionToken,
    `code#${state}`,
    [200],
  );
  if (completed.status !== 200) {
    throw new Error("Expected OAuth completion");
  }
  const c = completed.body.provider.id;
  await writeHistoricalSubscription(f.actor, f.type, "identity-b", 2);
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  server.use(
    http.get(
      "https://api.anthropic.com/api/oauth/profile",
      async ({ request }) => {
        if (
          request.headers.get("authorization") ===
          "Bearer sk-ant-oat-identity-b-v2"
        ) {
          entered.resolve(undefined);
          await release.promise;
        }
        return HttpResponse.json({
          account: { uuid: "b", email: "b@example.com" },
          organization: { uuid: "org-b", name: "B" },
        });
      },
    ),
  );
  const sending = createChatFilesBddApi(context).requestSendEvent(
    f.actor,
    {
      agentId: f.agentId,
      model: f.model,
      prompt: "capture B before activation",
    },
    [409],
  );
  onTestFinished(async () => {
    if (!release.settled()) {
      release.resolve(undefined);
    }
    await sending;
  });
  await entered.promise;
  await support.activatePersonalModelProviderAccount(f.actor, c);
  release.resolve(undefined);
  expect((await sending).status).toBe(409);
  const runId = await f.start();
  const claim = await f.claim(runId);
  expect(accountId(claim, f.type)).toBe(c);
  await expect(resolve(claim, f.type)).resolves.toMatchObject({
    Authorization: "Bearer claude-code-access-token",
  });
  await runs.requestCancelRun(f.actor, runId, [200]);
});

test("keeps a seeded Claude identity shared after a type-wide disconnect and reconnect", async () => {
  const f = await fixture("claude-code-oauth-token", true, true, true);
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

describe("canonical preparation identity", () => {
  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "does not replace a captured %s identity when retention is off",
    async (type) => {
      const f = await fixture(type, false, false);
      const runId = await f.start();
      const claim = await f.claim(runId);
      const captured = accountId(claim, type);
      const b = await connect(f.actor, type, "identity-b");
      const denied = await firewall.requestFirewallAuth(
        { authorization: `Bearer ${claim.sandboxToken}` },
        authBody(claim, type),
        [424],
      );
      expect(denied.status).toBe(424);
      const second = await f.start();
      const next = await f.claim(second);
      expect(accountId(next, type)).not.toBe(captured);
      await expect(resolve(next, type)).resolves.toMatchObject({
        Authorization: `Bearer ${b.token}`,
      });
      await runs.requestCancelRun(f.actor, runId, [200]);
      await runs.requestCancelRun(f.actor, second, [200]);
    },
  );
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
    "keeps %s unseeded singleton and historical retained-parent reconnect personal",
    async (type) => {
      const f = await fixture(type, false, true, true);
      await configureOrganizationApi(f, "custom");
      const first = await f.start();
      const a = await f.claim(first);
      onTestFinished(async () => {
        await runs.requestCancelRun(f.actor, first, [200]);
      });
      await expect(resolve(a, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
      await support.deletePersonalModelProvider(f.actor, type, [204]);
      // No new mirror is true absence even though A's parent is retained.
      const absent = await f.start();
      await expect(readRunModelSourceFixture(absent)).resolves.toMatchObject({
        modelProvider:
          type === "codex-oauth-token" ? "openai-api-key" : "anthropic-api-key",
        modelProviderCredentialScope: "org",
        selectedModel: f.model,
      });
      await runs.requestCancelRun(f.actor, absent, [200]);
      const b = await writeHistoricalSubscription(
        f.actor,
        type,
        "identity-b",
        2,
      );
      // A settings list here would import the mirror and hide a broken resolver.
      const second = await f.start();
      const selected = await f.claim(second);
      onTestFinished(async () => {
        await runs.requestCancelRun(f.actor, second, [200]);
      });
      expect(accountId(selected, type)).not.toBe(accountId(a, type));
      await expect(resolve(selected, type)).resolves.toMatchObject({
        Authorization: `Bearer ${b.token}`,
      });
      await expect(resolve(a, type)).resolves.toMatchObject({
        Authorization: `Bearer ${f.connected.token}`,
      });
    },
  );

  it("keeps a partial historical Claude reconnect personal without importing during projection", async () => {
    const f = await fixture("claude-code-oauth-token");
    await configureOrganizationApi(f, "custom");
    const runId = await f.start();
    const a = await f.claim(runId);
    onTestFinished(async () => {
      await runs.requestCancelRun(f.actor, runId, [200]);
    });
    await support.deletePersonalModelProviderAccount(
      f.actor,
      accountId(a, f.type),
    );
    const writer = await historicalClaudeSecretFirstFixture(f.actor, {
      accessToken: "sk-ant-oat-partial-b",
      workspaceName: "B",
    });
    const requests: string[] = [];
    server.use(
      http.get("https://api.anthropic.com/api/oauth/:path", ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const kms = useSecretKmsProbe();
    const policies = await createMiscRoutesApi(context).listModelPolicies(
      f.actor,
    );
    expect(policies.policies[0]?.memberEffective).toMatchObject({
      providerType: f.type,
      credentialScope: "member",
      accountSelection: "capture_required",
    });
    expect(JSON.stringify(policies)).not.toContain(accountId(a, f.type));
    const chat = createChatFilesBddApi(context);
    const thread = await chat.createThread(f.actor, {
      agentId: f.agentId,
      model: f.model,
    });
    await chat.updateThreadModelSelection(f.actor, thread.id, f.model);
    await chat.readThread(f.actor, thread.id);
    expect(requests).toStrictEqual([]);
    expect(kms.decryptCalls).toBe(0);
    expect(kms.generateDataKeyCalls).toBe(0);
    const denied = await createChatFilesBddApi(context).requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: f.model,
        prompt: "partial historical connection",
      },
      [409],
    );
    expect(denied.status).toBe(409);
    expect((await runs.readRunQueue(f.actor)).body.queue).toHaveLength(0);
    await writer.completeProviderWrite();
    // A real profile failure during canonical capture is also not absence.
    const unavailable = await createChatFilesBddApi(context).requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: f.model,
        prompt: "unresolved historical identity",
      },
      [409],
    );
    expect(unavailable.status).toBe(409);
    expect(requests).not.toHaveLength(0);
  });

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
      const policy = (
        await createMiscRoutesApi(context).listModelPolicies(f.actor)
      ).policies[0];
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
      const rejected = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "missing organization API",
        },
        [400],
      );
      expect(rejected.status).toBe(400);
    },
  );

  it.each(["claude-code-oauth-token", "codex-oauth-token"] as const)(
    "preserves priority-off %s organization routing and Built-in credit admission",
    async (type) => {
      const f = await fixture(type, false, false);
      await configureOrganizationApi(f, "custom");
      const custom = await f.start();
      await expect(readRunModelSourceFixture(custom)).resolves.toMatchObject({
        modelProvider:
          type === "codex-oauth-token" ? "openai-api-key" : "anthropic-api-key",
        modelProviderCredentialScope: "org",
      });
      await runs.requestCancelRun(f.actor, custom, [200]);
      await configureOrganizationApi(f, "built-in");
      if (!f.actor.orgId) {
        throw new Error("Expected an organization");
      }
      await seedOrgMetadata({ orgId: f.actor.orgId, tier: "pro", credits: 0 });
      const rejected = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "Built-in requires model credits",
        },
        [201],
      );
      expect(rejected.body).toMatchObject({ runId: null });
      await seedOrgMetadata({
        orgId: f.actor.orgId,
        tier: "pro",
        credits: 1_000_000,
      });
      await seedBuiltInModelCandidateKeys(context, f.model);
      const builtin = await f.start();
      await expect(readRunModelSourceFixture(builtin)).resolves.toMatchObject({
        modelProvider: "built-in",
        modelProviderCredentialScope: "org",
        creditAdmitted: true,
        builtInModelKeyId: expect.any(String),
      });
      await runs.requestCancelRun(f.actor, builtin, [200]);
      const policies = await createMiscRoutesApi(context).listModelPolicies(
        f.actor,
      );
      expect(policies.policies[0]).not.toHaveProperty("memberEffective");
    },
  );
});

describe("member-effective model policy contract", () => {
  it("keeps administrative GET and PUT fields identical for two real members", async () => {
    const f = await fixture("claude-code-oauth-token", false);
    await configureOrganizationApi(f, "custom");
    const bdd = createBddApi(context);
    const member = bdd.user({ orgId: f.actor.orgId, orgRole: "org:member" });
    const misc = createMiscRoutesApi(context);
    const before = await misc.listModelPolicies(f.actor);
    const other = await misc.listModelPolicies(member);
    expect(before.policies[0]?.memberEffective).toMatchObject({
      providerType: f.type,
      credentialScope: "member",
      accountSelection: "capture_required",
    });
    expect(other.policies[0]?.memberEffective).toMatchObject({
      providerType: "anthropic-api-key",
      credentialScope: "org",
      availability: "available",
      accountSelection: "not_applicable",
    });
    const administrative = (response: typeof before) => {
      return {
        ...response,
        policies: response.policies.map((policy) => {
          return {
            ...policy,
            memberEffective: undefined,
          };
        }),
      };
    };
    expect(administrative(before)).toStrictEqual(administrative(other));
    expect(JSON.stringify(before)).not.toContain(f.connected.id);
    expect(JSON.stringify(before)).not.toContain(f.connected.token);
    const put = await misc.updateModelPolicies(
      f.actor,
      before.policies,
      [200],
      before.revision,
    );
    expect(put.body).toMatchObject({
      policies: [
        {
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          memberEffective: { providerType: f.type, credentialScope: "member" },
        },
      ],
    });
    const after = await misc.listModelPolicies(member);
    expect(after.policies[0]).toMatchObject({
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      memberEffective: other.policies[0]?.memberEffective,
    });
    expect(
      (await misc.updateModelPolicies(member, before.policies, [403])).status,
    ).toBe(403);
    const otherAgent = await bdd.createAgent(member, {
      displayName: "Other member",
      visibility: "private",
    });
    const sent = await createChatFilesBddApi(context).requestSendEvent(
      member,
      {
        agentId: otherAgent.agentId,
        model: f.model,
        prompt: "use my configured org API",
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected a member run");
    }
    await expect(
      readRunModelSourceFixture(sent.body.runId),
    ).resolves.toMatchObject({
      modelProvider: "anthropic-api-key",
      modelProviderCredentialScope: "org",
      selectedModel: f.model,
    });
    await runs.requestCancelRun(member, sent.body.runId, [200]);
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
        isDefault: true,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: configured.providerId,
      },
    ]);
    const sent = await createChatFilesBddApi(context).requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: "gpt-5.6-luna",
        prompt: "Claude cannot authorize this model",
      },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected an organization run");
    }
    await expect(
      readRunModelSourceFixture(sent.body.runId),
    ).resolves.toMatchObject({
      modelProvider: "openai-api-key",
      modelProviderId: configured.providerId,
      modelProviderCredentialScope: "org",
      selectedModel: "gpt-5.6-luna",
    });
    await runs.requestCancelRun(f.actor, sent.body.runId, [200]);
  });

  it.each([
    ["claude-code-oauth-token", true],
    ["claude-code-oauth-token", false],
    ["codex-oauth-token", true],
    ["codex-oauth-token", false],
  ] as const)(
    "requires the configured %s subscription with priority %s",
    async (type, priority) => {
      const f = await fixture(type, false, priority);
      await support.deletePersonalModelProvider(f.actor, f.type, [204]);
      const sent = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "organization policy requires my subscription",
        },
        [409],
      );
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({
        error: { message: expect.stringContaining("subscription") },
      });
      const policies = await createMiscRoutesApi(context).listModelPolicies(
        f.actor,
      );
      expect(policies.policies[0]).toMatchObject({
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
      const sent = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "personal requires plan authority",
        },
        [201],
      );
      expect(sent.body).toMatchObject({ runId: null });
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
      // Missing canonical entitlement is an invariant error, not permission to run.
      createRouteMocks(context).clerk.session(f.actor.userId, f.actor.orgId);
      const missing = await createApp({
        routes: chatEventsRoutes,
        signal: context.signal,
      }).request("/api/chat/events", {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agentId: f.agentId,
          model: f.model,
          prompt: "missing plan authority",
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "missing plan authority" }],
          },
          hasTextContent: true,
          clientEventId: randomUUID(),
        }),
      });
      expect(missing.status).toBe(500);
    },
  );
});

describe("subscription bundle decryption ownership", () => {
  it("joins a failed KMS batch before releasing the provider to disconnect", async () => {
    const f = await fixture("codex-oauth-token");
    const runId = await f.start();
    const claim = await f.claim(runId);
    const captured = accountId(claim, f.type);
    if (!f.actor.orgId) {
      throw new Error("Expected an organization");
    }
    const orgId = f.actor.orgId;
    const batch = holdSubscriptionKmsBatch(context.signal);
    const requests: Promise<unknown>[] = [];
    onTestFinished(async () => {
      batch.release();
      await Promise.allSettled(requests);
      useSecretKmsProbe();
      await runs.requestCancelRun(f.actor, runId, [200]);
    });
    let responded = false;
    const reading = firewall
      .requestFirewallAuthRaw(JSON.stringify(authBody(claim, f.type)), {
        authorization: `Bearer ${claim.sandboxToken}`,
      })
      .then((response) => {
        responded = true;
        return response;
      });
    requests.push(reading);
    await batch.entered;
    batch.failFirst();
    const disconnecting = support.deletePersonalModelProviderAccount(
      f.actor,
      captured,
    );
    requests.push(disconnecting);
    // Infrastructure-only synchronization: the API does not expose DB waiters.
    await expect
      .poll(async () => {
        return await countWaitingPersonalSubscriptionMutationsFixture({
          orgId,
          userId: f.actor.userId,
          type: f.type,
        });
      })
      .toBeGreaterThan(0);
    expect(responded).toBeFalsy();
    expect(batch.active).toBe(1);
    expect(batch.calls).toBe(3);
    batch.release();
    const denied = await reading;
    await disconnecting;
    expect(denied.status).toBe(500);
    expect(denied.body).toStrictEqual({ error: "Internal server error" });
    expect(batch.active).toBe(0);
    expect(batch.peak).toBe(2);
    expect(batch.calls).toBe(3);
    useSecretKmsProbe();
    // The failed read neither exposed credentials nor poisoned the next owner.
    await expect(resolve(claim, f.type)).resolves.toMatchObject({
      Authorization: `Bearer ${f.connected.token}`,
      "ChatGPT-Account-ID": "identity-a",
    });
    expect(
      (await support.listPersonalModelProviders(f.actor, [200])).body,
    ).toMatchObject({ modelProviders: [] });
  });

  it.each([
    "reconnect",
    "activation",
    "disconnect",
    "membership",
    "final-cancel",
  ] as const)(
    "preserves exact authority when %s waits behind delayed bundle decrypts",
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
      await expect
        .poll(async () => {
          return await countWaitingPersonalSubscriptionMutationsFixture({
            orgId,
            userId: f.actor.userId,
            type: f.type,
          });
        })
        .toBeGreaterThan(0);
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
    expect(projected.policies[0]?.memberEffective).toMatchObject({
      providerType: f.type,
      credentialScope: "member",
    });
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
    await expect(readRunModelSourceFixture(runId)).resolves.toMatchObject({
      modelProvider: f.type,
      modelProviderId: f.connected.id,
      modelProviderCredentialScope: "member",
      creditAdmitted: false,
      builtInModelKeyId: null,
    });
    await expect(readRunUsageEventsFixture(runId)).resolves.toHaveLength(0);
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
          isDefault: true,
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
      expect(policies.policies[0]?.memberEffective).toMatchObject({
        providerType: f.type,
        credentialScope: "member",
      });
      if (loss === "deleted") {
        expect(policies.policies[0]?.modelProviderSurfaceId).toBeNull();
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
      const failed = await createChatFilesBddApi(context).requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          model: f.model,
          prompt: "the selected organization route must be valid",
        },
        [400],
      );
      expect(failed.status).toBe(400);
    },
  );

  it("preserves a Codex session across account changes and resolves uncreated queued messages at promotion", async () => {
    const f = await fixture("codex-oauth-token");
    await configureOrganizationApi(f, "custom");
    const chat = createChatFilesBddApi(context);
    const sent = await chat.requestSendEvent(
      f.actor,
      { agentId: f.agentId, model: f.model, prompt: "first account" },
      [201],
    );
    if (sent.status !== 201 || !sent.body.runId) {
      throw new Error("Expected the first run");
    }
    const first = await f.claim(sent.body.runId);
    const queued = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        threadId: sent.body.threadId,
        clientEventId: randomUUID(),
        prompt: "resolve my next account when the queued message becomes a run",
      },
      [201],
    );
    expect(queued.body).toMatchObject({ runId: null });
    const replacement = await connect(f.actor, f.type, "identity-b");
    const history = Buffer.from(`subscription history ${sent.body.runId}`);
    const hash = createHash("sha256").update(history).digest("hex");
    context.sessionHistoryBlobs.set(hash, history);
    await createWebhookCallbackApi(
      context,
    ).requestAgentCheckpointPrepareHistory(
      {
        runId: sent.body.runId,
        hash,
        rawSize: history.length,
        encodedSize: history.length,
        encoding: "identity",
      },
      { authorization: `Bearer ${first.sandboxToken}` },
      [200],
    );
    await finish(f.actor, sent.body.runId, first, "completed");
    let nextRunId: string | undefined;
    await expect
      .poll(async () => {
        const events = await chat.listThreadEvents(f.actor, sent.body.threadId);
        nextRunId = events.events.find((event) => {
          return (
            event.eventType === "input.prompt" &&
            event.runId &&
            event.runId !== sent.body.runId
          );
        })?.runId;
        return nextRunId;
      })
      .toBeTruthy();
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
    expect(second.resumeSession?.sessionId).toBe(
      `subscription-${sent.body.runId}`,
    );
    const thread = await chat.readThread(f.actor, sent.body.threadId);
    expect(thread).not.toHaveProperty("modelProviderId");
    expect(thread).not.toHaveProperty("modelProviderType");
  });
});
