import {
  projectIndicatorStates$,
  type ProjectIndicatorState,
} from "../../signals/projects/project-threads.ts";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
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
  getShortcutLabel,
} from "@okouai/ui";
import type { Project } from "@okouai/api-contracts/validators/projects";
import { projectsEnabled$ } from "../../signals/projects/projects.ts";
import { newProjectThread$ } from "../../signals/projects/project-new-thread.ts";
import {
  openProjectEditor$,
  setProjectDialog$,
  projectDialog$,
} from "../../signals/projects/project-ui.ts";
import {
  collapseProject$,
  expandProject$,
  toggleProject$,
} from "../../signals/projects/project-expansion.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { ChatThreadMenuShortcut } from "../okou-page/chat-thread-menu-shortcut.tsx";
import type {
  ChatThreadListRow,
  ProjectChatThreadListRow,
} from "../../signals/chat-page/chat-thread-list-rows.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { selectChatThreadFilter$ } from "../../signals/okou-page/chat-thread-filter-selection.ts";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import {
  clickProjectName$,
  selectedProjectId$,
} from "../../signals/projects/project-navigation.ts";
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
  const collapse = useSet(collapseProject$);
  const expand = useSet(expandProject$);
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
        if (expanded) {
          collapse(project.id);
        } else {
          expand(project.id);
        }
      }}
    >
      <Icon size={16} />
      {label}
      <ChatThreadMenuShortcut shortcut={shortcut.binding} />
    </DropdownMenuItem>
  );
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
              "group/project-menu shrink-0",
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
  creating,
  onNewChat,
}: ProjectRowProps & {
  indicator: ProjectIndicatorState | null;
  rowIndex: number;
  expanded: boolean;
  creating: boolean;
  /** Null when the row only carries its menu, as in My Okou's chat list. */
  onNewChat: (() => void) | null;
}) {
  const { t } = useTranslation();
  // The state glyph stands where the menu dots would, so it keeps the menu
  // visible at rest and only the other actions wait for hover or focus.
  const resting = indicator !== null;
  return (
    <div
      className={cn(
        "group/project-actions flex shrink-0 items-center group-hover/project:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100",
        !resting && "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0",
        layout === "list" ? "gap-1" : "gap-0.5",
      )}
    >
      {onNewChat ? (
        <Button
          variant="quiet"
          size="icon-sm"
          iconSize="md"
          className={cn(
            "shrink-0",
            touch && "min-h-11 min-w-11",
            resting &&
              "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/project:opacity-100 group-focus-within/project-actions:opacity-100 group-has-[[data-popup-open]]/project:opacity-100",
          )}
          aria-label={t(($) => {
            return $.projects.newChat;
          })}
          disabled={creating}
          onClick={onNewChat}
        >
          <Plus />
        </Button>
      ) : null}
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

/**
 * The folder folds the Project's chats. Hovering the row turns it into the fold
 * arrow, and its tooltip names the action and shortcut. The folder wears the
 * name's emoji as a badge.
 */
function ProjectFoldToggle({
  project,
  layout,
  expanded,
}: {
  readonly project: Project;
  readonly layout: ProjectRowLayout;
  readonly expanded: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useSet(toggleProject$);
  const Chevron = expanded ? ChevronDown : ChevronRight;
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
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={t(
                ($) => {
                  return $.projects.toggle;
                },
                { name: project.name },
              )}
              aria-keyshortcuts={shortcut.ariaKeyShortcuts}
              onClick={() => {
                return toggle(project.id);
              }}
              className={cn(
                "group/project-fold flex shrink-0 items-center justify-center rounded-lg text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                layout === "list" ? "h-14 w-10 pl-3 pr-1" : "h-8 w-8 px-1",
              )}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md group-hover/project-fold:bg-nested-fill">
                <ProjectFolderIcon
                  name={project.name}
                  open={expanded}
                  className="md:group-hover/project:hidden group-focus-visible/project-fold:hidden"
                  folderClassName="opacity-70 group-hover/project-fold:opacity-100"
                />
                <Chevron
                  size={16}
                  className="hidden opacity-70 group-hover/project-fold:opacity-100 md:group-hover/project:block group-focus-visible/project-fold:block"
                />
              </span>
            </button>
          }
        />
        <TooltipContent
          role="tooltip"
          side="bottom"
          className="flex flex-col items-center gap-1 py-1.5"
        >
          <span>{label}</span>
          <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
            {getShortcutLabel(shortcut.binding)}
          </kbd>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ProjectTrigger({
  project,
  layout,
  expanded,
  active,
  indicator,
}: {
  readonly project: Project;
  readonly layout: ProjectRowLayout;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly indicator: ProjectIndicatorState | null;
}) {
  const clickName = useSet(clickProjectName$);
  return (
    <div className="flex min-w-0 flex-1 items-center">
      {/* The folder folds the Project's chats. The name opens its page and
          unfolds its chats; on that page, clicking it again folds or
          unfolds them. */}
      <ProjectFoldToggle
        project={project}
        layout={layout}
        expanded={expanded}
      />
      <Link
        pathname="/projects/:projectId"
        options={{ pathParams: { projectId: project.id } }}
        data-project-trigger=""
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          clickName(project.id, event);
        }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-sm text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          layout === "list" ? "h-14 pl-2 text-base leading-5" : "h-8",
          active && "font-medium",
        )}
      >
        <span className="truncate">{projectNameParts(project.name).text}</span>
        <ChatThreadStateText state={indicator} />
      </Link>
    </div>
  );
}

/** A Project's own row: it folds its chats and starts new ones inside it. */
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
  const { t } = useTranslation();
  const { project, expanded } = row;
  // A Project's page makes its row the list's current item.
  const active = useGet(selectedProjectId$) === project.id;
  const state =
    useLastResolved(projectIndicatorStates$)?.get(project.id) ?? null;
  // An unfolded Project leaves each state to the chat row that owns it.
  const indicator = expanded ? null : state;
  const [creation, create] = useLoadableSet(newProjectThread$);
  const signal = useGet(rootSignal$);
  // My Okou starts chats from the list's New chat row, so a Project row keeps
  // only its menu.
  const singleAgent = useGet(singleAgentEnabled$);
  function newChat() {
    detach(create(project.id, signal), Reason.DomCallback);
  }
  return (
    <div
      className={cn(
        "group/project flex min-w-0 items-center rounded-lg motion-safe:transition-colors motion-safe:duration-[180ms]",
        active ? "bg-state-selected" : "hover:bg-state-hover",
      )}
    >
      <ProjectTrigger
        project={project}
        layout={layout}
        expanded={expanded}
        active={active}
        indicator={indicator}
      />
      {creation.state === "hasError" && (
        <span role="alert" className="shrink-0 px-1 text-xs text-destructive">
          {t(($) => {
            return $.projects.createChatError;
          })}
        </span>
      )}
      <ProjectActions
        project={project}
        touch={touch}
        layout={layout}
        indicator={indicator}
        rowIndex={rowIndex}
        expanded={expanded}
        creating={creation.state === "loading"}
        onNewChat={singleAgent ? null : newChat}
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
  const enabled = useGet(projectsEnabled$);
  const open = useSet(openProjectEditor$);
  if (!enabled) {
    return null;
  }
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
