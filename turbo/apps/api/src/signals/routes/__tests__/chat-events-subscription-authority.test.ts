import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { HTTPException } from "hono/http-exception";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { holdPiContextPreparationStagesFixture } from "../../../test-fixtures/pi-context-preparation";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { clearAllDetached } from "../../utils";
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

function jsonHttpException(status: 422, message: string) {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  });
}

describe("CHAT-02: run-level model overrides", () => {
  // A send only enqueues its input; the background pick prepares the run, so
  // these holds pause the pick while the input waits in the thread.
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

    async function sendHeldInput(
      f: Awaited<ReturnType<typeof prepareSubscriptionThread>>,
      clientEventId: string,
      prompt: string,
    ): Promise<void> {
      const sent = await chat.requestSendEvent(
        f.actor,
        {
          agentId: f.agentId,
          threadId: f.thread.id,
          model: "gpt-6-luna",
          prompt,
          clientEventId,
        },
        [201],
      );
      if (sent.status !== 201) {
        throw new Error("Expected the send to be accepted");
      }
      expect(sent.body).toMatchObject({ runId: null, threadId: f.thread.id });
    }

    /** The held pick has neither launched nor rejected the input yet. */
    async function expectInputNotConsumed(
      actor: Awaited<ReturnType<typeof entitledChatActor>>["actor"],
      threadId: string,
      clientEventId: string,
    ): Promise<void> {
      const page = await chat.listThreadEvents(actor, threadId);
      expect(
        userMessages(page.events).filter((message) => {
          return message.revokesEventId === clientEventId;
        }),
      ).toStrictEqual([]);
    }

    async function waitForRejection(
      f: Awaited<ReturnType<typeof prepareSubscriptionThread>>,
    ) {
      const messages = await waitForThreadMessages(
        f.actor,
        f.thread.id,
        (items) => {
          return items.some((event) => {
            return event.eventType === "output.error";
          });
        },
      );
      return messages.events;
    }

    it("overlaps account capture with thread observation and keeps captured identity", async () => {
      const f = await prepareSubscriptionThread();
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const clientEventId = randomUUID();
      const waiting = await sendWaitingChatInput(f.actor, {
        agentId: f.agentId,
        threadId: f.thread.id,
        model: "gpt-6-luna",
        prompt: "overlap subscription capture with thread preparation",
        clientEventId,
      });

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      // Identity-only bootstrap/catalog work can now finish independently of
      // account capture; admission still waits for the captured account below.
      f.preparation.release("subscription-account");
      await f.preparation.arrival("post-authorization-context");
      await expectInputNotConsumed(f.actor, f.thread.id, clientEventId);
      expect(f.preparation.arrivalCount("subscription-account")).toBe(1);
      expect(f.preparation.arrivalCount("thread-session")).toBe(1);
      f.preparation.release("post-authorization-context");
      f.preparation.release("thread-session");
      f.preparation.releaseAll();

      const run = await waiting.launchedRun();
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
      await sendHeldInput(
        f,
        clientEventId,
        "reject a disconnected captured account",
      );

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      f.preparation.release("subscription-account");
      await f.preparation.arrival("post-authorization-context");
      await expectInputNotConsumed(f.actor, f.thread.id, clientEventId);
      await authDeviceSupport.deletePersonalModelProviderAccount(
        f.actor,
        f.captured.accountSourceId,
      );
      f.preparation.release("post-authorization-context");
      f.preparation.release("thread-session");
      f.preparation.releaseAll();

      await expect(waitForRejection(f)).resolves.toStrictEqual([
        expect.objectContaining({
          eventType: "input.prompt",
          id: clientEventId,
        }),
        expect.objectContaining({
          eventType: "input.rejected",
          revokesEventId: clientEventId,
          error: "provider_unavailable",
        }),
        expect.objectContaining({
          eventType: "output.error",
          error: "provider_unavailable",
        }),
      ]);
    });

    it("rejects the input when a captured account disconnects and session preparation fails", async () => {
      const f = await prepareSubscriptionThread();
      const clientEventId = randomUUID();
      await sendHeldInput(
        f,
        clientEventId,
        "preserve the input after session preparation fails",
      );

      await Promise.all([
        f.preparation.arrival("subscription-account"),
        f.preparation.arrival("thread-session"),
      ]);
      // The queued model graph already captured the shared account metadata.
      // Disconnecting it now cannot rewrite that snapshot; the adjacent case
      // verifies the exact-account authority rejects it before run admission.
      await authDeviceSupport.deletePersonalModelProviderAccount(
        f.actor,
        f.captured.accountSourceId,
      );
      const sessionError = jsonHttpException(422, "session preparation failed");
      f.preparation.reject("thread-session", sessionError);
      await f.preparation.departure("thread-session");
      await expectInputNotConsumed(f.actor, f.thread.id, clientEventId);
      f.preparation.release("subscription-account");
      await f.preparation.arrival("post-authorization-context");
      f.preparation.releaseAll();

      await expect(clearAllDetached()).rejects.toBe(sessionError);
      const { events } = await chat.listThreadEvents(f.actor, f.thread.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          eventType: "input.rejected",
          revokesEventId: clientEventId,
          error: "internal_error",
        }),
      );
      await expect(
        api.listAgentRuns(f.actor, {
          status: "queued,pending,running,completed,failed,timeout,cancelled",
          limit: 100,
        }),
      ).resolves.toMatchObject({ runs: [] });
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
    await expectNoBuiltInModelUsage(run.runId);
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
      const firstSession = await readThreadSessionConversation(
        context,
        first.threadId,
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
          preferred: true,
          defaultProviderType: "anthropic-api-key",
          credentialScope: "org",
          modelProviderId: providerId,
        },
      ]);
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
      await expectNoBuiltInModelUsage(promoted.runId);

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
      await expectNoBuiltInModelUsage(immediateRunId);
      await cancelChatRun(actor, source.runId);
    },
    90_000,
  );
});
