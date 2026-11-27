import { createProjectOperationId } from "@okouai/core/project-operation-id";
import {
  expandProject$,
  restoreProjectExpansion$,
} from "./project-expansion.ts";
import { closeProjectDialog$, type ProjectDialog } from "./project-ui.ts";
import { now, nowDate } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import type {
  Project,
  ProjectEvent,
  projectEventQueryResultSchema,
} from "@okouai/api-contracts/validators/projects";
import { replayProjectEvents } from "@okouai/core/project-event-replay";
import {
  compareProjectSortOrder,
  lastProjectSortOrder,
  moveProjectSortOrder,
} from "@okouai/core/project-sort-order";
import type { infer as zInfer } from "zod";
import { queryProjectEventDatabase$ } from "../chat-database/signals.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedSessionKey$ } from "../auth.ts";
import { rootVersion$ } from "../root-signal.ts";
import { accept } from "../../lib/accept.ts";
import { detachedNavigateTo$, pathParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import {
  catchUpChatThreadEventSource$,
  eventDrivenChatThreads$,
  registerOptimisticChatThreadEvent$,
} from "../chat-page/chat-thread-event-sourcing.ts";

type OptimisticProjectRename = Pick<
  ProjectEvent,
  "id" | "projectId" | "createdAt"
> & {
  readonly name: string;
};
type OptimisticProjectArchive = Pick<
  ProjectEvent,
  "id" | "projectId" | "createdAt"
> & {
  readonly archived: boolean;
  readonly lastArchivedAt: Project["lastArchivedAt"];
};
interface OptimisticProjectMove {
  readonly id: string;
  readonly updates: readonly { projectId: string; sortOrder: string }[];
  readonly confirmation: Promise<void>;
}
const EMPTY_PROJECTS: readonly Project[] = Object.freeze([]);
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
    optimisticArchives$: state<readonly OptimisticProjectArchive[]>([]),
    optimisticMoves$: state<readonly OptimisticProjectMove[]>([]),
  };
});
// Each buffer edits one field. A persisted edit also settles earlier local
// edits of that Project's field, so an unpersisted predecessor cannot win.
function unsettledProjectEdits<
  T extends Pick<ProjectEvent, "id" | "projectId">,
>(edits: readonly T[], persistedIds: ReadonlySet<string>) {
  const settledThrough = new Map<string, number>();
  for (const [index, edit] of edits.entries()) {
    if (persistedIds.has(edit.id)) {
      settledThrough.set(edit.projectId, index);
    }
  }
  return edits.filter((edit, index) => {
    return index > (settledThrough.get(edit.projectId) ?? -1);
  });
}
// Reorders are serialized across the Project list. Confirming one operation
// settles its predecessors, including requests absent from a compacted stream.
function unsettledMoves(
  moves: readonly OptimisticProjectMove[],
  persistedIds: ReadonlySet<string>,
) {
  let settledThrough = -1;
  for (const [index, move] of moves.entries()) {
    if (persistedIds.has(move.id)) {
      settledThrough = index;
    }
  }
  return moves.slice(settledThrough + 1);
}
export const projects$ = computed((get) => {
  const owner = get(projectState$);
  const value = get(owner.events$);
  const optimisticCreates = get(owner.optimisticCreates$);
  if (
    !value?.snapshot?.projects.length &&
    !value?.events.length &&
    optimisticCreates.length === 0
  ) {
    return EMPTY_PROJECTS;
  }
  const persistedIds = new Set(
    value?.events.map((event) => {
      return event.id;
    }),
  );
  const creations = optimisticCreates
    .filter((event) => {
      return !persistedIds.has(event.eventId);
    })
    .map((event) => {
      return event.project;
    });
  const pending = new Map(
    unsettledProjectEdits(get(owner.optimisticRenames$), persistedIds).map(
      (event) => {
        return [event.projectId, event];
      },
    ),
  );
  const pendingArchives = new Map(
    unsettledProjectEdits(get(owner.optimisticArchives$), persistedIds).map(
      (event) => {
        return [event.projectId, event];
      },
    ),
  );
  const pendingOrders = new Map(
    unsettledMoves(get(owner.optimisticMoves$), persistedIds).flatMap(
      (move) => {
        return move.updates.map((update) => {
          return [update.projectId, update.sortOrder] as const;
        });
      },
    ),
  );
  return replayProjectEvents(
    [...creations, ...(value?.snapshot?.projects ?? [])],
    value?.events ?? [],
  )
    .map((project) => {
      const rename = pending.get(project.id);
      const renamed = rename
        ? { ...project, name: rename.name, updatedAt: rename.createdAt }
        : project;
      const archive = pendingArchives.get(project.id);
      const archived = archive
        ? {
            ...renamed,
            archived: archive.archived,
            lastArchivedAt: archive.lastArchivedAt,
            updatedAt:
              archive.createdAt > renamed.updatedAt
                ? archive.createdAt
                : renamed.updatedAt,
          }
        : renamed;
      const sortOrder = pendingOrders.get(project.id);
      return sortOrder === undefined ? archived : { ...archived, sortOrder };
    })
    .sort(compareProjectSortOrder);
});

