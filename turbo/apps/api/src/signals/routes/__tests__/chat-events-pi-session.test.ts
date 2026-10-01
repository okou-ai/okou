import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventDisplayText } from "./helpers/chat-event";
import {
  assistantEvent,
  claimEnvironment,
  createChatEventsFixture,
  createGptUsagePricingResolution,
  eventBackedContents,
  GPT_PI_BDD_MODELS,
  occurrences,
} from "./helpers/chat-events-fixture";
import {
  readThreadSessionBinding,
  readThreadSessionConversation,
} from "./helpers/runtime-state";

const context = testContext();
const {
  api,
  chat,
  chatCallbacks,
  entitledChatActor,
  seedBuiltInModelKey,
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

describe("CHAT-02: model-first provider policies", () => {
  it("preserves one Pi session while selecting Luna, Sol, Luna, and Luna again", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    for (const model of GPT_PI_BDD_MODELS) {
      await seedBuiltInModelKey(model);
    }
    await api.updateOrgModelPolicies(
      actor,
      GPT_PI_BDD_MODELS.map((model) => {
        return {
          model,
          preferred: model === "gpt-6-luna",
          defaultProviderType: "built-in",
          credentialScope: "org",
          modelProviderId: null,
        };
      }),
    );

    const usagePricingResolution = await createGptUsagePricingResolution();
    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
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
          thinkingLevel: "max",
        });
        expect(claim.claim.piModelConfig).not.toHaveProperty("serviceTier");
      }
      await completeSandboxFirstPiRun({
        actor,
        run,
        claim,
        checkpointObjects,
        prompt: `continue with ${model}`,
        answer: `answer ${index + 1}`,
        responsesModel: { provider: "openai", model },
        usagePricingResolution,
      });
      const session = await readThreadSessionConversation(context, threadId);
      if (sessionId === undefined) {
        sessionId = session.agent_session_id;
        expect(sessionId).toStrictEqual(expect.any(String));
      }
      expect(session.agent_session_id).toBe(sessionId);
    }
  }, 90_000);

  it("preserves generations across Luna Pi and fast Astra Codex boundaries", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected entitled chat actor to have an org");
    }
    const piModel = "gpt-6-luna";
    await seedBuiltInModelKey(piModel);
    await seedBuiltInModelKey("gpt-6-astra");
    await api.updateOrgModelPolicies(actor, [
      {
        model: piModel,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
      {
        model: "gpt-6-astra",
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);

    mockPiResourceArchiveDownloads();
    const checkpointObjects = mockPiCheckpointObjectStore();
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
      checkpointObjects,
      prompt: firstPiPrompt,
      answer: firstPiAnswer,
      responsesModel,
      usagePricingResolution,
    });
    const firstPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!firstPiBinding.agent_session_id) {
      throw new Error("Expected the first Pi run to bind a canonical session");
    }
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: firstPi.runId });

    const firstCodexPrompt = "continue through Codex between Pi generations";
    const firstCodexAnswer = "Codex answer between Pi generations";
    const firstCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: firstCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const firstCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(firstCodexBinding.agent_session_id).toBe(
      firstPiBinding.agent_session_id,
    );
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
    const returnedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    if (!returnedPiBinding.agent_session_id) {
      throw new Error(
        "Expected the returned Pi run to retain its application session",
      );
    }
    expect(returnedPiBinding.agent_session_id).toBe(
      firstCodexBinding.agent_session_id,
    );
    expect(returnedPiBinding.agent_session_id).toBe(
      firstPiBinding.agent_session_id,
    );
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
      checkpointObjects,
      prompt: returnedPiPrompt,
      answer: returnedPiAnswer,
      responsesModel,
      usagePricingResolution,
    });
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: returnedPiBinding.agent_session_id,
      conversation_run_id: returnedPi.runId,
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
    const piFollowUpBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(piFollowUpBinding.agent_session_id).toBe(
      returnedPiBinding.agent_session_id,
    );
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
        piSandboxBaseSession(piFollowUpClaim.claim, checkpointObjects).toString(
          "utf8",
        ),
      ).getSessionId(),
    ).toBe(firstPi.threadId);
    await cancelChatRun(
      actor,
      piFollowUp.runId,
      piFollowUpClaim.sandboxHeaders,
    );
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({ conversation_run_id: returnedPi.runId });

    const repeatedCodexPrompt = "cross Codex before returning to Pi again";
    const repeatedCodexAnswer = "second intervening Codex answer";
    const repeatedCodex = await sendChatRun(actor, {
      agentId,
      threadId: firstPi.threadId,
      prompt: repeatedCodexPrompt,
      model: "gpt-6-astra",
      runOptions: { codexServiceTier: "fast" },
    });
    const repeatedCodexBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedCodexBinding.agent_session_id).toBe(
      returnedPiBinding.agent_session_id,
    );
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
    const repeatedPiBinding = await readThreadSessionBinding(
      context,
      firstPi.threadId,
    );
    expect(repeatedPiBinding.agent_session_id).toBe(
      repeatedCodexBinding.agent_session_id,
    );
    expect(repeatedPiBinding.agent_session_id).toBe(
      returnedPiBinding.agent_session_id,
    );
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
      checkpointObjects,
      prompt: repeatedPiPrompt,
      answer: repeatedPiAnswer,
      responsesModel,
      usagePricingResolution,
    });
    await expect(
      readThreadSessionConversation(context, firstPi.threadId),
    ).resolves.toMatchObject({
      agent_session_id: repeatedPiBinding.agent_session_id,
      conversation_run_id: repeatedPi.runId,
    });

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
