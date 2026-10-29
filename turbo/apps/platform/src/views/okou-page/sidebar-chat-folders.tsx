import { chatFolderSearchNames$ } from "../../signals/chat-page/chat-folder-search.ts";
import { useLoadable, useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Folder,
  FolderPlus,
  ChevronRight,
  Ellipsis,
  Pencil,
  Trash,
  ArrowUp,
  ArrowDown,
  FolderInput,
} from "lucide-react";
import {
  Button,
  Input,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  RunningIndicator,
  cn,
} from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@okouai/ui/components/ui/dialog";
import type { DragEvent, ReactNode } from "react";
import { CHAT_THREAD_VIRTUAL_ROW_HEIGHT } from "../../signals/okou-page/sidebar-state.ts";
import { setThreadListNumberShortcutRoot$ } from "../../signals/okou-page/thread-list-number-shortcuts.ts";
import {
  currentChatFolders$,
  type ChatFolderSignals,
  type FolderDialog,
  CHAT_FOLDER_DRAG_TYPE,
  CHAT_THREAD_FOLDER_DRAG_TYPE,
} from "../../signals/chat-page/chat-folders.ts";
import type { ChatFolderRow } from "../../signals/chat-page/sidebar-chat-folder-rows.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ApiError } from "../../lib/api-error.ts";

export function ChatFolderCreateButton({
  touch = false,
}: { readonly touch?: boolean } = {}) {
  const { t } = useTranslation();
  const folders = useLoadable(currentChatFolders$);
  if (folders.state !== "hasData" || !folders.data) {
    return null;
  }
  return (
    <FolderCreateButton
      touch={touch}
      folders={folders.data}
      label={t(($) => {
        return $.chat.folders.create;
      })}
    />
  );
}
function FolderCreateButton({
  folders,
  label,
  touch = false,
}: {
  readonly folders: ChatFolderSignals;
  readonly label: string;
  readonly touch?: boolean;
}) {
  const open = useSet(folders.setDialog$);
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon-sm"
      aria-label={label}
      className={touch ? "min-h-11 min-w-11" : undefined}
      onClick={() => {
        return open({ kind: "create", id: crypto.randomUUID() });
      }}
    >
      <FolderPlus size={16} />
    </Button>
  );
}

export function ChatFolderMoveMenuItem({
  threadId,
}: {
  readonly threadId: string;
}) {
  const { t } = useTranslation();
  const folders = useLoadable(currentChatFolders$);
  if (folders.state !== "hasData" || !folders.data) {
    return null;
  }
  return (
    <MoveMenuItem
      folders={folders.data}
      threadId={threadId}
      label={t(($) => {
        return $.chat.folders.move;
      })}
    />
  );
}
function MoveMenuItem({
  folders,
  threadId,
  label,
}: {
  readonly folders: ChatFolderSignals;
  readonly threadId: string;
  readonly label: string;
}) {
  const open = useSet(folders.setDialog$);
  return (
    <DropdownMenuItem
      onClick={() => {
        return open({ kind: "move", threadId });
      }}
    >
      <FolderInput size={16} className="mr-2" />
      {label}
    </DropdownMenuItem>
  );
}

function FolderStatus({
  row,
}: {
  readonly row: Extract<ChatFolderRow, { kind: "folder" }>;
}) {
  const { t } = useTranslation();
  const unread = useLastResolved(row.unread$);
  const running = useLastResolved(row.running$);
  return (
    <span className="flex shrink-0 items-center gap-2">
      {running ? (
        <span
          role="img"
          aria-label={t(($) => {
            return $.chat.folders.running;
          })}
        >
          <RunningIndicator />
        </span>
      ) : null}
      {unread ? (
        <span
          role="img"
          aria-label={t(($) => {
            return $.chat.folders.unread;
          })}
          className="h-2 w-2 rounded-full bg-sky-600"
        />
      ) : null}
    </span>
  );
}
function hasFolderDrag(event: DragEvent): boolean {
  return (
    event.dataTransfer.types.includes(CHAT_FOLDER_DRAG_TYPE) ||
    event.dataTransfer.types.includes(CHAT_THREAD_FOLDER_DRAG_TYPE)
  );
}

