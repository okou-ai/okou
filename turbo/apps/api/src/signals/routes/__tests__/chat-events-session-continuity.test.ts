import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { randomUUID } from "node:crypto";
import { mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockCodexDeviceAuthProvider } from "./helpers/api-bdd-auth-device";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  createChatEventsFixture,
  claimEnvironment,
  eventBackedContents,
  assistantEvent,
  modelProviderSecretPlaceholder,
} from "./helpers/chat-events-fixture";
const context = testContext();
const {
  api,
  chat,
  webhooks,
  chatCallbacks,
  misc,
  authDevice,
  authDeviceSupport,
  entitledChatActor,
  configureSubscriptionPiModel,
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
    expect(secondClaim.claim.nativeContinuation?.sessionId).toBe(
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
    expect(thirdClaim.claim.nativeContinuation?.sessionId).toBe(
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

  it("resumes Claude Code with the current model selection", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
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

    // Editing the preference does not replace the bound Framework. Only the
    // model selected when the next input launches determines its execution.
    await chat.updateThreadModelSelection(actor, first.threadId, null);
    await chat.updateThreadModelSelection(
      actor,
      first.threadId,
      "claude-sonnet-5-5",
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue on sonnet in the same session",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.nativeContinuation).toMatchObject({
      sessionId: `bdd-cli-${first.runId}`,
      generationRunId: first.runId,
      recoveryPrompt: expect.stringContaining(
        "okou chat messages --output-dir threads",
      ),
    });
    expect(claimEnvironment(secondClaim.claim).ANTHROPIC_MODEL).toBe(
      "claude-sonnet-5-5",
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it("keeps the Pi session across subscription and Auto model switches", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor);
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "start with my subscription model",
      model: "gpt-6-luna",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    expect(firstClaim.claim).toMatchObject({
      cliAgentType: "pi",
      piModelConfig: { provider: "openai-codex", model: "gpt-6-luna" },
      nativeContinuation: {
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: null,
      },
    });
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
      cliAgentType: "pi",
      cliAgentSessionId: first.threadId,
    });
    await flushWaitUntilForTest();

    await chat.updateThreadModelSelection(actor, first.threadId, null);
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue with Auto in the same native session",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim).toMatchObject({
      cliAgentType: "pi",
      piModelConfig: { provider: "openrouter" },
      nativeContinuation: {
        sessionId: first.threadId,
        generationRunId: first.runId,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir threads",
        ),
      },
    });
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
      cliAgentType: "pi",
      cliAgentSessionId: first.threadId,
    });
    await flushWaitUntilForTest();

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "return to my subscription without losing the native context",
      model: "gpt-6-luna",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim).toMatchObject({
      cliAgentType: "pi",
      piModelConfig: { provider: "openai-codex", model: "gpt-6-luna" },
      nativeContinuation: {
        sessionId: first.threadId,
        generationRunId: second.runId,
      },
    });
    await cancelChatRun(actor, third.runId, thirdClaim.sandboxHeaders);
  }, 90_000);

  it.each(["claude-code", "pi"] as const)(
    "retains the newer %s producer after delayed initialization and repeated completion",
    async (framework) => {
      const { actor, agentId, runnerGroup } =
        framework === "pi"
          ? await entitledChatActor()
          : await entitledNativeChatActor();
      if (framework === "pi") {
        await configureSubscriptionPiModel(actor);
      }
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "initialize the first native context",
        model: framework === "pi" ? "gpt-6-luna" : "claude-fable-5-1",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      const firstSession = framework === "pi" ? first.threadId : randomUUID();
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: firstSession,
              sequenceNumber: 0,
            },
          ],
        },
        firstClaim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
        cliAgentType: framework,
        cliAgentSessionId: firstSession,
      });
      await flushWaitUntilForTest();

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue with a newer producer",
      });
      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim.nativeContinuation).toMatchObject({
        sessionId: firstSession,
        generationRunId: first.runId,
      });
      const secondSession = framework === "pi" ? first.threadId : randomUUID();
      await webhooks.requestAgentEvents(
        {
          runId: second.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: secondSession,
              sequenceNumber: 0,
            },
          ],
        },
        secondClaim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
        cliAgentType: framework,
        cliAgentSessionId: secondSession,
      });
      await flushWaitUntilForTest();

      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: firstSession,
              sequenceNumber: 1,
            },
          ],
        },
        firstClaim.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      await completeChatRunOk(first.runId, firstClaim.sandboxHeaders, {
        cliAgentType: framework,
        cliAgentSessionId: firstSession,
      });
      await flushWaitUntilForTest();
      await waitForRunStatus(actor, first.runId, "completed");

      const third = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "inspect the winning native binding",
      });
      const thirdClaim = await claimChatRun(runnerGroup, third.runId);
      expect(thirdClaim.claim.nativeContinuation).toMatchObject({
        sessionId: secondSession,
        generationRunId: second.runId,
      });
      await cancelChatRun(actor, third.runId, thirdClaim.sandboxHeaders);
    },
    90_000,
  );

  it("saves a released Run's recovery outputs without replacing a newer native binding", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "fail before native initialization",
      model: "claude-fable-5-1",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await failChatRun(
      first.runId,
      firstClaim.sandboxHeaders,
      "Runner fallback",
    );
    await waitForRunStatus(actor, first.runId, "failed");

    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "establish the current native context",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    const secondSession = randomUUID();
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
      cliAgentType: "claude-code",
      cliAgentSessionId: secondSession,
    });
    await flushWaitUntilForTest();

    const outputs = {
      runId: first.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: randomUUID(),
      cliAgentSessionHistoryDisposition: "native_only",
    } as const;
    await webhooks.requestAgentRunOutputs(
      outputs,
      firstClaim.sandboxHeaders,
      [200],
    );
    const recovered = await api.readRun(actor, first.runId);
    expect(recovered).toMatchObject({
      status: "failed",
      result: {
        frameworkSessionId: expect.any(String),
        storageOutputs: expect.any(Array),
      },
    });
    await webhooks.requestAgentRunOutputs(
      outputs,
      firstClaim.sandboxHeaders,
      [200],
    );
    expect((await api.readRun(actor, first.runId)).result).toStrictEqual(
      recovered.result,
    );

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "resume the current context after late recovery",
    });
    const thirdClaim = await claimChatRun(runnerGroup, third.runId);
    expect(thirdClaim.claim.nativeContinuation).toMatchObject({
      sessionId: secondSession,
      generationRunId: second.runId,
    });
    await cancelChatRun(actor, third.runId, thirdClaim.sandboxHeaders);
  }, 90_000);

  it.each(["failed", "cancelled"] as const)(
    "keeps the first native context fresh when initialization arrives after a %s Run released its slot",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "finish without native initialization",
        model: "claude-fable-5-1",
      });
      const claimed = await claimChatRun(runnerGroup, first.runId);
      if (status === "cancelled") {
        await cancelChatRun(actor, first.runId, claimed.sandboxHeaders);
      } else {
        await failChatRun(
          first.runId,
          claimed.sandboxHeaders,
          "Runtime stopped before initialization",
        );
      }
      await waitForRunStatus(actor, first.runId, status);
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: randomUUID(),
              sequenceNumber: 0,
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "start the first native context",
      });
      const next = await claimChatRun(runnerGroup, second.runId);
      expect(next.claim.nativeContinuation).toMatchObject({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir threads",
        ),
      });
      await cancelChatRun(actor, second.runId, next.sandboxHeaders);
    },
    90_000,
  );

  it.each(["claude-code", "pi"] as const)(
    "captures %s initialization during cancellation recovery before releasing the slot",
    async (framework) => {
      const { actor, agentId, runnerGroup } =
        framework === "pi"
          ? await entitledChatActor()
          : await entitledNativeChatActor();
      if (framework === "pi") {
        await configureSubscriptionPiModel(actor);
      }
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "cancel while native initialization is in flight",
        model: framework === "pi" ? "gpt-6-luna" : "claude-fable-5-1",
      });
      const claimed = await claimChatRun(runnerGroup, first.runId);
      await cancelChatRun(actor, first.runId);
      const sessionId = framework === "pi" ? first.threadId : randomUUID();
      await webhooks.requestAgentEvents(
        {
          runId: first.runId,
          events: [
            {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              sequenceNumber: 0,
            },
          ],
        },
        claimed.sandboxHeaders,
        [200],
      );
      await flushWaitUntilForTest();
      // Release recovery without completion metadata: only the initialization
      // receipt can have supplied the binding observed by the next claim.
      await failChatRun(first.runId, claimed.sandboxHeaders, "Run cancelled");
      await waitForRunStatus(actor, first.runId, "cancelled");
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "continue from the cancelled native context",
      });
      const next = await claimChatRun(runnerGroup, second.runId);
      expect(next.claim.nativeContinuation).toMatchObject({
        sessionId,
        generationRunId: first.runId,
      });
      await cancelChatRun(actor, second.runId, next.sandboxHeaders);
    },
    90_000,
  );

  it.each(["claude-code", "pi"] as const)(
    "preserves the %s binding when initialization, completion and cancellation overlap",
    async (framework) => {
      const { actor, agentId, runnerGroup } =
        framework === "pi"
          ? await entitledChatActor()
          : await entitledNativeChatActor();
      if (framework === "pi") {
        await configureSubscriptionPiModel(actor);
      }
      const first = await sendChatRun(actor, {
        agentId,
        prompt: "race native initialization against finalization",
        model: framework === "pi" ? "gpt-6-luna" : "claude-fable-5-1",
      });
      const claimed = await claimChatRun(runnerGroup, first.runId);
      const sessionId = framework === "pi" ? first.threadId : randomUUID();
      await Promise.all([
        webhooks.requestAgentEvents(
          {
            runId: first.runId,
            events: [
              {
                type: "system",
                subtype: "init",
                session_id: sessionId,
                sequenceNumber: 0,
              },
            ],
          },
          claimed.sandboxHeaders,
          [200],
        ),
        completeChatRunOk(first.runId, claimed.sandboxHeaders, {
          cliAgentType: framework,
          cliAgentSessionId: sessionId,
        }),
        api.requestCancelRun(actor, first.runId, [200, 400]),
      ]);
      await flushWaitUntilForTest();
      const settled = await api.readRun(actor, first.runId);
      expect(["completed", "cancelled"]).toContain(settled.status);
      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "resume after concurrent finalization",
      });
      const next = await claimChatRun(runnerGroup, second.runId);
      expect(next.claim.nativeContinuation).toMatchObject({
        sessionId,
        generationRunId: first.runId,
      });
      await cancelChatRun(actor, second.runId, next.sandboxHeaders);
    },
    90_000,
  );

  it("resumes the thread's latest session when a waiting input is picked", async () => {
    // Two blockers keep the next send waiting, independent of the plan's own
    // concurrency limit.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
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
    expect(resumed.claim.nativeContinuation?.sessionId).toBe(
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
    "uses the previous Run's resource and recovers native context across $from -> $to -> $from",
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
        result: { frameworkSessionId: expect.any(String) },
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
      expect(secondClaim.claim.nativeContinuation?.sessionId).toBeNull();
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders, {
        cliAgentType: toRuntime,
      });
      await flushWaitUntilForTest();
      const secondRun = await api.readRun(actor, second.runId);
      expect(secondRun).toMatchObject({
        status: "completed",
        result: { frameworkSessionId: expect.any(String) },
      });
      expect(secondClaim.claim.nativeContinuation?.recoveryPrompt).toContain(
        "okou chat messages --output-dir threads",
      );
      expect(secondRun.result?.framework).toBe(toRuntime);

      const runners = createRunsApi(context);
      const holders = [randomUUID(), randomUUID()];
      for (const [index, sourceRunId] of [
        first.runId,
        second.runId,
      ].entries()) {
        await runners.requestHeartbeatRunner(true, [200], {
          runnerId: holders[index],
          group: runnerGroup,
          snapshotGeneration: 7,
          snapshotSequence: 1,
          admittableProfiles: [],
          heldSandboxStates: [
            {
              reuseKey: `thread:${first.threadId}`,
              lastCompletedAt: nowDate().toISOString(),
              reusableSandbox: {
                profile: "vm0/default",
                sourceRunId,
              },
            },
          ],
        });
      }
      context.mocks.ably.publish.mockClear();
      const third = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt:
          "continue with both earlier rounds when returning to the first model",
        model: from,
      });
      const polled = await runners.pollRunner(runnerGroup);
      expect(polled.body.job).toMatchObject({
        runId: third.runId,
        runnerPreference: {
          tier: "exactSandbox",
          predecessorRunId: second.runId,
          runnerIdentity: { runnerId: holders[1], heartbeatGeneration: 7 },
        },
      });
      expect(context.mocks.ably.publish).toHaveBeenCalledWith(
        "job",
        expect.objectContaining({
          runId: third.runId,
          runnerPreference: polled.body.job?.runnerPreference,
        }),
      );
      const thirdClaim = await claimChatRun(runnerGroup, third.runId);
      expect(thirdClaim.claim.cliAgentType).toBe(fromRuntime);
      expect(thirdClaim.claim.nativeContinuation).toMatchObject({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir threads",
        ),
      });
      await waitForThreadMessages(actor, first.threadId, (items) => {
        const text = items.map(chatEventDisplayText).join("\n");
        return (
          text.includes("establish native history before switching models") &&
          text.includes("continue with the selected model")
        );
      });
      await cancelChatRun(actor, third.runId);
    },
    90_000,
  );

  it("requires Chat recovery after a Framework switch", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();

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

    // The next Framework must recover the durable Chat context on a fresh launch.
    await chat.updateThreadModelSelection(actor, first.threadId, "gpt-6-astra");
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue after the Framework switch",
    });
    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
      recoveryPrompt: expect.stringContaining(
        "okou chat messages --output-dir threads",
      ),
    });
    expect(secondClaim.claim.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
      first.threadId,
    );
    await cancelChatRun(actor, second.runId);
  }, 90_000);

  it.each(["failed", "cancelled"] as const)(
    "recovers durable Chat after an executed attempt was %s before initialization",
    async (status) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();

      const firstPrompt = "complete the migration without losing this request";
      const first = await sendChatRun(actor, {
        agentId,
        prompt: firstPrompt,
        model: "claude-fable-5-1",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.nativeContinuation).toMatchObject({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: null,
      });
      if (status === "cancelled") {
        await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
      } else {
        await failChatRun(
          first.runId,
          firstClaim.sandboxHeaders,
          "Runtime failed before native initialization",
        );
      }
      await waitForRunStatus(actor, first.runId, status);

      const second = await sendChatRun(actor, {
        agentId,
        threadId: first.threadId,
        prompt: "retry with the same model",
        model: "claude-fable-5-1",
      });
      const secondRun = await api.readRun(actor, second.runId);
      const appended = secondRun.appendSystemPrompt ?? "";
      expect(appended).toContain("# Incomplete Rounds Context");
      expect(appended).toContain(`User: ${firstPrompt}`);

      const secondClaim = await claimChatRun(runnerGroup, second.runId);
      expect(secondClaim.claim.cliAgentType).toBe(
        firstClaim.claim.cliAgentType,
      );
      expect(secondClaim.claim.nativeContinuation).toMatchObject({
        sessionId: null,
        generationRunId: null,
        recoveryPrompt: expect.stringContaining(
          "okou chat messages --output-dir threads",
        ),
      });
      chatCallbacks.mockChatOutputEvents([]);
      await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    },
    90_000,
  );

  it("keeps durable Chat and native identity independent of a history archive", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();

    const firstPrompt = "finish work before native history becomes oversized";
    const first = await sendChatRun(actor, {
      agentId,
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    const firstAnswer = "completed work preserved outside native history";
    for (const invalidId of ["../foreign-session", "x".repeat(256)]) {
      await webhooks.requestAgentComplete(
        {
          runId: first.runId,
          exitCode: 0,
          completion: {
            cliAgentType: "claude-code",
            cliAgentSessionId: invalidId,
            cliAgentSessionHistoryDisposition: "native_only",
          },
        },
        firstClaim.sandboxHeaders,
        [400],
      );
      expect((await api.readRun(actor, first.runId)).status).toBe("running");
    }
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
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `discarded-cli-${first.runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
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
    expect(appended).not.toContain(firstPrompt);
    expect(appended).not.toContain(firstAnswer);

    const secondClaim = await claimChatRun(runnerGroup, second.runId);
    expect(secondClaim.claim.nativeContinuation?.sessionId).toBe(
      originalSession,
    );
    expect(secondClaim.claim.nativeContinuation?.generationRunId).toBe(
      first.runId,
    );
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(second.runId, secondClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, second.runId),
    ).resolves.toBe(`bdd-cli-${second.runId}`);
  }, 90_000);

  it("resumes a sticky model through personal credential replacement and reconnect", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();

    const first = await sendChatRun(actor, {
      agentId,
      prompt: "pin fable model-first",
      model: "claude-fable-5-1",
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    chatCallbacks.mockChatOutputEvents([]);
    await completeChatRunOk(first.runId, firstClaim.sandboxHeaders);

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
    expect(secondClaim.claim.nativeContinuation?.sessionId).toBe(
      `bdd-cli-${first.runId}`,
    );
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
    expect(thirdClaim.claim.nativeContinuation?.sessionId).toBe(
      `bdd-cli-${second.runId}`,
    );
    await completeChatRunOk(third.runId, thirdClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, third.runId),
    ).resolves.toBe(`bdd-cli-${third.runId}`);
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
    expect(fourthClaim.claim.nativeContinuation?.sessionId).toBe(
      `bdd-cli-${third.runId}`,
    );
    await completeChatRunOk(fourth.runId, fourthClaim.sandboxHeaders);
    await expect(
      readCompletedRunSessionId(context, actor, fourth.runId),
    ).resolves.toBe(`bdd-cli-${fourth.runId}`);
  }, 90_000);

  it("rejects an explicit disconnected personal model instead of capturing Auto", async () => {
    const { actor, agentId } = await entitledNativeChatActor();

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
