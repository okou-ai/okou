/** Canonical ChatEvent route adapter. */
import { command } from "ccstate";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";

import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { resourceUnavailable } from "../../lib/error";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { handleSendChatEvent$ } from "../services/chat-events.command";

const sendEventBody$ = bodyResultOf(chatEventsContract.send);

const sendChatEventInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(sendEventBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const scope =
      typeof body.data.prompt === "string"
        ? "okou:chat:send"
        : "okou:run:cancel";
    if (auth.tokenType === "oauth" && !auth.scopes.includes(scope)) {
      return resourceUnavailable("Insufficient scope");
    }
    return await set(handleSendChatEvent$, body.data, signal);
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
