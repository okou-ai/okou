import type { DragEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  draggingProjectThread$,
  hoverProjectThreadDrop$,
  leaveProjectThreadDrop$,
  PROJECT_THREAD_DRAG_TYPE,
  projectThreadDropTargetId$,
} from "../../signals/projects/project-thread-drag.ts";

const PROJECT_DROP_ATTRIBUTE = "data-project-drop-id";

function dropProjectId(target: EventTarget | null): string | null | undefined {
  const id =
    target instanceof Element
      ? (target
          .closest(`[${PROJECT_DROP_ATTRIBUTE}]`)
          ?.getAttribute(PROJECT_DROP_ATTRIBUTE) ?? undefined)
      : undefined;
  // An empty id marks the chat list outside Projects; undefined is no target.
  return id === "" ? null : id;
}

/**
 * Every row of a Project accepts the drop for that Project. Its rows are
 * siblings in the virtual list, so the group is identified by its Project
 * rather than by a containing element. A null Project accepts chats back
 * into the outer list.
 */
export function useProjectThreadDropTarget({
  projectId,
  touch,
  moving,
  moveHere,
}: {
  readonly projectId: string | null;
  readonly touch: boolean;
  readonly moving: boolean;
  readonly moveHere: (projectId: string | null) => void;
}) {
  const draggingThread = useGet(draggingProjectThread$);
  const dropTargetId = useGet(projectThreadDropTargetId$);
  const hoverDrop = useSet(hoverProjectThreadDrop$);
  const leaveDrop = useSet(leaveProjectThreadDrop$);
  if (touch) {
    return { targeted: false, props: {} };
  }
  const acceptsDrop =
    draggingThread !== null &&
    draggingThread.projectId !== projectId &&
    !moving;
  return {
    targeted: acceptsDrop && dropTargetId === projectId,
    props: {
      [PROJECT_DROP_ATTRIBUTE]: projectId ?? "",
      onDragOver(event: DragEvent<HTMLElement>) {
        if (
          event.defaultPrevented ||
          dropProjectId(event.target) !== projectId ||
          !event.dataTransfer.types.includes(PROJECT_THREAD_DRAG_TYPE)
        ) {
          return;
        }
        if (!acceptsDrop) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        // Accept the nearest destination without overriding a nested Project.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        hoverDrop(projectId, { x: event.clientX, y: event.clientY });
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        // Moving between rows of the same Project keeps it targeted.
        if (dropProjectId(event.relatedTarget) === projectId) {
          return;
        }
        leaveDrop(projectId);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (
          event.defaultPrevented ||
          dropProjectId(event.target) !== projectId ||
          !acceptsDrop ||
          event.dataTransfer.getData(PROJECT_THREAD_DRAG_TYPE) !==
            draggingThread?.id
        ) {
          return;
        }
        event.preventDefault();
        moveHere(projectId);
      },
    },
  };
}
