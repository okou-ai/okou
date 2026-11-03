import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { expandProject$ } from "./project-folders.ts";
import { now, nowDate } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import type {
  ProjectEvent,
  projectEventQueryResultSchema,
} from "@okouai/api-contracts/validators/projects";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { infer as zInfer } from "zod";
import { installedSharedDatabaseBridge$ } from "../shared-database-bridge-state.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { searchParams$, pathParams$ } from "../route.ts";
import {
  catchUpChatThreadEventSource$,
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "../chat-page/chat-thread-event-sourcing.ts";

export const projectsEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.Projects] ?? false;
});
const state$ = state<zInfer<typeof projectEventQueryResultSchema>>({
  snapshot: null,
  events: [],
});
const optimisticProjectRenames$ = state<
  readonly (Pick<ProjectEvent, "id" | "projectId" | "createdAt"> & {
    readonly name: string;
  })[]
>([]);
export const projects$ = computed((get) => {
  if (!get(projectsEnabled$)) {
    return [];
  }
  const value = get(state$);
  const persistedIds = new Set(
    value.events.map((event) => {
      return event.id;
    }),
  );
  const pending = new Map(
    get(optimisticProjectRenames$)
      .filter((event) => {
        return !persistedIds.has(event.id);
      })
      .map((event) => {
        return [event.projectId, event];
      }),
  );
  return replayProjectEvents(value.snapshot?.projects ?? [], value.events).map(
    (project) => {
      const rename = pending.get(project.id);
      return rename
        ? { ...project, name: rename.name, updatedAt: rename.createdAt }
        : project;
    },
  );
});
export const syncProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(projectsEnabled$)) {
      set(state$, { snapshot: null, events: [] });
      return;
    }
    const result = await get(installedSharedDatabaseBridge$).query(
      {
        dataKey: { kind: "project-event" },
        afterSeqId: null,
        consistency: "catch-up",
      },
      signal,
    );
    signal.throwIfAborted();
    set(state$, result);
    const persistedIds = new Set(
      result.events.map((event) => {
        return event.id;
      }),
    );
    set(optimisticProjectRenames$, (events) => {
      return events.filter((event) => {
        return !persistedIds.has(event.id);
      });
    });
  },
);
export const hydrateProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(state$, { snapshot: null, events: [] });
    if (!get(projectsEnabled$)) {
      return;
    }
    set(
      state$,
      await get(installedSharedDatabaseBridge$).query(
        {
          dataKey: { kind: "project-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      ),
    );
    await set(syncProjects$, signal);
    const threadId = get(pathParams$)?.threadId;
    const projectId =
      typeof threadId === "string"
        ? get(eventDrivenChatThreads$).find((thread) => {
            return thread.id === threadId;
          })?.projectId
        : get(searchParams$).get("project");
    if (projectId) {
      set(expandProject$, projectId);
    }
  },
);
function operation() {
  return createProjectOperationId(now(), crypto.randomUUID());
}
export const createProject$ = command(
  async (
    { get, set },
    name: string,
    fromThreadId: string | undefined,
    signal: AbortSignal,
  ) => {
    const eventId = operation();
    const result = await accept(
      get(apiClient$)(projectsContract).create({
        body: { id: eventId, eventId, name, fromThreadId },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
    set(expandProject$, result.body.id);
    return result.body;
  },
);
export const renameProject$ = command(
  async ({ get, set }, id: string, name: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const eventId = operation();
    set(optimisticProjectRenames$, (events) => {
      return [
        ...events,
        {
          id: eventId,
          projectId: id,
          name: name.trim(),
          createdAt: nowDate().toISOString(),
        },
      ];
    });
    await accept(
      get(apiClient$)(projectsContract).update({
        params: { id },
        body: { name, eventId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(syncProjects$, signal);
  },
);
export const deleteProject$ = command(
  async ({ get, set }, id: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(projectsContract).delete({
        params: { id },
        body: { eventId: operation() },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
  },
);
export const moveProjectThread$ = command(
  async (
    { get, set },
    threadId: string,
    projectId: string | null,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const eventId = operation();
    const thread = get(eventDrivenChatThreads$).find((item) => {
      return item.id === threadId;
    });
    if (thread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "project_updated",
        chatThreadId: threadId,
        agentId: thread.agentId,
        projectId,
        createdAt: thread.sortAt,
      });
    }
    if (projectId) {
      set(expandProject$, projectId);
    }
    await accept(
      get(apiClient$)(projectsContract).membership({
        params: { id: threadId },
        body: { projectId, eventId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(catchUpChatThreadEventSource$, signal);
  },
);
