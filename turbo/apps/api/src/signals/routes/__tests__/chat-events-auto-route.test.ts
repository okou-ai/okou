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
      run: own,
      sendChatRun,
      runExecution,
    } = await publicChatActor(context);
    mockPiResourceArchiveDownloads();
    const historyObjects = mockPiObjectStore();
    const preset = "@preset/okou-1-0";
    const expectedExecution = {
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
    const initialExecution = await runExecution(initial.runId);
    expect(initialExecution.execution).toMatchObject(expectedExecution);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: initial,
        execution: initialExecution,
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
    const successorExecution = await runExecution(successor.runId);
    expect(successorExecution.execution).toMatchObject(expectedExecution);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        run: successor,
        execution: successorExecution,
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
