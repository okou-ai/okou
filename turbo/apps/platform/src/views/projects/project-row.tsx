import { unreadProjectIds$ } from "../../signals/projects/project-threads.ts";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
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
  showMoreProjectThreads$,
  toggleProject$,
} from "../../signals/projects/project-expansion.ts";
import { GLOBAL_KEYBOARD_SHORTCUTS } from "../../lib/global-keyboard-shortcuts.ts";
import { ChatThreadMenuShortcut } from "../okou-page/chat-thread-menu-shortcut.tsx";
import type {
  ChatThreadListRow,
  ProjectChatThreadListRow,
} from "../../signals/chat-page/chat-thread-list-rows.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import { Link } from "../router/link.tsx";
import { shouldHandleLinkClick } from "../router/link-click.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatThreadStateText } from "../okou-page/sidebar-shared.tsx";
import {
  cancelProjectInlineRename$,
  commitProjectInlineRename$,
  projectInlineRename$,
  projectInlineRenameInputRef$,
  startProjectInlineRename$,
  type ProjectInlineRename,
} from "../../signals/projects/project-inline-rename.ts";

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
  unread,
  expanded,
}: {
  project: Project;
  touch: boolean;
  unread: boolean;
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
        {unread ? (
          <>
            <span
              aria-hidden="true"
              data-testid="project-unread-indicator"
              className="flex items-center justify-center md:group-hover/project:hidden group-focus-visible/project-menu:hidden md:group-data-[popup-open]/project-menu:hidden"
            >
              <span className="h-2 w-2 rounded-full bg-sky-600" />
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
  unread,
  expanded,
  creating,
  onNewChat,
}: ProjectRowProps & {
  unread: boolean;
  expanded: boolean;
  creating: boolean;
  /** Null when the row only carries its menu, as in My Okou's chat list. */
  onNewChat: (() => void) | null;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group/project-actions flex shrink-0 items-center group-hover/project:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100",
        !unread && "md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0",
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
            unread &&
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
        unread={unread}
        expanded={expanded}
      />
    </div>
  );
}

function ProjectRenameForm({
  project,
  touch,
  layout,
  expanded,
  edit,
}: ProjectRowProps & {
  readonly expanded: boolean;
  readonly edit: ProjectInlineRename;
}) {
  const { t } = useTranslation();
  const commit = useSet(commitProjectInlineRename$);
  const cancel = useSet(cancelProjectInlineRename$);
  const inputRef = useSet(projectInlineRenameInputRef$);
  // Clicking another chat can end the route before the blur's save is sent.
  const signal = useGet(rootSignal$);
  const Icon = expanded ? FolderOpen : Folder;

  function returnFocusToProject(form: HTMLFormElement) {
    form.parentElement
      ?.querySelector<HTMLElement>("[data-project-trigger]")
      ?.focus();
  }

  return (
    <form
      className={cn(
        "col-start-1 row-start-1 flex min-w-0 items-center gap-2 rounded-lg px-2 text-sm text-nav-copy ring-2 ring-inset ring-ring",
        layout === "list" ? "h-14 px-3 text-base leading-5" : "h-8",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        returnFocusToProject(event.currentTarget);
      }}
      onKeyDown={(event) => {
        // Safari can end composition before its confirming Enter keydown.
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.key === "Enter") {
            event.preventDefault();
          }
          return;
        }
        if (event.key === "Escape") {
          cancel(edit);
          returnFocusToProject(event.currentTarget);
        }
      }}
    >
      <Icon size={16} className="shrink-0 opacity-70" />
      <input
        ref={inputRef}
        name="name"
        type="text"
        aria-label={t(($) => {
          return $.projects.name;
        })}
        defaultValue={project.name}
        maxLength={120}
        autoComplete="off"
        className={cn(
          "min-w-0 flex-1 bg-transparent p-0 outline-none",
          touch && "text-base",
        )}
        onBlur={(event) => {
          detach(
            commit(edit, event.currentTarget.value, signal),
            Reason.DomCallback,
          );
        }}
      />
    </form>
  );
}

