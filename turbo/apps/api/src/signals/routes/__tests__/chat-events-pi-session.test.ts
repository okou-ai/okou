import { publicChatActor } from "./helpers/public-chat-actor";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventDisplayText } from "./helpers/chat-event";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  createChatEventsFixture,
  GPT_PI_BDD_MODELS,
  executionEnvironment,
  eventBackedContents,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  configureSubscriptionPiModel,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  mockPiObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

describe("CHAT-02: personal subscription model selection", () => {
  it("preserves one Pi session while selecting Luna, Sol, Luna, and Luna again", async () => {
    const {
      run: own,
      actor,
      agentId,
      runExecution,
      sendChatRun,
    } = await publicChatActor(context);
    await own(async () => {
      return await configureSubscriptionPiModel(actor);
    });

    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    let threadId: string | undefined;
    let sessionId: string | null | undefined;
    const models = [...GPT_PI_BDD_MODELS, "gpt-6-luna"] as const;
    for (const [index, model] of models.entries()) {
      const run = await sendChatRun(actor, {
        agentId,
        threadId,
        model,
        prompt: `continue with ${model}`,
      });
      threadId = run.threadId;
      await flushWaitUntilForTest();
      const execution = await runExecution(run.runId);
      expect(execution.execution.piModelConfig).toMatchObject({ model });
      if (index === 0) {
        expect(execution.execution.piSessionId).toBe(run.threadId);
        expect(execution.execution.piModelConfig).toMatchObject({
          thinkingLevel:
            model === "gpt-6-luna" || model === "gpt-6.1-sol" ? "xhigh" : "max",
        });
        expect(execution.execution.piModelConfig).not.toHaveProperty(
          "serviceTier",
        );
      }
      await own(async () => {
        return await completeSandboxFirstPiRun({
          actor,
          run,
          execution,
          historyObjects,
          prompt: `continue with ${model}`,
          answer: `answer ${index + 1}`,
          responsesModel: { provider: "openai", model },
        });
      });
      const session = await readCompletedRunSessionId(
        context,
        actor,
        run.runId,
      );
      if (sessionId === undefined) {
        sessionId = session;
        expect(sessionId).toStrictEqual(expect.any(String));
      }
      expect(session).toBe(sessionId);
    }
  }, 90_000);

  it("preserves generations across Luna Pi and fast Astra Codex boundaries", async () => {
    const {
      run: own,
      actor,
      agentId,
      runExecution,
      sendChatRun,
    } = await publicChatActor(context);
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const piModel = "gpt-6-luna";
    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, piModel);
    });

    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const firstPiAnswer = "first Pi generation answer";
    const returnedPiAnswer = "returned Pi generation answer";
    const repeatedPiAnswer = "repeated Pi generation answer";
    const responsesModel = { provider: "openai", model: piModel } as const;

    const firstPiPrompt = "start the first Pi generation";
    const firstPi = await sendChatRun(actor, {
      agentId,
      prompt: firstPiPrompt,
      model: piModel,
    });
    await flushWaitUntilForTest();
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: firstPi,
        execution: await runExecution(firstPi.runId),
        historyObjects,
        prompt: firstPiPrompt,
        answer: firstPiAnswer,
        responsesModel,
      });
    });
    const firstSessionId = await readCompletedRunSessionId(
      context,
      actor,
      firstPi.runId,
    );

    const firstCodexPrompt = "continue through Codex between Pi generations";
    const firstCodexAnswer = "Codex answer between Pi generations";
    const firstCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: firstCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstCodexRun = await api.readRun(actor, firstCodex.runId);
    expect(firstCodexRun.appendSystemPrompt).not.toContain(firstPiPrompt);
    expect(firstCodexRun.appendSystemPrompt).not.toContain(firstPiAnswer);
    const firstCodexExecution = await runExecution(firstCodex.runId);
    expect(firstCodexExecution.execution.cliAgentType).toBe("codex");
    expect(
      executionEnvironment(firstCodexExecution.execution)
        .OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(firstCodexExecution.execution.piLaunchConfig).toBeUndefined();

    expect(firstCodexExecution.execution.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
    });
    expect(
      firstCodexExecution.execution.nativeContinuation?.recoveryPrompt,
    ).toContain("okou chat messages --output-dir /tmp/okou-chat-history");
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstCodexAnswer)]);
    await own(async () => {
      return await completeChatRunOk(
        firstCodex.runId,
        firstCodexExecution.sandboxHeaders,
        {
          cliAgentType: "codex",
          lastEventSequence: 0,
        },
      );
    });
    await flushWaitUntilForTest();

    const returnedPiPrompt = "return to Pi with every visible prior turn";
    await own(async () => {
      return await chat.updateThreadModelSelection(
        actor,
        firstPi.threadId,
        piModel,
        {
          codexServiceTier: null,
        },
      );
    });
    const returnedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: returnedPiPrompt,
      model: piModel,
    });
    await flushWaitUntilForTest();
    const returnedPiExecution = await runExecution(returnedPi.runId);

    expect(returnedPiExecution.execution.prompt).toBe(returnedPiPrompt);
    expect(returnedPiExecution.execution.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
    });
    expect(
      returnedPiExecution.execution.nativeContinuation?.recoveryPrompt,
    ).toContain("okou chat messages --output-dir /tmp/okou-chat-history");
    const returnedPiRun = await api.readRun(actor, returnedPi.runId);
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
    ]) {
      expect(returnedPiRun.appendSystemPrompt).not.toContain(prior);
      expect(returnedPiExecution.execution.appendSystemPrompt).not.toContain(
        prior,
      );
    }
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: returnedPi,
        execution: returnedPiExecution,
        historyObjects,
        prompt: returnedPiPrompt,
        answer: returnedPiAnswer,
        responsesModel,
      });
    });

    const piFollowUpPrompt = "resume the returned Pi generation once";
    const piFollowUp = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: piFollowUpPrompt,
      model: piModel,
    });
    await flushWaitUntilForTest();
    const piFollowUpRun = await api.readRun(actor, piFollowUp.runId);
    const piFollowUpAppend = piFollowUpRun.appendSystemPrompt ?? "";
    expect(piFollowUpAppend).not.toContain(firstPiPrompt);
    expect(piFollowUpAppend).not.toContain(firstCodexPrompt);
    const piFollowUpExecution = await runExecution(piFollowUp.runId);

    expect(piFollowUpExecution.execution.nativeContinuation).toMatchObject({
      sessionId: firstPi.threadId,
      generationRunId: returnedPi.runId,
    });
    expect(piFollowUpExecution.execution.piSessionId).toBe(firstPi.threadId);
    expect(piFollowUpExecution.execution.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
    });
    await own(async () => {
      return await cancelChatRun(
        actor,
        piFollowUp.runId,
        piFollowUpExecution.sandboxHeaders,
      );
    });

    const repeatedCodexPrompt = "cross Codex before returning to Pi again";
    const repeatedCodexAnswer = "second intervening Codex answer";
    const repeatedCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const repeatedCodexExecution = await runExecution(repeatedCodex.runId);
    expect(repeatedCodexExecution.execution.cliAgentType).toBe("codex");
    expect(
      executionEnvironment(repeatedCodexExecution.execution)
        .OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(repeatedCodexExecution.execution.piLaunchConfig).toBeUndefined();

    const repeatedCodexRun = await api.readRun(actor, repeatedCodex.runId);
    expect(repeatedCodexRun.appendSystemPrompt).toContain(piFollowUpPrompt);
    expect(repeatedCodexRun.appendSystemPrompt).toContain("Run cancelled");
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, repeatedCodexAnswer),
    ]);
    await own(async () => {
      return await completeChatRunOk(
        repeatedCodex.runId,
        repeatedCodexExecution.sandboxHeaders,
        { cliAgentType: "codex", lastEventSequence: 0 },
      );
    });
    await flushWaitUntilForTest();

    const repeatedPiPrompt = "return to a third Pi generation";
    await own(async () => {
      return await chat.updateThreadModelSelection(
        actor,
        firstPi.threadId,
        piModel,
        {
          codexServiceTier: null,
        },
      );
    });
    const repeatedPi = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedPiPrompt,
      model: piModel,
    });
    await flushWaitUntilForTest();
    const repeatedPiExecution = await runExecution(repeatedPi.runId);

    expect(repeatedPiExecution.execution.prompt).toBe(repeatedPiPrompt);
    const repeatedPiRun = await api.readRun(actor, repeatedPi.runId);
    const repeatedPiAppend = repeatedPiRun.appendSystemPrompt ?? "";
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      repeatedCodexPrompt,
      repeatedCodexAnswer,
    ]) {
      expect(repeatedPiAppend).not.toContain(prior);
      expect(repeatedPiExecution.execution.appendSystemPrompt).not.toContain(
        prior,
      );
    }
    expect(repeatedPiAppend).not.toContain(piFollowUpPrompt);
    expect(repeatedPiExecution.execution.nativeContinuation).toMatchObject({
      sessionId: null,
      generationRunId: null,
    });
    expect(
      repeatedPiExecution.execution.nativeContinuation?.recoveryPrompt,
    ).toContain("okou chat messages --output-dir /tmp/okou-chat-history");
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: repeatedPi,
        execution: repeatedPiExecution,
        historyObjects,
        prompt: repeatedPiPrompt,
        answer: repeatedPiAnswer,
        responsesModel,
      });
    });

    for (const completed of [firstPi, returnedPi, repeatedPi]) {
      await expect(
        readCompletedRunSessionId(context, actor, completed.runId),
      ).resolves.toBe(firstSessionId);
    }

    const visibleTurns = [
      { runId: firstPi.runId, prompt: firstPiPrompt, answer: firstPiAnswer },
      {
        runId: firstCodex.runId,
        prompt: firstCodexPrompt,
        answer: firstCodexAnswer,
      },
      {
        runId: returnedPi.runId,
        prompt: returnedPiPrompt,
        answer: returnedPiAnswer,
      },
      {
        runId: piFollowUp.runId,
        prompt: piFollowUpPrompt,
      },
      {
        runId: repeatedCodex.runId,
        prompt: repeatedCodexPrompt,
        answer: repeatedCodexAnswer,
      },
      {
        runId: repeatedPi.runId,
        prompt: repeatedPiPrompt,
        answer: repeatedPiAnswer,
      },
    ];
    const finalEvents = await waitForThreadMessages(
      actor,
      firstPi.threadId,
      (events) => {
        return eventBackedContents(events, repeatedPi.runId).some((event) => {
          return event.content === repeatedPiAnswer;
        });
      },
    );
    const allRunIds = new Set(
      visibleTurns.map((turn) => {
        return turn.runId;
      }),
    );
    expect(
      finalEvents.events
        .filter((event) => {
          return (
            event.runId !== undefined &&
            event.runId !== null &&
            allRunIds.has(event.runId) &&
            (event.eventType === "input.prompt" ||
              event.eventType === "output.message")
          );
        })
        .map((event) => {
          return {
            runId: event.runId,
            eventType: event.eventType,
            content: chatEventDisplayText(event),
          };
        }),
    ).toStrictEqual(
      visibleTurns.flatMap((turn) => {
        return [
          {
            runId: turn.runId,
            eventType: "input.prompt",
            content: turn.prompt,
          },
          ...(turn.answer === undefined
            ? []
            : [
                {
                  runId: turn.runId,
                  eventType: "output.message",
                  content: turn.answer,
                },
              ]),
        ];
      }),
    );
    await expect(api.readRun(actor, firstPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, firstCodex.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, returnedPi.runId)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(api.readRun(actor, piFollowUp.runId)).resolves.toMatchObject({
      status: "cancelled",
    });
  }, 90_000);
});
