import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { catchUpChatThreadEvents } from "../services/chat-event-snapshot.service";

const catchUpChatEventsBody$ = bodyResultOf(chatThreadEventsContract.catchUp);

const catchUpChatEventsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(catchUpChatEventsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await get(
      catchUpChatThreadEvents({
        cursors: body.data,
        userId: auth.userId,
        orgId: auth.orgId,
      }),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        events: Object.fromEntries(
          Object.entries(result.events).map(([threadId, events]) => {
            return [threadId, [...events]];
          }),
        ),
        notFoundThreads: [...result.notFoundThreads],
      },
    };
  },
);

export const chatThreadCatchUpRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadEventsContract.catchUp,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      catchUpChatEventsInner$,
    ),
  },
];
