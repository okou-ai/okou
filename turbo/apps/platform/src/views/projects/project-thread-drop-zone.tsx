import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { cn } from "@okouai/ui";
import type { Project } from "@okouai/api-contracts/validators/projects";
import {
  draggingProjectThread$,
  hoverProjectThreadDrop$,
  leaveProjectThreadDrop$,
  moveDraggedProjectThread$,
  PROJECT_THREAD_DRAG_TYPE,
  projectThreadDropTargetId$,
} from "../../signals/projects/project-thread-drag.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function ProjectThreadDropZone({
  project,
  touch,
  children,
}: {
  readonly project: Project;
  readonly touch: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const signal = useGet(rootSignal$);
  const draggingThread = useGet(draggingProjectThread$);
  const dropTargetId = useGet(projectThreadDropTargetId$);
  const hoverDrop = useSet(hoverProjectThreadDrop$);
  const leaveDrop = useSet(leaveProjectThreadDrop$);
  const [moving, moveHere] = useLoadableSet(moveDraggedProjectThread$);
  const acceptsDrop =
    !touch &&
    draggingThread !== null &&
    draggingThread.projectId !== project.id &&
    moving.state !== "loading";
  const targeted = acceptsDrop && dropTargetId === project.id;
  return (
    <div
      data-project-folder-id={project.id}
      data-project-drop-target={targeted ? "" : undefined}
      className={cn(
        "rounded-lg outline outline-1 outline-transparent -outline-offset-1",
        targeted && "bg-state-hover outline-[hsl(var(--gray-400))]",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(PROJECT_THREAD_DRAG_TYPE)) {
          return;
        }
        if (!acceptsDrop) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        // The folder owns the drop, including its child chat rows and padding.
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        hoverDrop(project.id, { x: event.clientX, y: event.clientY });
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        leaveDrop(project.id);
      }}
      onDrop={(event) => {
        if (
          !acceptsDrop ||
          event.dataTransfer.getData(PROJECT_THREAD_DRAG_TYPE) !==
            draggingThread?.id
        ) {
          return;
        }
        event.preventDefault();
        detach(moveHere(project.id, signal), Reason.DomCallback);
      }}
    >
      {children}
      {moving.state === "hasError" && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {t(($) => {
            return $.projects.moveError;
          })}
        </p>
      )}
    </div>
  );
}
