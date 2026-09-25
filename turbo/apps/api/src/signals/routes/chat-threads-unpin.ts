import { command } from "ccstate";
import { chatThreadUnpinContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const unpinInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadUnpinContract.unpin));
  const query = get(queryOf(chatThreadUnpinContract.unpin));
  signal.throwIfAborted();

  const writeDb = set(writeDb$);

  const written = await updateOwnedChatThreadWithEvent(writeDb, {
    userId: auth.userId,
    orgId: auth.orgId,
    threadId: params.id,
    set: { pinnedAt: null, pinOrder: null },
    event: () => {
      return {
        kind: "unpinned",
        eventId: query?.eventId,
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

export const chatThreadUnpinRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadUnpinContract.unpin,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      unpinInner$,
    ),
  },
];
