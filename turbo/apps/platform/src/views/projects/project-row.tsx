import {
  projectIndicatorStates$,
  type ProjectIndicatorState,
} from "../../signals/projects/project-threads.ts";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Trash,
} from "lucide-react";
import {
  Button,
  buttonVariants,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import type { Project } from "@okouai/api-contracts/validators/projects";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { projects$ } from "../../signals/projects/projects.ts";
import {
  projectReorderEnabled$,
  stepProject$,
} from "../../signals/projects/project-order.ts";
import {
  openProjectEditor$,
  setProjectDialog$,
  projectDialog$,
} from "../../signals/projects/project-ui.ts";
import {
  setProjectExpandedWithMotion$,
  toggleProjectWithMotion$,
} from "../../signals/projects/project-fold.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { ChatThreadMenuShortcut } from "../okou-page/chat-thread-menu-shortcut.tsx";
import { HoverScrollTitle } from "../okou-page/hover-scroll-title.tsx";
import { useTitleReveal } from "../okou-page/use-title-reveal.ts";
import type {
  ChatThreadListRow,
  ProjectChatThreadListRow,
} from "../../signals/chat-page/chat-thread-list-rows.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { selectChatThreadFilter$ } from "../../signals/okou-page/chat-thread-filter-selection.ts";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import { Link } from "../router/link.tsx";
import { ProjectFolderIcon, projectNameParts } from "./project-icon.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ChatThreadStateIndicator,
  ChatThreadStateText,
} from "../okou-page/sidebar-shared.tsx";

export type ProjectRowLayout = "sidebar" | "list";

interface ProjectRowProps {
  readonly project: Project;
  readonly touch: boolean;
  readonly layout: ProjectRowLayout;
}

function ProjectFoldMenuItem({
  project,
  expanded,
}: {
  project: Project;
  expanded: boolean;
}) {
  const { t } = useTranslation();
  const fold = useSet(setProjectExpandedWithMotion$);
  const signal = useGet(pageSignal$);
  const shortcut = expanded
    ? GLOBAL_KEYBOARD_SHORTCUTS.collapseProject
    : GLOBAL_KEYBOARD_SHORTCUTS.expandProject;
  const label = expanded
    ? t(($) => {
        return $.projects.collapse;
      })
    : t(($) => {
        return $.projects.expand;
      });
  const Icon = expanded ? Folder : FolderOpen;
  return (
    <DropdownMenuItem
      aria-label={label}
      aria-keyshortcuts={shortcut.ariaKeyShortcuts}
      onClick={() => {
        detach(fold(project.id, !expanded, signal), Reason.DomCallback);
      }}
    >
      <Icon size={16} />
      {label}
      <ChatThreadMenuShortcut shortcut={shortcut.binding} />
    </DropdownMenuItem>
  );
}

function ProjectMoveMenuItems({ project }: { project: Project }) {
  const { t } = useTranslation();
  const enabled = useGet(projectReorderEnabled$);
  const projects = useGet(projects$);
  const [moving, move] = useLoadableSet(stepProject$);
  const signal = useGet(pageSignal$);
  if (!enabled) {
    return null;
  }
  const index = projects.findIndex((item) => {
    return item.id === project.id;
  });
  return ([-1, 1] as const).map((direction) => {
    const shortcut =
      direction < 0
        ? GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinUp
        : GLOBAL_KEYBOARD_SHORTCUTS.moveChatPinDown;
    const label =
      direction < 0
        ? t(($) => {
            return $.chat.sidebar.movePinUp;
          })
        : t(($) => {
            return $.chat.sidebar.movePinDown;
          });
    const Icon = direction < 0 ? ArrowUp : ArrowDown;
    return (
      <DropdownMenuItem
        key={direction}
        aria-label={label}
        aria-keyshortcuts={shortcut.ariaKeyShortcuts}
        aria-busy={moving.state === "loading"}
        disabled={
          moving.state === "loading" ||
          index === -1 ||
          projects[index + direction] === undefined
        }
        onClick={() => {
          detach(move(project.id, direction, signal), Reason.DomCallback);
        }}
      >
        <Icon size={16} />
        {label}
        <ChatThreadMenuShortcut shortcut={shortcut.binding} />
      </DropdownMenuItem>
    );
  });
}

