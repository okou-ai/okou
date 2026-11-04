import { projectsContract } from "@okouai/api-contracts/client/projects";
import { chatThreadsContract } from "@okouai/api-contracts/client/chat-threads";
import {
  projectEventSchema,
  projectSnapshotArchiveSchema,
} from "@okouai/api-contracts/validators/projects";
import { chatThreadSnapshotArchiveSchema } from "@okouai/api-contracts/validators/chat-threads";
import type { IDBPDatabase } from "idb";
import { fetchResource } from "../lib/resource-fetch.ts";
import type { ApiClientFactory } from "../signals/api-client.ts";
import { createStrictIdbChatThreadEventStores } from "../signals/external/idb-chat-thread-event-store.ts";
import { createIdbProjectEventStores } from "../signals/external/idb-project-event-store.ts";
import {
  metadataEventCursor,
  type MetadataEvent,
  type MetadataSnapshot,
  type MetadataEventResult,
  type MetadataEventStores,
} from "../signals/external/idb-metadata-event-store.ts";
import { SharedDatabaseHttpError } from "./http-error.ts";
import { CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD } from "./event-log-policy.ts";

export interface MetadataEventSource<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
> {
  readonly name: string;
  readonly rebaseThreshold: number | null;
  readonly createStores: (
    getDb: () => Promise<IDBPDatabase>,
  ) => MetadataEventStores<TSnapshot, TEvent>;
  readonly snapshot: (signal: AbortSignal) => Promise<TSnapshot>;
  readonly events: (
    after: number | null,
    signal: AbortSignal,
  ) => Promise<
    | { readonly expired: true }
    | {
        readonly expired: false;
        readonly events: TEvent[];
        readonly hasMore: boolean;
      }
  >;
}

export interface MetadataEventRemoteState<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
> {
  readonly result: MetadataEventResult<TSnapshot, TEvent>;
  readonly replacement: boolean;
  readonly cursorFromServerSnapshot: boolean;
  readonly newEvents: readonly TEvent[];
}

export function createProjectEventSource(createClient: ApiClientFactory) {
  const client = createClient(projectsContract);
  return {
    name: "Project",
    // Project rename reconciliation consumes the returned event IDs. Do not
    // compact those confirmations out of the result before the page sees them.
    rebaseThreshold: null,
    createStores: createIdbProjectEventStores,
    async snapshot(signal: AbortSignal) {
      const response = await client.snapshot({ fetchOptions: { signal } });
      signal.throwIfAborted();
      if (response.status !== 200) {
        throw new SharedDatabaseHttpError(response.status);
      }
      if (!("url" in response.body)) {
        return response.body;
      }
      const archive = await fetchResource(response.body.url, {}, signal);
      if (!archive.ok) {
        throw new SharedDatabaseHttpError(archive.status);
      }
      const snapshot = projectSnapshotArchiveSchema.parse(await archive.json());
      signal.throwIfAborted();
      return snapshot;
    },
    async events(after: number | null, signal: AbortSignal) {
      const response = await client.events({
        query: { sinceSeqId: after ?? 0 },
        fetchOptions: { signal },
      });
      if (response.status === 410) {
        return { expired: true as const };
      }
      if (response.status !== 200) {
        throw new SharedDatabaseHttpError(response.status);
      }
      return {
        expired: false as const,
        events: projectEventSchema.array().parse(response.body.events),
        hasMore: response.body.hasMore,
      };
    },
  };
}

export function createChatThreadEventSource(createClient: ApiClientFactory) {
  const client = createClient(chatThreadsContract);
  return {
    name: "ChatThreadEvent",
    rebaseThreshold: CHAT_THREAD_EVENT_LOG_SNAPSHOT_REBASE_THRESHOLD,
    createStores: createStrictIdbChatThreadEventStores,
    async snapshot(signal: AbortSignal) {
      const response = await client.snapshot({ fetchOptions: { signal } });
      signal.throwIfAborted();
      if (response.status !== 200) {
        throw new SharedDatabaseHttpError(response.status);
      }
      if ("chatThreads" in response.body) {
        return response.body;
      }
      const archive = await fetchResource(response.body.url, {}, signal);
      if (!archive.ok) {
        throw new SharedDatabaseHttpError(archive.status);
      }
      const snapshot = chatThreadSnapshotArchiveSchema.parse(
        await archive.json(),
      );
      signal.throwIfAborted();
      return {
        chatThreads: snapshot.chatThreads,
        latestEventId: response.body.latestEventId,
        latestSeqId: response.body.latestSeqId,
      };
    },
    async events(after: number | null, signal: AbortSignal) {
      const response = await client.events({
        query: after === null ? {} : { sinceSeqId: after },
        fetchOptions: { signal },
      });
      if (response.status === 410) {
        return { expired: true as const };
      }
      if (response.status !== 200) {
        throw new SharedDatabaseHttpError(response.status);
      }
      return { expired: false as const, ...response.body };
    },
  };
}

export async function loadMetadataEventTail<
  TSnapshot extends MetadataSnapshot,
  TEvent extends MetadataEvent,
>(
  source: MetadataEventSource<TSnapshot, TEvent>,
  initial: MetadataEventRemoteState<TSnapshot, TEvent>,
  signal: AbortSignal,
): Promise<MetadataEventRemoteState<TSnapshot, TEvent>> {
  let state = initial;
  let hasMore = true;
  while (hasMore) {
    signal.throwIfAborted();
    const cursor = metadataEventCursor(state.result);
    const page = await source.events(cursor, signal);
    signal.throwIfAborted();
    if (page.expired) {
      if (state.cursorFromServerSnapshot) {
        throw new Error(
          `${source.name} cursor expired immediately after a server snapshot`,
        );
      }
      state = {
        result: { snapshot: await source.snapshot(signal), events: [] },
        replacement: true,
        cursorFromServerSnapshot: true,
        newEvents: [],
      };
      continue;
    }
    const events = page.events.filter((event) => {
      return cursor === null || event.seqId > cursor;
    });
    if (page.hasMore && events.length === 0) {
      throw new Error(`${source.name} event cursor did not advance`);
    }
    if (events.length > 0) {
      state = {
        result: {
          snapshot: state.result.snapshot,
          events: [...state.result.events, ...events],
        },
        replacement: state.replacement,
        cursorFromServerSnapshot: false,
        newEvents: [...state.newEvents, ...events],
      };
    }
    hasMore = page.hasMore;
  }
  return state;
}
