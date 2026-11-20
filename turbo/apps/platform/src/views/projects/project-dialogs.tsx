import type { ReactNode } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { useLastResolved, useGet, useSet, useLoadable } from "ccstate-react";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui/components/ui/dialog";
import { Check, Folder, Plus } from "lucide-react";
import {
  projects$,
  createProject$,
  renameProject$,
  deleteProject$,
  moveProjectThreadFromDialog$,
} from "../../signals/projects/projects.ts";
import {
  setProjectEditorName$,
  projectDialogSession$,
  projectEditorName$,
  openProjectEditor$,
  closeProjectDialog$,
  completeProjectDialogClose$,
  projectSearch$,
  setProjectSearch$,
  type ProjectDialog,
} from "../../signals/projects/project-ui.ts";
import { eventDrivenChatThreads$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import {
  projectDeletionThreads$,
  initializeProjectDeletion$,
  projectDeletionConfirmation$,
  projectDeletionChanged$,
  refreshProjectDeletion$,
  confirmProjectThreadDeletion$,
  backFromProjectThreadDeletion$,
  deleteProjectAndThreads$,
} from "../../signals/projects/project-deletion.ts";
import { mobileChatViewport$ } from "../../signals/okou-page/pwa-navigation.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
function ProjectNameField() {
  const { t } = useTranslation();
  const name = useGet(projectEditorName$);
  const setName = useSet(setProjectEditorName$);
  return (
    <label htmlFor="project-name" className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">
        {t(($) => {
          return $.projects.name;
        })}
      </span>
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
    </label>
  );
}

type EditorDialog = Extract<ProjectDialog, { kind: "editor" }>;
function ProjectEditor({ dialog }: { dialog: EditorDialog }) {
  const { t } = useTranslation();
  const name = useGet(projectEditorName$);
  const close = useSet(closeProjectDialog$);
  const completeClose = useSet(completeProjectDialogClose$);
  const [creation, create] = useLoadableSet(createProject$);
  const [renaming, rename] = useLoadableSet(renameProject$);
  const signal = useGet(pageSignal$);
  const creationSignal = useGet(rootSignal$);
  const pending = creation.state === "loading" || renaming.state === "loading";
  const error = creation.state === "hasError" || renaming.state === "hasError";
  async function submit() {
    // A newly visible Project can be used while its creation is still in flight.
    if (dialog.projectId) {
      const completion = rename(dialog.projectId, name, signal);
      close(dialog);
      await completion;
      return;
    }
    await create(dialog, name, creationSignal);
  }
  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open) {
          close(dialog);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeClose(dialog);
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
          className="flex flex-col gap-5"
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
          <ProjectNameField />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => {
                return $.projects.saveError;
              })}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending
                ? t(($) => {
                    return $.projects.saving;
                  })
                : t(($) => {
                    return $.projects.save;
                  })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function MembershipSurface({
  dialog,
  mobile,
  onOpenChange,
  onOpenChangeComplete,
  children,
}: {
  dialog: Extract<ProjectDialog, { kind: "membership" }>;
  mobile: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (mobile) {
    return (
      <Drawer
        open={dialog.open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <DrawerContent
          closeLabel={t(($) => {
            return $.projects.close;
          })}
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
    <Popover
      open={dialog.open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <PopoverContent
        anchor={dialog.anchor}
        align="end"
        className="w-72 p-2"
        aria-label={t(($) => {
          return $.projects.moveTitle;
        })}
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
        variant="quiet"
        className="w-full justify-start gap-2 text-foreground"
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
          variant="quiet"
          className="w-full justify-start text-foreground"
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
  const completeClose = useSet(completeProjectDialogClose$);
  const [moving, move] = useLoadableSet(moveProjectThreadFromDialog$);
  const signal = useGet(pageSignal$);
  const pending = moving.state === "loading";
  const matches = projects.filter((project) => {
    return project.name
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase());
  });
  function select(id: string | null) {
    return move(dialog, id, signal);
  }
  function onOpenChange(open: boolean) {
    if (!open) {
      close(dialog);
    }
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
              variant="quiet"
              className="w-full justify-start gap-2 text-left text-foreground"
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
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeClose(dialog);
        }
      }}
    >
      {content}
    </MembershipSurface>
  );
}
function ProjectDeleteChoices({
  pending,
  onDeleteProject,
}: {
  readonly pending: boolean;
  readonly onDeleteProject: () => void;
}) {
  const { t } = useTranslation();
  const threads = useLoadable(projectDeletionThreads$);
  const confirmThreads = useSet(confirmProjectThreadDeletion$);
  const refresh = useSet(refreshProjectDeletion$);
  const features = useLastResolved(featureSwitches$);
  const enabled = features?.[FeatureSwitchKey.ProjectThreadDeletion] ?? false;
  const signal = useGet(pageSignal$);
  return (
    <>
      <div className="flex flex-col gap-2">
        <Button disabled={pending} onClick={onDeleteProject}>
          {t(($) => {
            return $.projects.deleteProjectOnly;
          })}
        </Button>
        {enabled &&
          (threads.state !== "hasData" || threads.data.length > 0) && (
            <Button
              variant="outline"
              disabled={pending || threads.state !== "hasData"}
              onClick={() => {
                detach(confirmThreads(signal), Reason.DomCallback);
              }}
            >
              {threads.state === "hasData"
                ? t(
                    ($) => {
                      return $.projects.deleteProjectAndThreads;
                    },
                    { count: threads.data.length },
                  )
                : t(($) => {
                    return $.projects.loadingThreads;
                  })}
            </Button>
          )}
      </div>
      {enabled && threads.state === "hasError" && (
        <div
          role="alert"
          className="flex flex-col gap-2 text-sm text-destructive"
        >
          {t(($) => {
            return $.projects.loadThreadsError;
          })}
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              detach(refresh(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.projects.retryThreads;
            })}
          </Button>
        </div>
      )}
    </>
  );
}

