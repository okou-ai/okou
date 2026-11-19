import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createProjectOperationId } from "@okouai/core/project-operation-id";
import { now } from "../../lib/time.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { projectsContract } from "@okouai/api-contracts/client/projects";
import { chatThreadByIdContract } from "@okouai/api-contracts/client/chat-threads";
import type { ChatThreadSnapshotProjection } from "@okouai/api-contracts/contracts/chat-threads";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import {
  registerOptimisticChatThreadEvent$,
  catchUpChatThreadEventSource$,
} from "../chat-page/chat-thread-event-sourcing.ts";
import { navigateToNewChat$ } from "../okou-page/nav.ts";
import { onRef } from "../utils.ts";
import { pathParams$ } from "../route.ts";
import { projectDialogSession$ } from "./project-ui.ts";
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
  command(async ({ get, set }, _element: HTMLElement, signal: AbortSignal) => {
    const features = await get(featureSwitches$);
    signal.throwIfAborted();
    if (features[FeatureSwitchKey.ProjectThreadDeletion]) {
      await set(refreshProjectDeletion$, signal);
    }
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
    signal: AbortSignal,
  ) => {
    const currentThreadId = get(currentChatThreadId$);
    if (
      (currentThreadId && deletedThreadIds.includes(currentThreadId)) ||
      get(pathParams$)?.projectId === projectId
    ) {
      await set(navigateToNewChat$, signal);
    }
  },
);

export const deleteProjectAndThreads$ = command(
  async ({ get, set }, onDeleted: () => Promise<void>, signal: AbortSignal) => {
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
        await onDeleted();
        signal.throwIfAborted();
        await set(catchUpChatThreadEventSource$, signal);
        await set(
          navigateAfterProjectDeletion$,
          session.projectId,
          get(session.deletedThreadIds$),
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
        agentId: thread.agentId,
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
    await set(
      deleteProjectWithEventId$,
      session.projectId,
      eventId,
      onDeleted,
      signal,
    );
    await set(
      navigateAfterProjectDeletion$,
      session.projectId,
      get(session.deletedThreadIds$),
      signal,
    );
  },
);
