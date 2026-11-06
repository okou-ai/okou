import { command, computed, state } from "ccstate";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { onRef } from "../utils.ts";
import { moveProjectThread$, projects$, projectsEnabled$ } from "./projects.ts";

export const PROJECT_THREAD_DRAG_TYPE = "application/x-okou-chat-thread";

const draggingThreadId$ = state<string | null>(null);
const dropTarget$ = state<{
  readonly projectId: string | null;
  readonly x: number;
  readonly y: number;
} | null>(null);

export const draggingProjectThread$ = computed((get) => {
  const id = get(draggingThreadId$);
  return get(projectsEnabled$) && id
    ? (get(eventDrivenChatThreads$).find((thread) => {
        return thread.id === id;
      }) ?? null)
    : null;
});

export const projectThreadDropTargetId$ = computed((get) => {
  return get(dropTarget$)?.projectId;
});

export const projectThreadDragHint$ = computed((get) => {
  const target = get(dropTarget$);
  const thread = get(draggingProjectThread$);
  if (!target || !thread || thread.projectId === target.projectId) {
    return null;
  }
  if (target.projectId === null) {
    return { ...target, name: null };
  }
  const project = get(projects$).find((item) => {
    return item.id === target.projectId;
  });
  return project ? { ...target, name: project.name } : null;
});

export const startProjectThreadDrag$ = command(
  ({ get, set }, threadId: string) => {
    if (
      !get(projectsEnabled$) ||
      !get(eventDrivenChatThreads$).some((thread) => {
        return thread.id === threadId;
      })
    ) {
      return false;
    }
    set(draggingThreadId$, threadId);
    set(dropTarget$, null);
    return true;
  },
);

export const hoverProjectThreadDrop$ = command(
  (
    { set },
    projectId: string | null,
    position: { readonly x: number; readonly y: number },
  ) => {
    set(dropTarget$, { projectId, ...position });
  },
);

export const leaveProjectThreadDrop$ = command(
  ({ get, set }, projectId: string | null) => {
    if (get(dropTarget$)?.projectId === projectId) {
      set(dropTarget$, null);
    }
  },
);

export const endProjectThreadDrag$ = command(({ set }) => {
  set(draggingThreadId$, null);
  set(dropTarget$, null);
});

export const moveDraggedProjectThread$ = command(
  async ({ get, set }, projectId: string | null, signal: AbortSignal) => {
    const thread = get(draggingProjectThread$);
    set(endProjectThreadDrag$);
    if (
      !thread ||
      thread.projectId === projectId ||
      (projectId !== null &&
        !get(projects$).some((project) => {
          return project.id === projectId;
        }))
    ) {
      return;
    }
    // The accepted drop survives the source row unmounting or later navigation.
    await set(moveProjectThread$, thread.id, projectId, signal);
  },
);

export const projectThreadDragEventsRef$ = onRef(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    const document = element.ownerDocument;
    function endDrag() {
      set(endProjectThreadDrag$);
    }
    document.addEventListener("dragend", endDrag, { signal });
    document.addEventListener("drop", endDrag, { signal });
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          endDrag();
        }
      },
      { signal },
    );
    signal.addEventListener("abort", endDrag, { once: true });
  }),
);
