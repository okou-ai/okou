import { randomUUID } from "node:crypto";
import { DEFAULT_PROFILE } from "@okouai/api-contracts/contracts/runners";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import {
  holdOrgAdmissionLockFixture,
  holdThreadSessionBindingClearFixture,
  holdThreadSessionConversationChangesFixture,
  holdThreadSessionConversationClearFixture,
  replaceThreadSessionBindingFixture,
} from "../../../test-fixtures/chat-events";
import type { UsagePricingFixture } from "../../../test-fixtures/usage-pricing";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError } from "./helpers/api-bdd";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { chatEventDisplayText } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  readRunLaunchSnapshotFixture,
  readThreadSessionBinding,
} from "./helpers/runtime-state";
import {
  createChatEventsFixture,
  requireOrgId,
  createGptUsagePricingResolution,
  claimEnvironment,
  userMessages,
  eventBackedContents,
  assistantEvent,
  modelProviderSecretPlaceholder,
  PI_RESOURCE_ARCHIVE_DOWNLOAD_URL,
} from "./helpers/chat-events-fixture";
import {
  piResponsesTextSse,
  nativeCodexSseResponse,
} from "./helpers/pi-responses";

const context = testContext();
const {
  bdd,
  api,
  chat,
  webhooks,
  chatCallbacks,
  misc,
  authDevice,
  authDeviceSupport,
  entitledChatActor,
  seedBuiltInModelKey,
  configureBuiltInPiModel,
  sendChatRun,
  expectThreadCreatedModelEvent,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  cancelChatRun,
  upsertOrgModelProvider,
  requestSendEventRaw,
  mockPiCheckpointObjectStore,
  expectNoPiApiFirstTurnArtifacts,
  piS3Object,
  publishPendingPiInstructions,
} = createChatEventsFixture(context);

