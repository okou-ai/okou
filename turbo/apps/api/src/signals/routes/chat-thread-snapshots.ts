import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import { computed } from "ccstate";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { generatePresignedGetUrl } from "../external/s3";
import type { RouteEntry } from "../route-entry";
import {
  getChatThreadEventsSince,
  getChatThreadSnapshot,
} from "../services/chat-thread-event.service";
import { isOwnedChatThreadSnapshotObjectKey } from "../services/chat-thread-snapshot-object";

const getChatThreadSnapshotInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const snapshot = await get(
    getChatThreadSnapshot({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  if (!snapshot) {
    // No snapshot row is a permanent state, not a rollout fallback: every App,
    // CLI, iOS, and rollback-window API agrees on this empty shape.
    return {
      status: 200 as const,
      body: { chatThreads: [], latestEventId: null, latestSeqId: null },
    };
  }

  if (
    !isOwnedChatThreadSnapshotObjectKey(
      snapshot.objectKey,
      auth.userId,
      auth.orgId,
    )
  ) {
    throw new Error("Invalid chat thread snapshot object key");
  }

  const url = await get(
    generatePresignedGetUrl(
      env("R2_USER_STORAGES_BUCKET_NAME"),
      snapshot.objectKey,
    ),
  );
  return {
    status: 200 as const,
    body: {
      url,
      expiresInSeconds: PRESIGNED_URL_TTL_SECONDS,
      latestEventId: snapshot.latestEventId,
      latestSeqId: snapshot.latestSeqId,
    },
  };
});

const listChatThreadLifecycleEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatThreadsContract.events));
  const result = await get(
    getChatThreadEventsSince({
      userId: auth.userId,
      orgId: auth.orgId,
      sinceSeqId: query.sinceSeqId,
    }),
  );

  if (result.kind === "expired") {
    return {
      status: 410 as const,
      body: {
        error: {
          message: "Chat thread events cursor has expired",
          code: "CHAT_THREAD_EVENTS_EXPIRED",
        },
      },
    };
  }

  return {
    status: 200 as const,
    body: {
      events: [...result.events],
      hasMore: result.hasMore,
    },
  };
});

export const chatThreadSnapshotRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.snapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
        oauthScope: "okou:chat:read",
      },
      getChatThreadSnapshotInner$,
    ),
  },
  {
    route: chatThreadsContract.events,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
        oauthScope: "okou:chat:read",
      },
      listChatThreadLifecycleEventsInner$,
    ),
  },
];
