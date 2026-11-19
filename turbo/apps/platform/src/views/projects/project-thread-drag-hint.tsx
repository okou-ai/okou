import { useGet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FolderInput, FolderOutput } from "lucide-react";
import { Tooltip, TooltipContent } from "@okouai/ui";
import { projectThreadDragHint$ } from "../../signals/projects/project-thread-drag.ts";

export function ProjectThreadDragHint() {
  const { t } = useTranslation();
  const hint = useGet(projectThreadDragHint$);
  if (!hint) {
    return null;
  }
  return (
    <Tooltip open disableHoverablePopup>
      <TooltipContent
        role="tooltip"
        anchor={{
          getBoundingClientRect() {
            return new DOMRect(hint.x, hint.y, 0, 0);
          },
        }}
        side="bottom"
        align="start"
        sideOffset={12}
        alignOffset={12}
        className="pointer-events-none flex items-center gap-1.5 transition-none"
      >
        {hint.projectId === null ? (
          <FolderOutput size={14} className="shrink-0" />
        ) : (
          <FolderInput size={14} className="shrink-0" />
        )}
        <span className="truncate">
          {hint.projectId === null
            ? t(($) => {
                return $.projects.remove;
              })
            : t(
                ($) => {
                  return $.projects.moveTo;
                },
                { name: hint.name },
              )}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
