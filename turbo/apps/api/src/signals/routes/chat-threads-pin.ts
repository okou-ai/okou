import { command } from "ccstate";
import { chatThreadPinContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { isChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const pinInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadPinContract.pin));
  const query = get(queryOf(chatThreadPinContract.pin));
  signal.throwIfAborted();

  if (query?.pinOrder !== undefined && !isChatThreadPinOrder(query.pinOrder)) {
    return badRequestMessage("Invalid pin order");
  }
  const pinOrder = query?.pinOrder ?? null;
  const writeDb = set(writeDb$);

  const pinnedAt = nowDate();
  const written = await updateOwnedChatThreadWithEvent(writeDb, {
    userId: auth.userId,
    orgId: auth.orgId,
    threadId: params.id,
    set: { pinnedAt, pinOrder },
    event: () => {
      return {
        kind: "pinned",
        eventId: query?.eventId,
        pinOrder,
        createdAt: pinnedAt,
      };
    },
  });
  signal.throwIfAborted();
  if (!written) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();

  return { status: 204 as const, body: undefined };
});

export const chatThreadPinRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadPinContract.pin,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      pinInner$,
    ),
  },
];
