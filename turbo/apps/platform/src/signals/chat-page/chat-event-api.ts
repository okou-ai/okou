import { projectChatContract } from "@okouai/api-contracts/client/project-chat";
import { chatEventsContract } from "@okouai/api-contracts/client/chat-event-send";
import { userMessageDocumentSchema } from "@okouai/api-contracts/validators/chat-threads";
import type { ChatEventSendBody } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import type { ApiClientFactory } from "../api-client.ts";
export async function sendChatEvent(
  createClient: ApiClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
): Promise<void> {
  if (
    body.userMessage &&
    body.userMessage.parts.some((part) => {
      return (
        part.type === "project" ||
        (part.type === "feedback" &&
          part.note.some((note) => {
            return note.type === "project";
          }))
      );
    })
  ) {
    await accept(
      createClient(projectChatContract).send({
        body,
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    return;
  }
  const legacy = body.userMessage
    ? {
        ...body,
        userMessage: userMessageDocumentSchema.parse(body.userMessage),
      }
    : body;
  await accept(
    createClient(chatEventsContract).send({
      body: legacy,
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
}
