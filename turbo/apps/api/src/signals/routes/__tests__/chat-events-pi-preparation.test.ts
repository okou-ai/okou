import { publicChatActor } from "./helpers/public-chat-actor";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const { api, configureSubscriptionPiModel, cancelChatRun, mockPiObjectStore } =
  createChatEventsFixture(context);

describe("CHAT-02: model-first routing", () => {
  it("launches an at-capacity Pi send on a fresh session once a slot frees", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
      sendWaitingChatInput,
    } = await publicChatActor(context);
    await own(async () => {
      return await api.heartbeatRunner(runnerGroup);
    });
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
    await own(async () => {
      return await api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const anchor = await sendChatRun(actor, {
      agentId,
      prompt: "hold admission capacity",
      model: "claude-fable-5-1",
    });
    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    });
    mockPiObjectStore();
    const prompt = "keep the complete admission independent";
    const waiting = await sendWaitingChatInput(actor, {
      agentId,
      prompt,
      model: "gpt-6-luna",
    });
    await own(async () => {
      return await cancelChatRun(actor, anchor.runId);
    });
    const run = await waiting.launchedRun();
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(claimed.claim.prompt).toBe(prompt);

    expect(claimed.claim.piSessionId).toBe(run.threadId);
    expect(claimed.claim.piLaunchConfig).toMatchObject({ schemaVersion: 2 });
    await own(async () => {
      return await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    });
  }, 30_000);
});
