import { command } from "ccstate";
import { isNotNull } from "drizzle-orm";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { isChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import { badRequestMessage, notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const reorderBody$ = bodyResultOf(chatThreadPinOrderContract.reorder);

const reorderInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadPinOrderContract.reorder));
  const body = await get(reorderBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);
  if (!isChatThreadPinOrder(body.data.pinOrder)) {
    return badRequestMessage("Invalid pin order");
  }

  const written = await updateOwnedChatThreadWithEvent(writeDb, {
    userId: auth.userId,
    orgId: auth.orgId,
    threadId: params.id,
    set: { pinOrder: body.data.pinOrder },
    where: isNotNull(chatThreads.pinnedAt),
    event: () => {
      return {
        kind: "sort_touched",
        eventId: body.data.eventId,
        pinOrder: body.data.pinOrder,
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

export const chatThreadPinOrderRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadPinOrderContract.reorder,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      reorderInner$,
    ),
  },
];
