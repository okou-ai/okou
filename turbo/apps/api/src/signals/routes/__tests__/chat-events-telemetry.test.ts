import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mockAxiomSdkTelemetryFailure } from "../../../__tests__/mocks";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  chat,
  entitledNativeChatActor,
  sendChatRun,
  runExecution,
  cancelChatRun,
} = createChatEventsFixture(context);

describe("chat enqueue telemetry failures", () => {
  it("keeps an input claimable and its retry idempotent when timing delivery throws AbortError", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    mockAxiomSdkTelemetryFailure({
      mode: "ingest",
      datasets: ["vm0-sandbox-op-log-dev"],
      operationTypes: ["chat_enqueue_request_total"],
      error: new DOMException("Timing delivery cancelled", "AbortError"),
    });
    const eventId = randomUUID();
    const prompt = "enqueue despite an unavailable timing sink";
    const sent = await sendChatRun(actor, {
      agentId,
      prompt,
      clientEventId: eventId,
    });
    const execution = await runExecution(sent.runId);
    expect(execution.execution.prompt).toContain(prompt);
    const beforeRetry = await chat.listThreadEvents(actor, sent.threadId);

    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: sent.threadId,
        prompt,
        clientEventId: eventId,
      },
      [201],
    );
    const events = await chat.listThreadEvents(actor, sent.threadId);
    expect(events.events).toStrictEqual(beforeRetry.events);
    await cancelChatRun(actor, sent.runId);
  });
});
