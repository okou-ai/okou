import {
  captureSuggestionCard,
  type SuggestionDirection,
} from "../../lib/posthog.ts";
import { suggestionFeedbacks } from "@okouai/api-contracts/contracts/suggestion-context";
import { chatEventsContract } from "@okouai/api-contracts/client/chat-event-send";
import type { ChatEventSendBody } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import type { ApiClientFactory } from "../api-client.ts";
export async function sendChatEvent(
  createClient: ApiClientFactory,
  body: ChatEventSendBody,
  signal: AbortSignal,
  direction?: SuggestionDirection,
  assertOwner?: () => void,
): Promise<void> {
  await accept(
    createClient(chatEventsContract, {
      getTokenGuard: assertOwner
        ? () => {
            return assertOwner;
          }
        : undefined,
    }).send({
      body,
      fetchOptions: { signal },
    }),
    [201],
    signal,
  );
  if (
    direction &&
    "userMessage" in body &&
    body.userMessage &&
    (direction.direction_type === "preset" ||
      suggestionFeedbacks(body.userMessage).some(({ context }) => {
        return context.suggestionId === direction.suggestion_id;
      }))
  ) {
    captureSuggestionCard(
      {
        eventName: "suggestion_card_message_sent",
        properties: direction,
      },
      body.clientEventId,
    );
  }
}
