import type {
  ChatEvent,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { createBddApi } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";

const context = testContext();

function sourcesOf(events: readonly ChatEvent[]): UserMessagePart[] {
  return events.flatMap((event) => {
    if (event.eventType !== "input.prompt") {
      return [];
    }
    return event.userMessage.parts.filter((part) => {
      return part.type === "source";
    });
  });
}

describe("chat event source annotations", () => {
  it("chat-event-annotations-008 keeps a GitHub issue-comment source with its anchor", async () => {
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const chat = createChatFilesBddApi(context);
    const href =
      "https://github.com/okou-ai/okou/issues/123#issuecomment-456789";

    const sent = await chat.requestSendEvent(
      actor,
      {
        prompt: "github linked",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "github linked" },
            { type: "source", kind: "github", href },
          ],
        },
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the prompt to be accepted");
    }
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);

    expect(sourcesOf(events)).toContainEqual({
      type: "source",
      kind: "github",
      href,
    });
  });
  it("chat-event-annotations-009 keeps a GitHub pull request source link", async () => {
    const actor = createBddApi(context).user({ orgRole: "org:admin" });
    const chat = createChatFilesBddApi(context);
    const href = "https://github.com/okou-ai/okou/pull/4242";

    const sent = await chat.requestSendEvent(
      actor,
      {
        prompt: "review this pull request",
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "review this pull request" },
            { type: "source", kind: "github", href },
          ],
        },
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the prompt to be accepted");
    }
    const { events } = await chat.listThreadEvents(actor, sent.body.threadId);

    expect(sourcesOf(events)).toStrictEqual([
      { type: "source", kind: "github", href },
    ]);
  });
});
