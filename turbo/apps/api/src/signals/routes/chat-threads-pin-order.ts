import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadPinOrderContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { isChatThreadPinOrder } from "@okouai/core/chat-thread-pin-order";
import { badRequestMessage, notFound } from "../../lib/error";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
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

  const updated = await writeDb.transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ pinOrder: body.data.pinOrder })
      .where(
        and(
          eq(chatThreads.id, params.id),
          eq(chatThreads.userId, auth.userId),
          chatThreadOrganizationCondition(tx, auth.orgId),
          isNotNull(chatThreads.agentId),
          isNotNull(chatThreads.pinnedAt),
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
      kind: "sort_touched",
      userId: auth.userId,
      orgId: auth.orgId,
      chatThreadId: thread.id,
      agentId: thread.agentId,
      eventId: body.data.eventId,
      pinOrder: body.data.pinOrder,
    });
    return true;
  });
  signal.throwIfAborted();

  if (!updated) {
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
