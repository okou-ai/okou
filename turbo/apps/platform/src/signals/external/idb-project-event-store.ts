import { openDB } from "idb";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import {
  projectSnapshotArchiveSchema,
  projectEventSchema,
  projectEventQueryResultSchema,
} from "@okouai/api-contracts/validators/projects";
import { fetchResource } from "../../lib/resource-fetch.ts";
import type { ApiClientFactory } from "../api-client.ts";
export async function queryProjectEventStore(
  scope: { userId: string; orgId: string },
  consistency: "cache-only" | "catch-up",
  createClient: ApiClientFactory,
  signal: AbortSignal,
) {
  const db = await openDB(
    `okou-projects:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.orgId)}`,
    1,
    {
      upgrade(database) {
        database.createObjectStore("metadata");
      },
    },
  );
  using _connection = {
    [Symbol.dispose]: () => {
      db.close();
    },
  };
  {
    const stored: unknown = await db.get("metadata", "state");
    let state =
      stored === undefined
        ? { snapshot: null, events: [] }
        : projectEventQueryResultSchema.parse(stored);
    if (consistency === "cache-only") {
      return state;
    }
    const client = createClient(projectsContract);
    let refreshed = false;
    let hasMore = true;
    while (hasMore) {
      signal.throwIfAborted();
      if (state.snapshot === null) {
        const response = await client.snapshot({ fetchOptions: { signal } });
        if (response.status !== 200) {
          throw new Error(`Project snapshot failed (${response.status})`);
        }
        if ("url" in response.body) {
          const bytes = await fetchResource(response.body.url, {}, signal);
          if (!bytes.ok) {
            throw new Error(
              `Project snapshot download failed (${bytes.status})`,
            );
          }
          state = {
            snapshot: projectSnapshotArchiveSchema.parse(await bytes.json()),
            events: [],
          };
        } else {
          state = { snapshot: response.body, events: [] };
        }
        refreshed = true;
      }
      const since = state.events.at(-1)?.seqId ?? state.snapshot!.latestSeqId;
      const response = await client.events({
        query: { sinceSeqId: since },
        fetchOptions: { signal },
      });
      if (response.status === 410) {
        if (refreshed) {
          throw new Error(
            "Project cursor expired immediately after a snapshot",
          );
        }
        state = { snapshot: null, events: [] };
        continue;
      }
      if (response.status !== 200) {
        throw new Error(`Project events failed (${response.status})`);
      }
      const page = projectEventSchema
        .array()
        .parse(response.body.events)
        .filter((event) => {
          return event.seqId > since;
        });
      if (response.body.hasMore && page.length === 0) {
        throw new Error("Project event cursor did not advance");
      }
      state = { snapshot: state.snapshot, events: [...state.events, ...page] };
      hasMore = response.body.hasMore;
    }
    signal.throwIfAborted();
    const transaction = db.transaction("metadata", "readwrite");
    const current: unknown = await transaction.store.get("state");
    const previous =
      current === undefined
        ? null
        : projectEventQueryResultSchema.parse(current);
    const cursor = (value: typeof state) => {
      return value.events.at(-1)?.seqId ?? value.snapshot?.latestSeqId ?? 0;
    };
    if (previous && cursor(previous) > cursor(state)) {
      state = previous;
    } else {
      await transaction.store.put(state, "state");
    }
    await transaction.done;
    return state;
  }
}
