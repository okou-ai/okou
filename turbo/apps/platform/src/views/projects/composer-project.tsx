import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, Folder, FolderPlus, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  composerProjectAvailable,
  type ComposerProjectSignals,
} from "../../signals/projects/composer-project.ts";
import { openProjectEditor$ } from "../../signals/projects/project-ui.ts";
import { projects$ } from "../../signals/projects/projects.ts";
import type { ComposerAddMenuItem } from "../okou-page/composer-add-menu.tsx";
import { ComposerChoiceChip } from "../okou-page/composer-create.tsx";
import { ProjectFolderIcon, projectNameParts } from "./project-icon.tsx";

function useComposerProjectAvailable(
  project: ComposerProjectSignals | undefined,
): boolean {
  return useLastResolved(composerProjectAvailable(project)) ?? false;
}

/**
 * The submenu's rows. A new Project opens once it is named; the current one is
 * marked and cannot be picked again, and leaving it is the last row.
 */
function ComposerProjectMenuItems({
  project,
}: {
  readonly project: ComposerProjectSignals;
}) {
  const { t } = useTranslation();
  const projects = useGet(projects$);
  const select = useSet(project.select$);
  const openEditor = useSet(openProjectEditor$);
  return (
    <>
      <DropdownMenuItem
        onClick={() => {
          openEditor({ fromComposer: true });
        }}
      >
        <FolderPlus className="text-muted-foreground" aria-hidden="true" />
        {t(($) => {
          return $.projects.new;
        })}
      </DropdownMenuItem>
      {projects.length > 0 && <DropdownMenuSeparator />}
      {projects.map((item) => {
        const current = item.id === project.projectId;
        return (
          <DropdownMenuItem
            key={item.id}
            disabled={current}
            onClick={() => {
              select(item.id);
            }}
          >
            <ProjectFolderIcon
              name={item.name}
              folderClassName="text-muted-foreground"
            />
            <span className="min-w-0 flex-1 truncate">
              {projectNameParts(item.name).text}
            </span>
            {current && <Check aria-hidden="true" />}
          </DropdownMenuItem>
        );
      })}
      {project.projectId && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              select(null);
            }}
          >
            <X className="text-muted-foreground" aria-hidden="true" />
            {t(($) => {
              return $.projects.remove;
            })}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

/** The `+` menu's Project row, on a new chat that can start in a Project. */
export function useComposerProjectMenuItem(
  signals: ComposerSignals,
): ComposerAddMenuItem | null {
  const { t } = useTranslation();
  const available = useComposerProjectAvailable(signals.project);
  if (!signals.project || !available) {
    return null;
  }
  return {
    id: "project",
    Icon: Folder,
    label: t(($) => {
      return $.projects.project;
    }),
    submenu: <ComposerProjectMenuItems project={signals.project} />,
  };
}

function ComposerProjectChip({
  project,
}: {
  readonly project: ComposerProjectSignals;
}) {
  const { t } = useTranslation();
  const available = useComposerProjectAvailable(project);
  const projects = useGet(projects$);
  const select = useSet(project.select$);
  const current = projects.find((item) => {
    return item.id === project.projectId;
  });
  if (!available || !current) {
    return null;
  }
  return (
    <>
      <div className="h-5 w-px shrink-0 bg-divider/60" aria-hidden />
      <ComposerChoiceChip
        icon={<ProjectFolderIcon name={current.name} />}
        label={projectNameParts(current.name).text}
        labelClassName="max-w-40 truncate"
        removeLabel={t(
          ($) => {
            return $.projects.removeFromNewChat;
          },
          { name: current.name },
        )}
        onRemove={() => {
          select(null);
        }}
      />
    </>
  );
}

/**
 * The Project this new chat starts in, after the toolbar's icons. It takes no
 * row of its own; with no Project the toolbar is unchanged and the `+` menu
 * offers one.
 */
export function ComposerProjectControl({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  return signals.project?.projectId ? (
    <ComposerProjectChip project={signals.project} />
  ) : null;
}