function ProjectMenu({
  project,
  touch,
  indicator,
  rowIndex,
  expanded,
}: {
  project: Project;
  touch: boolean;
  indicator: ProjectIndicatorState | null;
  rowIndex: number;
  expanded: boolean;
}) {
  const { t } = useTranslation();
  const editor = useSet(openProjectEditor$);
  const open = useSet(setProjectDialog$);
  const dialog = useGet(projectDialog$);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-project-menu-id={project.id}
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn(
              "group/project-menu pointer-events-auto shrink-0",
              touch && "min-h-11 min-w-11",
            )}
            aria-label={t(
              ($) => {
                return $.projects.options;
              },
              {
                name: project.name,
              },
            )}
          />
        }
      >
        {indicator !== null ? (
          <>
            <span
              aria-hidden="true"
              data-testid="project-state-indicator"
              className="flex items-center justify-center md:group-hover/project:hidden group-focus-visible/project-menu:hidden md:group-data-[popup-open]/project-menu:hidden"
            >
              <ChatThreadStateIndicator state={indicator} rowIndex={rowIndex} />
            </span>
            <Ellipsis className="hidden md:group-hover/project:block group-focus-visible/project-menu:block md:group-data-[popup-open]/project-menu:block" />
          </>
        ) : (
          <Ellipsis />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        finalFocus={dialog ? false : undefined}
        data-project-menu-content-id={project.id}
      >
        <ProjectMoveMenuItems project={project} />
        <ProjectFoldMenuItem project={project} expanded={expanded} />
        <DropdownMenuItem
          onClick={() => {
            return editor({ projectId: project.id }, project.name);
          }}
        >
          <Pencil size={16} />
          {t(($) => {
            return $.projects.rename;
          })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            return open({ kind: "delete", projectId: project.id });
          }}
        >
          <Trash size={16} />
          {t(($) => {
            return $.projects.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectActions({
  project,
  touch,
  layout,
  indicator,
  rowIndex,
  expanded,
  active,
  titleRevealEnabled,
}: ProjectRowProps & {
  indicator: ProjectIndicatorState | null;
  rowIndex: number;
  expanded: boolean;
  active: boolean;
  titleRevealEnabled: boolean;
}) {
  const { t } = useTranslation();
  // The state glyph stands where the menu dots would, so it keeps the menu
  // visible at rest and only the other actions wait for hover or focus.
  const resting = indicator !== null;
  const label = t(
    ($) => {
      return $.projects.openHome;
    },
    { name: project.name },
  );
  return (
    <div
      className={cn(
        "group/project-actions flex items-center group-hover/project:opacity-100 group-focus-within/project:opacity-100 has-[[data-popup-open]]:opacity-100",
        titleRevealEnabled
          ? "pointer-events-none col-start-1 row-start-1 justify-self-end"
          : "shrink-0",
        !resting && "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0",
        layout === "list" ? "gap-1" : "gap-0.5",
      )}
    >
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                pathname="/projects/:projectId"
                options={{ pathParams: { projectId: project.id } }}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  buttonVariants({
                    variant: "quiet",
                    size: "icon-sm",
                    iconSize: "md",
                  }),
                  "pointer-events-auto shrink-0",
                  touch && "min-h-11 min-w-11",
                  resting &&
                    "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 group-has-[[data-popup-open]]/project:opacity-100",
                )}
              />
            }
          >
            <Plus />
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <ProjectMenu
        project={project}
        touch={touch}
        indicator={indicator}
        rowIndex={rowIndex}
        expanded={expanded}
      />
    </div>
  );
}

function ProjectTrigger({
  project,
  layout,
  touch,
  expanded,
  active,
  indicator,
  titleRevealEnabled,
}: {
  readonly project: Project;
  readonly layout: ProjectRowLayout;
  readonly touch: boolean;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly indicator: ProjectIndicatorState | null;
  readonly titleRevealEnabled: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useSet(toggleProjectWithMotion$);
  const signal = useGet(pageSignal$);
  const titleReveal = useTitleReveal();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const stateId = `project-state-${layout}-${project.id}`;
  const shortcut = expanded
    ? GLOBAL_KEYBOARD_SHORTCUTS.collapseProject
    : GLOBAL_KEYBOARD_SHORTCUTS.expandProject;
  return (
    <button
      {...(titleRevealEnabled ? titleReveal : {})}
      type="button"
      data-project-trigger=""
      aria-expanded={expanded}
      aria-label={t(
        ($) => {
          return $.projects.toggle;
        },
        { name: project.name },
      )}
      aria-describedby={indicator !== null ? stateId : undefined}
      aria-keyshortcuts={shortcut.ariaKeyShortcuts}
      onClick={() => {
        detach(toggle(project.id, signal), Reason.DomCallback);
      }}
      className={cn(
        "group/project-fold flex min-w-0 items-center rounded-lg text-left text-sm text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        titleRevealEnabled ? "col-start-1 row-start-1" : "flex-1 pr-2",
        layout === "list" ? "h-14 gap-2 text-base leading-5" : "h-8",
        titleRevealEnabled &&
          (touch
            ? "pr-24"
            : "pr-18 md:[@media(hover:hover)_and_(pointer:fine)]:pr-8 group-hover/project:pr-18 group-focus-within/project:pr-18 group-has-[[data-popup-open]]/project:pr-18"),
        active && "font-medium",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex shrink-0 items-center justify-center",
          layout === "list" ? "w-10 pl-3 pr-1" : "w-8 px-1",
        )}
      >
        <ProjectFolderIcon
          name={project.name}
          open={expanded}
          className="md:group-hover/project:hidden group-focus-visible/project-fold:hidden"
          folderClassName="opacity-70"
        />
        <Chevron
          size={16}
          className="hidden opacity-70 md:group-hover/project:block group-focus-visible/project-fold:block"
        />
      </span>
      {titleRevealEnabled ? (
        <HoverScrollTitle title={projectNameParts(project.name).text} />
      ) : (
        <span className="truncate">{projectNameParts(project.name).text}</span>
      )}
      {indicator !== null && (
        <span id={stateId}>
          <ChatThreadStateText state={indicator} />
        </span>
      )}
    </button>
  );
}

/** A Project's row folds its chats and links to its home. */
export function ProjectRow({
  row,
  rowIndex,
  touch,
  layout,
}: {
  readonly row: ProjectChatThreadListRow;
  /** The row's position in the whole chat list. */
  readonly rowIndex: number;
  readonly touch: boolean;
  readonly layout: ProjectRowLayout;
}) {
  const { project, expanded } = row;
  const titleRevealEnabled =
    useLastResolved(featureSwitches$)?.[FeatureSwitchKey.ProjectTitleReveal] ===
    true;
  // A Project's page makes its row the list's current item.
  const active = useGet(selectedProjectId$) === project.id;
  const state =
    useLastResolved(projectIndicatorStates$)?.get(project.id) ?? null;
  // An unfolded Project leaves each state to the chat row that owns it.
  const indicator = expanded ? null : state;
  return (
    <div
      className={cn(
        "group/project min-w-0 items-center rounded-lg motion-safe:transition-colors motion-safe:duration-[180ms]",
        titleRevealEnabled ? "grid grid-cols-[minmax(0,1fr)]" : "flex",
        active ? "bg-state-selected" : "hover:bg-state-hover",
      )}
    >
      <ProjectTrigger
        project={project}
        layout={layout}
        touch={touch}
        expanded={expanded}
        active={active}
        indicator={indicator}
        titleRevealEnabled={titleRevealEnabled}
      />
      <ProjectActions
        project={project}
        touch={touch}
        layout={layout}
        indicator={indicator}
        rowIndex={rowIndex}
        expanded={expanded}
        active={active}
        titleRevealEnabled={titleRevealEnabled}
      />
    </div>
  );
}

/**
 * What an unfolded Project shows in place of its chats when the list has none:
 * the empty notice, then the way to its archived chats when it holds any.
 */
export function ProjectStatusRow({
  row,
  layout,
}: {
  readonly row: Extract<
    ChatThreadListRow,
    { readonly kind: "project-empty" | "project-archived" }
  >;
  readonly layout: ProjectRowLayout;
}) {
  const { t } = useTranslation();
  const selectFilter = useSet(selectChatThreadFilter$);
  const signal = useGet(pageSignal$);
  if (row.kind === "project-empty") {
    return (
      <p
        className={cn(
          "flex items-center text-xs text-nav-copy-muted",
          layout === "list" ? "h-14 px-3" : "h-8 px-2",
        )}
      >
        {t(($) => {
          return $.projects.empty;
        })}
      </p>
    );
  }
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "w-full justify-start font-normal text-nav-copy-muted",
        layout === "list" ? "h-14 px-3" : "h-8 px-2",
      )}
      onClick={() => {
        detach(selectFilter("archived", signal), Reason.DomCallback);
      }}
    >
      {t(($) => {
        return $.chat.sidebar.showArchivedChats;
      })}
    </Button>
  );
}

export function ProjectCreateButton({ touch = false }: { touch?: boolean }) {
  const { t } = useTranslation();

  const open = useSet(openProjectEditor$);

  const label = t(($) => {
    return $.projects.create;
  });
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="quiet"
              size={touch ? "icon" : "icon-sm"}
              iconSize={touch ? "lg" : "md"}
              className={cn("shrink-0", touch && "min-h-11 min-w-11")}
              data-project-create=""
              aria-label={label}
              onClick={() => {
                return open();
              }}
            >
              <FolderPlus />
            </Button>
          }
        />
        <TooltipContent side="bottom">
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
