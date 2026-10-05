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
  cancelChatRun,
  upsertOrgModelProvider,
} = createChatEventsFixture(context);

// Session continuity is observed through the native Runner claim protocol.
// The fixture's default Sonnet policy is Pi-eligible, so select the Fable
// native route instead.
async function entitledNativeChatActor(): Promise<
  Awaited<ReturnType<typeof entitledChatActor>>
> {
  const fixture = await entitledChatActor();
  await api.updateOrgModelPolicies(fixture.actor, [
    {
      model: "claude-fable-5-1",
      preferred: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: fixture.providerId,
    },
  ]);
  return fixture;
}

describe("CHAT-02: run-level model overrides", () => {
  it("reuses Codex sessions across account switches with the newly captured account", async () => {
    const { actor, agentId, runnerGroup, providerId } =
      await entitledChatActor();
    const firewall = createFirewallApi(context);
    chatCallbacks.failIfChatCallbackRouteIsFetched();

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

    // Astra keeps Codex subscription runs on the native Codex harness; other
    // GPT models on this route run through Pi.
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

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
    await chatCallbacks.updateOrgModelPolicies(actor, [
      {
        model: "claude-opus-5",
        preferred: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
      {
        model: "claude-sonnet-5",
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
        modelProviderId: null,
      },
    ]);

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start on opus before switching within Claude",
      model: "claude-opus-5",
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

  // Built-in native Runner routes are the Fable (Claude Code) and Astra
  // (Codex) frontier lines; every other built-in model runs through Pi.
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
    "applies family compatibility when switching built-in $from on $fromRuntime to $to on $toRuntime",
    async ({ from, fromRuntime, to, toRuntime }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();

      await seedBuiltInModelKey(from);
      await seedBuiltInModelKey(to);
      await api.updateOrgModelPolicies(actor, [
        {
          model: from,
          preferred: true,
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        },
        {
          model: to,
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
    // Fable and Astra keep both families on their native Runner harnesses.
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
        defaultProviderType: "anthropic-api-key",
        credentialScope: "org",
        modelProviderId: providerId,
      },
      {
        model: "gpt-6-astra",
        defaultProviderType: "openai-api-key",
        credentialScope: "org",
        modelProviderId: codexProviderId,
      },
    ]);

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

  it("keeps the application session when oversized native history is discarded", async () => {
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

  it("re-resolves a sticky model through the current provider policy", async () => {
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
    expect(pinned).not.toHaveProperty("modelProviderId");
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
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
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
    expect(environment.ANTHROPIC_MODEL).toBe("claude-fable-5-1");
    expect(secondClaim.claim.resumeSession?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
    const after = await chat.readThread(actor, first.threadId);
    expect(after).not.toHaveProperty("selectedModel");
    expect(after).not.toHaveProperty("modelProviderId");
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

    // A connected personal subscription outranks the organization API for a
    // model it supports, so the organization route only becomes observable once
    // the member disconnects it.
    await authDeviceSupport.deletePersonalModelProvider(
      actor,
      "claude-code-oauth-token",
      [204],
    );
    const { providerId: openRouterProviderId } = await upsertOrgModelProvider(
      actor,
      {
        type: "openrouter-api-key",
        secret: "rerouted-openrouter-key",
      },
    );
    await api.updateOrgModelPolicies(actor, [
      {
        model: "claude-fable-5-1",
        preferred: true,
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

  it("captures the system default when an explicit model is outside workspace policy", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await seedBuiltInModelKey(SEEDED_SYSTEM_DEFAULT_MODEL);
    const fallback = await sendChatRun(actor, {
      agentId,
      prompt: "use a supported model outside workspace policy",
      model: "gpt-6-luna",
    });
    await expectThreadCreatedModelEvent(actor, fallback.threadId, "gpt-6-luna");
    await expect(
      chat.readThreadMetadata(actor, fallback.threadId),
    ).resolves.toMatchObject({
      selectedModel: "gpt-6-luna",
    });
    expect((await api.readRun(actor, fallback.runId)).source.model).toBe(
      SEEDED_SYSTEM_DEFAULT_MODEL,
    );
    await cancelChatRun(actor, fallback.runId);
  }, 60_000);
});
