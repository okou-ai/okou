import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadPinContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { isChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import { badRequestMessage, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
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

  // A pin timestamp, its client rank and the sidebar copy of both are account
  // content, so the existing transaction now runs inside the shared B1
  // admission and the canonical Agent/thread locks. The thread UPDATE, the
  // durable sidebar sequence and the `pinned` event stay in that one
  // transaction: a denied or rolled back pin consumes no sequence and appends
  // no event, and the content-free invalidation below still publishes only
  // after a successful COMMIT. B1 closure reuses this route's existing 404,
  // alongside its unchanged organization and non-null Agent requirements.
  const result = await withChatThreadContentWrite(
    writeDb,
    {
      chatThreadId: params.id,
      authorize: (identity) => {
        return (
          identity.userId === auth.userId &&
          identity.agentId !== null &&
          identity.orgId === auth.orgId
        );
      },
    },
    async (tx) => {
      const pinnedAt = nowDate();
      const [thread] = await tx
        .update(chatThreads)
        .set({ pinnedAt, pinOrder })
        .where(
          and(
            eq(chatThreads.id, params.id),
            eq(chatThreads.userId, auth.userId),
            chatThreadOrganizationCondition(tx, auth.orgId),
            isNotNull(chatThreads.agentId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
        });
      if (!thread?.agentId) {
        return false;
      }
      await appendChatThreadEvent(tx, {
        kind: "pinned",
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
        eventId: query?.eventId,
        pinOrder,
        createdAt: pinnedAt,
      });
      return true;
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.outcome !== "written" || !result.value) {
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
