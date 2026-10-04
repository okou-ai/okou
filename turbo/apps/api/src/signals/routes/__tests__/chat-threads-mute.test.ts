import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

async function fixture(enabled = true) {
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  await bdd.readOnboardingStatus(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "Mute test",
    visibility: "private",
  });
  const thread = await chat.createThread(actor, {
    agentId: agent.agentId,
    title: "Keep this title",
  });
  if (!actor.orgId) {
    throw new Error("Expected organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { userId: actor.userId, orgId: actor.orgId, orgRole: actor.orgRole },
    {
      [FeatureSwitchKey.ChatThreadMuting]: enabled,
      [FeatureSwitchKey.ChatThreadArchiving]: true,
    },
  );
  return { actor, thread };
}

describe("chat thread muting", () => {
  it("persists idempotent mute changes independently of archive and activity ordering", async () => {
    const { actor, thread } = await fixture();
    const before = await chat.readThreadMetadata(actor, thread.id);
    const muteId = randomUUID();
    const unmuteId = randomUUID();
    await chat.requestSetThreadArchived(actor, thread.id, true, [204]);
    await chat.requestSetThreadMuted(actor, thread.id, true, [204], {
      eventId: muteId,
    });
    await chat.requestSetThreadMuted(actor, thread.id, true, [204]);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      muted: true,
      archived: true,
      title: before.title,
    });
    await chat.requestSetThreadMuted(actor, thread.id, false, [204], {
      eventId: unmuteId,
    });
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      muted: false,
      archived: true,
      title: before.title,
    });
    const response = await chat.requestThreadEvents(actor, {}, [200]);
    if (response.status !== 200) {
      throw new Error("Expected events");
    }
    expect(response.body.events).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: muteId,
          kind: "sort_touched",
          muted: true,
        }),
        expect.objectContaining({
          id: unmuteId,
          kind: "sort_touched",
          muted: false,
        }),
      ]),
    );
  });

  it("gates mute and unmute and does not expose threads across user or organization boundaries", async () => {
    const { actor, thread } = await fixture(false);
    await chat.requestSetThreadMuted(actor, thread.id, true, [404]);
    await chat.requestSetThreadMuted(actor, thread.id, false, [404]);
    await expect(
      chat.readThreadMetadata(actor, thread.id),
    ).resolves.toMatchObject({
      muted: false,
    });
    await chat.requestSetThreadMuted(null, thread.id, true, [401]);
    for (const outsider of [
      bdd.user({ orgId: actor.orgId }),
      bdd.user({ userId: actor.userId }),
    ]) {
      await bdd.readOnboardingStatus(outsider);
      if (!outsider.orgId) {
        throw new Error("Expected organization");
      }
      await updateFeatureSwitchesForUser(
        context,
        {
          userId: outsider.userId,
          orgId: outsider.orgId,
          orgRole: outsider.orgRole,
        },
        { [FeatureSwitchKey.ChatThreadMuting]: true },
      );
      await chat.requestSetThreadMuted(outsider, thread.id, true, [404]);
      await chat.requestSetThreadMuted(outsider, thread.id, false, [404]);
    }
  });
});
