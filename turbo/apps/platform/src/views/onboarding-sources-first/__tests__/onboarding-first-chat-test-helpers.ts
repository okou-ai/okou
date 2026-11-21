import { screen } from "@testing-library/react";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

export function receiveFirstChat(
  context: TestContext,
  received = createDeferredPromise<{ prompt: string; threadId: string }>(
    context.signal,
  ),
) {
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!body.threadId || typeof body.prompt !== "string") {
      throw new Error("Expected a text prompt addressed to a chat");
    }
    if (!received.settled()) {
      received.resolve({ prompt: body.prompt, threadId: body.threadId });
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-10-15T10:20:00.000Z",
    });
  });
  return received.promise;
}

export const documentInstructions =
  "Create a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.";

/** Preserve line breaks when locating the text the person sent in the new chat. */
export function findSentPrompt(prompt: string) {
  return screen.findByText(prompt, {
    normalizer: (text) => {
      return text;
    },
  });
}
