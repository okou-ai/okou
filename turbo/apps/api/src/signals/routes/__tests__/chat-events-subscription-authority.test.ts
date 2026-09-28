import { randomUUID } from "node:crypto";
import { piApiFirstTurnManifestSchema } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HTTPException } from "hono/http-exception";
import { HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { holdThreadSessionConversationClearFixture } from "../../../test-fixtures/chat-events";
import { holdPiContextPreparationStagesFixture } from "../../../test-fixtures/pi-context-preparation";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { readThreadSessionConversation } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  requireOrgId,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  chatCallbacks,
  authDeviceSupport,
  entitledChatActor,
  configureUserOwnedGptPiModel,
  configureOrganizationGptModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  requestSendEventRaw,
  requestSendEventWithBearer,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  expectPiSandboxHandoff,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

function jsonHttpException(status: 409 | 422, message: string) {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

function observePendingSend<T>(send: Promise<T>) {
  const result = settleIncludingAbort(send);
  const phases: Promise<unknown>[] = [];

  async function beforeSettlement(phase: PromiseLike<unknown>) {
    const work = Promise.resolve(phase);
    phases.push(work);
    await Promise.race([
      work,
      result.then((settled) => {
        if (!settled.ok) {
          throw settled.error;
        }
        throw new Error(
          "Chat send completed before its held subscription preparation phase",
        );
      }),
    ]);
  }

  async function joinPhases() {
    await Promise.allSettled(phases);
  }

  return { result, beforeSettlement, joinPhases };
}

describe("CHAT-02: run-level model overrides", () => {
  describe("subscription account preparation", () => {
    async function prepareSubscriptionThread() {
      const { actor, agentId } = await entitledChatActor();
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: `preparation-subscription-${randomUUID()}`,
      });

      const thread = await chat.createThread(actor, { agentId });
      const preparation = holdPiContextPreparationStagesFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      return { actor, agentId, captured, thread, preparation };
    }

    it("overlaps account capture with thread observation and keeps captured identity", async () => {
      const f = await prepareSubscriptionThread();
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const send = sendChatRun(f.actor, {
        agentId: f.agentId,
        threadId: f.thread.id,
        model: "gpt-5.6-terra",
        prompt: "overlap subscription capture with thread preparation",
      });
      const observed = observePendingSend(send);

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      expect(
        f.preparation.hasArrived("post-authorization-context"),
      ).toBeFalsy();
      f.preparation.release("subscription-account");
      await observed.beforeSettlement(
        f.preparation.arrival("post-authorization-context"),
      );
      expect(f.preparation.arrivalCount("subscription-account")).toBe(1);
      expect(f.preparation.arrivalCount("thread-session")).toBe(1);
      f.preparation.release("post-authorization-context");
      f.preparation.release("thread-session");
      f.preparation.releaseAll();

      const run = await send;
      await observed.joinPhases();
      await expect(api.readRun(f.actor, run.runId)).resolves.toMatchObject({
        source: {
          providerType: "codex-oauth-token",
          account: { id: f.captured.accountSourceId },
        },
      });
    });

    it("rejects an account disconnected after capture before environment preparation", async () => {
      const f = await prepareSubscriptionThread();
      const clientEventId = randomUUID();
      const prompt = "reject a disconnected captured account";
      const send = requestSendEventRaw(f.actor, {
        agentId: f.agentId,
        threadId: f.thread.id,
        model: "gpt-5.6-terra",
        prompt,
        clientEventId,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
      });
      const observed = observePendingSend(send);

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      f.preparation.release("subscription-account");
      await observed.beforeSettlement(
        f.preparation.arrival("post-authorization-context"),
      );
      await authDeviceSupport.deletePersonalModelProviderAccount(
        f.actor,
        f.captured.accountSourceId,
      );
      f.preparation.release("post-authorization-context");
      f.preparation.release("thread-session");
      f.preparation.releaseAll();

      await expect(send).resolves.toMatchObject({
        status: 503,
        body: { error: { code: "PROVIDER_UNAVAILABLE" } },
      });
      await observed.joinPhases();
      const events = await chat.listThreadEvents(f.actor, f.thread.id);
      expect(events.events).toStrictEqual([
        expect.objectContaining({
          eventType: "input.prompt",
          id: clientEventId,
        }),
        expect.objectContaining({
          eventType: "control.revoke",
          revokesEventId: clientEventId,
        }),
      ]);
    });

    it("captures once while a stale thread snapshot retries with the same account", async () => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: `retry-subscription-${randomUUID()}`,
      });

      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const firstPrompt = "establish subscription session before retry";
      const first = await sendChatRun(actor, {
        agentId,
        model: "gpt-5.6-terra",
        prompt: firstPrompt,
      });
      await completeSandboxFirstPiRun({
        actor,
        answer: "subscription retry answer",
        checkpointObjects: objects,
        claim: await claimChatRun(runnerGroup, first.runId),
        prompt: firstPrompt,
        run: first,
        usagePricingResolution: await createGptUsagePricingResolution(),
      });

      const conversationClear = await holdThreadSessionConversationClearFixture(
        {
          threadId: first.threadId,
          signal: context.signal,
        },
      );
      onTestFinished(async () => {
        conversationClear.release();
        await conversationClear.done;
      });
      const preparation = holdPiContextPreparationStagesFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: context.signal,
      });
      const secondPromise = sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: "gpt-5.6-terra",
        prompt: "retry subscription preparation after snapshot change",
      });

      await Promise.all([
        preparation.arrival("subscription-account"),
        preparation.arrival("thread-session"),
      ]);
      preparation.release("subscription-account");
      await preparation.arrival("post-authorization-context");
      for (const stage of [
        "post-authorization-context",
        "thread-session",
        "connector-contexts",
        "model-provider",
        "user-timezone",
        "media-models",
        "official-workflow",
      ] as const) {
        preparation.release(stage);
      }
      await expect
        .poll(conversationClear.blockedWaiterCount)
        .toBeGreaterThanOrEqual(1);

      conversationClear.release();
      await conversationClear.done;
      const second = await secondPromise;
      expect(preparation.arrivalCount("subscription-account")).toBe(1);
      expect(preparation.arrivalCount("thread-session")).toBe(2);
      await expect(api.readRun(actor, second.runId)).resolves.toMatchObject({
        source: {
          providerType: "codex-oauth-token",
          account: { id: captured.accountSourceId },
        },
      });
      preparation.releaseAll();
      await cancelChatRun(actor, second.runId);
    }, 90_000);

    it("keeps an unavailable capture ahead of a speculative thread failure", async () => {
      const f = await prepareSubscriptionThread();
      const clientEventId = randomUUID();
      const prompt = "prefer unavailable capture over thread failure";
      const send = requestSendEventRaw(f.actor, {
        agentId: f.agentId,
        threadId: f.thread.id,
        model: "gpt-5.6-terra",
        prompt,
        clientEventId,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
      });
      const observed = observePendingSend(send);

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      await authDeviceSupport.deletePersonalModelProviderAccount(
        f.actor,
        f.captured.accountSourceId,
      );
      f.preparation.reject(
        "thread-session",
        jsonHttpException(422, "session preparation failed"),
      );
      await observed.beforeSettlement(
        f.preparation.departure("thread-session"),
      );
      f.preparation.release("subscription-account");

      await expect(send).resolves.toStrictEqual({
        status: 409,
        body: {
          error: {
            code: "CONFLICT",
            message:
              "The selected subscription account is unavailable. Reconnect it before starting another run.",
          },
        },
      });
      await observed.joinPhases();
      expect(
        f.preparation.hasArrived("post-authorization-context"),
      ).toBeFalsy();
      f.preparation.releaseAll();
      const events = await chat.listThreadEvents(f.actor, f.thread.id);
      expect(events.events).toStrictEqual([
        expect.objectContaining({
          eventType: "input.prompt",
          id: clientEventId,
        }),
        expect.objectContaining({
          eventType: "control.revoke",
          revokesEventId: clientEventId,
        }),
      ]);
    });

    it("keeps post-authorization failure ahead of thread failure after capture", async () => {
      const f = await prepareSubscriptionThread();
      const clientEventId = randomUUID();
      const prompt = "preserve subscription preparation error order";
      const send = requestSendEventRaw(f.actor, {
        agentId: f.agentId,
        threadId: f.thread.id,
        model: "gpt-5.6-terra",
        prompt,
        clientEventId,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
      });
      const observed = observePendingSend(send);

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      f.preparation.release("subscription-account");
      await f.preparation.arrival("post-authorization-context");
      f.preparation.reject(
        "thread-session",
        jsonHttpException(422, "session preparation failed"),
      );
      await observed.beforeSettlement(
        f.preparation.departure("thread-session"),
      );
      f.preparation.reject(
        "post-authorization-context",
        jsonHttpException(409, "authorization preparation failed"),
      );

      await expect(send).resolves.toStrictEqual({
        status: 409,
        body: { error: { message: "authorization preparation failed" } },
      });
      await observed.joinPhases();
      f.preparation.releaseAll();
      const events = await chat.listThreadEvents(f.actor, f.thread.id);
      expect(events.events).toStrictEqual([
        expect.objectContaining({
          eventType: "input.prompt",
          id: clientEventId,
        }),
      ]);
    });

    it("settles capture and thread branches before surfacing cancellation", async () => {
      const { actor, agentId } = await entitledChatActor();
      await configureSubscriptionPiModel(actor, {
        accountId: `cancelled-subscription-${randomUUID()}`,
      });

      const thread = await chat.createThread(actor, { agentId });
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([
        controller.signal,
        context.signal,
      ]);
      const preparation = holdPiContextPreparationStagesFixture({
        userId: actor.userId,
        orgId: requireOrgId(actor),
        signal: requestSignal,
        gateSignal: context.signal,
      });
      const clientEventId = randomUUID();
      const prompt = "cancel held subscription preparation";
      const send = requestSendEventRaw(
        actor,
        {
          agentId,
          threadId: thread.id,
          model: "gpt-5.6-terra",
          prompt,
          clientEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: prompt }],
          },
          hasTextContent: true,
        },
        requestSignal,
      );
      const observed = observePendingSend(send);

      await Promise.all([
        preparation.arrival("subscription-account"),
        preparation.arrival("thread-session"),
      ]);
      controller.abort(
        new DOMException("cancelled by subscription route test", "AbortError"),
      );
      preparation.release("thread-session");
      await observed.beforeSettlement(preparation.departure("thread-session"));
      preparation.release("subscription-account");

      const response = await send;
      expect(response.status).toBe(500);
      await observed.joinPhases();
      await preparation.departure("subscription-account");
      expect(preparation.hasArrived("post-authorization-context")).toBeFalsy();
      preparation.releaseAll();
      const events = await chat.listThreadEvents(actor, thread.id);
      expect(events.events).toStrictEqual([
        expect.objectContaining({
          eventType: "input.prompt",
          id: clientEventId,
        }),
      ]);
    });
  });

  describe("final subscription authority", () => {
    async function claimPreparedSubscription() {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const identity = `held-subscription-${randomUUID()}`;
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: identity,
        accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
      });
      await configureOrganizationGptModel(actor);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const run = await sendChatRun(actor, {
        agentId,
        model: "gpt-5.6-terra",
        prompt: "preserve final subscription authority",
        runOptions: { codexServiceTier: "fast" },
      });
      const claimed = await claimChatRun(runnerGroup, run.runId);
      return { actor, captured, run, ...claimed };
    }

    it.each(["connected invalid_grant", "retained terminal refresh"] as const)(
      "rejects %s acquired after preparation without refreshing again",
      async (failure) => {
        const f = await claimPreparedSubscription();
        if (failure === "retained terminal refresh") {
          await authDeviceSupport.deletePersonalModelProviderAccount(
            f.actor,
            f.captured.accountSourceId,
          );
        }
        let refreshAttempts = 0;
        const firewall = createFirewallApi(context);
        firewall.mockCodexTokenRefresh(() => {
          refreshAttempts += 1;
          return failure === "connected invalid_grant"
            ? HttpResponse.json({ error: "invalid_grant" }, { status: 400 })
            : HttpResponse.json(
                { error: { code: "refresh_token_invalidated" } },
                { status: 401 },
              );
        });
        const rejected = await firewall.requestFirewallAuth(
          f.sandboxHeaders,
          {
            encryptedSecrets: z.string().parse(f.claim.encryptedSecrets),
            authHeaders: {
              Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
              "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
            },
            secretConnectorMap: f.claim.secretConnectorMap ?? undefined,
            secretConnectorMetadataMap:
              f.claim.secretConnectorMetadataMap ?? undefined,
            forceRefresh: true,
          },
          [502],
        );
        expect(rejected.body).toMatchObject({
          error: { failureReason: "reconnect_required" },
        });
        expect(refreshAttempts).toBe(1);
        expect(f.captured.oauth.oauthToken).toHaveLength(1);
        await expectNoBuiltInModelUsage(f.run.runId);
        await cancelChatRun(f.actor, f.run.runId, f.sandboxHeaders);
      },
      30_000,
    );
  });

  // A captured account referenced by a nonterminal run is retained, so deleting
  // it no longer revokes the prepared subscription. `personal-subscription-run-
  // identity` owns that retention contract; this case keeps the refresh path.
  it("rejects a prepared subscription when its captured account needs a reconnect", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor, {
      accountId: "prepared-subscription-account",
      accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
    });
    mockPiResourceArchiveDownloads();
    mockPiCheckpointObjectStore();
    const run = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "retain subscription revocation at execution",
      runOptions: { codexServiceTier: "fast" },
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const firewall = createFirewallApi(context);
    firewall.mockCodexTokenRefresh(() => {
      return HttpResponse.json(
        {
          error: {
            code: "refresh_token_invalidated",
            message: "revoked account",
          },
        },
        { status: 401 },
      );
    });
    const rejected = await firewall.requestFirewallAuth(
      sandboxHeaders,
      {
        encryptedSecrets: z.string().parse(claim.encryptedSecrets),
        authHeaders: {
          Authorization: `Bearer ${secretTemplate("CHATGPT_ACCESS_TOKEN")}`,
          "ChatGPT-Account-ID": secretTemplate("CHATGPT_ACCOUNT_ID"),
        },
        secretConnectorMap: claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          claim.secretConnectorMetadataMap ?? undefined,
        forceRefresh: true,
      },
      [502],
    );
    expect(rejected.body).toMatchObject({
      error: { failureReason: "reconnect_required" },
    });
    await expectNoBuiltInModelUsage(run.runId);
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 30_000);

  const representativeModels = {
    "codex-oauth-token": "gpt-5.6-terra",
    "openai-api-key": "gpt-5.6-sol",
    "openrouter-codex": "gpt-5.6-luna",
    "vercel-ai-gateway-codex": "gpt-5.6-terra",
  } as const;

  it.each(
    USER_OWNED_GPT_FAST_BDD_ROUTES.filter((route) => {
      return route.selectedModel === representativeModels[route.type];
    }),
  )(
    "reuses one $name Pi session across standard, Fast, and standard requests",
    async (route) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { secret } = await configureUserOwnedGptPiModel(actor, route);
      const pricing = await createGptUsagePricingResolution();
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();

      const first = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "Terra standard start",
      });
      expect(
        expectPiSandboxHandoff(first.runId, objects).manifest,
      ).toMatchObject({ schemaVersion: 3 });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
      });
      expect(firstClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      await completeSandboxFirstPiRun({
        actor,
        answer: "Terra standard sandbox answer",
        checkpointObjects: objects,
        claim: firstClaim,
        prompt: "Terra standard start",
        run: first,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      const firstSession = await readThreadSessionConversation(
        context,
        first.threadId,
      );
      const fast = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: route.selectedModel,
        prompt: "Terra Fast continuation",
        runOptions: { codexServiceTier: "fast" },
      });
      await flushWaitUntilForTest();
      const fastManifestBytes = objects.get(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${fast.runId}/manifest.json`,
      );
      if (!fastManifestBytes) {
        throw new Error("Expected Fast resume handoff manifest");
      }
      expect(
        piApiFirstTurnManifestSchema.parse(
          JSON.parse(fastManifestBytes.toString("utf8")),
        ),
      ).toMatchObject({
        schemaVersion: 4,
        mode: "sandbox-first",
        baseSession: {
          sessionId: first.threadId,
          sha256: expect.any(String),
        },
      });
      const fastClaim = await claimChatRun(runnerGroup, fast.runId);
      expect(fastClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
        serviceTier: route.type === "codex-oauth-token" ? "fast" : "priority",
      });
      await completeSandboxFirstPiRun({
        actor,
        answer: "Terra Fast sandbox answer",
        checkpointObjects: objects,
        claim: fastClaim,
        prompt: "Terra Fast continuation",
        run: fast,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
      });
      await chat.updateThreadModelSelection(
        actor,
        first.threadId,
        route.selectedModel,
        { codexServiceTier: null },
      );
      const standard = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: route.selectedModel,
        prompt: "Terra standard return",
      });
      await flushWaitUntilForTest();
      const standardClaim = await claimChatRun(runnerGroup, standard.runId);
      expect(standardClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
      });
      expect(standardClaim.claim.piModelConfig).not.toHaveProperty(
        "serviceTier",
      );
      await completeSandboxFirstPiRun({
        actor,
        answer: "Terra standard sandbox answer",
        checkpointObjects: objects,
        claim: standardClaim,
        prompt: "Terra standard return",
        run: standard,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
        conversation_run_id: standard.runId,
      });

      const histories = [...objects.entries()].filter(([key]) => {
        return key.endsWith(".blob");
      });
      expect(histories).toHaveLength(3);
      for (const [, value] of histories) {
        expect(
          MemoryPiSession.fromJsonl(value.toString("utf8")).getSessionId(),
        ).toBe(first.threadId);
        expect(value.toString("utf8")).not.toMatch(/serviceTier|service_tier/);
        expect(value.toString("utf8")).not.toContain(secret);
      }
      for (const run of [first, fast, standard]) {
        await expectNoBuiltInModelUsage(run.runId);
      }
    },
    90_000,
  );

  it.each(
    USER_OWNED_GPT_FAST_BDD_ROUTES.flatMap((route) => {
      return (["web", "agent"] as const)
        .filter((origin) => {
          return (
            origin === "web" ||
            route.selectedModel === representativeModels[route.type]
          );
        })
        .map((origin) => {
          return {
            route,
            name: route.name,
            origin,
          };
        });
    }),
  )(
    "promotes queued and immediate $name Fast from $origin into the runner claim",
    async ({ route, origin }) => {
      const { actor, agentId, runnerGroup, providerId } =
        await entitledChatActor();
      await api.updateOrgModelPolicies(actor, [
        {
          model: "claude-fable-5-1",
          isDefault: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
      const source = await sendChatRun(actor, {
        agentId,
        prompt: "source run for Terra handoff",
        model: "claude-fable-5-1",
      });
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the Terra target thread",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const token = api.okouTokenForRunWithCapabilities(actor, source.runId, [
        "chat-thread:read",
        "chat-thread:write",
        "chat-event:read",
        "chat-event:write",
      ]);
      await configureUserOwnedGptPiModel(actor, route);
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const fastTier = route.type === "codex-oauth-token" ? "fast" : "priority";
      const queuedId = randomUUID();
      const body = {
        agentId,
        threadId: anchor.threadId,
        clientEventId: queuedId,
        prompt: "queued Terra Fast",
        model: route.selectedModel,
        runOptions: { codexServiceTier: "fast" as const },
      };
      const queued =
        origin === "agent"
          ? await requestSendEventWithBearer(token, body, [201])
          : await chat.requestSendEvent(actor, body, [201]);
      if (queued.status !== 201) {
        throw new Error("Expected queued subscription send");
      }
      expect(queued.body.runId).toBeNull();
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      await flushWaitUntilForTest();
      const messages = await waitForThreadMessages(
        actor,
        anchor.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === queuedId && event.runId !== undefined
            );
          });
        },
      );
      const promoted = userMessages(messages.events).find((event) => {
        return event.revokesEventId === queuedId;
      });
      if (!promoted?.runId) {
        throw new Error("Expected queued subscription promotion");
      }
      const promotedClaim = await claimChatRun(runnerGroup, promoted.runId);
      expect(promotedClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
        serviceTier: fastTier,
      });
      await cancelChatRun(actor, promoted.runId, promotedClaim.sandboxHeaders);
      await expectNoBuiltInModelUsage(promoted.runId);

      const immediateBody = {
        agentId,
        prompt: "immediate Terra Fast",
        model: route.selectedModel,
        runOptions: { codexServiceTier: "fast" as const },
      };
      const immediate =
        origin === "agent"
          ? await requestSendEventWithBearer(token, immediateBody, [201])
          : await chat.requestSendEvent(actor, immediateBody, [201]);
      if (immediate.status !== 201 || !immediate.body.runId) {
        throw new Error("Expected immediate subscription run");
      }
      const immediateClaim = await claimChatRun(
        runnerGroup,
        immediate.body.runId,
      );
      expect(immediateClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
        serviceTier: fastTier,
      });
      await cancelChatRun(
        actor,
        immediate.body.runId,
        immediateClaim.sandboxHeaders,
      );
      await expectNoBuiltInModelUsage(immediate.body.runId);
      await cancelChatRun(actor, source.runId);
    },
    90_000,
  );
});
