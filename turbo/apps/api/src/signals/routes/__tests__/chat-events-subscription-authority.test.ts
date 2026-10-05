import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { randomUUID } from "node:crypto";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  createChatEventsFixture,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
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
  entitledNativeChatActor,
  configureUserOwnedGptPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  sendWaitingChatInput,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  requestSendEventWithBearer,
  mockPiCheckpointObjectStore,
  completeSandboxFirstPiRun,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

describe("CHAT-02: run-level model overrides", () => {
  describe("subscription account preparation", () => {
    it("rejects a personal account disconnected while its input is queued", async () => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold capacity",
        model: "claude-fable-5-1",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: `preparation-subscription-${randomUUID()}`,
      });
      mockPiCheckpointObjectStore();
      mockPiResourceArchiveDownloads();
      const clientEventId = randomUUID();
      const waiting = await sendWaitingChatInput(actor, {
        agentId,
        model: "gpt-6-luna",
        prompt: "reject a disconnected queued account",
        clientEventId,
      });
      await flushWaitUntilForTest();
      await authDeviceSupport.deletePersonalModelProviderAccount(
        actor,
        captured.accountSourceId,
      );
      await completeChatRunOk(anchor.runId, anchorClaim.sandboxHeaders);
      const page = await waitForThreadMessages(
        actor,
        waiting.threadId,
        (items) => {
          return items.some((event) => {
            return event.eventType === "input.rejected";
          });
        },
      );
      // The public queue reaches the existing unavailable-subscription
      // conflict, before any captured account can authorize launch.
      expect(page.events).toContainEqual(
        expect.objectContaining({
          eventType: "input.rejected",
          revokesEventId: clientEventId,
          error: "conflict",
        }),
      );
      expect(page.events).toContainEqual(
        expect.objectContaining({
          eventType: "output.error",
          error: "conflict",
          content:
            "The selected subscription account is unavailable. Reconnect it before starting another run.",
        }),
      );
      expect(
        page.events.filter((event) => {
          return event.runId !== undefined;
        }),
      ).toStrictEqual([]);
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
      await api.updateUserModelPreference(actor, "okou-1.0");
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const run = await sendChatRun(actor, {
        agentId,
        model: "gpt-6-luna",
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
        await expectThreadModelCredits(context, f.actor, f.run.threadId, 0);
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
      model: "gpt-6-luna",
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
    await expectThreadModelCredits(context, actor, run.threadId, 0);
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  }, 30_000);

  const representativeModels = {
    "codex-oauth-token": "gpt-6-luna",
    "openai-api-key": "gpt-5.6-sol",
    "openrouter-codex": "gpt-5.6-luna",
    "vercel-ai-gateway-codex": "gpt-5.6-luna",
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
        prompt: "Luna standard start",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.resumeSession).toBeNull();
      expect(firstClaim.claim.piSessionId).toBe(first.threadId);
      expect(firstClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
      });
      expect(firstClaim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      await completeSandboxFirstPiRun({
        actor,
        answer: "Luna standard sandbox answer",
        checkpointObjects: objects,
        claim: firstClaim,
        prompt: "Luna standard start",
        run: first,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      const firstSession = await readCompletedRunSessionId(
        context,
        actor,
        first.runId,
      );
      const fast = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        model: route.selectedModel,
        prompt: "Luna Fast continuation",
        runOptions: { codexServiceTier: "fast" },
      });
      await flushWaitUntilForTest();
      const fastClaim = await claimChatRun(runnerGroup, fast.runId);
      expect(fastClaim.claim.resumeSession).toMatchObject({
        sessionId: first.threadId,
        historyRef: {
          kind: "blob",
          hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(fastClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
        serviceTier: route.type === "codex-oauth-token" ? "fast" : "priority",
      });
      await completeSandboxFirstPiRun({
        actor,
        answer: "Luna Fast sandbox answer",
        checkpointObjects: objects,
        claim: fastClaim,
        prompt: "Luna Fast continuation",
        run: fast,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      await expect(
        readCompletedRunSessionId(context, actor, fast.runId),
      ).resolves.toBe(firstSession);
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
        prompt: "Luna standard return",
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
        answer: "Luna standard sandbox answer",
        checkpointObjects: objects,
        claim: standardClaim,
        prompt: "Luna standard return",
        run: standard,
        responsesModel: { provider: "openai", model: route.selectedModel },
        usagePricingResolution: pricing,
      });
      await expect(
        readCompletedRunSessionId(context, actor, standard.runId),
      ).resolves.toBe(firstSession);

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
        await expectThreadModelCredits(context, actor, run.threadId, 0);
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
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await api.ensurePersonalSubscriptionModel(actor, {
        model: "claude-fable-5-1",
      });
      const source = await sendChatRun(actor, {
        agentId,
        prompt: "source run for Luna handoff",
        model: "claude-fable-5-1",
      });
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the Luna target thread",
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
        prompt: "queued Luna Fast",
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
      await expectThreadModelCredits(context, actor, anchor.threadId, 0);

      const immediateId = randomUUID();
      const immediateBody = {
        agentId,
        clientEventId: immediateId,
        prompt: "immediate Luna Fast",
        model: route.selectedModel,
        runOptions: { codexServiceTier: "fast" as const },
      };
      const immediate =
        origin === "agent"
          ? await requestSendEventWithBearer(token, immediateBody, [201])
          : await chat.requestSendEvent(actor, immediateBody, [201]);
      if (immediate.status !== 201) {
        throw new Error("Expected immediate subscription send");
      }
      // The idle new thread's input is picked in the background.
      const immediateMessages = await waitForThreadMessages(
        actor,
        immediate.body.threadId,
        (events) => {
          return userMessages(events).some((event) => {
            return (
              event.revokesEventId === immediateId && event.runId !== undefined
            );
          });
        },
      );
      const immediateRunId = userMessages(immediateMessages.events).find(
        (event) => {
          return event.revokesEventId === immediateId;
        },
      )?.runId;
      if (!immediateRunId) {
        throw new Error("Expected immediate subscription run");
      }
      const immediateClaim = await claimChatRun(runnerGroup, immediateRunId);
      expect(immediateClaim.claim.piModelConfig).toMatchObject({
        model: route.runtimeModel,
        serviceTier: fastTier,
      });
      await cancelChatRun(actor, immediateRunId, immediateClaim.sandboxHeaders);
      await expectThreadModelCredits(
        context,
        actor,
        immediate.body.threadId,
        0,
      );
      await cancelChatRun(actor, source.runId);
    },
    90_000,
  );
});
