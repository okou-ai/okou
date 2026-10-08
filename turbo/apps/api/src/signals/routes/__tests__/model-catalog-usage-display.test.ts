import { randomUUID } from "node:crypto";
import { testContext } from "../../../__tests__/test-context";
import { createUsagePricingFixture } from "../../../test-fixtures/usage-pricing";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext();
const chatEvents = createChatEventsFixture(context);

describe("fixed Auto usage display", () => {
  it("rejects Auto when its billable long-context usage is unpriced", async () => {
    // Base token categories are priced but the route's long-context
    // threshold makes `.long_context` billable too. Nothing may run unbilled.
    const { actor, agentId } = await chatEvents.entitledChatActor();
    const model = "okou-1.0";
    const base = [
      "tokens.input",
      "tokens.output",
      "tokens.cache_read",
      "tokens.cache_creation",
    ] as const;
    const pricing = await createUsagePricingFixture({
      configured: base.map((category) => {
        return {
          kind: "model",
          provider: model,
          category,
          unitPrice: 1,
          unitSize: 1,
        };
      }),
      missing: base.map((category) => {
        return {
          kind: "model",
          provider: model,
          category: `${category}.long_context`,
        };
      }),
    });
    onTestFinished(pricing.cleanup);
    await chatEvents.configureBuiltInPiModel(actor);

    const clientEventId = randomUUID();
    const sent = await chatEvents.chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "run without complete pricing",
        model: null,
        clientEventId,
      },
      [201],
      { usagePricingResolution: pricing.resolution },
    );
    if (sent.status !== 201) {
      throw new Error("Expected the chat input to be accepted");
    }
    expect(sent.body.runId).toBeNull();
    await flushWaitUntilForTest();
    const { events } = await chatEvents.waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return userMessages(items).some((message) => {
          return (
            message.revokesEventId === clientEventId &&
            message.eventType === "input.rejected"
          );
        });
      },
    );
    expect(
      userMessages(events).find((message) => {
        return message.revokesEventId === clientEventId;
      }),
    ).toMatchObject({
      eventType: "input.rejected",
      error: "model_provider_unavailable",
    });
    expect(
      events.filter((event) => {
        return "runId" in event && event.runId !== undefined;
      }),
    ).toStrictEqual([]);
  });
});
