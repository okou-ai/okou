import { chatThreadOrganizationPredicate } from "../services/chat-thread-organization.service";
import { synchronizeUserPushBadge$ } from "../services/push-notifications.service";
import { waitUntil } from "../context/wait-until";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishChatThreadReadCursorUpdatedSafely } from "../external/realtime";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";

const markUnreadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadMarkUnreadContract.markUnread));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const [cleared] = await writeDb
    .update(chatThreads)
    .set({ lastReadAt: null })
    .where(
      and(
        eq(chatThreads.id, params.id),
        eq(chatThreads.userId, auth.userId),
        isNotNull(chatThreads.agentId),
        chatThreadOrganizationPredicate(auth.orgId),
      ),
    )
    .returning({ agentId: chatThreads.agentId });
  signal.throwIfAborted();
  if (!cleared?.agentId) {
    return notFound("Chat thread not found");
  }
  waitUntil(
    set(synchronizeUserPushBadge$, auth.userId, new AbortController().signal),
  );
  await publishChatThreadReadCursorUpdatedSafely(
    { userId: auth.userId, orgId: auth.orgId },
    {
      threadId: params.id,
      agentId: cleared.agentId,
      lastReadAt: null,
    },
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      lastReadAt: null,
    },
  };
});

export const chatThreadMarkUnreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkUnreadContract.markUnread,
    handler: authRoute({ requireOrganization: true }, markUnreadInner$),
  },
];
