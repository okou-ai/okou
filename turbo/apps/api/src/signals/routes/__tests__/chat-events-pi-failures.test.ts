import { createHash, randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import {
  createChatEventsFixture,
  expectNoBuiltInModelUsage,
  createGptUsagePricingResolution,
} from "./helpers/chat-events-fixture";

const context = testContext();
const {
  api,
  chat,
  entitledChatActor,
  configureBuiltInPiModel,
  configureSubscriptionPiModel,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  mockPiCheckpointObjectStore,
  piSandboxBaseSession,
  completeSandboxFirstPiRun,
} = createChatEventsFixture(context);

function blobEntriesOf(objects: ReadonlyMap<string, Buffer>) {
  return [...objects.entries()].filter(([key]) => {
    return key.includes("/blobs/");
  });
}

describe("CHAT-02: model-first provider policies", () => {
  it("preserves an ordinary Pi stop checkpoint for referenced Sandbox continuation", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    const usagePricingResolution = await createGptUsagePricingResolution();
    await configureBuiltInPiModel(actor, "gpt-6-luna");

    const objects = mockPiCheckpointObjectStore();
    const answer = "the last complete canonical answer";
    const firstPrompt = "create the last complete checkpoint";
    const first = await sendChatRun(
      actor,
      {
        agentId,
        model: "gpt-6-luna",
        prompt: firstPrompt,
      },
      usagePricingResolution,
    );
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    // The first turn has no stored history, so the Sandbox starts fresh.
    expect(firstClaim.claim.resumeSession).toBeNull();
    expect(firstClaim.claim.piSessionId).toBe(first.threadId);
    await completeSandboxFirstPiRun({
      actor,
      answer,
      checkpointObjects: objects,
      claim: firstClaim,
      prompt: firstPrompt,
      run: first,
      usagePricingResolution,
    });
    const blobEntries = blobEntriesOf(objects);
    expect(blobEntries).toHaveLength(1);
    const h0 = blobEntries[0]?.[1];
    if (!h0) {
      throw new Error("Expected the ordinary stop checkpoint");
    }
    expect(h0.toString("utf8")).toContain(answer);
    const h0Hash = createHash("sha256").update(h0).digest("hex");

    const resumed = await sendChatRun(
      actor,
      {
        agentId,
        threadId: first.threadId,
        prompt: "continue the preserved canonical session with tools",
      },
      usagePricingResolution,
    );
    const claimed = await claimChatRun(runnerGroup, resumed.runId);
    const resumeSession = claimed.claim.resumeSession;
    expect(resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { kind: "blob", hash: h0Hash, rawSize: h0.length },
    });
    if (!resumeSession || !("historyRef" in resumeSession)) {
      throw new Error("Expected a referenced resume history");
    }
    expect(
      new URL(resumeSession.historyRef.url).searchParams.get("object"),
    ).toBe(`${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h0Hash}.blob`);
    expect(piSandboxBaseSession(claimed.claim, objects)).toStrictEqual(h0);
    await cancelChatRun(actor, resumed.runId, claimed.sandboxHeaders);
    expect(blobEntriesOf(objects)).toStrictEqual(blobEntries);
  }, 90_000);

  it("preserves subscription H0 and active input during referenced Sandbox transfer", async () => {
    const { actor, agentId, runnerGroup } = await entitledChatActor();
    await configureSubscriptionPiModel(actor, {
      accountId: "model-handoff-account",
    });
    const usagePricingResolution = await createGptUsagePricingResolution();
    const checkpointObjects = mockPiCheckpointObjectStore();
    const firstPrompt = "establish original subscription history";
    const first = await sendChatRun(actor, {
      agentId,
      model: "gpt-6-luna",
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await completeSandboxFirstPiRun({
      actor,
      answer: "previous settled subscription answer",
      checkpointObjects,
      claim: firstClaim,
      prompt: firstPrompt,
      responsesModel: { provider: "openai-codex", model: "gpt-6-luna" },
      run: first,
      usagePricingResolution,
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
    await chat.requestSendEvent(
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
    expect(claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { kind: "blob", hash: expect.any(String) },
    });
    const h0 = piSandboxBaseSession(claim, checkpointObjects).toString("utf8");
    expect(h0).toContain("previous settled subscription answer");
    expect(h0).not.toContain(prompt);
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
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
    await expectNoBuiltInModelUsage(run.runId);
    await cancelChatRun(actor, run.runId, {
      authorization: `Bearer ${claim.sandboxToken}`,
    });
  }, 90_000);
});
