import { synchronizeUserPushBadge$ } from "../services/push-notifications.service";
import { waitUntil } from "../context/wait-until";
import { command, computed } from "ccstate";
import { chatThreadMarkAllReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { publishChatIndicatorsChangedSafely } from "../external/realtime";
import {
  advanceChatThreadReadCursors$,
  createWorkspaceThreadReadPreparation,
} from "../services/chat-thread-read-state-query";
import type { RouteEntry } from "../route-entry";

const markAllReadBody$ = bodyResultOf(
  chatThreadMarkAllReadContract.markAllRead,
);
const markAllReadPreparation$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(markAllReadBody$);
  if (!bodyResult.ok) {
    return bodyResult;
  }
  const cursors = await get(
    createWorkspaceThreadReadPreparation({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );
  return {
    ok: true as const,
    userId: auth.userId,
    orgId: auth.orgId,
    cursors,
  };
});

/** Marks only prepared caller-owned cursors; publication follows committed CAS writes. */
const markAllReadInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  const prepared = await get(markAllReadPreparation$);
  signal.throwIfAborted();
  if (!prepared.ok) {
    return prepared.response;
  }
  const { userId, orgId, cursors } = prepared;

  const updatedThreadIds = await set(
    advanceChatThreadReadCursors$,
    { cursors, userId, orgId, unmutedOnly: true },
    signal,
  );
  signal.throwIfAborted();

  if (updatedThreadIds.length > 0) {
    waitUntil(
      set(synchronizeUserPushBadge$, userId, new AbortController().signal),
    );
    await publishChatIndicatorsChangedSafely({ userId, orgId });
    signal.throwIfAborted();
  }

  return { status: 204 as const, body: undefined };
});

export const chatThreadMarkAllReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadMarkAllReadContract.markAllRead,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      markAllReadInner$,
    ),
  },
];
