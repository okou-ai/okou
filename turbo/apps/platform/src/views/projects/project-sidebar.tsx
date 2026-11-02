import { projectThreadItems$ } from "../../signals/projects/project-threads.ts";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Archive,
  ChevronDown,
  ChevronRight,
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
  newProjectThread$,
} from "../../signals/projects/projects.ts";
import {
  openProjectEditor$,
  setProjectDialog$,
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
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="icon-2xs"
            className={cn("rounded-md", touch && "min-h-11 min-w-11")}
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
        <Ellipsis size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
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

function ProjectFolderEmpty({
  archived,
  pending,
  onNewChat,
}: {
  archived: boolean;
  pending: boolean;
  onNewChat: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-2 py-2 text-xs text-muted-foreground">
      <p>
        {archived
          ? t(($) => {
              return $.projects.emptyArchive;
            })
          : t(($) => {
              return $.projects.empty;
            })}
      </p>
      {!archived && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 -ml-2 text-xs"
          disabled={pending}
          onClick={onNewChat}
        >
          <Plus size={14} />
          {t(($) => {
            return $.projects.newChat;
          })}
        </Button>
      )}
    </div>
  );
}

interface ProjectFolderProps {
  readonly project: Project;
  readonly touch: boolean;
}

function ProjectFolder({ project, touch }: ProjectFolderProps) {
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
  const signal = useGet(pageSignal$);
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
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-sm text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            touch ? "min-h-12" : "h-8",
          )}
        >
          {expanded ? (
            <ChevronDown size={14} className="shrink-0 opacity-50" />
          ) : (
            <ChevronRight size={14} className="shrink-0 opacity-50" />
          )}
          <Icon size={16} className="shrink-0 opacity-70" />
          <span className="truncate">{project.name}</span>
        </button>
        <div className="flex shrink-0 items-center md:[@media(hover:hover)_and_(pointer:fine)]:opacity-0 group-hover/project:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100">
          <Button
            variant="quiet"
            size="icon-2xs"
            className={cn("rounded-md", touch && "min-h-11 min-w-11")}
            aria-label={t(($) => {
              return $.projects.newChat;
            })}
            disabled={creation.state === "loading"}
            onClick={newChat}
          >
            <Plus size={16} />
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
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {t(($) => {
                return $.projects.archived;
              })}
            </p>
          )}
          {items.length === 0 ? (
            <ProjectFolderEmpty
              archived={archived}
              pending={creation.state === "loading"}
              onNewChat={newChat}
            />
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

export function ProjectSidebar({ touch = false }: { touch?: boolean }) {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const projects = useGet(projects$);
  const open = useSet(openProjectEditor$);
  if (!enabled) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.projects.projects;
      })}
      className="min-h-0 shrink-0 px-2 pb-2"
    >
      <div className="flex h-8 items-center justify-between px-2">
        <span className="text-xs text-muted-foreground">
          {t(($) => {
            return $.projects.projects;
          })}
        </span>
        <Button
          variant="quiet"
          size="icon-2xs"
          className="rounded-md"
          aria-label={t(($) => {
            return $.projects.create;
          })}
          onClick={() => {
            return open();
          }}
        >
          <Plus size={15} />
        </Button>
      </div>
      <div className="max-h-[45dvh] overflow-y-auto">
        {projects.map((project) => {
          return (
            <ProjectFolder key={project.id} project={project} touch={touch} />
          );
        })}
      </div>
    </section>
  );
}
