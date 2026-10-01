import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  sendWaitingChatInput,
  cancelChatRun,
} = createChatEventsFixture(context);

async function expectImageGuidance(
  actor: ApiTestUser,
  runId: string,
  model: string,
): Promise<void> {
  const run = await api.readRun(actor, runId);
  expect(run.appendSystemPrompt).toContain(
    `Built-in image generation uses \`${model}\`, from the user's image model setting in Settings › Built-in tools.`,
  );
}

describe("CHAT-02: run image model through public prompts", () => {
  it("keeps a run's image guidance stable and applies member changes to subsequent turns", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "image model comes from the global default",
    });
    await expectImageGuidance(actor, first.runId, "gpt-image-2.5-flare");
    await cancelChatRun(actor, first.runId);

    await chat.updateUserModelPreference(
      actor,
      "claude-fable-5-1",
      "fal-ai/flux-pro/v1.1",
    );
    const second = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "existing thread follows the member image model",
    });
    await expectImageGuidance(actor, second.runId, "flux-pro-1.1");
    await chat.updateUserModelPreference(
      actor,
      "claude-fable-5-1",
      "fal-ai/nano-banana-2",
    );
    await expectImageGuidance(actor, second.runId, "flux-pro-1.1");
    const prompt = (await api.readRun(actor, second.runId)).appendSystemPrompt;
    expect(prompt).toContain(
      "The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    );
    expect(prompt).toContain(
      "Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.\n\n# Restricted Explicit Content",
    );
    await cancelChatRun(actor, second.runId);

    const third = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "next run sees the new image model",
    });
    await expectImageGuidance(actor, third.runId, "nano-banana-2");
    await cancelChatRun(actor, third.runId);
  }, 90_000);

  it("uses the member image model when an organization slot releases", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    await chat.updateUserModelPreference(
      actor,
      "claude-fable-5-1",
      "fal-ai/flux-pro/v1.1",
    );
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    const blocker = await sendChatRun(actor, {
      agentId,
      prompt: "occupy the organization slot",
    });
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      prompt: "queued image model guidance",
    });
    await cancelChatRun(actor, blocker.runId);
    await flushWaitUntilForTest();
    const picked = await waiting.launchedRun();
    expect(
      (await api.readRun(actor, picked.runId)).appendSystemPrompt,
    ).toContain(
      "Built-in image generation uses `flux-pro-1.1`, from the user's image model setting in Settings › Built-in tools.",
    );
    await cancelChatRun(actor, picked.runId);
  }, 90_000);

  it("re-resolves direct session continuation without changing earlier run guidance", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const first = await api.createRun(actor, {
      agentId,
      prompt: "direct image model guidance",
      modelProvider: "anthropic-api-key",
    });
    await expectImageGuidance(actor, first.runId, "gpt-image-2.5-flare");
    await chat.updateUserModelPreference(
      actor,
      "claude-fable-5-1",
      "fal-ai/flux-pro/v1.1",
    );
    const resumed = await api.createRun(actor, {
      agentId,
      sessionId: first.sessionId,
      prompt: "continued session image model guidance",
      modelProvider: "anthropic-api-key",
    });
    expect(resumed.sessionId).toBe(first.sessionId);
    await expectImageGuidance(actor, resumed.runId, "flux-pro-1.1");
    await expectImageGuidance(actor, first.runId, "gpt-image-2.5-flare");
    await cancelChatRun(actor, first.runId);
    await cancelChatRun(actor, resumed.runId);
  }, 90_000);
});
