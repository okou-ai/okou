/** Canonical ChatEvent route adapter. */
import { command } from "ccstate";
import {
  chatEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-event-send";

import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { resourceUnavailable, badRequestMessage } from "../../lib/error";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { handleSendChatEvent$ } from "../services/chat-events.command";
import {
  hasEmptySuggestionNote,
  suggestionFeedbacks,
} from "@okouai/api-contracts/contracts/suggestion-context";
import {
  validateSuggestionFollowup$,
  recordAcceptedSuggestionFollowup$,
  suggestionAccess$,
} from "../services/agent-suggestions.service";

const sendEventBody$ = bodyResultOf(chatEventsContract.send);

export const sendValidatedChatEvent$ = command(
  async ({ get, set }, data: ChatEventSendBody, signal: AbortSignal) => {
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const scope =
      typeof data.prompt === "string" ? "okou:chat:send" : "okou:run:cancel";
    if (auth.tokenType === "oauth" && !auth.scopes.includes(scope)) {
      return resourceUnavailable("Insufficient scope");
    }
    const candidate =
      auth.tokenType === "session" &&
      data.userMessage &&
      suggestionFeedbacks(data.userMessage).length > 0;
    const access = candidate ? await set(suggestionAccess$, signal) : null;
    const custom = access !== null && !("status" in access);
    if (custom && data.userMessage) {
      if (
        !data.threadId ||
        !data.clientEventId ||
        hasEmptySuggestionNote(data.userMessage)
      ) {
        return badRequestMessage(
          "Add your question or direction before sending this suggestion.",
        );
      }
      const invalid = await set(
        validateSuggestionFollowup$,
        auth,
        {
          threadId: data.threadId,
          eventId: data.clientEventId,
          document: data.userMessage,
        },
        signal,
      );
      if (invalid) {
        return invalid;
      }
    }
    const result = await set(handleSendChatEvent$, data, signal);
    if (custom && result.status === 201 && data.clientEventId) {
      await set(
        recordAcceptedSuggestionFollowup$,
        auth,
        result.body.threadId,
        data.clientEventId,
        signal,
      );
    }
    return result;
  },
);

const sendChatEventInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(sendEventBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    return await set(sendValidatedChatEvent$, body.data, signal);
  },
);

export const chatEventsRoutes: readonly RouteEntry[] = [
  {
    route: chatEventsContract.send,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:write",
        oauthScope: ["okou:chat:send", "okou:run:cancel"],
      },
      sendChatEventInner$,
    ),
  },
];
