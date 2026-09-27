import { createHash, randomUUID } from "node:crypto";
import { isChatRunTerminalEventType } from "@okouai/api-contracts/contracts/chat-events";
import { MemoryPiSession } from "@okouai/pi-agent-runtime/node";
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
  expectPiSandboxHandoff,
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
    await configureBuiltInPiModel(actor, "gpt-5.6-terra");

    const objects = mockPiCheckpointObjectStore();
    const answer = "the last complete canonical answer";
    const firstPrompt = "create the last complete checkpoint";
    const first = await sendChatRun(
      actor,
      {
        agentId,
        model: "gpt-5.6-terra",
        prompt: firstPrompt,
      },
      usagePricingResolution,
    );
    // Run creation hands the first turn to the Sandbox without inference.
    const firstHandoff = expectPiSandboxHandoff(first.runId, objects);
    expect(firstHandoff.manifest).toMatchObject({
      schemaVersion: 3,
      baseSession: { sessionId: first.threadId, sha256: null },
      sandboxEventSequenceStart: 1,
    });
    if (!firstHandoff.session) {
      throw new Error("Expected the first-turn Pi session object");
    }
    expect(
      MemoryPiSession.fromJsonl(
        firstHandoff.session.toString("utf8"),
      ).buildSessionContext().messages,
    ).toStrictEqual([]);
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
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
    const { manifest, session } = expectPiSandboxHandoff(
      resumed.runId,
      objects,
    );
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      baseSession: { sessionId: first.threadId, sha256: h0Hash },
      session: { sessionId: first.threadId, sha256: h0Hash },
    });
    if (manifest.schemaVersion !== 4) {
      throw new Error("Expected v4 history reference");
    }
    expect(session).toBeUndefined();
    const objectKey = new URL(manifest.history.url).searchParams.get("object");
    expect(objectKey).toBe(
      `${env("R2_USER_STORAGES_BUCKET_NAME")}/blobs/${h0Hash}.blob`,
    );
    expect(objects.get(objectKey ?? "")).toStrictEqual(h0);
    expect(
      objects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${resumed.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    const claimed = await claimChatRun(runnerGroup, resumed.runId);
    expect(claimed.claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: h0Hash },
    });
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
      model: "gpt-5.6-terra",
      prompt: firstPrompt,
    });
    const firstClaim = await claimChatRun(runnerGroup, first.runId);
    await completeSandboxFirstPiRun({
      actor,
      answer: "previous settled subscription answer",
      checkpointObjects,
      claim: firstClaim,
      prompt: firstPrompt,
      responsesModel: { provider: "openai-codex", model: "gpt-5.6-terra" },
      run: first,
      usagePricingResolution,
    });
    const prompt = "resume from the settled subscription H0";
    const run = await sendChatRun(actor, {
      agentId,
      threadId: first.threadId,
      model: "gpt-5.6-terra",
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
    const reserved = await api.reserveRunnerActiveInputs(
      claim.sandboxToken,
      run.runId,
    );
    if (reserved.outcome !== "reserved") {
      throw new Error("Expected one reserved active input");
    }
    const { manifest } = expectPiSandboxHandoff(run.runId, checkpointObjects);
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      baseSession: { sessionId: first.threadId, sha256: expect.any(String) },
      session: { sessionId: first.threadId, sha256: expect.any(String) },
    });
    if (manifest.schemaVersion !== 4) {
      throw new Error("Expected referenced subscription history");
    }
    expect(claim.prompt).toBe(prompt);
    expect(claim.resumeSession).toMatchObject({
      sessionId: first.threadId,
      historyRef: { hash: manifest.baseSession.sha256 },
    });
    const objectKey = new URL(manifest.history.url).searchParams.get("object");
    const h0 = objectKey ? checkpointObjects.get(objectKey) : undefined;
    expect(h0?.toString("utf8")).toContain(
      "previous settled subscription answer",
    );
    expect(h0?.toString("utf8")).not.toContain(prompt);
    expect(
      checkpointObjects.has(
        `${env("R2_USER_STORAGES_BUCKET_NAME")}/pi-api-first-turn/${run.runId}/session.jsonl`,
      ),
    ).toBeFalsy();
    await expect(
      api.reserveRunnerActiveInputs(claim.sandboxToken, run.runId),
    ).resolves.toStrictEqual(reserved);
    await expect(
      api.recordRunnerActiveInputDelivery(
        claim.sandboxToken,
        run.runId,
        reserved.deliveryId,
      ),
    ).resolves.toStrictEqual({ outcome: "delivered" });
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