function ProjectDeleteConfirmation({
  pending,
  hasError,
  onDelete,
}: {
  readonly pending: boolean;
  readonly hasError: boolean;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation();
  const confirmation = useGet(projectDeletionConfirmation$);
  const changed = useGet(projectDeletionChanged$);
  const back = useSet(backFromProjectThreadDeletion$);
  return (
    <DialogContent
      initialFocus={() => {
        return document.querySelector<HTMLButtonElement>(
          "[data-project-delete-back]",
        );
      }}
      showCloseButton={!pending}
      closeLabel={t(($) => {
        return $.projects.close;
      })}
    >
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.projects.deleteThreadsTitle;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(
            ($) => {
              return $.projects.deleteThreadsDescription;
            },
            { count: confirmation?.length ?? 0 },
          )}
        </DialogDescription>
      </DialogHeader>
      <ul className="max-h-48 overflow-y-auto text-sm">
        {confirmation?.map((thread) => {
          return (
            <li key={thread.id} className="truncate py-1">
              {thread.title ??
                t(($) => {
                  return $.projects.untitledThread;
                })}
            </li>
          );
        })}
      </ul>
      {changed && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.projects.threadsChanged;
          })}
        </p>
      )}
      {hasError && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.projects.deleteThreadsError;
          })}
        </p>
      )}
      <DialogFooter>
        <Button
          data-project-delete-back
          variant="outline"
          disabled={pending}
          onClick={back}
        >
          {t(($) => {
            return $.projects.back;
          })}
        </Button>
        <Button variant="destructive" disabled={pending} onClick={onDelete}>
          {pending
            ? t(($) => {
                return $.projects.deletingThreads;
              })
            : t(($) => {
                return $.projects.confirmDeleteThreads;
              })}
        </Button>
      </DialogFooter>
    </DialogContent>
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
  const [threadDeletion, removeThreads] = useLoadableSet(
    deleteProjectAndThreads$,
  );
  const confirmation = useGet(projectDeletionConfirmation$);
  const initialize = useSet(initializeProjectDeletion$);
  const back = useSet(backFromProjectThreadDeletion$);
  const features = useLastResolved(featureSwitches$);
  const enabled = features?.[FeatureSwitchKey.ProjectThreadDeletion] ?? false;
  const signal = useGet(pageSignal$);
  const pending =
    deletion.state === "loading" || threadDeletion.state === "loading";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          close(dialog);
        }
      }}
    >
      <DialogContent
        ref={initialize}
        hideWhenNestedOpen
        showCloseButton={!pending}
        closeLabel={t(($) => {
          return $.projects.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.projects.deleteTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {enabled
              ? t(($) => {
                  return $.projects.deleteChoiceDescription;
                })
              : t(($) => {
                  return $.projects.deleteDescription;
                })}
          </DialogDescription>
        </DialogHeader>
        <ProjectDeleteChoices
          pending={pending}
          onDeleteProject={() => {
            detach(remove(dialog, signal), Reason.DomCallback);
          }}
        />
        {deletion.state === "hasError" && (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return $.projects.deleteError;
            })}
          </p>
        )}
        <Dialog
          open={confirmation !== null}
          onOpenChange={(open) => {
            if (!open && !pending) {
              back();
            }
          }}
        >
          <ProjectDeleteConfirmation
            pending={pending}
            hasError={threadDeletion.state === "hasError"}
            onDelete={() => {
              detach(removeThreads(dialog, signal), Reason.DomCallback);
            }}
          />
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
export function ProjectDialogs() {
  const dialog = useGet(projectDialogSession$);
  if (!dialog) {
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
