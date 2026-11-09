import { synchronizeUserPushBadge$ } from "../services/push-notifications.service";
import { waitUntil } from "../context/wait-until";
import { command } from "ccstate";
import { chatThreadMuteContract } from "@okouai/api-contracts/contracts/chat-threads";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import {
  publishChatIndicatorsChangedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent$ } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

function muteHandler(muted: boolean) {
  const route = muted
    ? chatThreadMuteContract.mute
    : chatThreadMuteContract.unmute;
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(route));
    const query = get(queryOf(route));
    const written = await set(
      updateOwnedChatThreadWithEvent$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: params.id,
        set: { muted },
        event: { kind: "sort_touched", muted, eventId: query?.eventId },
      },
      signal,
    );
    signal.throwIfAborted();
    if (!written) {
      return notFound("Chat thread not found");
    }
    waitUntil(
      set(synchronizeUserPushBadge$, auth.userId, new AbortController().signal),
    );
    await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
    signal.throwIfAborted();
    // Unread indicators exclude muted threads.
    await publishChatIndicatorsChangedSafely({
      userId: auth.userId,
      orgId: auth.orgId,
    });
    signal.throwIfAborted();
    return { status: 204 as const, body: undefined };
  });
}

export const chatThreadMuteRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMuteContract.mute,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      muteHandler(true),
    ),
  },
  {
    route: chatThreadMuteContract.unmute,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      muteHandler(false),
    ),
  },
];
