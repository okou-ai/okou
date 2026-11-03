import { projectThreadItems$ } from "../../signals/projects/project-threads.ts";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Ellipsis,
  Folder,
  FolderOpen,
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
  cn,
} from "@okouai/ui";
import type { Project } from "@okouai/api-contracts/validators/projects";
import {
  projects$,
  projectsEnabled$,
} from "../../signals/projects/projects.ts";
import { newProjectThread$ } from "../../signals/projects/project-new-thread.ts";
import {
  openProjectEditor$,
  setProjectDialog$,
  projectDialog$,
} from "../../signals/projects/project-ui.ts";
import {
  archivedProjectIds$,
  expandedProjectIds$,
  projectThreadLimits$,
  showMoreProjectThreads$,
  toggleProject$,
  toggleProjectArchive$,
} from "../../signals/projects/project-folders.ts";
import { projectCreationAgentId$ } from "../../signals/projects/project-selected-agent.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatThreadItem } from "../okou-page/sidebar-threads.tsx";

function ProjectFolderMenu({
  project,
  archived,
  touch,
}: {
  project: Project;
  archived: boolean;
  touch: boolean;
}) {
  const { t } = useTranslation();
  const editor = useSet(openProjectEditor$);
  const open = useSet(setProjectDialog$);
  const toggleArchive = useSet(toggleProjectArchive$);
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
            className={cn("shrink-0", touch && "min-h-11 min-w-11")}
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
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" finalFocus={dialog ? false : undefined}>
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
        <DropdownMenuItem
          onClick={() => {
            return toggleArchive(project.id);
          }}
        >
          <Archive size={16} />
          {archived
            ? t(($) => {
                return $.projects.active;
              })
            : t(($) => {
                return $.projects.archived;
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

type ProjectSidebarLayout = "sidebar" | "list";

function ProjectFolderEmpty({
  archived,
  layout,
}: {
  archived: boolean;
  layout: ProjectSidebarLayout;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "py-2 text-xs text-nav-copy-muted",
        layout === "list" ? "px-3" : "px-2",
      )}
    >
      <p>
        {archived
          ? t(($) => {
              return $.projects.emptyArchive;
            })
          : t(($) => {
              return $.projects.empty;
            })}
      </p>
    </div>
  );
}

interface ProjectFolderProps {
  readonly project: Project;
  readonly touch: boolean;
  readonly layout: ProjectSidebarLayout;
}

function ProjectFolder({ project, touch, layout }: ProjectFolderProps) {
  const { t } = useTranslation();
  const agent = useLastResolved(projectCreationAgentId$);
  const expanded = useGet(expandedProjectIds$).has(project.id);
  const archived = useGet(archivedProjectIds$).has(project.id);
  const limit = useGet(projectThreadLimits$)[project.id] ?? 20;
  const items = useGet(projectThreadItems$).filter(({ thread }) => {
    return thread.projectId === project.id && thread.archived === archived;
  });
  const toggle = useSet(toggleProject$);
  const showMore = useSet(showMoreProjectThreads$);
  const [creation, create] = useLoadableSet(newProjectThread$);
  const signal = useGet(rootSignal$);
  const Icon = expanded ? FolderOpen : Folder;
  const contentsId = `project-threads-${touch ? "touch" : "sidebar"}-${project.id}`;
  function newChat() {
    detach(create(project.id, signal), Reason.DomCallback);
  }
  return (
    <div data-project-folder-id={project.id}>
      <div className="group/project flex min-w-0 items-center rounded-lg hover:bg-state-hover">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentsId}
          onClick={() => {
            return toggle(project.id);
          }}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm text-nav-copy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            touch ? "min-h-12" : "h-8",
            layout === "list" && "h-14 px-3 text-base leading-5",
          )}
        >
          <Icon size={16} className="shrink-0 opacity-70" />
          <span className="truncate">{project.name}</span>
        </button>
        <div
          className={cn(
            "flex shrink-0 items-center md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/project:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100",
            layout === "list" ? "gap-1" : "gap-0.5",
          )}
        >
          <Button
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn("shrink-0", touch && "min-h-11 min-w-11")}
            aria-label={t(($) => {
              return $.projects.newChat;
            })}
            disabled={creation.state === "loading"}
            onClick={newChat}
          >
            <Plus />
          </Button>
          <ProjectFolderMenu
            project={project}
            archived={archived}
            touch={touch}
          />
        </div>
      </div>
      {creation.state === "hasError" && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {t(($) => {
            return $.projects.createChatError;
          })}
        </p>
      )}
      {expanded && (
        <div
          id={contentsId}
          className="ml-6 min-w-0 pb-1"
          aria-label={project.name}
        >
          {archived && (
            <p
              className={cn(
                "py-1 text-xs text-nav-copy-muted",
                layout === "list" ? "px-3" : "px-2",
              )}
            >
              {t(($) => {
                return $.projects.archived;
              })}
            </p>
          )}
          {items.length === 0 ? (
            <ProjectFolderEmpty archived={archived} layout={layout} />
          ) : (
            items.slice(0, limit).map(({ signals }, index) => {
              return (
                <ChatThreadItem
                  key={signals.threadId}
                  signals={signals}
                  rowIndex={index}
                  shortcutNumber={undefined}
                  touch={touch}
                  projectContext={
                    agent
                      ? { projectId: project.id, agentId: agent }
                      : undefined
                  }
                />
              );
            })
          )}
          {items.length > limit && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                return showMore(project.id);
              }}
            >
              {t(($) => {
                return $.projects.showMore;
              })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function ProjectSidebar({
  touch = false,
  layout = "sidebar",
}: {
  touch?: boolean;
  layout?: ProjectSidebarLayout;
}) {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const projects = useGet(projects$);
  const open = useSet(openProjectEditor$);
  if (!enabled) {
    return null;
  }
  return (
    <section
      data-project-sidebar=""
      aria-label={t(($) => {
        return $.projects.projects;
      })}
      className={cn(
        "min-h-0 shrink-0 pb-2",
        touch && layout === "sidebar" ? "px-2" : "px-3",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between",
          touch ? "min-h-12 pl-2 pr-2" : "h-8 pl-2",
          layout === "list" && "pl-3 pr-0",
        )}
      >
        <span className="text-[13px] leading-4 text-nav-copy-muted">
          {t(($) => {
            return $.projects.projects;
          })}
        </span>
        <Button
          variant="quiet"
          size="icon-sm"
          iconSize="md"
          className={cn("shrink-0", touch && "min-h-11 min-w-11")}
          data-project-create=""
          aria-label={t(($) => {
            return $.projects.create;
          })}
          onClick={() => {
            return open();
          }}
        >
          <Plus />
        </Button>
      </div>
      <div className="max-h-[45dvh] overflow-y-auto">
        {projects.map((project) => {
          return (
            <ProjectFolder
              key={project.id}
              project={project}
              touch={touch}
              layout={layout}
            />
          );
        })}
      </div>
    </section>
  );
}