/**
 * Projects created on this page that the server has not persisted yet. A chat
 * cannot start inside one until its creation lands.
 */
export const unconfirmedProjectIds$ = computed((get) => {
  const owner = get(projectState$);
  const persistedIds = new Set(
    get(owner.events$)?.events.map((event) => {
      return event.id;
    }),
  );
  return new Set(
    get(owner.optimisticCreates$)
      .filter((event) => {
        return !persistedIds.has(event.eventId);
      })
      .map((event) => {
        return event.project.id;
      }),
  );
});
export const syncProjects$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = get(projectState$);

    const result = await set(
      queryProjectEventDatabase$,
      {
        dataKey: { kind: "project-event" },
        afterSeqId: null,
        consistency: "catch-up",
      },
      signal,
    );
    signal.throwIfAborted();
    set(owner.events$, result);
    if (result.events.length === 0) {
      return;
    }
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
      return unsettledProjectEdits(events, persistedIds);
    });
    set(owner.optimisticArchives$, (events) => {
      return unsettledProjectEdits(events, persistedIds);
    });
    set(owner.optimisticMoves$, (moves) => {
      return unsettledMoves(moves, persistedIds);
    });
  },
);
export const hydrateProjectCache$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = get(projectState$);

    await set(restoreProjectExpansion$, signal);
    signal.throwIfAborted();
    // Cache hydration belongs to the session, not each route. Keep the current
    // Projects mounted while navigation catches up with the canonical stream.
    if (get(owner.events$) === null) {
      const cached = await set(
        queryProjectEventDatabase$,
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
  },
);
export const hydrateProjects$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(hydrateProjectCache$, signal);

    await set(syncProjects$, signal);
  },
);
export const revealCurrentThreadProject$ = command(({ get, set }) => {
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
});
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
    dialog: Extract<ProjectDialog, { kind: "editor" }>,
    name: string,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const projects = get(projects$);
    signal.throwIfAborted();
    const { fromThreadId } = dialog;
    const owner = get(projectState$);
    const eventId = operation();
    const createdAt = nowDate().toISOString();
    const sortOrder = lastProjectSortOrder(projects);
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
            sortOrder,
            createdAt,
            updatedAt: createdAt,
          },
          confirmation,
        },
      ];
    });
    set(expandProject$, eventId);
    if (dialog.fromComposer) {
      // The page opens on the optimistic Project; a chat sent from it waits
      // for the creation to be confirmed.
      set(detachedNavigateTo$, ROUTES.project, {
        pathParams: { projectId: eventId },
      });
    }
    const thread = get(eventDrivenChatThreads$).find((item) => {
      return item.id === fromThreadId;
    });
    if (thread) {
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "project_updated",
        chatThreadId: thread.id,
        projectId: eventId,
        createdAt: thread.sortAt,
      });
    }
    set(closeProjectDialog$, dialog);
    const result = await confirmation;
    signal.throwIfAborted();
    await set(syncProjects$, signal);
    await set(catchUpChatThreadEventSource$, signal);
    return result.body;
  },
);
const persistProjectMove$ = command(
  async (
    { get, set },
    {
      projectId,
      targetId,
      side,
      eventId,
      previous,
    }: {
      readonly projectId: string;
      readonly targetId: string;
      readonly side: "before" | "after";
      readonly eventId: string;
      readonly previous: Promise<void> | undefined;
    },
    signal: AbortSignal,
  ) => {
    // The preceding command reports its own failure. Wait for settlement so a
    // later user move stays serialized without inheriting that rejection.
    await Promise.allSettled(previous ? [previous] : []);
    signal.throwIfAborted();
    await set(waitForProjectCreation$, projectId, signal);
    await set(waitForProjectCreation$, targetId, signal);
    await accept(
      get(apiClient$)(projectsContract).reorder({
        params: { id: projectId },
        body: { targetId, side, eventId },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    await set(syncProjects$, signal);
  },
);

export const reorderProject$ = command(
  async (
    { get, set },
    projectId: string,
    targetId: string,
    side: "before" | "after",
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const updates = moveProjectSortOrder(
      get(projects$),
      projectId,
      targetId,
      side,
    );
    if (updates.length === 0) {
      return;
    }
    const owner = get(projectState$);
    const eventId = operation();
    const previous = get(owner.optimisticMoves$).at(-1)?.confirmation;
    const confirmation = set(
      persistProjectMove$,
      { projectId, targetId, side, eventId, previous },
      signal,
    );
    set(owner.optimisticMoves$, (moves) => {
      return [...moves, { id: eventId, updates, confirmation }];
    });
    // Failure or cancellation does not establish whether the server committed.
    // Only matching persistent events settle these page-local moves.
    await confirmation;
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
export const setProjectArchived$ = command(
  async ({ get, set }, id: string, archived: boolean, signal: AbortSignal) => {
    signal.throwIfAborted();
    const owner = get(projectState$);
    const eventId = operation();
    const createdAt = nowDate().toISOString();
    const project = get(projects$).find((item) => {
      return item.id === id;
    });
    set(owner.optimisticArchives$, (events) => {
      return [
        ...events,
        {
          id: eventId,
          projectId: id,
          archived,
          lastArchivedAt: archived ? createdAt : project?.lastArchivedAt,
          createdAt,
        },
      ];
    });
    await set(waitForProjectCreation$, id, signal);
    await accept(
      get(apiClient$)(projectsContract).update({
        params: { id },
        body: { archived, eventId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await set(syncProjects$, signal);
  },
);

export const deleteProjectWithEventId$ = command(
  async (
    { get, set },
    dialog: Extract<ProjectDialog, { kind: "delete" }>,
    eventId: string,
    signal: AbortSignal,
  ) => {
    const id = dialog.projectId;
    await set(waitForProjectCreation$, id, signal);
    await accept(
      get(apiClient$)(projectsContract).delete({
        params: { id },
        body: { eventId },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    await set(syncProjects$, signal);
    // The Project has left the list; chat synchronization must not keep its
    // confirmation dialog open.
    signal.throwIfAborted();
    set(closeProjectDialog$, dialog);
    await set(catchUpChatThreadEventSource$, signal);
  },
);
export const deleteProject$ = command(
  async (
    { set },
    dialog: Extract<ProjectDialog, { kind: "delete" }>,
    signal: AbortSignal,
  ) => {
    await set(deleteProjectWithEventId$, dialog, operation(), signal);
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

export const moveProjectThreadFromDialog$ = command(
  async (
    { set },
    dialog: Extract<ProjectDialog, { kind: "membership" }>,
    projectId: string | null,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const completion = set(
      moveProjectThread$,
      dialog.threadId,
      projectId,
      signal,
    );
    set(closeProjectDialog$, dialog);
    await completion;
  },
);
