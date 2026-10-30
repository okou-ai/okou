import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command } from "ccstate";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { chatThreadEventRows } from "../services/chat-event-row-read.service";
import { chatThreadEventSnapshot } from "../services/chat-event-snapshot.service";
import { chatThreadNotFound } from "./chat-thread-not-found";

const getChatEventSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.snapshot));
    const snapshot = await set(
      chatThreadEventSnapshot({
        threadId: params.threadId,
        userId: auth.userId,
        ...(auth.tokenType === "oauth" ? { orgId: auth.orgId } : {}),
      }),
      signal,
    );
    if (snapshot.kind === "thread-not-found") {
      return chatThreadNotFound();
    }
    if (snapshot.kind === "snapshot-not-found") {
      return {
        status: 404 as const,
        body: {
          error: {
            message: "Chat event snapshot not found",
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        url: snapshot.url,
        expiresInSeconds: snapshot.expiresInSeconds,
        lastEventId: snapshot.lastEventId,
        lastSeqId: snapshot.lastSeqId,
      },
    };
  },
);

const listChatEventRowsInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.rows));
    const query = get(queryOf(chatThreadEventsContract.rows));
    const page = await get(
      chatThreadEventRows({
        threadId: params.threadId,
        userId: auth.userId,
        ...(auth.tokenType === "oauth" ? { orgId: auth.orgId } : {}),
        limit: query.limit,
        ...(query.sinceEventId === undefined
          ? { sinceSeqId: 0 as const }
          : {
              sinceSeqId: query.sinceSeqId,
              sinceEventId: query.sinceEventId,
            }),
      }),
    );
    signal.throwIfAborted();
    if (page.kind === "thread-not-found") {
      return chatThreadNotFound();
    }
    if (page.kind === "expired") {
      return {
        status: 410 as const,
        body: {
          error: {
            message: "Chat events cursor has expired",
            code: "CHAT_EVENTS_EXPIRED",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        rows: [...page.rows],
        cursor: page.cursor,
        hasMore: page.hasMore,
      },
    };
  },
);

export const chatThreadMessageReadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadEventsContract.snapshot,
    handler: authRoute(
      { requiredCapability: "chat-event:read", oauthScope: "okou:chat:read" },
      getChatEventSnapshotInner$,
    ),
  },
  {
    route: chatThreadEventsContract.rows,
    handler: authRoute(
      { requiredCapability: "chat-event:read", oauthScope: "okou:chat:read" },
      listChatEventRowsInner$,
    ),
  },
];
