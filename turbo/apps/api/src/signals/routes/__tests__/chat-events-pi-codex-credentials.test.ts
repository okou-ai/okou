import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { now } from "../../../lib/time";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  chat,
  entitledChatActor,
  configureSubscriptionPiModel,
  authDeviceSupport,
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
    const response = await chat.requestSendEvent(
      f.actor,
      {
        agentId: f.agentId,
        model: "gpt-5.6-terra",
        prompt: "do not reuse the deleted codex account",
        clientEventId: randomUUID(),
      },
      [409],
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: "CONFLICT" } });
    expect(JSON.stringify(response.body)).not.toContain(f.identity);
  }, 30_000);
});
