import { chatThreadActivitySummaryRoutes } from "./chat-threads-activity-summary";
import { CHAT_EVENT_SCHEMA_VERSION_HEADER } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { CHAT_THREAD_SNAPSHOT_R2_HEADER } from "@okouai/api-contracts/contracts/client-headers";
import { command, computed } from "ccstate";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import {
  chatSearchContract,
  chatThreadSnapshotArchiveSchema,
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { z } from "zod";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { request$, setResHeader$ } from "../context/hono";
import { db$ } from "../external/db";
import { downloadS3Buffer, generatePresignedGetUrl } from "../external/s3";
import { notFound } from "../../lib/error";
import { env } from "../../lib/env";
import { PRESIGNED_URL_TTL_SECONDS } from "@okouai/api-contracts/contracts/presigned-urls";
import {
  applyGoogleDriveArtifactSyncStatuses,
  googleDriveArtifactStatusLookup,
} from "../services/google-drive-artifact-sync.service";
import {
  chatIndicators,
  chatThreadArtifacts,
  chatThreadDetail,
  chatThreadDraftIds,
} from "../services/chat-thread.service";
import { chatSearch } from "../services/chat-search.service";
import {
  catchUpChatThreadEvents,
  chatThreadEventRows,
  chatThreadEventSnapshot,
} from "../services/chat-event-snapshot.service";
import { resolveChatEventSchemaVersion } from "../services/chat-event-schema-version.service";
import {
  getChatThreadEventsSince,
  getChatThreadSnapshot,
} from "../services/chat-thread-event.service";
import { isOwnedChatThreadSnapshotObjectKey } from "../services/chat-thread-snapshot-object";
import type { RouteEntry } from "../route-entry";
import { chatThreadsArtifactsSyncRoutes } from "./chat-threads-artifacts-sync";
import { chatThreadComputerUseHostRoutes } from "./chat-threads-computer-use-host";
import { chatThreadConnectorSelectionRoutes } from "./chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "./chat-threads-create";
import { chatThreadDeleteRoutes } from "./chat-threads-delete";
import { chatThreadDraftGetRoutes } from "./chat-threads-draft-get";
import { chatThreadGetRoutes } from "./chat-threads-get";
import { chatThreadImageModelRoutes } from "./chat-threads-image-model";
import { chatThreadMarkAgentReadRoutes } from "./chat-threads-mark-agent-read";
import { chatThreadMarkReadRoutes } from "./chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "./chat-threads-mark-unread";
import { chatThreadModelSelectionRoutes } from "./chat-threads-model-selection";
import { chatThreadVideoModelRoutes } from "./chat-threads-video-model";
import { chatThreadPatchRoutes } from "./chat-threads-patch";
import { chatThreadPinRoutes } from "./chat-threads-pin";
import { chatThreadPinOrderRoutes } from "./chat-threads-pin-order";
import { chatThreadRenameRoutes } from "./chat-threads-rename";
import { chatThreadUnpinRoutes } from "./chat-threads-unpin";

const chatThreadIdSchema = z.string().uuid();
const gunzipAsync = promisify(gunzip);
const catchUpChatEventsBody$ = bodyResultOf(chatThreadEventsContract.catchUp);

function chatThreadNotFound() {
  return notFound("Chat thread not found");
}

function isValidChatThreadId(id: string): boolean {
  return chatThreadIdSchema.safeParse(id).success;
}

const getChatThreadInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(chatThreadByIdContract.get));

  if (!isValidChatThreadId(params.id)) {
    return chatThreadNotFound();
  }

  const thread = await get(
    chatThreadDetail({ threadId: params.id, userId: auth.userId }),
  );
  if (!thread) {
    return chatThreadNotFound();
  }

  return { status: 200 as const, body: thread };
});

const getChatThreadSnapshotInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const snapshot = await getChatThreadSnapshot(db, {
    userId: auth.userId,
    orgId: auth.orgId,
  });

  if ("objectKey" in snapshot) {
    if (
      !isOwnedChatThreadSnapshotObjectKey(
        snapshot.objectKey,
        auth.userId,
        auth.orgId,
        snapshot.latestSeqId,
      )
    ) {
      throw new Error("Invalid chat thread snapshot object key");
    }
    const supportsR2Url =
      get(request$).header(CHAT_THREAD_SNAPSHOT_R2_HEADER) === "1";
    if (!supportsR2Url) {
      // Old App/CLI -> new API: loaded clients without this capability still
      // require inline data. Remove after distinct replacement versions are
      // deployed and client floors exclude the old builds (follow-up #36375).
      // Read R2 without detoasting the retired JSONB column meanwhile.
      const body = await get(
        downloadS3Buffer(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          snapshot.objectKey,
        ),
      );
      const archive = chatThreadSnapshotArchiveSchema.parse(
        JSON.parse((await gunzipAsync(body)).toString("utf8")) as unknown,
      );
      return {
        status: 200 as const,
        body: {
          chatThreads: archive.chatThreads,
          latestEventId: snapshot.latestEventId,
          latestSeqId: snapshot.latestSeqId,
        },
      };
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
  }

  return {
    status: 200 as const,
    body: {
      chatThreads: [...snapshot.chatThreads],
      latestEventId: snapshot.latestEventId,
      latestSeqId: snapshot.latestSeqId,
    },
  };
});

const listChatThreadLifecycleEventsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatThreadsContract.events));
  const db = get(db$);
  const result = await getChatThreadEventsSince(db, {
    userId: auth.userId,
    orgId: auth.orgId,
    sinceSeqId: query.sinceSeqId,
  });

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

const listChatIndicatorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const indicators = await get(
    chatIndicators({
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  return { status: 200 as const, body: indicators };
});

const catchUpChatEventsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const version = resolveChatEventSchemaVersion(
      get(request$).header(CHAT_EVENT_SCHEMA_VERSION_HEADER),
    );
    if (version.kind === "error") {
      return version.response;
    }
    set(
      setResHeader$,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
      version.version.toString(),
    );
    const body = await get(catchUpChatEventsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await get(
      catchUpChatThreadEvents({
        cursors: body.data,
        userId: auth.userId,
        orgId: auth.orgId,
      }),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        events: Object.fromEntries(
          Object.entries(result.events).map(([threadId, events]) => {
            return [threadId, [...events]];
          }),
        ),
        notFoundThreads: [...result.notFoundThreads],
      },
    };
  },
);

const getChatEventSnapshotInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.snapshot));
    const version = resolveChatEventSchemaVersion(
      get(request$).header(CHAT_EVENT_SCHEMA_VERSION_HEADER),
    );
    if (version.kind === "error") {
      return version.response;
    }
    set(
      setResHeader$,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
      version.version.toString(),
    );
    const snapshot = await set(
      chatThreadEventSnapshot({
        threadId: params.threadId,
        userId: auth.userId,
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
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadEventsContract.rows));
    const query = get(queryOf(chatThreadEventsContract.rows));
    const version = resolveChatEventSchemaVersion(
      get(request$).header(CHAT_EVENT_SCHEMA_VERSION_HEADER),
    );
    if (version.kind === "error") {
      return version.response;
    }
    set(
      setResHeader$,
      CHAT_EVENT_SCHEMA_VERSION_HEADER,
      version.version.toString(),
    );
    const page = await get(
      chatThreadEventRows({
        threadId: params.threadId,
        userId: auth.userId,
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

const listChatThreadDraftsInner$ = computed(async (get) => {
  const auth = get(authContext$);

  const draftThreadIds = await get(
    chatThreadDraftIds({
      userId: auth.userId,
    }),
  );

  return {
    status: 200 as const,
    body: { draftThreadIds: [...draftThreadIds] },
  };
});

const listChatThreadArtifactsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(pathParamsOf(chatThreadArtifactsContract.list));
    const [runs, lookup] = await Promise.all([
      get(
        chatThreadArtifacts({
          threadId: params.threadId,
          userId: auth.userId,
        }),
      ),
      set(
        googleDriveArtifactStatusLookup({
          threadId: params.threadId,
          orgId: auth.orgId,
          userId: auth.userId,
        }),
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (!runs) {
      return chatThreadNotFound();
    }

    return {
      status: 200 as const,
      body: { runs: applyGoogleDriveArtifactSyncStatuses(runs, lookup) },
    };
  },
);

const searchChatInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(chatSearchContract.search));
  const result = await get(
    chatSearch({
      userId: auth.userId,
      orgId: auth.orgId,
      keyword: query.keyword,
      agentId: query.agentId,
      since: query.since,
    }),
  );

  return {
    status: 200 as const,
    body: { results: [...result.results] },
  };
});

export const chatThreadRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadsContract.indicators,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
      },
      listChatIndicatorsInner$,
    ),
  },
  {
    route: chatThreadsContract.snapshot,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:read",
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
      },
      listChatThreadLifecycleEventsInner$,
    ),
  },
  {
    route: chatThreadsContract.drafts,
    handler: authRoute({}, listChatThreadDraftsInner$),
  },
  {
    route: chatThreadByIdContract.get,
    handler: authRoute({}, getChatThreadInner$),
  },
  {
    route: chatThreadArtifactsContract.list,
    handler: authRoute({}, listChatThreadArtifactsInner$),
  },
  {
    route: chatThreadEventsContract.catchUp,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      catchUpChatEventsInner$,
    ),
  },
  {
    route: chatThreadEventsContract.snapshot,
    handler: authRoute(
      { requiredCapability: "chat-event:read" },
      getChatEventSnapshotInner$,
    ),
  },
  {
    route: chatThreadEventsContract.rows,
    handler: authRoute(
      { requiredCapability: "chat-event:read" },
      listChatEventRowsInner$,
    ),
  },
  {
    route: chatSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      searchChatInner$,
    ),
  },
  ...chatThreadActivitySummaryRoutes,
  ...chatThreadsArtifactsSyncRoutes,
  ...chatThreadComputerUseHostRoutes,
  ...chatThreadConnectorSelectionRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadDeleteRoutes,
  ...chatThreadDraftGetRoutes,
  ...chatThreadGetRoutes,
  ...chatThreadImageModelRoutes,
  ...chatThreadMarkAgentReadRoutes,
  ...chatThreadMarkReadRoutes,
  ...chatThreadMarkUnreadRoutes,
  ...chatThreadModelSelectionRoutes,
  ...chatThreadPatchRoutes,
  ...chatThreadPinRoutes,
  ...chatThreadPinOrderRoutes,
  ...chatThreadRenameRoutes,
  ...chatThreadUnpinRoutes,
  ...chatThreadVideoModelRoutes,
];
