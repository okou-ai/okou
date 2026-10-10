import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const { chat, entitledNativeChatActor, expectThreadCreatedModelEvent } =
  createChatEventsFixture(context);

describe("Auto selection through public Thread creation", () => {
  it.each([null, "auto"])(
    "writes canonical Thread identity for Auto intent %s",
    async (model) => {
      const { actor, agentId } = await entitledNativeChatActor();
      const thread = await chat.createThread(actor, { agentId, model });
      await expectThreadCreatedModelEvent(actor, thread.id, "auto");
      await expect(
        chat.readThreadMetadata(actor, thread.id),
      ).resolves.toMatchObject({
        selectedModel: "auto",
      });
    },
  );
});
