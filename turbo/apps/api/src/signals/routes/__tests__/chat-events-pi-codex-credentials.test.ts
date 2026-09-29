import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import {
  assistantMessages,
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  authDeviceSupport,
  waitForThreadMessages,
} = createChatEventsFixture(context);

async function fixture(expiresAt = Math.floor(now() / 1000) + 7200) {
  const { actor, agentId } = await entitledChatActor();
  const identity = `pi-codex-fast-${randomUUID()}`;
  const connected = await configureSubscriptionPiModel(actor, {
    accountId: identity,
    accessTokenExpiresAt: expiresAt,
    refreshedAccessTokenExpiresAt: Math.floor(now() / 1000) + 7200,
  });
  return { actor, agentId, connected, identity };
}

describe("Pi Codex subscription admission", () => {
  it("does not admit a new personal run after its only account is deleted", async () => {
    const f = await fixture();
    await authDeviceSupport.deletePersonalModelProviderAccount(
      f.actor,
      f.connected.accountSourceId,
    );
    const clientEventId = randomUUID();
    const response = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: "gpt-6-luna",
        prompt: "do not reuse the deleted codex account",
        clientEventId,
      },
      [201],
    );
    if (response.status !== 201) {
      throw new Error("Expected the send to be accepted");
    }
    expect(response.body.runId).toBeNull();
    // The pick refuses the input in the thread instead of launching a run.
    const messages = await waitForThreadMessages(
      f.actor,
      response.body.threadId,
      (items) => {
        return assistantMessages(items).some((message) => {
          return message.eventType === "output.error";
        });
      },
    );
    expect(
      userMessages(messages.events).filter((message) => {
        return message.revokesEventId === clientEventId;
      }),
    ).toStrictEqual([
      expect.objectContaining({
        eventType: "input.rejected",
        error: "conflict",
      }),
    ]);
    expect(
      assistantMessages(messages.events).filter((message) => {
        return message.eventType === "output.error";
      }),
    ).toStrictEqual([
      expect.objectContaining({
        error: "conflict",
        content:
          "The selected subscription account is unavailable. Reconnect it before starting another run.",
      }),
    ]);
    expect(JSON.stringify(messages.events)).not.toContain(f.identity);
  }, 30_000);
});
