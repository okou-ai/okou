import { readCompletedRunSessionId } from "./helpers/public-run-session";
import { now } from "../../../lib/time";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";

import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  postThreadPiAutomationEvent,
  completeSandboxFirstPiRun,
  expectThreadPiTerminal,
  sendChatRun,
  api,
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  claimChatRun,
  completeChatRunOk,
  failChatRun,
  cancelChatRun,
  sessionHeaders,
  threadPiAutomationsClient,
  lastThreadPiAutomationRun,
  claimGptPiSandbox,
  mockPiObjectStore,
  mockPiResourceArchiveDownloads,
} = createChatEventsFixture(context);

describe("thread-bound Pi Automation execution", () => {
  it("rotates a signed event Automation session into Pi and preserves its user conversation", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor({}, "team");
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor,
      {
        agentId,
        name: "pi-event-session",
      },
    );
    await api.updateUserModelPreference(actor, "claude-fable-5-1");
    const created = await accept(
      threadPiAutomationsClient().create({
        headers: sessionHeaders(actor),
        params: { workflowId },
        body: { kind: "event", eventType: "webhook-received" },
      }),
      [201],
    );
    const automation = created.body;
    if (
      automation.kind !== "event" ||
      automation.eventType !== "webhook-received" ||
      !automation.webhookUrl ||
      !automation.webhookSecret ||
      !automation.chatThreadId
    ) {
      throw new Error("Expected the event automation webhook and thread");
    }
    const eventRoute = {
      webhookUrl: automation.webhookUrl,
      webhookSecret: automation.webhookSecret,
    };
    const threadId = automation.chatThreadId;
    await postThreadPiAutomationEvent({
      ...eventRoute,
      payload: "legacy",
      timestamp: Math.floor(now() / 1000),
    });
    const legacyRunId = await lastThreadPiAutomationRun(actor, threadId);
    const legacyClaim = await claimChatRun(runnerGroup, legacyRunId);
    await completeChatRunOk(legacyRunId, legacyClaim.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    const legacySessionId = await readCompletedRunSessionId(
      context,
      actor,
      legacyRunId,
    );

    await configureSubscriptionPiModel(actor);
    await chat.updateThreadModelSelection(actor, threadId, "gpt-6-luna");
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const event = {
      ...eventRoute,
      payload: "pi-event",
      timestamp: Math.floor(now() / 1000),
    };
    await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject({
      duplicate: false,
    });
    await expect(postThreadPiAutomationEvent(event)).resolves.toMatchObject({
      duplicate: true,
    });
    const piRunId = await lastThreadPiAutomationRun(actor, threadId);
    expect(piRunId).not.toBe(legacyRunId);
    const piClaim = await claimChatRun(runnerGroup, piRunId);
    expect(piClaim.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
    });
    await completeSandboxFirstPiRun({
      actor,
      run: { runId: piRunId, threadId },
      claim: piClaim,
      historyObjects,
      prompt: piClaim.claim.prompt,
      answer: "owned event answer",
      responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
    });
    await expectThreadPiTerminal(actor, threadId, piRunId);
    await expect(
      readCompletedRunSessionId(context, actor, piRunId),
    ).resolves.toBe(legacySessionId);

    const user = await sendChatRun(actor, {
      agentId,
      threadId,
      prompt: "continue this Automation conversation",
    });
    const userClaim = await claimChatRun(runnerGroup, user.runId);
    expect(userClaim.claim.piModelConfig).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
    });
    await completeSandboxFirstPiRun({
      actor,
      run: user,
      claim: userClaim,
      historyObjects,
      prompt: "continue this Automation conversation",
      answer: "owned user answer",
      responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
    });
    await expectThreadPiTerminal(actor, threadId, user.runId);
    await expect(
      readCompletedRunSessionId(context, actor, user.runId),
    ).resolves.toBe(legacySessionId);
  }, 90_000);
});

