import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventDisplayText } from "./helpers/chat-event";
import { readCompletedRunSessionId } from "./helpers/public-run-session";
import {
  createChatEventsFixture,
  GPT_PI_BDD_MODELS,
  createGptUsagePricingResolution,
  claimEnvironment,
  eventBackedContents,
  assistantEvent,
  occurrences,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  waitForThreadMessages,
  completeChatRunOk,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
  piSandboxBaseSession,
} = createChatEventsFixture(context);

describe("CHAT-02: personal subscription model selection", () => {
  it("preserves one Pi session while selecting Luna, Sol, Luna, and Luna again", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor);

    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();
    let threadId: string | undefined;
    let sessionId: string | null | undefined;
    const models = [...GPT_PI_BDD_MODELS, "gpt-6-luna"] as const;
    for (const [index, model] of models.entries()) {
      const run = await sendChatRun(
        actor,
        { agentId, threadId, model, prompt: `continue with ${model}` },
        usagePricingResolution,
      );
      threadId = run.threadId;
      await flushWaitUntilForTest();
      const claim = await claimChatRun(runnerGroup, run.runId);
      expect(claim.claim.piModelConfig).toMatchObject({ model });
      if (index === 0) {
        expect(claim.claim.resumeSession).toBeNull();
        expect(claim.claim.piSessionId).toBe(run.threadId);
        expect(claim.claim.piModelConfig).toMatchObject({
          thinkingLevel:
            model === "gpt-6-luna" || model === "gpt-6.1-sol" ? "xhigh" : "max",
        });
        expect(claim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      }
      await completeSandboxFirstPiRun({
        actor,
        run,
        claim,
        historyObjects,
        prompt: `continue with ${model}`,
        answer: `answer ${index + 1}`,
        responsesModel: { provider: "openai", model },
        usagePricingResolution,
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
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const piModel = "gpt-6-luna";
    await configureSubscriptionPiModel(actor, {}, piModel);

    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiCheckpointObjectStore();
    const firstPiAnswer = "first Pi generation answer";
    const returnedPiAnswer = "returned Pi generation answer";
    const repeatedPiAnswer = "repeated Pi generation answer";
    const usagePricingResolution = await createGptUsagePricingResolution();
    const responsesModel = { provider: "openai", model: piModel } as const;

    const firstPiPrompt = "start the first Pi generation";
    const firstPi = await sendChatRun(
      actor,
      { agentId, prompt: firstPiPrompt, model: piModel },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    await completeSandboxFirstPiRun({
      actor,
      run: firstPi,
      claim: await claimChatRun(runnerGroup, firstPi.runId),
      historyObjects,
      prompt: firstPiPrompt,
      answer: firstPiAnswer,
      responsesModel,
      usagePricingResolution,
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
    expect(firstCodexRun.appendSystemPrompt).toContain(
      "# Web Chat Run Context",
    );
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiPrompt);
    expect(firstCodexRun.appendSystemPrompt).toContain(firstPiAnswer);
    const firstCodexClaim = await claimChatRun(runnerGroup, firstCodex.runId);
    expect(firstCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(firstCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(firstCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(firstCodexClaim.claim.resumeSession).toBeNull();
    chatCallbacks.mockChatOutputEvents([assistantEvent(0, firstCodexAnswer)]);
    await completeChatRunOk(firstCodex.runId, firstCodexClaim.sandboxHeaders, {
      cliAgentType: "codex",
      lastEventSequence: 0,
    });
    await flushWaitUntilForTest();

    const returnedPiPrompt = "return to Pi with every visible prior turn";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const returnedPi = await sendChatRun(
      actor,
      {
        agentId,
        threadId: firstPi.threadId,
        prompt: returnedPiPrompt,
        model: piModel,
      },
      usagePricingResolution,
    );
    // A new Pi generation starts from a fresh Sandbox session; prior visible
    // turns travel only through the run context instructions.
    await flushWaitUntilForTest();
    const returnedPiClaim = await claimChatRun(runnerGroup, returnedPi.runId);
    expect(returnedPiClaim.claim.resumeSession).toBeNull();
    expect(returnedPiClaim.claim.prompt).toBe(returnedPiPrompt);
    const returnedPiRun = await api.readRun(actor, returnedPi.runId);
    const returnedPiAppend = returnedPiRun.appendSystemPrompt ?? "";
    expect(returnedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
    ]) {
      expect(occurrences(returnedPiAppend, prior)).toBe(1);
    }
    const returnedPiInstructions =
      returnedPiClaim.claim.appendSystemPrompt ?? "";
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
    ]) {
      expect(occurrences(returnedPiInstructions, prior)).toBe(1);
    }
    await completeSandboxFirstPiRun({
      actor,
      run: returnedPi,
      claim: returnedPiClaim,
      historyObjects,
      prompt: returnedPiPrompt,
      answer: returnedPiAnswer,
      responsesModel,
      usagePricingResolution,
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
    expect(piFollowUpAppend).not.toContain("# Web Chat Run Context");
    expect(piFollowUpAppend).not.toContain(firstPiPrompt);
    expect(piFollowUpAppend).not.toContain(firstCodexPrompt);
    const piFollowUpClaim = await claimChatRun(runnerGroup, piFollowUp.runId);
    const resumedPiSession = piFollowUpClaim.claim.resumeSession;
    if (!resumedPiSession || !("historyRef" in resumedPiSession)) {
      throw new Error("Expected the Pi follow-up to resume a blob checkpoint");
    }
    expect(resumedPiSession).toMatchObject({
      sessionId: firstPi.threadId,
      historyRef: {
        kind: "blob",
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(piFollowUpClaim.claim.piSessionId).toBe(firstPi.threadId);
    expect(piFollowUpClaim.claim.piLaunchConfig).toMatchObject({
      schemaVersion: 2,
    });
    expect(
      MemoryPiSession.fromJsonl(
        piSandboxBaseSession(piFollowUpClaim.claim, historyObjects).toString(
          "utf8",
        ),
      ).getSessionId(),
    ).toBe(firstPi.threadId);
    await cancelChatRun(
      actor,
      piFollowUp.runId,
      piFollowUpClaim.sandboxHeaders,
    );

    const repeatedCodexPrompt = "cross Codex before returning to Pi again";
    const repeatedCodexAnswer = "second intervening Codex answer";
    const repeatedCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const repeatedCodexClaim = await claimChatRun(
      runnerGroup,
      repeatedCodex.runId,
    );
    expect(repeatedCodexClaim.claim.cliAgentType).toBe("codex");
    expect(
      claimEnvironment(repeatedCodexClaim.claim).OKOU_CODEX_SERVICE_TIER,
    ).toBe("fast");
    expect(repeatedCodexClaim.claim.piLaunchConfig).toBeUndefined();
    expect(repeatedCodexClaim.claim.resumeSession).toBeNull();
    const repeatedCodexRun = await api.readRun(actor, repeatedCodex.runId);
    expect(repeatedCodexRun.appendSystemPrompt).toContain(piFollowUpPrompt);
    expect(repeatedCodexRun.appendSystemPrompt).toContain("Run cancelled");
    chatCallbacks.mockChatOutputEvents([
      assistantEvent(0, repeatedCodexAnswer),
    ]);
    await completeChatRunOk(
      repeatedCodex.runId,
      repeatedCodexClaim.sandboxHeaders,
      { cliAgentType: "codex", lastEventSequence: 0 },
    );
    await flushWaitUntilForTest();

    const repeatedPiPrompt = "return to a third Pi generation";
    await chat.updateThreadModelSelection(actor, firstPi.threadId, piModel, {
      codexServiceTier: null,
    });
    const repeatedPi = await sendChatRun(
      actor,
      {
        agentId,
        threadId: firstPi.threadId,
        prompt: repeatedPiPrompt,
        model: piModel,
      },
      usagePricingResolution,
    );
    await flushWaitUntilForTest();
    const repeatedPiClaim = await claimChatRun(runnerGroup, repeatedPi.runId);
    expect(repeatedPiClaim.claim.resumeSession).toBeNull();
    expect(repeatedPiClaim.claim.prompt).toBe(repeatedPiPrompt);
    const repeatedPiRun = await api.readRun(actor, repeatedPi.runId);
    const repeatedPiAppend = repeatedPiRun.appendSystemPrompt ?? "";
    expect(repeatedPiAppend).toContain("# Web Chat Run Context");
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
    ]) {
      expect(occurrences(repeatedPiAppend, prior)).toBe(1);
    }
    const repeatedPiInstructions =
      repeatedPiClaim.claim.appendSystemPrompt ?? "";
    for (const prior of [
      firstPiPrompt,
      firstPiAnswer,
      firstCodexPrompt,
      firstCodexAnswer,
      returnedPiPrompt,
      returnedPiAnswer,
      piFollowUpPrompt,
      "Run cancelled",
      repeatedCodexPrompt,
      repeatedCodexAnswer,
    ]) {
      expect(occurrences(repeatedPiInstructions, prior)).toBe(1);
    }
    await completeSandboxFirstPiRun({
      actor,
      run: repeatedPi,
      claim: repeatedPiClaim,
      historyObjects,
      prompt: repeatedPiPrompt,
      answer: repeatedPiAnswer,
      responsesModel,
      usagePricingResolution,
    });

    for (const completed of [
      firstPi,
      firstCodex,
      returnedPi,
      repeatedCodex,
      repeatedPi,
    ]) {
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