function ProjectTrigger({
  project,
  touch,
  layout,
  expanded,
  active,
  rowId,
  unread,
}: ProjectRowProps & {
  readonly expanded: boolean;
  readonly active: boolean;
  readonly rowId: string;
  readonly unread: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useSet(toggleProject$);
  const expand = useSet(expandProject$);
  const edit = useGet(projectInlineRename$);
  const renaming = edit?.rowId === rowId;
  const startRename = useSet(startProjectInlineRename$);
  const Icon = expanded ? FolderOpen : Folder;
  const rowHeight = layout === "list" ? "h-14" : "h-8";
  return (
    <div className="grid min-w-0 flex-1">
      <div
        className={cn(
          "col-start-1 row-start-1 flex min-w-0 items-center",
          renaming && "invisible",
        )}
      >
        {/* The folder folds the Project's chats; the name opens its page and
            unfolds its chats. */}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t(
            ($) => {
              return $.projects.toggle;
            },
            { name: project.name },
          )}
          onClick={() => {
            return toggle(project.id);
          }}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-lg text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            rowHeight,
            layout === "list" ? "w-10 pl-3 pr-1" : "w-8 px-2",
          )}
        >
          <Icon size={16} className="shrink-0 opacity-70" />
        </button>
        <Link
          pathname="/projects/:projectId"
          options={{ pathParams: { projectId: project.id } }}
          data-project-trigger=""
          aria-current={active ? "page" : undefined}
          onClick={(event) => {
            // Unfold only when the click opens the page here, not in a new
            // tab or window.
            if (shouldHandleLinkClick(event)) {
              expand(project.id);
            }
          }}
          onDoubleClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            startRename(project.id, rowId);
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-sm text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            rowHeight,
            layout === "list" && "pl-2 text-base leading-5",
            active && "font-medium",
          )}
        >
          <span className="truncate">{project.name}</span>
          <ChatThreadStateText state={unread ? "unread" : null} />
        </Link>
      </div>
      {renaming && (
        <ProjectRenameForm
          project={project}
          touch={touch}
          layout={layout}
          expanded={expanded}
          edit={edit}
        />
      )}
    </div>
  );
}

/** A Project's own row: it folds its chats and starts new ones inside it. */
export function ProjectRow({
  row,
  touch,
  layout,
}: {
  readonly row: ProjectChatThreadListRow;
  readonly touch: boolean;
  readonly layout: ProjectRowLayout;
}) {
  const { t } = useTranslation();
  const { project, expanded } = row;
  // A Project's page makes its row the list's current item.
  const active = useGet(selectedProjectId$) === project.id;
  const unread = useLastResolved(unreadProjectIds$)?.has(project.id) ?? false;
  const showUnread = !expanded && unread;
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
        touch={touch}
        layout={layout}
        expanded={expanded}
        active={active}
        rowId={`project-${touch ? "touch" : "sidebar"}-${project.id}`}
        unread={showUnread}
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
        unread={showUnread}
        expanded={expanded}
        creating={creation.state === "loading"}
        onNewChat={singleAgent ? null : newChat}
      />
    </div>
  );
}

/** The empty notice or "show more" control that closes a Project's chats. */
export function ProjectStatusRow({
  row,
  layout,
}: {
  readonly row: Extract<
    ChatThreadListRow,
    { readonly kind: "project-more" | "project-empty" }
  >;
  readonly layout: ProjectRowLayout;
}) {
  const { t } = useTranslation();
  const showMore = useSet(showMoreProjectThreads$);
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
        "w-full justify-start text-nav-copy-muted",
        layout === "list" ? "h-14 px-3" : "h-8 px-2",
      )}
      onClick={() => {
        return showMore(row.projectId);
      }}
    >
      {t(($) => {
        return $.projects.showMore;
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
