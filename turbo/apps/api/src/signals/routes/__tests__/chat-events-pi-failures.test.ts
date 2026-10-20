import { publicChatActor } from "./helpers/public-chat-actor";
import { expectThreadModelCredits } from "./helpers/public-thread-usage";
import { randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  configureSubscriptionPiModel,
  cancelChatRun,
  mockPiObjectStore,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

function blobEntriesOf(objects: ReadonlyMap<string, Buffer>) {
  return [...objects.entries()].filter(([key]) => {
    return key.includes("/blobs/");
  });
}

describe("CHAT-02: model-first routing", () => {
  it("continues an ordinary Pi stop through retained home without uploading an archive", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
    } = await publicChatActor(context);
    await own(async () => {
      return await configureSubscriptionPiModel(actor, {}, "gpt-6-luna");
    });

    const objects = mockPiObjectStore();
    const answer = "the last complete canonical answer";
    const firstPrompt = "create the last complete history";
    const first = await sendChatRun(actor, {
      agentId,
      model: "gpt-6-luna",
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    // The first turn has no stored history, so the Sandbox starts fresh.

    expect(firstClaim.claim.piSessionId).toBe(first.threadId);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer,
        historyObjects: objects,
        claim: firstClaim,
        prompt: firstPrompt,
        run: first,
      });
    });
    expect(blobEntriesOf(objects)).toStrictEqual([]);

    const resumed = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      prompt: "continue the preserved canonical session with tools",
    });
    const claimed = await claimChatRun(runnerGroup, resumed.runId);

    expect(claimed.claim.nativeContinuation).toMatchObject({
      sessionId: first.threadId,
      generationRunId: first.runId,
    });
    expect(claimed.claim.appendSystemPrompt).not.toContain(answer);
    await own(async () => {
      return await cancelChatRun(actor, resumed.runId, claimed.sandboxHeaders);
    });
    expect(blobEntriesOf(objects)).toStrictEqual([]);
  }, 90_000);

  it("preserves native subscription continuity and active input without a history transfer", async () => {
    const {
      run: own,
      actor,
      agentId,
      runnerGroup,
      claimChatRun,
      sendChatRun,
      requestSendEvent,
    } = await publicChatActor(context);
    await own(async () => {
      return await configureSubscriptionPiModel(actor, {
        accountId: "model-handoff-account",
      });
    });
    const historyObjects = mockPiObjectStore();
    const firstPrompt = "establish original subscription history";
    const first = await sendChatRun(actor, {
      agentId,
      model: "gpt-6-luna",
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await own(async () => {
      return await completeSandboxFirstPiRun({
        actor,
        answer: "previous settled subscription answer",
        historyObjects,
        claim: firstClaim,
        prompt: firstPrompt,
        responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
        run: first,
      });
    });
    const prompt = "resume from the settled subscription H0";
    const run = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      model: "gpt-6-luna",
      prompt,
    });
    const { claim } = await claimChatRun(runnerGroup, run.runId);
    const activeInputEventId = randomUUID();
    await requestSendEvent(
      actor,
      {
        agentId,
        threadId: run.threadId,
        prompt: "preserve this in-flight active input",
        clientEventId: activeInputEventId,
      },
      [201],
    );
    const steerable = await api.nextSteerableInput(
      claim.sandboxToken,
      run.runId,
    );
    expect(steerable).toStrictEqual({
      input: {
        eventId: activeInputEventId,
        prompt: "preserve this in-flight active input",
      },
    });
    expect(claim.prompt).toBe(prompt);

    expect(claim.nativeContinuation).toMatchObject({
      sessionId: first.threadId,
      generationRunId: first.runId,
    });
    expect(claim.appendSystemPrompt).not.toContain(
      "previous settled subscription answer",
    );
    expect(blobEntriesOf(historyObjects)).toStrictEqual([]);
    await expect(
      api.nextSteerableInput(claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(steerable);
    await expect(
      api.declareSteeredInput(
        claim.sandboxToken,
        run.runId,
        activeInputEventId,
      ),
    ).resolves.toStrictEqual({ outcome: "steered" });
    const events = (await chat.listThreadEvents(actor, run.threadId)).events;
    expect(
      events.filter((event) => {
        return event.revokesEventId === activeInputEventId;
      }),
    ).toHaveLength(1);
    expect(
      events.filter((event) => {
        return (
          event.runId === run.runId &&
          isChatRunTerminalEventType(event.eventType)
        );
      }),
    ).toStrictEqual([]);
    await expectThreadModelCredits(context, actor, run.threadId, 0);
    await own(async () => {
      return await cancelChatRun(actor, run.runId, {
        authorization: `Bearer ${claim.sandboxToken}`,
      });
    });
  }, 90_000);
});
