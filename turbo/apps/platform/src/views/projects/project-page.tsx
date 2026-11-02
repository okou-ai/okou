import { useLoadableSet } from "ccstate-react/experimental";
import { FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useGet, useLastResolved } from "ccstate-react";
import { Button, Input } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui/components/ui/dialog";
import {
  projects$,
  projectsEnabled$,
  createProject$,
  renameProject$,
  deleteProject$,
  moveProjectThread$,
  newProjectThread$,
} from "../../signals/projects/projects.ts";
import { selectedProjectId$ } from "../../signals/projects/project-navigation.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { currentChatAgentRecordId$ } from "../../signals/agent-chat.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

export function ProjectEditor({
  projectId,
  fromThreadId,
  onClose,
}: {
  projectId?: string;
  fromThreadId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const projects = useGet(projects$);
  const original = projects.find((p) => {
    return p.id === projectId;
  });
  const [name, setName] = useState(original?.name ?? "");
  const [creation, create] = useLoadableSet(createProject$);
  const [renaming, rename] = useLoadableSet(renameProject$);
  const pending = creation.state === "loading" || renaming.state === "loading";
  const error =
    creation.state === "hasError" || renaming.state === "hasError"
      ? t(($) => {
          return $.projects.saveError;
        })
      : "";
  const signal = useGet(pageSignal$);
  async function submit() {
    if (projectId) {
      await rename(projectId, name, signal);
    } else {
      await create(name, fromThreadId, signal);
    }
    signal.throwIfAborted();
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {projectId
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
          <p role="alert">{error}</p>
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
  const [create, setCreate] = useState(false);
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
            setCreate(true);
          }}
        >
          +
        </Button>
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {projects.map((p) => {
          return (
            <Link
              key={p.id}
              pathname="/projects/:projectId"
              options={{
                pathParams: { projectId: p.id },
                searchParams: agent
                  ? new URLSearchParams({ projectAgent: agent })
                  : undefined,
              }}
              aria-current={selected === p.id ? "page" : undefined}
              className="truncate rounded-lg px-2 py-1 text-sm hover:bg-state-hover aria-[current=page]:bg-state-selected"
            >
              {p.name}
            </Link>
          );
        })}
      </div>
      {create && (
        <ProjectEditor
          onClose={() => {
            setCreate(false);
          }}
        />
      )}
    </section>
  );
}
export function ProjectMembership({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const enabled = useGet(projectsEnabled$);
  const projects = useGet(projects$);
  const [open, setOpen] = useState(false);
  const [create, setCreate] = useState(false);
  const [moving, move] = useLoadableSet(moveProjectThread$);
  const pending = moving.state === "loading";
  const error =
    moving.state === "hasError"
      ? t(($) => {
          return $.projects.moveError;
        })
      : "";
  const signal = useGet(pageSignal$);
  if (!enabled) {
    return null;
  }
  async function select(id: string | null) {
    await move(threadId, id, signal);
    signal.throwIfAborted();
    setOpen(false);
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t(($) => {
          return $.projects.move;
        })}
        onClick={() => {
          setOpen(true);
        }}
      >
        <FolderInput size={18} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
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
            {projects.map((p) => {
              return (
                <Button
                  key={p.id}
                  disabled={pending}
                  variant="outline"
                  onClick={() => {
                    detach(select(p.id), Reason.DomCallback);
                  }}
                >
                  {p.name}
                </Button>
              );
            })}
            <Button
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setCreate(true);
              }}
            >
              {t(($) => {
                return $.projects.fromChat;
              })}
            </Button>
            <p role="alert">{error}</p>
          </div>
        </DialogContent>
      </Dialog>
      {create && (
        <ProjectEditor
          fromThreadId={threadId}
          onClose={() => {
            setCreate(false);
          }}
        />
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
  const [archived, setArchived] = useState(false);
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deletion, remove] = useLoadableSet(deleteProject$);
  const [creation, create] = useLoadableSet(newProjectThread$);
  const pending = deletion.state === "loading" || creation.state === "loading";
  const error =
    deletion.state === "hasError"
      ? t(($) => {
          return $.projects.deleteError;
        })
      : creation.state === "hasError"
        ? t(($) => {
            return $.projects.createChatError;
          })
        : "";
  const signal = useGet(pageSignal$);
  const project = projects.find((p) => {
    return p.id === id;
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
  const threads = all.filter((t) => {
    return t.projectId === id && t.archived === archived;
  });
  async function createChat() {
    await create(project!.id, signal);
  }
  async function deleteCurrent() {
    await remove(project!.id, signal);
    signal.throwIfAborted();
    setConfirm(false);
  }
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setEdit(true);
            }}
          >
            {t(($) => {
              return $.projects.rename;
            })}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setConfirm(true);
            }}
          >
            {t(($) => {
              return $.projects.delete;
            })}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              detach(createChat(), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.projects.newChat;
            })}
          </Button>
        </div>
      </header>
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
      <p role="alert">{error}</p>
      {edit && (
        <ProjectEditor
          projectId={project.id}
          onClose={() => {
            setEdit(false);
          }}
        />
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
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
            disabled={pending}
            onClick={() => {
              detach(deleteCurrent(), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.projects.deleteProject;
            })}
          </Button>
        </DialogContent>
      </Dialog>
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
