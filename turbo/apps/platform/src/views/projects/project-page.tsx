import { useLoadableSet } from "ccstate-react/experimental";
import { FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { Button, Input } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui/components/ui/dialog";
import type { Project } from "@okouai/api-contracts/validators/projects";
import {
  projects$,
  projectsEnabled$,
  createProject$,
  renameProject$,
  deleteProject$,
  moveProjectThread$,
  newProjectThread$,
} from "../../signals/projects/projects.ts";
import {
  setProjectDialog$,
  setProjectEditorName$,
  setProjectArchiveFilter$,
  projectDialog$,
  projectEditorName$,
  projectArchiveFilter$,
  openProjectEditor$,
  closeProjectDialog$,
  type ProjectDialog,
} from "../../signals/projects/project-ui.ts";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { currentChatAgentRecordId$ } from "../../signals/agent-chat.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

type EditorDialog = Extract<ProjectDialog, { kind: "editor" }>;
function ProjectEditor({ dialog }: { dialog: EditorDialog }) {
  const { t } = useTranslation();
  const name = useGet(projectEditorName$);
  const setName = useSet(setProjectEditorName$);
  const close = useSet(closeProjectDialog$);
  const [creation, create] = useLoadableSet(createProject$);
  const [renaming, rename] = useLoadableSet(renameProject$);
  const signal = useGet(pageSignal$);
  const pending = creation.state === "loading" || renaming.state === "loading";
  const error = creation.state === "hasError" || renaming.state === "hasError";
  async function submit() {
    if (dialog.projectId) {
      await rename(dialog.projectId, name, signal);
    } else {
      await create(name, dialog.fromThreadId, signal);
    }
    signal.throwIfAborted();
    close(dialog);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close(dialog);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {dialog.projectId
              ? t(($) => {
                  return $.projects.renameProject;
                })
              : t(($) => {
                  return $.projects.create;
                })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.projects.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            detach(submit(), Reason.DomCallback);
          }}
        >
          <label htmlFor="project-name">
            {t(($) => {
              return $.projects.name;
            })}
          </label>
          <Input
            id="project-name"
            value={name}
            maxLength={120}
            onChange={(event) => {
              setName(event.target.value);
            }}
            autoFocus
            required
          />
          {error && (
            <p role="alert">
              {t(($) => {
                return $.projects.saveError;
              })}
            </p>
          )}
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending
              ? t(($) => {
                  return $.projects.saving;
                })
              : t(($) => {
                  return $.projects.save;
                })}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ProjectSidebar() {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const projects = useGet(projects$);
  const selected = useGet(selectedProjectId$);
  const agent = useLastResolved(currentChatAgentRecordId$);
  const open = useSet(openProjectEditor$);
  if (!enabled) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.projects.projects;
      })}
      className="px-2 py-2"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          {t(($) => {
            return $.projects.projects;
          })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t(($) => {
            return $.projects.create;
          })}
          onClick={() => {
            open();
          }}
        >
          +
        </Button>
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {projects.map((project) => {
          return (
            <Link
              key={project.id}
              pathname="/projects/:projectId"
              options={{
                pathParams: { projectId: project.id },
                searchParams: agent
                  ? new URLSearchParams({ projectAgent: agent })
                  : undefined,
              }}
              aria-current={selected === project.id ? "page" : undefined}
              className="truncate rounded-lg px-2 py-1 text-sm hover:bg-state-hover aria-[current=page]:bg-state-selected"
            >
              {project.name}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
export function ProjectMembership({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const open = useSet(setProjectDialog$);
  if (!enabled) {
    return null;
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t(($) => {
        return $.projects.move;
      })}
      onClick={() => {
        open({ kind: "membership", threadId });
      }}
    >
      <FolderInput size={18} />
    </Button>
  );
}
function ProjectMembershipDialog({
  dialog,
}: {
  dialog: Extract<ProjectDialog, { kind: "membership" }>;
}) {
  const { t } = useTranslation();
  const projects = useGet(projects$);
  const close = useSet(closeProjectDialog$);
  const editor = useSet(openProjectEditor$);
  const [moving, move] = useLoadableSet(moveProjectThread$);
  const signal = useGet(pageSignal$);
  const pending = moving.state === "loading";
  async function select(id: string | null) {
    await move(dialog.threadId, id, signal);
    signal.throwIfAborted();
    close(dialog);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close(dialog);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.projects.moveTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.projects.moveDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          <Button
            disabled={pending}
            variant="outline"
            onClick={() => {
              detach(select(null), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.projects.remove;
            })}
          </Button>
          {projects.map((project) => {
            return (
              <Button
                key={project.id}
                disabled={pending}
                variant="outline"
                onClick={() => {
                  detach(select(project.id), Reason.DomCallback);
                }}
              >
                {project.name}
              </Button>
            );
          })}
          <Button
            disabled={pending}
            onClick={() => {
              editor({ fromThreadId: dialog.threadId });
            }}
          >
            {t(($) => {
              return $.projects.fromChat;
            })}
          </Button>
          {moving.state === "hasError" && (
            <p role="alert">
              {t(($) => {
                return $.projects.moveError;
              })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
function DeleteProjectDialog({
  dialog,
}: {
  dialog: Extract<ProjectDialog, { kind: "delete" }>;
}) {
  const { t } = useTranslation();
  const close = useSet(closeProjectDialog$);
  const [deletion, remove] = useLoadableSet(deleteProject$);
  const signal = useGet(pageSignal$);
  async function submit() {
    await remove(dialog.projectId, signal);
    signal.throwIfAborted();
    close(dialog);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          close(dialog);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.projects.deleteTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.projects.deleteDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <Button
          disabled={deletion.state === "loading"}
          onClick={() => {
            detach(submit(), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.projects.deleteProject;
          })}
        </Button>
        {deletion.state === "hasError" && (
          <p role="alert">
            {t(($) => {
              return $.projects.deleteError;
            })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
export function ProjectDialogs() {
  const enabled = useGet(projectsEnabled$);
  const dialog = useGet(projectDialog$);
  if (!enabled || !dialog) {
    return null;
  }
  if (dialog.kind === "editor") {
    return <ProjectEditor dialog={dialog} />;
  }
  if (dialog.kind === "membership") {
    return <ProjectMembershipDialog dialog={dialog} />;
  }
  return <DeleteProjectDialog dialog={dialog} />;
}
function ProjectHeader({ project }: { project: Project }) {
  const { t } = useTranslation();
  const editor = useSet(openProjectEditor$);
  const open = useSet(setProjectDialog$);
  const [creation, create] = useLoadableSet(newProjectThread$);
  const signal = useGet(pageSignal$);
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              editor({ projectId: project.id }, project.name);
            }}
          >
            {t(($) => {
              return $.projects.rename;
            })}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              open({ kind: "delete", projectId: project.id });
            }}
          >
            {t(($) => {
              return $.projects.delete;
            })}
          </Button>
          <Button
            disabled={creation.state === "loading"}
            onClick={() => {
              detach(create(project.id, signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.projects.newChat;
            })}
          </Button>
        </div>
      </header>
      {creation.state === "hasError" && (
        <p role="alert">
          {t(($) => {
            return $.projects.createChatError;
          })}
        </p>
      )}
    </>
  );
}
export function ProjectPage() {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const id = useGet(selectedProjectId$);
  const projects = useGet(projects$);
  const all = useGet(eventDrivenChatThreads$);
  const agent = useLastResolved(currentChatAgentRecordId$);
  const archived = useGet(projectArchiveFilter$);
  const setArchived = useSet(setProjectArchiveFilter$);
  const project = projects.find((item) => {
    return item.id === id;
  });
  if (!enabled || !project) {
    return (
      <main className="p-6">
        <h1>
          {t(($) => {
            return $.projects.unavailable;
          })}
        </h1>
        <p>
          {t(($) => {
            return $.projects.unavailableDescription;
          })}
        </p>
      </main>
    );
  }
  const threads = all.filter((thread) => {
    return thread.projectId === id && thread.archived === archived;
  });
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <ProjectHeader project={project} />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => {
            setArchived(event.target.checked);
          }}
        />
        {t(($) => {
          return $.projects.archived;
        })}
      </label>
      {threads.length === 0 ? (
        <p className="text-muted-foreground">
          {t(($) => {
            return $.projects.empty;
          })}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {threads.map((thread) => {
            return (
              <li
                key={thread.id}
                className="flex items-center justify-between gap-2 py-3"
              >
                <Link
                  pathname="/chats/:threadId"
                  options={{
                    pathParams: { threadId: thread.id },
                    searchParams: new URLSearchParams({
                      project: project.id,
                      ...(agent ? { projectAgent: agent } : {}),
                    }),
                  }}
                  className="min-w-0 flex-1 truncate rounded-lg p-2 hover:bg-state-hover"
                >
                  {thread.title ??
                    t(($) => {
                      return $.projects.newChat;
                    })}
                </Link>
                <ProjectMembership threadId={thread.id} />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
export function ProjectReference({
  part,
  className,
}: {
  part: { readonly projectId: string; readonly nameSnapshot: string };
  className?: string;
}) {
  const agent = useLastResolved(currentChatAgentRecordId$);
  return (
    <Link
      pathname="/projects/:projectId"
      options={{
        pathParams: { projectId: part.projectId },
        searchParams: agent
          ? new URLSearchParams({ projectAgent: agent })
          : undefined,
      }}
      className={className}
    >
      {part.nameSnapshot}
    </Link>
  );
}