describe("CHAT effort: automation launches", () => {
  async function startAutomation() {
    const scenario = await entitledChatActor({}, "pro");
    const { actor, agentId, runnerGroup } = scenario;
    // Fable keeps the automation on the Claude Code Runner claim protocol;
    // the Sonnet fixture default would launch a Pi run instead.
    await api.updateUserModelPreference(actor, "claude-fable-5-1");
    const workflowId = await createWorkflowsBddApi(context).createWorkflow(
      actor,
      { agentId, name: "native-effort" },
    );
    const created = await accept(
      threadPiAutomationsClient().create({
        headers: sessionHeaders(actor),
        params: { workflowId },
        body: { schedule: { type: "loop", intervalSeconds: 3600 } },
      }),
      [201],
    );
    const started = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: created.body.id },
      }),
      [201],
    );
    const threadId = started.body.chatThreadId;
    const runId = await lastThreadPiAutomationRun(actor, threadId);
    const claimed = await claimChatRun(runnerGroup, runId);
    // No saved thread effort yet: the launch uses Fable's route default.
    expect(claimed.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("max");
    return {
      ...scenario,
      threadId,
      runId,
      claimed,
      automationId: created.body.id,
    };
  }

  it("captures automation effort at enqueue and applies edits to later triggers", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await chat.updateThreadModelSelection(actor, threadId, "claude-fable-5-1", {
      reasoningEffort: "extra",
    });
    const queued = await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: automationId },
      }),
      [201],
    );
    expect(queued.body.runId).toBeNull();
    await chat.updateThreadModelSelection(actor, threadId, "claude-fable-5-1", {
      reasoningEffort: "high",
    });
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    const nextRunId = await lastThreadPiAutomationRun(actor, threadId);
    expect(nextRunId).not.toBe(runId);
    const next = await claimChatRun(runnerGroup, nextRunId);
    expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("extra");
    await expect(
      chat.readThreadMetadata(actor, threadId),
    ).resolves.toMatchObject({
      modelSettings: { "claude-fable-5-1": { effort: "high" } },
    });
    await cancelChatRun(actor, nextRunId, next.sandboxHeaders);

    // The edit applies to a newly enqueued trigger, not the prior queued input.
    await accept(
      threadPiAutomationsClient().run({
        headers: sessionHeaders(actor),
        params: { id: automationId },
      }),
      [201],
    );
    const latestRunId = await lastThreadPiAutomationRun(actor, threadId);
    expect(latestRunId).not.toBe(nextRunId);
    const latest = await claimChatRun(runnerGroup, latestRunId);
    expect(latest.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe("high");
    await cancelChatRun(actor, latestRunId, latest.sandboxHeaders);
  }, 90_000);

  it("uses route defaults for unsupported effort at automation launch", async () => {
    const { actor, runnerGroup, threadId, runId, claimed, automationId } =
      await startAutomation();
    await completeChatRunOk(runId, claimed.sandboxHeaders, {
      cliAgentType: "claude-code",
    });
    await flushWaitUntilForTest();
    let previousRunId = runId;
    for (const route of [
      {
        model: "claude-fable-5-1",
        effort: "ultracode",
        pi: false,
        providerType: "claude-code-oauth-token",
        effectiveEffort: "max",
      },
      {
        model: "gpt-6-sol",
        effort: "high",
        pi: true,
        providerType: "codex-oauth-token",
        effectiveEffort: "high",
      },
    ] as const) {
      if (route.pi) {
        await configureSubscriptionPiModel(actor, {}, route.model);
      } else {
        await api.ensurePersonalSubscriptionModel(actor, {
          model: route.model,
        });
      }
      await chat.updateThreadModelSelection(actor, threadId, route.model, {
        reasoningEffort: route.effort,
      });
      if (route.pi) {
        mockPiObjectStore();
      }
      const started = await accept(
        threadPiAutomationsClient().run({
          headers: sessionHeaders(actor),
          params: { id: automationId },
        }),
        [201],
      );
      expect(started.body.runId).toBeNull();
      const startedRunId = await lastThreadPiAutomationRun(actor, threadId);
      expect(startedRunId).not.toBe(previousRunId);
      previousRunId = startedRunId;
      const next = await claimChatRun(runnerGroup, startedRunId);
      expect(next.claim.platformEnvironment.OKOU_REASONING_EFFORT).toBe(
        route.effectiveEffort,
      );
      if (route.pi) {
        expect(next.claim.piModelConfig).toMatchObject({
          thinkingLevel: route.effectiveEffort,
        });
      }
      await expect(
        chat.readThreadMetadata(actor, threadId),
      ).resolves.toMatchObject({
        modelSettings: { [route.model]: { effort: route.effort } },
      });
      await cancelChatRun(actor, startedRunId, next.sandboxHeaders);
    }
  }, 90_000);
});

describe("thread-bound Pi terminal failures", () => {
  it.each([{ status: "failed" }, { status: "cancelled" }] as const)(
    "settles a user-owned automation $status once without Built-in charges",
    async ({ status }) => {
      const { actor, agentId, runnerGroup } = await entitledChatActor();
      await configureSubscriptionPiModel(
        actor,
        { accountId: "terminal-owner" },
        "gpt-6.1-sol",
      );
      mockPiResourceArchiveDownloads();
      mockPiObjectStore();
      let run: { readonly runId: string; readonly threadId: string };
      {
        const workflowId = await createWorkflowsBddApi(context).createWorkflow(
          actor,
          { agentId, name: "pi-terminal" },
        );
        const created = await accept(
          threadPiAutomationsClient().create({
            headers: sessionHeaders(actor),
            params: { workflowId },
            body: { schedule: { type: "loop", intervalSeconds: 3600 } },
          }),
          [201],
        );
        const started = await accept(
          threadPiAutomationsClient().run({
            headers: sessionHeaders(actor),
            params: { id: created.body.id },
          }),
          [201],
        );
        const threadId = started.body.chatThreadId;
        const runId = await lastThreadPiAutomationRun(actor, threadId);
        run = { runId, threadId };
        await flushWaitUntilForTest();
        await api.heartbeatRunner(runnerGroup);
        const claim = await claimGptPiSandbox(actor, runId, undefined);
        const claimed = {
          claim,
          sandboxHeaders: { authorization: `Bearer ${claim.sandboxToken}` },
        };
        expect(claimed.claim.piModelConfig).toMatchObject({
          model: "gpt-6.1-sol",
        });
        if (status === "cancelled") {
          await cancelChatRun(actor, runId, claimed.sandboxHeaders);
        } else {
          await failChatRun(
            runId,
            claimed.sandboxHeaders,
            "subscription rejected",
          );
        }
        await failChatRun(
          runId,
          claimed.sandboxHeaders,
          "duplicate terminal delivery",
        );
      }
      await flushWaitUntilForTest();

      await expectThreadModelCredits(context, actor, run.threadId, 0);
      const events = (await chat.listThreadEvents(actor, run.threadId)).events;
      expect(
        events
          .filter((event) => {
            return (
              event.runId === run.runId &&
              isChatRunTerminalEventType(event.eventType)
            );
          })
          .map((event) => {
            return event.eventType;
          }),
      ).toStrictEqual([`run.${status}`]);
    },
    90_000,
  );
});