describe("CHAT-02: run-level model overrides", () => {
  it("reuses Codex sessions across account switches with the newly captured account", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    const firewall = createFirewallApi(context);
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await authDeviceSupport.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    });

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-a",
      workspaceName: "Chat Account A",
    });
    const startedA = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedA.status !== 200) {
      throw new Error("Expected Codex account A auth to start");
    }
    const completedA = await authDevice.requestCodexComplete(
      actor,
      startedA.body.sessionToken,
      [200],
    );
    if (
      !("status" in completedA.body) ||
      completedA.body.status !== "complete"
    ) {
      throw new Error("Expected Codex account A auth to complete");
    }
    const accountAId = completedA.body.provider.id;

    mockCodexDeviceAuthProvider({
      tokenScope: "personal",
      accountId: "chat-codex-account-b",
      workspaceName: "Chat Account B",
    });
    const startedB = await authDevice.requestCodexStart(
      actor,
      "personal",
      [200],
      { mode: "add" },
    );
    if (startedB.status !== 200) {
      throw new Error("Expected Codex account B auth to start");
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
      throw new Error("Expected Codex account B auth to complete");
    }
    const accountBId = completedB.body.provider.id;

    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-luna",
        isDefault: false,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start with account A",
      model: "gpt-5.6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(
      firstClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountAId });

    await authDeviceSupport.activatePersonalModelProviderAccount(
      actor,
      accountBId,
    );
    if (!firstClaim.claim.encryptedSecrets) {
      throw new Error("Expected account A run to carry encrypted secrets");
    }
    const firstResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${firstClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: firstClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: firstClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          firstClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (firstResolved.status !== 200) {
      throw new Error("Expected account A firewall auth to resolve");
    }
    expect(firstResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-a",
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with account B",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(
      secondClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountBId });
    if (!secondClaim.claim.encryptedSecrets) {
      throw new Error("Expected account B run to carry encrypted secrets");
    }
    const secondResolved = await firewall.requestFirewallAuth(
      { authorization: `Bearer ${secondClaim.claim.sandboxToken}` },
      {
        encryptedSecrets: secondClaim.claim.encryptedSecrets,
        authHeaders: {
          Authorization: `Bearer \${{ secrets.CHATGPT_ACCESS_TOKEN }}`,
          "ChatGPT-Account-ID": `\${{ secrets.CHATGPT_ACCOUNT_ID }}`,
        },
        secretConnectorMap: secondClaim.claim.secretConnectorMap ?? undefined,
        secretConnectorMetadataMap:
          secondClaim.claim.secretConnectorMetadataMap ?? undefined,
      },
      [200],
    );
    if (secondResolved.status !== 200) {
      throw new Error("Expected account B firewall auth to resolve");
    }
    expect(secondResolved.body.headers["ChatGPT-Account-ID"]).toBe(
      "chat-codex-account-b",
    );
    expect(secondResolved.body.headers.Authorization).not.toBe(
      firstResolved.body.headers.Authorization,
    );

    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
      cliAgentType: "codex",
    });
    await flushWaitUntilForTest();

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue again with account B",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    expect(
      thirdClaim.claim.secretConnectorMetadataMap?.CHATGPT_ACCESS_TOKEN,
    ).toMatchObject({ sourceId: accountBId });

    await cancelChatRun(actor, third.runId);
    await authDeviceSupport.deletePersonalModelProvider(
      actor,
      "codex-oauth-token",
      [204],
    );
  }, 90_000);

  it("resumes the CLI session across same-family model switches", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-4-8",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "claude-sonnet-5",
        isDefault: false,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-4-8",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
      model: "claude-sonnet-5",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5",
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it.each([
    {
      from: "gpt-5.6-sol",
      to: "gpt-6-astra",
      runtime: "codex",
      reuse: true,
    },
    {
      from: "claude-opus-4-8",
      to: "claude-sonnet-5",
      runtime: "claude-code",
      reuse: true,
    },
    {
      from: "deepseek-v4-flash",
      to: "deepseek-v4-pro",
      runtime: "codex",
      reuse: true,
    },
    {
      from: "gpt-6-astra",
      to: "deepseek-v4-flash",
      runtime: "codex",
      reuse: false,
    },
  ] as const)(
    "applies family compatibility when switching built-in $from to $to on $runtime",
    async ({ from, to, runtime, reuse }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await updateFeatureSwitchesForUser(
        context,
        { ...actor, orgId: requireOrgId(actor) },
        { [FeatureSwitchKey.PiLoop]: false },
      );
      await seedBuiltInModelKey(from);
      await seedBuiltInModelKey(to);
      await api.updateOrgModelPolicies(actor, [
        {
          model: from,
          isDefault: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          model: to,
          isDefault: false,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
      ]);
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "establish native history before switching models",
        model: from,
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe(runtime);
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
        cliAgentType: runtime,
      });
      await flushWaitUntilForTest();
      const firstRun = await api.readRun(actor, first.runId);
      expect(firstRun).toMatchObject({
        status: "completed",
        result: { agentSessionId: expect.any(String) },
      });

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with the selected model",
        model: to,
      });
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim.cliAgentType).toBe(runtime);
      const environment = claimEnvironment(secondClaim.claim);
      expect(
        runtime === "codex"
          ? environment.OPENAI_MODEL
          : environment.ANTHROPIC_MODEL,
      ).toBe(to);
      expect(secondClaim.claim.resumeSession?.sessionId ?? null).toBe(
        reuse ? `bdd-cli-${first.runId}` : null,
      );
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
        cliAgentType: runtime,
      });
      await flushWaitUntilForTest();
      const secondRun = await api.readRun(actor, second.runId);
      expect(secondRun).toMatchObject({
        status: "completed",
        result: { agentSessionId: expect.any(String) },
      });
      expect(
        secondRun.result?.agentSessionId === firstRun.result?.agentSessionId,
      ).toBe(reuse);
    },
    90_000,
  );

  it("refuses a canonical session owned by another user and organization", async () => {
    const primary = await entitledChatActor();
    const foreign = await entitledChatActor();
    const runnerGroup = api.configureRunnerGroup();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const primaryFirst = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      prompt: "establish the correctly owned canonical session",
    });
    const primaryClaim = await claimChatRun(runnerGroup, primaryFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(primaryFirst.runId, primaryClaim.sandboxHeaders);

    const foreignFirst = await sendChatRun(foreign.actor, {
      agentId: foreign.agentId,
      prompt: "establish a foreign canonical session",
    });
    const foreignClaim = await claimChatRun(runnerGroup, foreignFirst.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(foreignFirst.runId, foreignClaim.sandboxHeaders);

    // Completion acknowledges before terminal callbacks finish. Settle both
    // runs before injecting a cross-owner binding that production APIs forbid.
    await flushWaitUntilForTest();

    const primaryBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    const foreignBinding = await readThreadSessionBinding(
      context,
      foreignFirst.threadId,
    );
    if (!primaryBinding.agent_session_id || !foreignBinding.agent_session_id) {
      throw new Error("Expected both threads to establish canonical sessions");
    }
    await replaceThreadSessionBindingFixture({
      threadId: primaryFirst.threadId,
      sessionId: foreignBinding.agent_session_id,
      runId: foreignFirst.runId,
    });

    const primarySecond = await sendChatRun(primary.actor, {
      agentId: primary.agentId,
      threadId: primaryFirst.threadId,
      prompt: "continue without reusing the foreign session",
    });
    const repairedBinding = await readThreadSessionBinding(
      context,
      primaryFirst.threadId,
    );
    expect(repairedBinding).toMatchObject({
      agent_session_id: expect.any(String),
      agent_session_run_id: primarySecond.runId,
      run_session_id: repairedBinding.agent_session_id,
    });
    expect(repairedBinding.agent_session_id).not.toBe(
      foreignBinding.agent_session_id,
    );
    expect(repairedBinding.agent_session_id).not.toBe(
      primaryBinding.agent_session_id,
    );
    const primarySecondClaim = await claimChatRun(
      runnerGroup,
      primarySecond.runId,
    );
    expect(primarySecondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(primary.actor, primarySecond.runId);
  }, 90_000);

  it.each(["sandbox", "pi"] as const)(
    "does not repeat preparation after a competing run changes the binding for %s",
    async (framework) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped actor for binding admission");
      }
      chatCallbacks.failIfChatCallbackRouteIsFetched();

      const established = await sendChatRun(actor, {
        agentId,
        prompt: "establish the binding before competing sends",
      });
      const establishedClaim = await claimChatRun(
        runnerGroup,
        established.runId,
      );
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(
        established.runId,
        establishedClaim.sandboxHeaders,
      );
      await flushWaitUntilForTest();

      const providerRequests: string[] = [];
      const checkpointObjects =
        framework === "pi" ? mockPiCheckpointObjectStore() : undefined;
      let sdk:
        | Awaited<ReturnType<typeof context.mocks.piSdk.controlInitialization>>
        | undefined;
      let usagePricingResolution: UsagePricingFixture["resolution"] | undefined;
      if (framework === "pi") {
        await configureBuiltInPiModel(actor, "gpt-5.6-terra");
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.PiLoop]: true },
        );
        usagePricingResolution = await createGptUsagePricingResolution();
        const instructions = await publishPendingPiInstructions(actor, agentId);
        // Only the external SDK can delay initialization across both admissions.
        sdk = await context.mocks.piSdk.controlInitialization(
          {
            sessionId: established.threadId,
            instructions,
            holdInitialization: true,
          },
          context.signal,
        );
        server.use(
          http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
            const key = new URL(request.url).searchParams.get("object");
            if (!key) {
              throw new Error("Expected exact resource identity");
            }
            return new HttpResponse(piS3Object(key));
          }),
          http.post(
            "https://api.openai.com/v1/responses",
            async ({ request }) => {
              providerRequests.push(await request.text());
              return nativeCodexSseResponse(
                piResponsesTextSse(
                  "winning binding answer",
                  providerRequests.length,
                ),
              );
            },
          ),
        );
      }

      const admissionLock = await holdOrgAdmissionLockFixture({
        orgId: actor.orgId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        admissionLock.release();
        await admissionLock.done;
      });

      const firstEventId = randomUUID();
      const secondEventId = randomUUID();
      const firstRequest = {
        eventId: firstEventId,
        prompt: "first competing binding send",
        response: chat.requestSendEvent(
          actor,
          {
            agentId,
            threadId: established.threadId,
            prompt: "first competing binding send",
            clientEventId: firstEventId,
            ...(framework === "pi" ? { model: "gpt-5.6-terra" } : {}),
          },
          [201],
          { usagePricingResolution },
        ),
      } as const;
      // Make the queue head the first admission-lock waiter so the second
      // prepared request observes the binding committed by the first.
      await expect.poll(admissionLock.waiterCount).toBe(1);

      const secondRequest = {
        eventId: secondEventId,
        prompt: "second competing binding send",
        response: chat.requestSendEvent(
          actor,
          {
            agentId,
            threadId: established.threadId,
            prompt: "second competing binding send",
            clientEventId: secondEventId,
            ...(framework === "pi" ? { model: "gpt-5.6-terra" } : {}),
          },
          [201],
          { usagePricingResolution },
        ),
      } as const;
      const requests = [firstRequest, secondRequest] as const;

      await expect
        .poll(async () => {
          const messages = await chat.listThreadEvents(
            actor,
            established.threadId,
          );
          return requests.every(({ eventId }) => {
            return messages.events.some((event) => {
              return event.id === eventId;
            });
          });
        })
        .toBe(true);
      await expect.poll(admissionLock.transitiveWaiterCount).toBe(2);
      if (sdk) {
        await expect.poll(sdk.initializationCount).toBe(2);
      }

      admissionLock.release();
      const responses = await Promise.all(
        requests.map(({ response }) => {
          return response;
        }),
      );
      await admissionLock.done;

      const winners = responses.flatMap((response, index) => {
        if (response.status !== 201 || response.body.runId === null) {
          return [];
        }
        return [
          {
            eventId: requests[index]!.eventId,
            runId: response.body.runId,
          },
        ];
      });
      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (!winner) {
        throw new Error("Expected one competing send to create a run");
      }
      const loser = requests.find(({ eventId }) => {
        return eventId !== winner.eventId;
      });
      if (!loser) {
        throw new Error("Expected one competing send to lose admission");
      }
      expect(
        responses.filter((response) => {
          return response.status === 201 && response.body.runId === null;
        }),
      ).toHaveLength(1);

      const messages = await chat.listThreadEvents(actor, established.threadId);
      expect(
        userMessages(messages.events).filter((message) => {
          return (
            message.revokesEventId === winner.eventId &&
            message.runId === winner.runId
          );
        }),
      ).toHaveLength(1);
      expect(
        userMessages(messages.events).filter((message) => {
          return (
            message.revokesEventId === loser.eventId &&
            message.runId !== undefined
          );
        }),
      ).toHaveLength(0);
      const queuedLoser = userMessages(messages.events).find((message) => {
        return message.id === loser.eventId;
      });
      if (!queuedLoser) {
        throw new Error("Expected the losing message to remain queued");
      }
      expect(queuedLoser.runId).toBeUndefined();
      expect(chatEventDisplayText(queuedLoser)).toBe(loser.prompt);
      await expect(
        readThreadSessionBinding(context, established.threadId),
      ).resolves.toMatchObject({
        agent_session_run_id: winner.runId,
      });
      if (sdk && checkpointObjects) {
        expect(providerRequests).toHaveLength(0);
        expectNoPiApiFirstTurnArtifacts(winner.runId, checkpointObjects);
        expect(
          messages.events.filter((event) => {
            return (
              event.eventType.startsWith("output.") &&
              "runId" in event &&
              event.runId !== established.runId
            );
          }),
        ).toStrictEqual([]);
      }

      await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: established.threadId,
          revokesEventId: loser.eventId,
          clientEventId: randomUUID(),
        },
        [201],
      );
      if (sdk) {
        // Revoke the losing queued message before the winning API can complete,
        // so queue draining cannot conceal a duplicate provider attempt.
        sdk.release();
        await waitForRunStatus(actor, winner.runId, "completed", 10_000);
        await flushWaitUntilForTest();
        expect(providerRequests).toHaveLength(1);
        expect(sdk.initializationCount()).toBe(2);
        expect(sdk.disposeCount()).toBe(2);
        const completed = await chat.listThreadEvents(
          actor,
          established.threadId,
        );
        expect(
          eventBackedContents(completed.events, winner.runId),
        ).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: "winning binding answer" }),
          ]),
        );
      } else {
        await cancelChatRun(actor, winner.runId);
      }
    },
    90_000,
  );

  it.each(["sandbox", "pi"] as const)(
    "retries preparation when the canonical binding changes for %s",
    async (framework) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      if (!actor.orgId) {
        throw new Error("Expected an org-scoped actor for binding validation");
      }
      chatCallbacks.failIfChatCallbackRouteIsFetched();

      const first = await sendChatRun(actor, {
        agentId,
        prompt: "establish the binding snapshot",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
      await flushWaitUntilForTest();
      const firstBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      if (!firstBinding.agent_session_id) {
        throw new Error("Expected the first run to establish a session");
      }

      const providerRequests: string[] = [];
      const checkpointObjects =
        framework === "pi" ? mockPiCheckpointObjectStore() : undefined;
      let sdk:
        | Awaited<ReturnType<typeof context.mocks.piSdk.controlInitialization>>
        | undefined;
      let usagePricingResolution: UsagePricingFixture["resolution"] | undefined;
      if (framework === "pi") {
        await configureBuiltInPiModel(actor, "gpt-5.6-terra");
        await updateFeatureSwitchesForUser(
          context,
          { ...actor, orgId: actor.orgId },
          { [FeatureSwitchKey.PiLoop]: true },
        );
        usagePricingResolution = await createGptUsagePricingResolution();
        const instructions = await publishPendingPiInstructions(actor, agentId);
        sdk = await context.mocks.piSdk.controlInitialization(
          { sessionId: first.threadId, instructions, holdInitialization: true },
          context.signal,
        );
        server.use(
          http.get(PI_RESOURCE_ARCHIVE_DOWNLOAD_URL, ({ request }) => {
            const key = new URL(request.url).searchParams.get("object");
            if (!key) {
              throw new Error("Expected exact resource identity");
            }
            return new HttpResponse(piS3Object(key));
          }),
          http.post(
            "https://api.openai.com/v1/responses",
            async ({ request }) => {
              providerRequests.push(await request.text());
              return nativeCodexSseResponse(
                piResponsesTextSse(
                  "retried binding answer",
                  providerRequests.length,
                ),
              );
            },
          ),
        );
      }

      const admissionLock = await holdOrgAdmissionLockFixture({
        orgId: actor.orgId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        admissionLock.release();
        await admissionLock.done;
      });
      const messageId = randomUUID();
      const secondPromise = sendChatRun(
        actor,
        {
          agentId,
          threadId: first.threadId,
          prompt: "retry after the binding changes",
          clientEventId: messageId,
          ...(framework === "pi" ? { model: "gpt-5.6-terra" } : {}),
        },
        usagePricingResolution,
      );
      // The queue-first insert must complete before a fixture owns the parent
      // thread row; otherwise its FK check would block before session resolution.
      await expect
        .poll(async () => {
          const messages = await chat.listThreadEvents(actor, first.threadId);
          return messages.events.some((message) => {
            return message.id === messageId;
          });
        })
        .toBe(true);
      if (sdk) {
        await sdk.entered;
      }

      const bindingClear = await holdThreadSessionBindingClearFixture({
        threadId: first.threadId,
        signal: context.signal,
      });
      onTestFinished(async () => {
        bindingClear.release();
        await bindingClear.done;
      });
      admissionLock.release();
      await admissionLock.done;
      // Unlike the shared org advisory key, this row lock can only be reached
      // after the target preparation has captured its binding snapshot.
      await expect
        .poll(bindingClear.blockedWaiterCount)
        .toBeGreaterThanOrEqual(1);
      bindingClear.release();
      await bindingClear.done;
      const second = await secondPromise;
      if (sdk) {
        await expect.poll(sdk.initializationCount).toBe(2);
      }

      const secondBinding = await readThreadSessionBinding(
        context,
        first.threadId,
      );
      expect(secondBinding).toMatchObject({
        agent_session_id: expect.any(String),
        agent_session_run_id: second.runId,
        run_session_id: secondBinding.agent_session_id,
      });
      expect(secondBinding.agent_session_id).not.toBe(
        firstBinding.agent_session_id,
      );
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      await expect(
        readRunLaunchSnapshotFixture(context, second.runId),
      ).resolves.toStrictEqual({
        exists: true,
        launch_snapshot: {
          schemaVersion: 3,
          framework: secondClaim.claim.cliAgentType,
          runnerProfile: DEFAULT_PROFILE,
        },
      });
      expect(secondClaim.claim.resumeSession).toBeNull();
      if (sdk && checkpointObjects) {
        expect(providerRequests).toHaveLength(0);
        expectNoPiApiFirstTurnArtifacts(second.runId, checkpointObjects);
        sdk.release();
        await waitForRunStatus(actor, second.runId, "completed", 10_000);
        await flushWaitUntilForTest();
        expect(providerRequests).toHaveLength(1);
        expect(sdk.initializationCount()).toBe(2);
        expect(sdk.disposeCount()).toBe(2);
        const completed = await chat.listThreadEvents(actor, first.threadId);
        expect(
          eventBackedContents(completed.events, second.runId),
        ).toStrictEqual(
          expect.arrayContaining([
            expect.objectContaining({ content: "retried binding answer" }),
          ]),
        );
      } else {
        await cancelChatRun(actor, second.runId);
      }
    },
    90_000,
  );

  it("replays only each prior run's final answer when a model family rotates the session", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const { providerId: codexProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openai-api-key",
        secret: "prior-round-trim-openai-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-5.6-terra",
        isDefault: false,
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);

    const firstPrompt = "plan the migration in several steps";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, "narration: reading the first file"),
      assistantEvent(1, "narration: reading the second file"),
      assistantEvent(2, "final answer with the migration plan"),
    ]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      lastEventSequence: 2,
    });
    await flushWaitUntilForTest();
    await waitForThreadMessages(actor, first.threadId, (items) => {
      return eventBackedContents(items, first.runId).some((message) => {
        return message.content === "final answer with the migration plan";
      });
    });

    // Switching model family rotates the CLI session, so the prior round is
    // replayed. An agentic run emits one chat message per step; only its final
    // answer carries information the next run needs.
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "gpt-5.6-terra",
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after the family switch",
    });
    const appended = (await api.readRun(actor, second.runId))
      .appendSystemPrompt;
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(`- RUN_ID: ${first.runId}`);
    expect(appended).toContain(
      `- AGENT_SESSION_COMMAND: okou search "${first.runId}" --source agent-session`,
    );
    expect(appended).toContain("Use the AGENT_SESSION_COMMAND for a run");
    expect(appended).not.toContain("LOG_COMMAND");
    expect(appended).toContain(`User: ${firstPrompt}`);
    expect(appended).toContain(
      "Assistant: final answer with the migration plan",
    );
    expect(appended).not.toContain("narration: reading the first file");
    expect(appended).not.toContain("narration: reading the second file");
    expect(appended).toContain(`- CHAT_THREAD_ID: ${first.threadId}`);
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("rotates a canonical thread after an oversized history is discarded", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstPrompt = "finish work before native history becomes oversized";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const firstAnswer = "completed work preserved outside native history";
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstAnswer)]);
    const outputEvents = chatCallbacks.consumeMockChatOutputEvents();
    await webhooks.requestAgentEvents(
      { runId: first.runId, events: outputEvents },
      firstClaim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
        lastEventSequence: 0,
        checkpoint: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `discarded-cli-${first.runId}`,
          cliAgentSessionHistoryDisposition: "discarded_oversized",
        },
      },
      firstClaim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    await waitForRunStatus(actor, first.runId, "completed");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue in a fresh native session",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).toContain("# Web Chat Run Context");
    expect(appended).toContain(firstPrompt);
    expect(appended).toContain(firstAnswer);

    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("retries preparation when the canonical conversation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the checkpoint snapshot",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const conversationClear = await holdThreadSessionConversationClearFixture({
      threadId: first.threadId,
      signal: context.signal,
    });
    onTestFinished(async () => {
      conversationClear.release();
      await conversationClear.done;
    });
    const secondPromise = sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry after the checkpoint changes",
    });
    // The staged clear is still uncommitted, so the run resolves the pre-clear
    // snapshot and only blocks once its commit re-reads the session row.
    await expect
      .poll(conversationClear.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);

    conversationClear.release();
    await conversationClear.done;
    const second = await secondPromise;

    const secondBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(secondBinding).toMatchObject({
      agent_session_id: expect.any(String),
      agent_session_run_id: second.runId,
      run_session_id: secondBinding.agent_session_id,
    });
    expect(secondBinding.agent_session_id).not.toBe(
      firstBinding.agent_session_id,
    );
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("fails after every canonical session preparation snapshot changes", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the snapshot before retry exhaustion",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();
    const firstBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!firstBinding.agent_session_id) {
      throw new Error("Expected the first run to establish a session");
    }

    const preparationAttempts = 3;
    const conversationChanges =
      await holdThreadSessionConversationChangesFixture({
        threadId: first.threadId,
        changeCount: preparationAttempts,
        signal: context.signal,
      });
    onTestFinished(async () => {
      conversationChanges.releaseAll();
      await conversationChanges.done;
    });
    const retryPrompt = "exhaust every session preparation attempt";
    const failedPromise = requestSendEventRaw(actor, {
      agentId,
      threadId: first.threadId,
      clientEventId: randomUUID(),
      prompt: retryPrompt,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: retryPrompt }],
      },
      hasTextContent: true,
    });

    const intermediateAttempts = preparationAttempts - 1;
    for (let attempt = 0; attempt < intermediateAttempts; attempt += 1) {
      await expect
        .poll(conversationChanges.blockedWaiterCount)
        .toBeGreaterThanOrEqual(1);
      conversationChanges.queueNextChange();
      await expect.poll(conversationChanges.queuedChangeIsBlocked).toBe(true);
      conversationChanges.release();
      await expect
        .poll(conversationChanges.stagedChangeCount)
        .toBe(attempt + 2);
    }
    await expect
      .poll(conversationChanges.blockedWaiterCount)
      .toBeGreaterThanOrEqual(1);
    conversationChanges.release();
    await conversationChanges.done;
    const failed = await failedPromise;
    expect(failed).toStrictEqual({
      status: 500,
      body: { error: "Internal server error" },
    });

    await expect(
      readThreadSessionBinding(context, first.threadId),
    ).resolves.toStrictEqual(firstBinding);
  }, 90_000);

  it("re-resolves a sticky model through the current provider policy", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin sonnet model-first",
      model: "claude-sonnet-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const originalBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    if (!originalBinding.agent_session_id) {
      throw new Error("Expected the original route to bind a session");
    }
    const pinned = await chat.readThread(actor, first.threadId);
    expect(pinned).not.toHaveProperty("selectedModel");
    expect(pinned).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "rerouted-claude-oauth-token",
      },
      [200, 201],
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the provider policy reroute",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const environment = claimEnvironment(secondClaim.claim);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "claude-code-oauth-token",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-sonnet-5");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    expect(after).not.toHaveProperty("modelProviderId");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    const { providerId: openRouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-api-key",
        secret: "rerouted-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-sonnet-5",
        isDefault: true,
        defaultProviderType: "openrouter-api-key",
        credentialScope: "org",
        modelProviderId: openRouterProviderId,
      },
    ]);

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the upstream provider changes",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(claimEnvironment(thirdClaim.claim).ANTHROPIC_AUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "openrouter-api-key",
        "OPENROUTER_API_KEY",
      ),
    );
    expect(thirdClaim.claim.cliAgentType).toBe("claude-code");
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    await completeChatRunOk(third.runId, thirdClaim.sandboxHeaders);
    const reusedBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(reusedBinding.agent_session_id).toBe(
      originalBinding.agent_session_id,
    );
    expect(reusedBinding).toMatchObject({
      agent_session_run_id: third.runId,
      run_session_id: reusedBinding.agent_session_id,
    });
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-sonnet-5",
    );

    const fourth = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the same canonical session",
    });
    const fourthBinding = await readThreadSessionBinding(
      context,
      first.threadId,
    );
    expect(fourthBinding).toMatchObject({
      agent_session_id: reusedBinding.agent_session_id,
      agent_session_run_id: fourth.runId,
      run_session_id: reusedBinding.agent_session_id,
    });
    const fourthClaim = await claimChatRun(runnerGroup, fourth.runId);
    expect(fourthClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${third.runId}`,
    );
    await cancelChatRun(actor, fourth.runId);
  }, 90_000);

  it("rejects invalid model selections without creating visible state", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Invalid model selection agent",
    });

    // Chat send only accepts supported run models.
    const invalidModelThreadId = randomUUID();
    const invalidModel = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use an unsupported model",
        clientThreadId: invalidModelThreadId,
        model: "codex" as never,
      },
      [400],
    );
    expectApiError(invalidModel.body);
    expect(invalidModel.body.error.message).toBe("Invalid input");
    await chat.requestReadThread(actor, invalidModelThreadId, [404]);

    const unavailableThreadId = randomUUID();
    const unavailable = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "use a supported model outside workspace policy",
        clientThreadId: unavailableThreadId,
        model: "gpt-5.6-terra",
      },
      [400],
    );
    expectApiError(unavailable.body);
    expect(unavailable.body.error.message).toBe(
      "The selected model is not available in this workspace",
    );
    await chat.requestReadThread(actor, unavailableThreadId, [404]);

    // Removed sentinel models fail contract validation.
    for (const selectedModel of [
      "claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
    ]) {
      const removedThreadId = randomUUID();
      const removed = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt: `removed ${selectedModel}`,
          clientThreadId: removedThreadId,
          model: selectedModel as never,
        },
        [400],
      );
      expectApiError(removed.body);
      expect(removed.body.error).toMatchObject({
        code: "BAD_REQUEST",
        message: "Invalid input",
      });
      await chat.requestReadThread(actor, removedThreadId, [404]);
    }

    const events = await chat.requestThreadEvents(actor, {}, [200]);
    expect(events.status).toBe(200);
    if (events.status !== 200) {
      throw new Error("Expected chat thread events to load");
    }
    expect(events.body.events).toStrictEqual([]);
  }, 60_000);
});
