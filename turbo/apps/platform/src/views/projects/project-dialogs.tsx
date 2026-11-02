import type { ReactNode } from "react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { useGet, useSet } from "ccstate-react";
import { Button, Input, Popover, PopoverContent } from "@okouai/ui";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@okouai/ui/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui/components/ui/dialog";
import { Check, Folder, Plus } from "lucide-react";
import {
  projects$,
  projectsEnabled$,
  createProject$,
  renameProject$,
  deleteProject$,
  moveProjectThread$,
} from "../../signals/projects/projects.ts";
import {
  setProjectEditorName$,
  projectDialog$,
  projectEditorName$,
  openProjectEditor$,
  closeProjectDialog$,
  projectSearch$,
  setProjectSearch$,
  projectDialogHasSuccessor$,
  type ProjectDialog,
} from "../../signals/projects/project-ui.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { mobileChatViewport$ } from "../../signals/okou-page/pwa-navigation.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
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
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229)
            ) {
              event.preventDefault();
            }
          }}
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
function MembershipSurface({
  dialog,
  mobile,
  finalFocus,
  onOpenChange,
  children,
}: {
  dialog: Extract<ProjectDialog, { kind: "membership" }>;
  mobile: boolean;
  finalFocus: () => HTMLElement | false;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (mobile) {
    return (
      <Drawer open onOpenChange={onOpenChange}>
        <DrawerContent
          closeLabel={t(($) => {
            return $.projects.close;
          })}
          finalFocus={finalFocus}
        >
          <DrawerHeader>
            <DrawerTitle>
              {t(($) => {
                return $.projects.moveTitle;
              })}
            </DrawerTitle>
          </DrawerHeader>
          {children}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={dialog.anchor}
        align="end"
        className="w-72 p-2"
        aria-label={t(($) => {
          return $.projects.moveTitle;
        })}
        finalFocus={finalFocus}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MembershipActions({
  threadId,
  current,
  pending,
  search,
  onSelect,
}: {
  threadId: string;
  current: string | null | undefined;
  pending: boolean;
  search: string;
  onSelect: (id: string | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const editor = useSet(openProjectEditor$);
  return (
    <div className="border-t border-border pt-1">
      <Button
        variant="ghost"
        className="w-full justify-start gap-2"
        disabled={pending}
        onClick={() => {
          return editor({ fromThreadId: threadId }, search.trim());
        }}
      >
        <Plus size={16} />
        {t(($) => {
          return $.projects.fromChat;
        })}
      </Button>
      {current && (
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={pending}
          onClick={() => {
            return detach(onSelect(null), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.projects.remove;
          })}
        </Button>
      )}
    </div>
  );
}

function ProjectMembershipPicker({
  dialog,
}: {
  dialog: Extract<ProjectDialog, { kind: "membership" }>;
}) {
  const { t } = useTranslation();
  const projects = useGet(projects$);
  const search = useGet(projectSearch$);
  const setSearch = useSet(setProjectSearch$);
  const current = useGet(eventDrivenChatThreads$).find((thread) => {
    return thread.id === dialog.threadId;
  })?.projectId;
  const mobile = useGet(mobileChatViewport$);
  const close = useSet(closeProjectDialog$);
  const [moving, move] = useLoadableSet(moveProjectThread$);
  const signal = useGet(pageSignal$);
  const hasSuccessor = useSet(projectDialogHasSuccessor$);
  const pending = moving.state === "loading";
  const matches = projects.filter((project) => {
    return project.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  });
  async function select(id: string | null) {
    await move(dialog.threadId, id, signal);
    signal.throwIfAborted();
    close(dialog);
  }
  function onOpenChange(open: boolean) {
    if (!open) {
      close(dialog);
    }
  }
  // Moving can replace the original row. Focus its surviving navigation link,
  // or return to the menu trigger when the row has stayed in place.
  function finalFocus() {
    if (hasSuccessor(dialog)) {
      return false;
    }
    return (
      document.querySelector<HTMLElement>(
        `[data-sidebar-chat-thread-id="${dialog.threadId}"]`,
      ) ?? dialog.anchor
    );
  }
  const content = (
    <div className="flex min-h-0 flex-col gap-2">
      <Input
        aria-label={t(($) => {
          return $.projects.search;
        })}
        placeholder={t(($) => {
          return $.projects.search;
        })}
        value={search}
        onChange={(event) => {
          return setSearch(event.target.value);
        }}
        autoFocus
        autoComplete="off"
      />
      <div
        className="max-h-64 overflow-y-auto"
        aria-label={t(($) => {
          return $.projects.projects;
        })}
      >
        {matches.map((project) => {
          return (
            <Button
              key={project.id}
              variant="ghost"
              className="w-full justify-start gap-2 text-left"
              disabled={pending || project.id === current}
              onClick={() => {
                return detach(select(project.id), Reason.DomCallback);
              }}
            >
              <Folder size={16} />
              <span className="flex-1 truncate">{project.name}</span>
              {project.id === current && <Check size={16} />}
            </Button>
          );
        })}
        {matches.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.projects.noMatches;
            })}
          </p>
        )}
      </div>
      <MembershipActions
        threadId={dialog.threadId}
        current={current}
        pending={pending}
        search={search}
        onSelect={select}
      />
      {moving.state === "hasError" && (
        <p role="alert" className="px-2 text-sm text-destructive">
          {t(($) => {
            return $.projects.moveError;
          })}
        </p>
      )}
    </div>
  );
  return (
    <MembershipSurface
      dialog={dialog}
      mobile={mobile}
      finalFocus={finalFocus}
      onOpenChange={onOpenChange}
    >
      {content}
    </MembershipSurface>
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
    return <ProjectMembershipPicker dialog={dialog} />;
  }
  return <DeleteProjectDialog dialog={dialog} />;
}
