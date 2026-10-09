import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { randomUUID } from "node:crypto";
import { mockEnv } from "../../../lib/env";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { expectApiError } from "./helpers/api-bdd";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  createChatEventsFixture,
  claimEnvironment,
  eventBackedContents,
  assistantEvent,
  modelProviderSecretPlaceholder,
} from "./helpers/chat-events-fixture";
import { SEEDED_SYSTEM_DEFAULT_MODEL } from "./helpers/seeded-system-default";
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
  sendChatRun,
  sendWaitingChatInput,
  expectThreadCreatedModelEvent,
  expectNoThreadModelUpdateEvent,
  claimChatRun,
  waitForThreadMessages,
  waitForRunStatus,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

// Session continuity is observed through the native Runner claim protocol,
// so select Fable's native personal-subscription route.
async function entitledNativeChatActor(): Promise<
  Awaited<ReturnType<typeof entitledChatActor>>
> {
  const fixture = await entitledChatActor();
  await api.updateUserModelPreference(fixture.actor, "claude-fable-5-1");
  return fixture;
}

describe("CHAT-02: run-level model overrides", () => {
  it("reuses Codex sessions across account switches with the newly captured account", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const firewall = createFirewallApi(context);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    mockCodexDeviceAuthProvider({
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

    // Astra keeps Codex subscription runs on the native Codex harness; other
    // GPT models on this route run through Pi.
    await api.updateUserModelPreference(actor, "gpt-6-astra");

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start with account A",
      model: "gpt-6-astra",
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
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    // Claude subscription credentials stay on the native Claude Code harness
    // for every Claude model, so a same-family switch keeps the CLI session.
    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "same-family-claude-oauth-token",
      },
      [200, 201],
    );
    await api.updateUserModelPreference(actor, "claude-opus-5-5");

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-5-5",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
      model: "claude-sonnet-5-5",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5-5",
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("resumes the thread's latest session when a waiting input is picked", async () => {
    // Two blockers keep the next send waiting, independent of the plan's own
    // concurrency limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "establish the session before organization capacity fills",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    await flushWaitUntilForTest();

    const blockerOne = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the first organization slot",
    });
    const blockerTwo = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the second organization slot",
    });
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue the same session after capacity becomes available",
    });

    // The launch reads the thread session when the slot frees, not when the
    // input was accepted.
    await cancelChatRun(actor, blockerOne.runId);
    await flushWaitUntilForTest();
    const picked = await waiting.launchedRun();
    await waitForRunStatus(actor, picked.runId, "pending");
    const resumed = await claimChatRun(runnerGroup, picked.runId);
    expect(resumed.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    await cancelChatRun(actor, picked.runId);
    await cancelChatRun(actor, blockerTwo.runId);
  }, 90_000);

  // Caller-owned Fable (Claude Code) and Astra (Codex) use distinct runtime families.
  it.each([
    {
      from: "claude-fable-5-1",
      fromRuntime: "claude-code",
      to: "gpt-6-astra",
      toRuntime: "codex",
    },
    {
      from: "gpt-6-astra",
      fromRuntime: "codex",
      to: "claude-fable-5-1",
      toRuntime: "claude-code",
    },
  ] as const)(
    "applies family compatibility when switching owned $from on $fromRuntime to $to on $toRuntime",
    async ({ from, fromRuntime, to, toRuntime }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();

      await createBddIntegrationApi(context)
        .configureNativeSubscriptionModels(actor)
        .then(() => {
          return api.updateUserModelPreference(actor, from);
        });
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "establish native history before switching models",
        model: from,
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe(fromRuntime);
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
        cliAgentType: fromRuntime,
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
      expect(secondClaim.claim.cliAgentType).toBe(toRuntime);
      const environment = claimEnvironment(secondClaim.claim);
      expect(
        toRuntime === "codex"
          ? environment.OPENAI_MODEL
          : environment.ANTHROPIC_MODEL,
      ).toBe(to);
      expect(secondClaim.claim.resumeSession).toBeNull();
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
        cliAgentType: toRuntime,
      });
      await flushWaitUntilForTest();
      const secondRun = await api.readRun(actor, second.runId);
      expect(secondRun).toMatchObject({
        status: "completed",
        result: { agentSessionId: expect.any(String) },
      });
      expect(secondRun.result?.agentSessionId).toBe(
        firstRun.result?.agentSessionId,
      );
    },
    90_000,
  );

  it("replays prior final answers when a model family resets native history", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    // Fable and Astra keep both families on their native Runner harnesses.
    await createBddIntegrationApi(context)
      .configureNativeSubscriptionModels(actor)
      .then(() => {
        return api.updateUserModelPreference(actor, "claude-fable-5-1");
      });

    const firstPrompt = "plan the migration in several steps";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-fable-5-1",
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
    await chat.updateThreadModelSelection(actor, first.threadId, "gpt-6-astra");
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

  it("keeps incomplete context without rotating after a failure before the first native checkpoint", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const firstPrompt = "complete the migration without losing this request";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
      model: "claude-fable-5-1",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(
      first.runId,
      firstClaim.sandboxHeaders,
      "Runtime failed before its first checkpoint",
    );
    await waitForRunStatus(actor, first.runId, "failed");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "retry with the same model",
      model: "claude-fable-5-1",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).toContain("# Incomplete Rounds Context");
    expect(appended).toContain(`User: ${firstPrompt}`);

    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.cliAgentType).toBe(firstClaim.claim.cliAgentType);
    expect(secondClaim.claim.resumeSession).toBeNull();
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
  }, 90_000);

  it("keeps the application session without rotating when oversized native history is discarded", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
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
    const originalSession = await readCompletedRunSessionId(
      context,
      actor,
      first.runId,
    );

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue in a fresh native session",
    });
    const secondRun = await api.readRun(actor, second.runId);
    const appended = secondRun.appendSystemPrompt ?? "";
    expect(appended).not.toContain("# Web Chat Run Context");
    expect(appended).not.toContain(firstPrompt);
    expect(appended).not.toContain(firstAnswer);

    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.resumeSession).toBeNull();
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, second.runId),
    ).resolves.toBe(originalSession);
  }, 90_000);

  it("resumes a sticky model through personal credential replacement and reconnect", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin fable model-first",
      model: "claude-fable-5-1",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);
    const originalSession = await readCompletedRunSessionId(
      context,
      actor,
      first.runId,
    );
    const pinned = await chat.readThread(actor, first.threadId);
    expect(pinned).not.toHaveProperty("selectedModel");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-fable-5-1",
    );

    await misc.upsertPersonalModelProvider(
      actor,
      {
        type: "claude-code-oauth-token",
        secret: "rerouted-claude-oauth-token",
      },
      [200, 201],
    );
    await api.updateUserModelPreference(actor, "claude-fable-5-1");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after reconnecting the Claude subscription",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const environment = claimEnvironment(secondClaim.claim);
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "claude-code-oauth-token",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    );
    expect(environment.ANTHROPIC_MODEL).toBe("claude-fable-5-1");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    await expectThreadCreatedModelEvent(
      actor,
      first.threadId,
      "claude-fable-5-1",
    );
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-fable-5-1",
    );
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);

    // Disconnect and reconnect only this member's credential source; no
    // organization API route may replace a missing personal subscription.
    await authDeviceSupport.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );

    await api.ensurePersonalSubscriptionModel(actor, {
      model: "claude-fable-5-1",
    });

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "follow up after the upstream provider changes",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(claimEnvironment(thirdClaim.claim).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      modelProviderSecretPlaceholder(
        "claude-code-oauth-token",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ),
    );
    expect(thirdClaim.claim.cliAgentType).toBe("claude-code");
    expect(thirdClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    await completeChatRunOk(third.runId, thirdClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, third.runId),
    ).resolves.toBe(originalSession);
    await expectNoThreadModelUpdateEvent(
      actor,
      first.threadId,
      "claude-fable-5-1",
    );

    const fourth = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on the same canonical session",
    });
    const fourthClaim = await claimChatRun(runnerGroup, fourth.runId);
    expect(fourthClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${third.runId}`,
    );
    await completeChatRunOk(fourth.runId, fourthClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, fourth.runId),
    ).resolves.toBe(originalSession);
  }, 90_000);

  it("rejects invalid model selections without creating visible state", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await api.ensurePersonalSubscriptionModel(actor);
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
    expect(invalidModel.body.error.message).toBe('Unknown model "codex"');
    await chat.requestReadThread(actor, invalidModelThreadId, [404]);

    // Models outside the catalog are rejected.
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
        message: `Unknown model "${selectedModel}"`,
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

  it("rejects an explicit disconnected personal model instead of capturing Auto", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "do not bill Auto for my unavailable personal model",
        model: "gpt-6-luna",
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error(
        "Expected the input acknowledgement before personal admission rejection",
      );
    }
    await flushWaitUntilForTest();
    const page = await chat.listThreadEvents(actor, sent.body.threadId);
    expect(page.events).toContainEqual(
      expect.objectContaining({ eventType: "input.rejected" }),
    );
    expect(
      page.events.some((event) => {
        return event.runId !== undefined;
      }),
    ).toBeFalsy();
    await expect(
      chat.readThreadMetadata(actor, sent.body.threadId),
    ).resolves.toMatchObject({ selectedModel: "gpt-6-luna" });
  }, 60_000);
});
