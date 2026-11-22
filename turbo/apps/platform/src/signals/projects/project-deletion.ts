import { command, computed, state } from "ccstate";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { now } from "../../lib/time.ts";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import { chatThreadByIdContract } from "@okouai/api-contracts/client/chat-threads";
import type { ChatThreadSnapshotProjection } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { currentChatThreadId$ } from "../chat-thread-list.ts";
import {
  registerOptimisticChatThreadEvent$,
  catchUpChatThreadEventSource$,
} from "../chat-page/chat-thread-event-sourcing.ts";
import { navigateToNewChat$ } from "../okou-page/nav.ts";
import { onRef } from "../utils.ts";
import { pathParams$ } from "../route.ts";
import {
  closeProjectDialog$,
  projectDialogSession$,
  type ProjectDialog,
} from "./project-ui.ts";
import { deleteProjectWithEventId$, syncProjects$ } from "./projects.ts";

const deletionSession$ = computed((get) => {
  const dialog = get(projectDialogSession$);
  return {
    projectId: dialog?.kind === "delete" ? dialog.projectId : null,
    threads$: state<Promise<readonly ChatThreadSnapshotProjection[]> | null>(
      null,
    ),
    confirmation$: state<readonly ChatThreadSnapshotProjection[] | null>(null),
    changed$: state(false),
    deletedThreadIds$: state<readonly string[]>([]),
    attemptedThreadIds$: state<readonly string[]>([]),
    projectDeleteEventId$: state<string | null>(null),
  };
});

const readProjectDeletionThreads$ = command(
  async ({ get }, projectId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(projectsContract);
    const threads: ChatThreadSnapshotProjection[] = [];
    let after: string | undefined;
    do {
      const result = await accept(
        client.threads({
          params: { id: projectId },
          query: { archived: "all", limit: 100, after },
          fetchOptions: { signal },
        }),
        [200],
        signal,
      );
      threads.push(...result.body.threads);
      after = result.body.nextAfter ?? undefined;
    } while (after);
    return threads;
  },
);

export const projectDeletionThreads$ = computed(async (get) => {
  return (await get(get(deletionSession$).threads$)) ?? [];
});

export const projectDeletionConfirmation$ = computed((get) => {
  return get(get(deletionSession$).confirmation$);
});
export const projectDeletionChanged$ = computed((get) => {
  return get(get(deletionSession$).changed$);
});
export const refreshProjectDeletion$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const session = get(deletionSession$);
    if (!session.projectId) {
      return [];
    }
    const result = set(readProjectDeletionThreads$, session.projectId, signal);
    set(session.threads$, result);
    return await result;
  },
);
export const initializeProjectDeletion$ = onRef(
  command(async ({ set }, _element: HTMLElement, signal: AbortSignal) => {
    await set(refreshProjectDeletion$, signal);
  }),
);
export const confirmProjectThreadDeletion$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const session = get(deletionSession$);
    const threads = await set(refreshProjectDeletion$, signal);
    signal.throwIfAborted();
    set(session.confirmation$, threads);
    set(session.changed$, false);
  },
);
export const backFromProjectThreadDeletion$ = command(({ get, set }) => {
  const session = get(deletionSession$);
  set(session.confirmation$, null);
  set(session.changed$, false);
});

const navigateAfterProjectDeletion$ = command(
  async (
    { get, set },
    projectId: string,
    deletedThreadIds: readonly string[],
    attemptedThreadIds: readonly string[],
    signal: AbortSignal,
  ) => {
    const currentThreadId = get(currentChatThreadId$);
    if (
      (currentThreadId && deletedThreadIds.includes(currentThreadId)) ||
      get(pathParams$)?.projectId === projectId
    ) {
      await set(navigateToNewChat$, signal);
    } else if (
      currentThreadId &&
      attemptedThreadIds.includes(currentThreadId)
    ) {
      // A failed response may still have deleted the open chat. Leaving the
      // Project alone is not proof of deletion: it could have moved elsewhere.
      const current = await accept(
        get(apiClient$)(chatThreadByIdContract).get({
          params: { id: currentThreadId },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
      if (current.status === 404) {
        await set(navigateToNewChat$, signal);
      }
    }
  },
);

export const deleteProjectAndThreads$ = command(
  async (
    { get, set },
    dialog: Extract<ProjectDialog, { kind: "delete" }>,
    signal: AbortSignal,
  ) => {
    if (get(projectDialogSession$) !== dialog) {
      return;
    }
    const session = get(deletionSession$);
    const confirmed = get(session.confirmation$);
    if (!session.projectId || !confirmed) {
      return;
    }
    if (get(session.projectDeleteEventId$)) {
      // A lost final response or failed synchronization must not replay the
      // batch. Read the Project before reusing its original operation receipt.
      const project = await accept(
        get(apiClient$)(projectsContract).get({
          params: { id: session.projectId },
          fetchOptions: { signal },
        }),
        [200, 404],
        signal,
      );
      if (project.status === 404) {
        await set(syncProjects$, signal);
        signal.throwIfAborted();
        set(closeProjectDialog$, dialog);
        await set(catchUpChatThreadEventSource$, signal);
        await set(
          navigateAfterProjectDeletion$,
          session.projectId,
          get(session.deletedThreadIds$),
          get(session.attemptedThreadIds$),
          signal,
        );
        return;
      }
    }
    // Reconcile before each attempt. A failed request may already have deleted
    // its thread, and membership may have changed while confirmation was open.
    const current = await set(refreshProjectDeletion$, signal);
    signal.throwIfAborted();
    const confirmedIds = new Set(
      confirmed.map((thread) => {
        return thread.id;
      }),
    );
    if (
      current.length !== confirmed.length ||
      current.some((thread) => {
        return !confirmedIds.has(thread.id);
      })
    ) {
      set(session.confirmation$, current);
      set(session.changed$, true);
      return;
    }
    const client = get(apiClient$)(chatThreadByIdContract);
    for (const thread of current) {
      const eventId = crypto.randomUUID();
      set(session.attemptedThreadIds$, (ids) => {
        return ids.includes(thread.id) ? ids : [...ids, thread.id];
      });
      await accept(
        client.delete({
          params: { id: thread.id },
          query: { eventId },
          fetchOptions: { signal },
        }),
        [204],
        signal,
      );
      set(registerOptimisticChatThreadEvent$, {
        id: eventId,
        kind: "deleted",
        chatThreadId: thread.id,
      });
      set(session.deletedThreadIds$, (ids) => {
        return [...ids, thread.id];
      });
      set(session.confirmation$, (remaining) => {
        return (
          remaining?.filter((item) => {
            return item.id !== thread.id;
          }) ?? null
        );
      });
    }
    const remaining = await set(refreshProjectDeletion$, signal);
    signal.throwIfAborted();
    if (remaining.length > 0) {
      set(session.confirmation$, remaining);
      set(session.changed$, true);
      return;
    }
    const eventId =
      get(session.projectDeleteEventId$) ??
      createProjectOperationId(now(), crypto.randomUUID());
    set(session.projectDeleteEventId$, eventId);
    await set(deleteProjectWithEventId$, dialog, eventId, signal);
    await set(
      navigateAfterProjectDeletion$,
      session.projectId,
      get(session.deletedThreadIds$),
      get(session.attemptedThreadIds$),
      signal,
    );
  },
);
