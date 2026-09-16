import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { expectApiError } from "./helpers/api-bdd";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { readThreadSessionConversation } from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  USER_OWNED_GPT_FAST_BDD_ROUTES,
  expectNoBuiltInModelUsage,
  userMessages,
  eventBackedContents,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  nativeCodexSseResponse,
  readCodexRequestJson,
} from "./helpers/pi-responses";

const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  authDevice,
  authDeviceSupport,
  entitledChatActor,
  configureUserOwnedGptPiModel,
  configureOrganizationGptModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  requestSendEventWithBearer,
  cancelBeforeLatePiResult,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  expectPiApiFirstTurnTerminalWithoutOutput,
  piS3Object,
  publishPendingPiInstructions,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

describe("CHAT-02: run-level model overrides", () => {
  describe("final subscription authority", () => {
    function observeProviderRequests() {
      const requests: {
        body: unknown;
        authorization: string | null;
        accountId: string | null;
      }[] = [];
      const alternateRequests: string[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          async ({ request }) => {
            requests.push({
              body: await readCodexRequestJson(request),
              authorization: request.headers.get("authorization"),
              accountId: request.headers.get("chatgpt-account-id"),
            });
            return nativeCodexSseResponse(
              piResponsesTextSse(
                "captured subscription answer",
                requests.length,
              ),
            );
          },
        ),
        http.post(
          /^https:\/\/(api\.openai\.com|openrouter\.ai|api\.anthropic\.com)\//,
          ({ request }) => {
            alternateRequests.push(request.url);
            return HttpResponse.json(
              { error: "unexpected alternate provider" },
              { status: 500 },
            );
          },
        ),
      );
      return { requests, alternateRequests };
    }

    async function prepareHeldSubscription(accountsEnabled = true) {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const identity = `held-subscription-${randomUUID()}`;
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: identity,
        accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
      });
      await authDeviceSupport.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.PersonalSubscriptionPriority]: true,
        [FeatureSwitchKey.PersonalModelProviderAccounts]: accountsEnabled,
      });
      await configureOrganizationGptModel(actor);
      const instructions = await publishPendingPiInstructions(actor, agentId);
      const thread = await chat.createThread(actor, { agentId });
      const sdk = await context.mocks.piSdk.controlInitialization(
        { sessionId: thread.id, instructions, holdInitialization: true },
        context.signal,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const observed = observeProviderRequests();
      const run = await sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        model: "gpt-5.6-terra",
        prompt: "preserve final subscription authority",
        runOptions: { codexServiceTier: "fast" },
      });
      await sdk.entered;
      onTestFinished(async () => {
        sdk.release();
        await flushWaitUntilForTest();
      });
      expect(observed.requests).toHaveLength(0);
      return {
        actor,
        agentId,
        runnerGroup,
        identity,
        captured,
        sdk,
        objects,
        run,
        ...observed,
      };
    }

    it.each([
      { change: "ordinary disconnect", accountsEnabled: true },
      { change: "singleton disconnect", accountsEnabled: false },
      { change: "different-identity reconnect", accountsEnabled: true },
    ] as const)(
      "keeps admitted A through $change with accounts UI $accountsEnabled",
      async ({ change, accountsEnabled }) => {
        const f = await prepareHeldSubscription(accountsEnabled);
        let replacement:
          | ReturnType<typeof mockCodexDeviceAuthProvider>
          | undefined;
        const replacementIdentity = `replacement-${randomUUID()}`;
        if (change === "different-identity reconnect") {
          replacement = mockCodexDeviceAuthProvider({
            tokenScope: "personal",
            accountId: replacementIdentity,
            accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
          });
          const started = await authDevice.requestCodexStart(
            f.actor,
            "personal",
            [200],
            {
              mode: "reconnect",
              modelProviderId: f.captured.accountSourceId,
            },
          );
          if (started.status !== 200) {
            throw new Error("Expected replacement authorization to start");
          }
          const completed = await authDevice.requestCodexComplete(
            f.actor,
            started.body.sessionToken,
            [200],
          );
          if (
            !("status" in completed.body) ||
            completed.body.status !== "complete"
          ) {
            throw new Error("Expected replacement authorization to complete");
          }
          expect(completed.body.provider.id).not.toBe(
            f.captured.accountSourceId,
          );
          const listed = await authDeviceSupport.listPersonalModelProviders(
            f.actor,
            [200],
          );
          expect(listed.body).toMatchObject({
            modelProviders: [
              expect.objectContaining({
                id: completed.body.provider.id,
                isActive: true,
              }),
            ],
          });
          expect(JSON.stringify(listed.body)).not.toContain(
            f.captured.accountSourceId,
          );
        } else if (accountsEnabled) {
          await authDeviceSupport.deletePersonalModelProviderAccount(
            f.actor,
            f.captured.accountSourceId,
          );
        } else {
          await authDeviceSupport.deletePersonalModelProvider(
            f.actor,
            "codex-oauth-token",
            [204],
          );
        }
        if (!replacement) {
          expect(
            (await authDeviceSupport.listPersonalModelProviders(f.actor, [200]))
              .body,
          ).toMatchObject({ modelProviders: [] });
        }
        f.sdk.release();
        await waitForRunStatus(f.actor, f.run.runId, "completed");
        await f.sdk.disposed;
        await flushWaitUntilForTest();
        expect(f.sdk.disposeCount()).toBe(1);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({
          authorization: `Bearer ${f.captured.oauth.oauthTokenResponses[0]?.access_token}`,
          accountId: f.identity,
          body: {
            model: "gpt-5.6-terra",
            service_tier: "priority",
            stream: true,
            store: false,
          },
        });
        expect(
          eventBackedContents(
            (await chat.listThreadEvents(f.actor, f.run.threadId)).events,
            f.run.runId,
          ),
        ).toContainEqual(
          expect.objectContaining({ content: "captured subscription answer" }),
        );
        await expectNoBuiltInModelUsage(f.run.runId);
        if (replacement) {
          const later = await sendChatRun(f.actor, {
            agentId: f.agentId,
            model: "gpt-5.6-terra",
            prompt: "select replacement B in a new run",
          });
          expect(later.threadId).not.toBe(f.run.threadId);
          await waitForRunStatus(f.actor, later.runId, "completed");
          await flushWaitUntilForTest();
          expect(f.requests).toHaveLength(2);
          expect(f.requests[1]).toMatchObject({
            authorization: `Bearer ${replacement.oauthTokenResponses[0]?.access_token}`,
            accountId: replacementIdentity,
            body: { model: "gpt-5.6-terra", stream: true, store: false },
          });
          expect(replacement.oauthToken).toHaveLength(1);
          await expectNoBuiltInModelUsage(later.runId);
        }
        expect(f.captured.oauth.oauthToken).toHaveLength(1);
        expect(f.alternateRequests).toHaveLength(0);
      },
      30_000,
    );

    it.each(["connected invalid_grant", "retained terminal refresh"] as const)(
      "rejects %s acquired after preparation without refreshing again",
      async (failure) => {
        const f = await prepareHeldSubscription();
        const { claim, sandboxHeaders } = await claimChatRun(
          f.runnerGroup,
          f.run.runId,
        );
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
        expect(refreshAttempts).toBe(1);
        expect(f.requests).toHaveLength(0);
        f.sdk.release();
        await waitForRunStatus(f.actor, f.run.runId, "failed");
        await f.sdk.disposed;
        await flushWaitUntilForTest();
        expect(f.sdk.disposeCount()).toBe(1);
        expect(f.requests).toHaveLength(0);
        expect(f.alternateRequests).toHaveLength(0);
        expect(refreshAttempts).toBe(1);
        expect(f.captured.oauth.oauthToken).toHaveLength(1);
        expectNoPiApiFirstTurnArtifacts(f.run.runId, f.objects);
        await expectNoBuiltInModelUsage(f.run.runId);
        const events = (await chat.listThreadEvents(f.actor, f.run.threadId))
          .events;
        expect(events).toContainEqual(
          expect.objectContaining({
            eventType: "run.failed",
            runId: f.run.runId,
            failureReason: "reconnect_required",
          }),
        );
        expect(eventBackedContents(events, f.run.runId)).toStrictEqual([]);
        await expect(api.readRun(f.actor, f.run.runId)).resolves.toMatchObject({
          status: "failed",
          error: expect.stringContaining("[PI_API_MODEL_CREDENTIAL_INVALID]"),
        });
      },
      30_000,
    );

    it.each(["cancellation", "membership revocation"] as const)(
      "honors %s before releasing a retained subscription session",
      async (revocation) => {
        const f = await prepareHeldSubscription();
        await authDeviceSupport.deletePersonalModelProviderAccount(
          f.actor,
          f.captured.accountSourceId,
        );
        if (revocation === "cancellation") {
          await cancelChatRun(f.actor, f.run.runId);
        } else {
          webhooks.configureClerkWebhookSecret();
          webhooks.verifyNextClerkWebhook({
            type: "organizationMembership.deleted",
            data: {
              id: `membership-${randomUUID()}`,
              organization_id: f.actor.orgId,
              user_id: f.actor.userId,
            },
          });
          await webhooks.requestClerkWebhook("{}", {}, [200]);
          // The webhook acknowledges before its owned cleanup finishes. Wait
          // for the external revocation outcome before releasing the SDK.
          await expect
            .poll(async () => {
              const result = await api.requestReadRun(
                f.actor,
                f.run.runId,
                [200, 401, 403, 404],
              );
              return result.status === 200
                ? result.body.status === "cancelled"
                : true;
            })
            .toBe(true);
        }
        f.sdk.release();
        await f.sdk.disposed;
        await flushWaitUntilForTest();
        expect(f.sdk.disposeCount()).toBe(1);
        expect(f.requests).toHaveLength(0);
        expect(f.alternateRequests).toHaveLength(0);
        expect(f.captured.oauth.oauthToken).toHaveLength(1);
        expectNoPiApiFirstTurnArtifacts(f.run.runId, f.objects);
        await expectNoBuiltInModelUsage(f.run.runId);
        if (revocation === "cancellation") {
          await expectPiApiFirstTurnTerminalWithoutOutput(
            f.actor,
            f.run,
            "cancelled",
          );
        } else {
          // A revoked actor may lose read access too; only a successful read
          // can expose the canonical terminal state. Never infer a fixed denial.
          const result = await api.requestReadRun(
            f.actor,
            f.run.runId,
            [200, 401, 403, 404],
          );
          if (result.status === 200) {
            expect(result.body).toMatchObject({ status: "cancelled" });
            expect(result.body.result).toBeFalsy();
          }
        }
      },
      30_000,
    );
  });

  it.each(["deleted", "reconnect-required"] as const)(
    "rejects a prepared subscription when its captured account becomes %s",
    async (revocation) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const captured = await configureSubscriptionPiModel(actor, {
        accountId: "prepared-subscription-account",
        accessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
      });
      const instructions = await publishPendingPiInstructions(actor, agentId);
      const thread = await chat.createThread(actor, { agentId });
      const sdk = await context.mocks.piSdk.controlInitialization(
        { sessionId: thread.id, instructions, holdInitialization: true },
        context.signal,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: string[] = [];
      server.use(
        http.post(
          "https://chatgpt.com/backend-api/codex/responses",
          ({ request }) => {
            requests.push(request.url);
            return nativeCodexSseResponse(
              piResponsesTextSse("unexpected revoked account", 1),
            );
          },
        ),
      );
      const run = await sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        model: "gpt-5.6-terra",
        prompt: "retain subscription revocation at execution",
        runOptions: { codexServiceTier: "fast" },
      });
      // Credentials have been materialized before this real SDK boundary.
      await sdk.entered;
      expect(requests).toHaveLength(0);
      if (revocation === "deleted") {
        await authDeviceSupport.deletePersonalModelProviderAccount(
          actor,
          captured.accountSourceId,
        );
      } else {
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
      }
      sdk.release();
      await waitForRunStatus(actor, run.runId, "failed");
      await flushWaitUntilForTest();
      expect(requests).toHaveLength(0);
      expect(sdk.disposeCount()).toBe(1);
      expectNoPiApiFirstTurnArtifacts(run.runId, objects);
      await expectNoBuiltInModelUsage(run.runId);
      expect(
        (await chat.listThreadEvents(actor, thread.id)).events,
      ).toContainEqual(
        expect.objectContaining({
          eventType: "run.failed",
          runId: run.runId,
          failureReason: "reconnect_required",
        }),
      );
    },
    30_000,
  );

  it("refreshes the captured subscription Fast account while another account becomes active", async () => {
    const { actor, agentId } = await entitledChatActor();
    await publishPendingPiInstructions(actor, agentId);
    const other = await configureSubscriptionPiModel(actor, {
      accountId: "other-active-account",
    });
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const refreshToken = "rt_captured_subscription_fast_account";
    const captured = await configureSubscriptionPiModel(actor, {
      accountId: "captured-subscription-account",
      refreshToken,
      accessTokenExpiresAt: Math.floor(now() / 1000) - 60,
      refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
    });
    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      captured.accountSourceId,
    );
    server.use(
      http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, async ({ request }) => {
        if (!entered.settled()) {
          entered.resolve(undefined);
        }
        await release.promise;
        const objectKey = new URL(request.url).searchParams.get("object");
        if (!objectKey) {
          throw new Error("Expected Pi resource archive identity");
        }
        return new HttpResponse(piS3Object(objectKey), {
          headers: { "content-type": "application/gzip" },
        });
      }),
    );
    mockPiCheckpointObjectStore();
    const requests: {
      body: unknown;
      authorization: string | null;
      accountId: string | null;
    }[] = [];
    server.use(
      http.post(
        "https://chatgpt.com/backend-api/codex/responses",
        async ({ request }) => {
          requests.push({
            body: await readCodexRequestJson(request),
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("chatgpt-account-id"),
          });
          return nativeCodexSseResponse(
            piResponsesTextSse("captured subscription answer", 1),
          );
        },
      ),
    );
    const run = await sendChatRun(actor, {
      agentId,
      model: "gpt-5.6-terra",
      prompt: "retain captured subscription Fast credentials",
      runOptions: { codexServiceTier: "fast" },
    });
    await entered.promise;
    expect(requests).toHaveLength(0);
    // Credential refresh overlaps the blocked resource read. Wait for that
    // actual HTTP request before changing the active account selection.
    await expect
      .poll(() => {
        return captured.oauth.oauthToken.length;
      })
      .toBe(2);
    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      other.accountSourceId,
    );
    release.resolve(undefined);
    await waitForRunStatus(actor, run.runId, "completed");
    await flushWaitUntilForTest();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      authorization: `Bearer ${captured.oauth.oauthTokenResponses[1]?.access_token}`,
      accountId: "captured-subscription-account",
      body: {
        model: "gpt-5.6-terra",
        service_tier: "priority",
        stream: true,
        store: false,
      },
    });
    expect(requests[0]?.body).not.toHaveProperty("previous_response_id");
    expect(captured.oauth.oauthToken).toHaveLength(2);
    expect(captured.oauth.oauthToken[1]?.get("refresh_token")).toBe(
      refreshToken,
    );
    expect(other.oauth.oauthToken).toHaveLength(1);
    await expectNoBuiltInModelUsage(run.runId);
  }, 90_000);

  it.each(USER_OWNED_GPT_FAST_BDD_ROUTES)(
    "reuses one $name Pi session across standard, Fast, and standard requests",
    async (route) => {
      const { actor, agentId } = await entitledChatActor();
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const requests: {
        body: unknown;
        authorization: string | null;
        accountId: string | null;
      }[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          requests.push({
            body: await readCodexRequestJson(request),
            authorization: request.headers.get("authorization"),
            accountId: request.headers.get("chatgpt-account-id"),
          });
          return nativeCodexSseResponse(
            piResponsesTextSse(
              `Terra answer ${requests.length}`,
              requests.length,
            ),
          );
        }),
      );

      const first = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "Terra standard start",
      });
      await waitForRunStatus(actor, first.runId, "completed");
      await flushWaitUntilForTest();
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
      await waitForRunStatus(actor, fast.runId, "completed");
      await flushWaitUntilForTest();
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
      await waitForRunStatus(actor, standard.runId, "completed");
      await flushWaitUntilForTest();
      await expect(
        readThreadSessionConversation(context, first.threadId),
      ).resolves.toMatchObject({
        agent_session_id: firstSession.agent_session_id,
        conversation_run_id: standard.runId,
      });

      expect(requests).toHaveLength(3);
      expect(
        requests.map(({ body }) => {
          return z
            .object({ service_tier: z.literal("priority").optional() })
            .parse(body).service_tier;
        }),
      ).toStrictEqual([undefined, route.wireTier, undefined]);
      for (const request of requests) {
        expect(request).toMatchObject({
          authorization: `Bearer ${secret}`,
          accountId,
          body: {
            model: route.runtimeModel,
            stream: true,
            store: false,
            reasoning: { effort: "max" },
          },
        });
        expect(request.body).not.toHaveProperty("previous_response_id");
      }
      expect(JSON.stringify(requests[1]?.body)).toContain("Terra answer 1");
      expect(JSON.stringify(requests[2]?.body)).toContain("Terra answer 2");
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
      return (["web", "agent"] as const).map((origin) => {
        return {
          route,
          name: route.name,
          origin,
        };
      });
    }),
  )(
    "promotes queued and immediate $name Fast from $origin through API-first",
    async ({ route, origin }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const source = await sendChatRun(actor, {
        agentId,
        prompt: "source run for Terra handoff",
      });
      const anchor = await sendChatRun(actor, {
        agentId,
        prompt: "hold the Terra target thread",
      });
      const anchorClaim = await claimChatRun(runnerGroup, anchor.runId);
      const token = api.okouTokenForRunWithCapabilities(actor, source.runId, [
        "chat-thread:read",
        "chat-thread:write",
        "chat-event:read",
        "chat-event:write",
      ]);
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      mockPiCheckpointObjectStore();
      const requests: unknown[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
          expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
          requests.push(await readCodexRequestJson(request));
          return nativeCodexSseResponse(
            piResponsesTextSse("queued Terra answer", requests.length),
          );
        }),
      );
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
      expect(requests).toHaveLength(0);
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
      await waitForRunStatus(actor, promoted.runId, "completed");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: route.runtimeModel,
        service_tier: route.wireTier,
        stream: true,
        store: false,
      });
      expect(requests[0]).not.toHaveProperty("previous_response_id");
      expect(occurrences(JSON.stringify(requests[0]), body.prompt)).toBe(1);
      await expectNoBuiltInModelUsage(promoted.runId);
      const claim = await api.requestClaimRunnerJob(
        true,
        promoted.runId,
        [404],
        { capabilities: { piModelConfigGenerations: [1, 2, 3] } },
      );
      expectApiError(claim.body);

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
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, immediate.body.runId, "completed");
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ service_tier: route.wireTier });
      await expectNoBuiltInModelUsage(immediate.body.runId);
      await cancelChatRun(actor, source.runId);
    },
    90_000,
  );

  it.each(
    USER_OWNED_GPT_FAST_BDD_ROUTES.flatMap((route) => {
      return (["in-flight", "late-result"] as const).map((phase) => {
        return {
          route,
          name: route.name,
          phase,
        };
      });
    }),
  )(
    "keeps cancelled $name Fast $phase results unbilled and unreplayed",
    async ({ route, phase }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      const { secret, accountId } = await configureUserOwnedGptPiModel(
        actor,
        route,
      );
      mockPiResourceArchiveDownloads();
      const objects = mockPiCheckpointObjectStore();
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const requests: unknown[] = [];
      server.use(
        http.post(route.endpoint, async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
          expect(request.headers.get("chatgpt-account-id")).toBe(accountId);
          requests.push(await readCodexRequestJson(request));
          if (!entered.settled()) {
            entered.resolve(undefined);
          }
          await release.promise;
          return nativeCodexSseResponse(
            piResponsesTextSse("discarded Terra answer", requests.length),
          );
        }),
      );
      const run = await sendChatRun(actor, {
        agentId,
        model: route.selectedModel,
        prompt: "cancel Terra Fast ownership",
        runOptions: { codexServiceTier: "fast" },
      });
      await entered.promise;
      if (phase === "late-result") {
        await cancelBeforeLatePiResult(actor, run.runId, () => {
          release.resolve(undefined);
        });
      } else {
        await cancelChatRun(actor, run.runId);
        release.resolve(undefined);
      }
      await flushWaitUntilForTest();
      await expect(api.readRun(actor, run.runId)).resolves.toMatchObject({
        status: "cancelled",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        service_tier: route.wireTier,
        stream: true,
        store: false,
      });
      await expectNoBuiltInModelUsage(run.runId);
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/manifest.json`,
        ),
      ).toBeFalsy();
      expect(
        objects.has(
          `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
        ),
      ).toBeFalsy();
      expect(
        eventBackedContents(
          (await chat.listThreadEvents(actor, run.threadId)).events,
          run.runId,
        ),
      ).toHaveLength(0);
      await api.heartbeatRunner(runnerGroup);
      const claim = await api.requestClaimRunnerJob(true, run.runId, [404], {
        capabilities: { piModelConfigGenerations: [1, 2, 3] },
      });
      expectApiError(claim.body);
    },
    90_000,
  );
});