function ChatFolderHeader({
  row,
  folders,
  touch,
}: {
  readonly row: Extract<ChatFolderRow, { kind: "folder" }>;
  readonly folders: ChatFolderSignals;
  readonly touch?: boolean;
}) {
  const expand = useSet(folders.setExpanded$);
  const [operation, mutate] = useLoadableSet(folders.mutate$);
  const signal = useGet(pageSignal$);
  const catalog = useLastResolved(folders.catalog$);
  const list = catalog?.folders ?? [];
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg hover:bg-state-hover",
        touch ? "h-14" : "h-8",
      )}
      draggable={operation.state !== "loading"}
      onDragStart={(event) => {
        event.dataTransfer.setData(CHAT_FOLDER_DRAG_TYPE, row.folder.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (hasFolderDrag(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (!hasFolderDrag(event)) {
          return;
        }
        event.preventDefault();
        const threadId = event.dataTransfer.getData(
          CHAT_THREAD_FOLDER_DRAG_TYPE,
        );
        if (threadId) {
          detach(
            mutate({ kind: "move", threadId, folderId: row.folder.id }, signal),
            Reason.DomCallback,
          );
          return;
        }
        const movedId = event.dataTransfer.getData(CHAT_FOLDER_DRAG_TYPE);
        if (!movedId || movedId === row.folder.id) {
          return;
        }
        const remaining = list.filter((item) => {
          return item.id !== movedId;
        });
        const target = remaining.findIndex((item) => {
          return item.id === row.folder.id;
        });
        const after =
          event.clientY >
          event.currentTarget.getBoundingClientRect().top +
            event.currentTarget.clientHeight / 2;
        const gap = target + (after ? 1 : 0);
        detach(
          mutate(
            {
              kind: "reorder",
              id: movedId,
              beforeId: remaining[gap - 1]?.id ?? null,
              afterId: remaining[gap]?.id ?? null,
            },
            signal,
          ),
          Reason.DomCallback,
        );
      }}
    >
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className={cn(
          "min-w-0 flex-1 justify-start gap-2 px-2 text-nav-copy",
          touch ? "h-14" : "h-8",
        )}
        aria-expanded={row.expanded}
        onClick={() => {
          return expand(row.folder.id, !row.expanded);
        }}
      >
        <ChevronRight
          size={12}
          className={cn("shrink-0 opacity-50", row.expanded && "rotate-90")}
        />
        <Folder size={16} className="shrink-0 opacity-50" />
        <span className="min-w-0 flex-1 truncate text-left">
          {row.folder.name}
        </span>
        <FolderStatus row={row} />
      </Button>
      <FolderHeaderMenu row={row} folders={folders} touch={touch} />
    </div>
  );
}

function FolderHeaderMenu({
  row,
  folders,
  touch,
}: {
  readonly row: Extract<ChatFolderRow, { kind: "folder" }>;
  readonly folders: ChatFolderSignals;
  readonly touch?: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(folders.setDialog$);
  const [operation, mutate] = useLoadableSet(folders.mutate$);
  const signal = useGet(pageSignal$);
  const catalog = useLastResolved(folders.catalog$);
  const list = catalog?.folders ?? [];
  const index = list.findIndex((item) => {
    return item.id === row.folder.id;
  });
  const reorder = (target: number) => {
    const remaining = list.filter((item) => {
      return item.id !== row.folder.id;
    });
    detach(
      mutate(
        {
          kind: "reorder",
          id: row.folder.id,
          beforeId: remaining[target - 1]?.id ?? null,
          afterId: remaining[target]?.id ?? null,
        },
        signal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            className={touch ? "min-h-11 min-w-11" : undefined}
            aria-label={t(
              ($) => {
                return $.chat.folders.actions;
              },
              {
                name: row.folder.name,
              },
            )}
          >
            <Ellipsis size={16} />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            return open({ kind: "rename", folder: row.folder });
          }}
        >
          <Pencil size={16} className="mr-2" />
          {t(($) => {
            return $.chat.folders.rename;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index <= 0 || operation.state === "loading"}
          onClick={() => {
            return reorder(index - 1);
          }}
        >
          <ArrowUp size={16} className="mr-2" />
          {t(($) => {
            return $.chat.folders.up;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={
            index === -1 ||
            index >= list.length - 1 ||
            operation.state === "loading"
          }
          onClick={() => {
            return reorder(index + 1);
          }}
        >
          <ArrowDown size={16} className="mr-2" />
          {t(($) => {
            return $.chat.folders.down;
          })}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => {
            return open({ kind: "delete", folder: row.folder });
          }}
        >
          <Trash size={16} className="mr-2" />
          {t(($) => {
            return $.chat.folders.delete;
          })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatFolderAuxiliaryRow({
  row,
  folders,
}: {
  readonly row: Exclude<ChatFolderRow, { kind: "folder" | "thread" }>;
  readonly folders: ChatFolderSignals;
}) {
  const { t } = useTranslation();
  const open = useSet(folders.setDialog$);
  const mutate = useSet(folders.mutate$);
  const signal = useGet(pageSignal$);
  if (row.kind === "create") {
    return (
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="h-8 w-full justify-start gap-2 px-2 text-nav-copy-muted"
        onClick={() => {
          return open({ kind: "create", id: crypto.randomUUID() });
        }}
      >
        <FolderPlus size={16} />
        {t(($) => {
          return $.chat.folders.create;
        })}
      </Button>
    );
  }
  if (row.kind === "empty") {
    return (
      <p className="h-8 truncate px-8 py-2 text-xs text-nav-copy-muted">
        {t(($) => {
          return $.chat.folders.empty;
        })}
      </p>
    );
  }
  return (
    <div
      className="flex h-8 items-center rounded-lg px-2 text-[13px] text-nav-copy-muted hover:bg-state-hover"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(CHAT_THREAD_FOLDER_DRAG_TYPE)) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const threadId = event.dataTransfer.getData(
          CHAT_THREAD_FOLDER_DRAG_TYPE,
        );
        if (threadId) {
          event.preventDefault();
          detach(
            mutate({ kind: "move", threadId, folderId: null }, signal),
            Reason.DomCallback,
          );
        }
      }}
    >
      {!row.hasFolders
        ? t(($) => {
            return $.chat.folders.chats;
          })
        : t(($) => {
            return $.chat.folders.unfiled;
          })}
    </div>
  );
}

function ChatFolderControls({
  folders,
}: {
  readonly folders: ChatFolderSignals;
}) {
  const subscribe = useSet(folders.subscribeOnRef$);
  const dialog = useGet(folders.dialog$);
  const close = useSet(folders.setDialog$);
  return (
    <>
      <span ref={subscribe} hidden />
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            close(null);
          }
        }}
      >
        {dialog ? (
          <DialogContent>
            <FolderDialogBody
              key={dialog.kind}
              folders={folders}
              dialog={dialog}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function FolderDialogBody({
  folders,
  dialog,
}: {
  readonly folders: ChatFolderSignals;
  readonly dialog: FolderDialog;
}) {
  const { t } = useTranslation();
  const title =
    dialog.kind === "create"
      ? t(($) => {
          return $.chat.folders.create;
        })
      : dialog.kind === "rename"
        ? t(($) => {
            return $.chat.folders.rename;
          })
        : dialog.kind === "delete"
          ? t(($) => {
              return $.chat.folders.delete;
            })
          : t(($) => {
              return $.chat.folders.move;
            });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {dialog.kind === "delete"
            ? t(
                ($) => {
                  return $.chat.folders.deleteDescription;
                },
                {
                  name: dialog.folder.name,
                },
              )
            : t(($) => {
                return $.chat.folders.description;
              })}
        </DialogDescription>
      </DialogHeader>
      {dialog.kind === "move" ? (
        <FolderMoveChooser folders={folders} threadId={dialog.threadId} />
      ) : (
        <FolderNameForm folders={folders} dialog={dialog} />
      )}
    </>
  );
}
function FolderMutationError({
  error,
  folders,
}: {
  readonly error: unknown;
  readonly folders: ChatFolderSignals;
}) {
  const { t } = useTranslation();
  const reload = useSet(folders.reload$);
  return (
    <div className="flex flex-col gap-2">
      <p role="alert" className="text-sm text-destructive">
        {error instanceof ApiError
          ? error.message
          : t(($) => {
              return $.chat.folders.failed;
            })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          return reload();
        }}
      >
        {t(($) => {
          return $.chat.folders.refresh;
        })}
      </Button>
    </div>
  );
}
function FolderMoveChooser({
  folders,
  threadId,
}: {
  readonly folders: ChatFolderSignals;
  readonly threadId: string;
}) {
  const { t } = useTranslation();
  const [operation, mutate] = useLoadableSet(folders.mutate$);
  const signal = useGet(pageSignal$);
  const catalog = useLastResolved(folders.catalog$);
  const loading = operation.state === "loading";
  return (
    <>
      {operation.state === "hasError" ? (
        <FolderMutationError error={operation.error} folders={folders} />
      ) : null}
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        <Button
          variant="quiet"
          className="justify-start"
          disabled={loading}
          onClick={() => {
            return detach(
              mutate({ kind: "move", threadId, folderId: null }, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.chat.folders.unfiled;
          })}
        </Button>
        {catalog?.folders.map((folder) => {
          return (
            <Button
              key={folder.id}
              variant="quiet"
              className="justify-start gap-2"
              disabled={loading}
              onClick={() => {
                return detach(
                  mutate(
                    { kind: "move", threadId, folderId: folder.id },
                    signal,
                  ),
                  Reason.DomCallback,
                );
              }}
            >
              <Folder size={16} />
              <span className="truncate">{folder.name}</span>
            </Button>
          );
        })}
      </div>
    </>
  );
}
function FolderNameForm({
  folders,
  dialog,
}: {
  readonly folders: ChatFolderSignals;
  readonly dialog: Exclude<FolderDialog, { kind: "move" }>;
}) {
  const { t } = useTranslation();
  const [operation, mutate] = useLoadableSet(folders.mutate$);
  const close = useSet(folders.setDialog$);
  const signal = useGet(pageSignal$);
  const loading = operation.state === "loading";
  return (
    <>
      {operation.state === "hasError" ? (
        <FolderMutationError error={operation.error} folders={folders} />
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (loading) {
            return;
          }
          if (dialog.kind === "delete") {
            detach(
              mutate({ kind: "delete", id: dialog.folder.id }, signal),
              Reason.DomCallback,
            );
            return;
          }
          const name = String(
            new FormData(event.currentTarget).get("name") ?? "",
          ).trim();
          if (!name) {
            return;
          }
          detach(
            mutate(
              {
                kind: dialog.kind,
                id: dialog.kind === "create" ? dialog.id : dialog.folder.id,
                name,
              },
              signal,
            ),
            Reason.DomCallback,
          );
        }}
      >
        {dialog.kind !== "delete" ? (
          <label className="flex flex-col gap-2 text-sm">
            {t(($) => {
              return $.chat.folders.name;
            })}
            <Input
              name="name"
              autoFocus
              required
              maxLength={100}
              defaultValue={dialog.kind === "rename" ? dialog.folder.name : ""}
              disabled={loading}
              onKeyDown={(event) => {
                // Confirming an IME candidate must not submit the folder name.
                if (
                  event.key === "Enter" &&
                  (event.nativeEvent.isComposing || event.keyCode === 229)
                ) {
                  event.preventDefault();
                }
              }}
            />
          </label>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              return close(null);
            }}
          >
            {t(($) => {
              return $.chat.actions.cancel;
            })}
          </Button>
          <Button
            type="submit"
            disabled={loading}
            variant={dialog.kind === "delete" ? "destructive" : "default"}
          >
            {dialog.kind === "delete"
              ? t(($) => {
                  return $.chat.folders.delete;
                })
              : t(($) => {
                  return $.chat.folders.save;
                })}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function ChatFolderSearchLabel({
  threadId,
}: {
  readonly threadId: string;
}) {
  const labels = useLoadable(chatFolderSearchNames$);
  const name =
    labels.state === "hasData" ? labels.data.get(threadId) : undefined;
  return name ? (
    <span className="inline-flex max-w-full items-center gap-1 truncate text-xs text-nav-copy-muted">
      <Folder size={12} />
      {name}
    </span>
  ) : null;
}

export function VirtualizedChatFolderRows({
  folders,
  rows,
  startIndex,
  rowCount,
  showAllChats,
  showAllChatsRow,
  searchOpen,
  renderThread,
  rowHeight = CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  touch = false,
}: {
  readonly folders: ChatFolderSignals;
  readonly rows: readonly ChatFolderRow[];
  readonly startIndex: number;
  readonly rowCount: number;
  readonly showAllChats: boolean;
  readonly showAllChatsRow: ReactNode;
  readonly searchOpen: boolean;
  readonly rowHeight?: number;
  readonly touch?: boolean;
  readonly renderThread: (
    row: Extract<ChatFolderRow, { kind: "thread" }>,
    index: number,
    searchOpen: boolean,
  ) => ReactNode;
}) {
  const shortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  return (
    <>
      <div
        ref={touch ? undefined : shortcutRoot}
        className="relative w-full"
        data-testid="sidebar-chat-threads-virtual-list"
        style={{ height: rowCount * rowHeight }}
      >
        {rows.map((row, offset) => {
          return (
            <div
              key={row.key}
              className="absolute left-0 top-0 w-full pb-1"
              style={{
                transform: `translateY(${(startIndex + offset) * rowHeight}px)`,
              }}
            >
              {row.kind === "folder" ? (
                <ChatFolderHeader row={row} folders={folders} touch={touch} />
              ) : row.kind === "thread" ? (
                <div
                  className={
                    row.filed ? "ml-5 border-l border-divider pl-2" : undefined
                  }
                >
                  {renderThread(row, startIndex + offset, searchOpen)}
                </div>
              ) : (
                <ChatFolderAuxiliaryRow row={row} folders={folders} />
              )}
            </div>
          );
        })}
        {showAllChats ? (
          <div
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${(rowCount - 1) * rowHeight}px)`,
            }}
          >
            {showAllChatsRow}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function CurrentChatFolderControls() {
  const folders = useLoadable(currentChatFolders$);
  return folders.state === "hasData" && folders.data ? (
    <ChatFolderControls
      key={`${folders.data.owner.userId}:${folders.data.owner.orgId}:${folders.data.owner.agentId}`}
      folders={folders.data}
    />
  ) : null;
}

export function ChatFolderCatalogError() {
  const folders = useLoadable(currentChatFolders$);
  return folders.state === "hasData" && folders.data ? (
    <ChatFolderReload folders={folders.data} />
  ) : null;
}
function ChatFolderReload({
  folders,
}: {
  readonly folders: ChatFolderSignals;
}) {
  const { t } = useTranslation();
  const reload = useSet(folders.reload$);
  const catalog = useLoadable(folders.catalog$);
  if (catalog.state !== "hasError") {
    return null;
  }
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-4 text-center">
      <p role="alert" className="text-sm text-nav-copy-muted">
        {t(($) => {
          return $.appShell.pwaNavigation.chatListUnavailable;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          return reload();
        }}
      >
        {t(($) => {
          return $.chat.folders.refresh;
        })}
      </Button>
    </div>
  );
}
