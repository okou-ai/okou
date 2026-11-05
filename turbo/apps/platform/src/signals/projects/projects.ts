import { createProjectOperationId } from "@okouai/core/project-operation-id";
import {
  expandProject$,
  restoreProjectExpansion$,
} from "./project-expansion.ts";
import { now, nowDate } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import type {
  Project,
  ProjectEvent,
  projectEventQueryResultSchema,
} from "@okouai/api-contracts/validators/projects";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { infer as zInfer } from "zod";
import { installedSharedDatabaseBridge$ } from "../shared-database-bridge-state.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { rootVersion$ } from "../root-signal.ts";
import { accept } from "../../lib/accept.ts";
import { pathParams$ } from "../route.ts";
import {
  catchUpChatThreadEventSource$,
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "../chat-page/chat-thread-event-sourcing.ts";

export const projectsEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.Projects] ?? false;
});
type OptimisticProjectRename = Pick<
  ProjectEvent,
  "id" | "projectId" | "createdAt"
> & {
  readonly name: string;
};
const projectState$ = computed((get) => {
  get(authenticatedSessionKey$);
  get(rootVersion$);
  return {
    events$: state<zInfer<typeof projectEventQueryResultSchema> | null>(null),
    optimisticCreates$: state<
      readonly {
        readonly eventId: string;
        readonly project: Project;
        readonly confirmation: Promise<unknown>;
      }[]
    >([]),
    optimisticRenames$: state<readonly OptimisticProjectRename[]>([]),
  };
});
// A persisted rename also settles earlier local renames of its Project. One
// that never persisted must not override the confirmed name that followed it.
function unsettledRenames(
  renames: readonly OptimisticProjectRename[],
  persistedIds: ReadonlySet<string>,
) {
  const settledThrough = new Map<string, number>();
  for (const [index, rename] of renames.entries()) {
    if (persistedIds.has(rename.id)) {
      settledThrough.set(rename.projectId, index);
    }
  }
  return renames.filter((rename, index) => {
    return index > (settledThrough.get(rename.projectId) ?? -1);
  });
}
export const projects$ = computed((get) => {
  if (!get(projectsEnabled$)) {
    return [];
  }
  const owner = get(projectState$);
  const value = get(owner.events$);
  const persistedIds = new Set(
    value?.events.map((event) => {
      return event.id;
    }),
  );
  const creations = get(owner.optimisticCreates$)
    .filter((event) => {
      return !persistedIds.has(event.eventId);
    })
    .map((event) => {
      return event.project;
    });
  const pending = new Map(
    unsettledRenames(get(owner.optimisticRenames$), persistedIds).map(
      (event) => {
        return [event.projectId, event];
      },
    ),
  );
  return replayProjectEvents(
    [...creations, ...(value?.snapshot?.projects ?? [])],
    value?.events ?? [],
  ).map((project) => {
    const rename = pending.get(project.id);
    return rename
      ? { ...project, name: rename.name, updatedAt: rename.createdAt }
      : project;
  });
});
export const syncProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = get(projectState$);
    if (!get(projectsEnabled$)) {
      set(owner.events$, null);
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
    set(owner.events$, result);
    const persistedIds = new Set(
      result.events.map((event) => {
        return event.id;
      }),
    );
    set(owner.optimisticCreates$, (events) => {
      return events.filter((event) => {
        return !persistedIds.has(event.eventId);
      });
    });
    set(owner.optimisticRenames$, (events) => {
      return unsettledRenames(events, persistedIds);
    });
  },
);
export const hydrateProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = get(projectState$);
    if (!get(projectsEnabled$)) {
      set(owner.events$, null);
      return;
    }
    await set(restoreProjectExpansion$, signal);
    signal.throwIfAborted();
    // Cache hydration belongs to the session, not each route. Keep the current
    // Projects mounted while navigation catches up with the canonical stream.
    if (get(owner.events$) === null) {
      const cached = await get(installedSharedDatabaseBridge$).query(
        {
          dataKey: { kind: "project-event" },
          afterSeqId: null,
          consistency: "cache-only",
        },
        signal,
      );
      signal.throwIfAborted();
      if (get(owner.events$) === null) {
        set(owner.events$, cached);
      }
    }
    await set(syncProjects$, signal);
    // An open chat reveals its Project the first time; a Project page leaves
    // the Project folded the way its member left it.
    const threadId = get(pathParams$)?.threadId;
    const projectId =
      typeof threadId === "string"
        ? get(eventDrivenChatThreads$).find((thread) => {
            return thread.id === threadId;
          })?.projectId
        : null;
    if (projectId) {
      set(expandProject$, projectId, { ifUnset: true });
    }
  },
);
function operation() {
  return createProjectOperationId(now(), crypto.randomUUID());
}
export const waitForProjectCreation$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    const creation = get(get(projectState$).optimisticCreates$).find(
      (event) => {
        return event.project.id === id;
      },
    );
    if (creation) {
      await creation.confirmation;
    }
    signal.throwIfAborted();
  },
);
export const createProject$ = command(
  async (
    { get, set },
    name: string,
    fromThreadId: string | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const owner = get(projectState$);
    const eventId = operation();
    const createdAt = nowDate().toISOString();
    const confirmation = accept(
      get(apiClient$)(projectsContract).create({
        body: { id: eventId, eventId, name, fromThreadId },
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
    set(owner.optimisticCreates$, (events) => {
      return [
        ...events,
        {
          eventId,
          project: {
            id: eventId,
            name: name.trim(),
            createdAt,
            updatedAt: createdAt,
          },
          confirmation,
        },
      ];
    });
    set(expandProject$, eventId);
    const thread = get(eventDrivenChatThreads$).find((item) => {
      return item.id === fromThreadId;
    });
    if (thread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "project_updated",
        chatThreadId: thread.id,
        agentId: thread.agentId,
        projectId: eventId,
        createdAt: thread.sortAt,
      });
    }
    const result = await confirmation;
    signal.throwIfAborted();
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
    return result.body;
  },
);
export const renameProject$ = command(
  async ({ get, set }, id: string, name: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const owner = get(projectState$);
    const eventId = operation();
    set(owner.optimisticRenames$, (events) => {
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
    await set(waitForProjectCreation$, id, signal);
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
    await set(waitForProjectCreation$, id, signal);
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
      await set(waitForProjectCreation$, projectId, signal);
    }
    if (thread?.projectId && thread.projectId !== projectId) {
      await set(waitForProjectCreation$, thread.projectId, signal);
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
