import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { readCompletedRunSessionId } from "./helpers/public-run-session";

const context = testContext();
const {
  api,
  mockPiObjectStore,
  mockPiResourceArchiveDownloads,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

describe("Auto native routing", () => {
  it("claims the OpenRouter preset for a completed initial run and its successor", async () => {
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context);
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const preset = "@preset/okou-1-0";
    const expectedClaim = {
      cliAgentType: "pi",
      piModelConfig: {
        baseUrl: "https://openrouter.ai/api/v1",
        model: preset,
      },
      modelUsageProvider: preset,
    };
    const expectedSource = {
      providerType: "built-in",
      runtimeProviderType: "openrouter-codex",
      model: "auto",
      credentialScope: "org",
    };

    const initialPrompt = "start with Auto";
    const initial = await sendChatRun(actor, {
      agentId,
      prompt: initialPrompt,
      model: "auto",
    });
    await flushWaitUntilForTest();
    const initialClaim = await claimChatRun(runnerGroup, initial.runId);
    expect(initialClaim.claim).toMatchObject(expectedClaim);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: initial,
        claim: initialClaim,
        historyObjects,
        prompt: initialPrompt,
        answer: "initial Auto answer",
        responsesModel: { provider: "openrouter", model: preset },
      });
    });
    await expect(api.readRun(actor, initial.runId)).resolves.toMatchObject({
      status: "completed",
      source: expectedSource,
    });
    const initialSession = await readCompletedRunSessionId(
      context,
      actor,
      initial.runId,
    );

    const successorPrompt = "continue without selecting another model";
    const successor = await sendChatRun(actor, {
      agentId,
      threadId: initial.threadId,
      prompt: successorPrompt,
    });
    expect(successor.runId).not.toBe(initial.runId);
    expect(successor.threadId).toBe(initial.threadId);
    await flushWaitUntilForTest();
    const successorClaim = await claimChatRun(runnerGroup, successor.runId);
    expect(successorClaim.claim).toMatchObject(expectedClaim);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: successor,
        claim: successorClaim,
        historyObjects,
        prompt: successorPrompt,
        answer: "continued Auto answer",
        responsesModel: { provider: "openrouter", model: preset },
      });
    });
    await expect(api.readRun(actor, successor.runId)).resolves.toMatchObject({
      status: "completed",
      source: expectedSource,
    });
    await expect(
      readCompletedRunSessionId(context, actor, successor.runId),
    ).resolves.toBe(initialSession);
  }, 90_000);
});
