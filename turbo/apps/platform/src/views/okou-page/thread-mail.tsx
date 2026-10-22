import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ThreadMailSummary } from "@okouai/api-contracts/contracts/mail";
import {
  Button,
  buttonVariants,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Toggle,
  ToggleGroup,
} from "@okouai/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ComponentProps } from "react";
import {
  ChevronRight,
  Loader2,
  Mail,
  Search,
  Send,
  Trash,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type { ThreadMailFilter } from "../../signals/chat-page/thread-mail.ts";
import {
  navigateThreadMail$,
  openThreadMailList$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import {
  threadMailParams,
  type ThreadMailDestination,
} from "../../signals/chat-page/thread-mail-location.ts";
import { hash$, pathname$, searchParams$ } from "../../signals/route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { shouldHandleLinkClick } from "../router/link-click.ts";

export function ThreadMailLink({
  thread,
  destination,
  disabled = false,
  onClick,
  className,
  ...props
}: Omit<ComponentProps<"a">, "href"> & {
  readonly thread: ChatPanelSignals;
  readonly destination: ThreadMailDestination;
  readonly disabled?: boolean;
}) {
  const pathname = useGet(pathname$);
  const searchParams = useGet(searchParams$);
  const hash = useGet(hash$);
  const signal = useGet(pageSignal$);
  const navigate = useSet(navigateThreadMail$);
  const params = threadMailParams(searchParams, thread.threadId, destination);
  return (
    <a
      {...props}
      href={`${pathname}?${params.toString()}${hash}`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : props.tabIndex}
      className={cn(className, disabled && "pointer-events-none opacity-50")}
      onClick={(event) => {
        onClick?.(event);
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (shouldHandleLinkClick(event)) {
          // Only plain activation updates this page; modified links retain
          // their native destination and browsing context.
          event.preventDefault();
          detach(navigate(thread, destination, signal), Reason.DomCallback);
        }
      }}
    />
  );
}

export function ThreadMailButton({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ThreadEmailManager];
  const exists = useGet(thread.threadExists$);
  return enabled && exists ? <ThreadMailButtonInner thread={thread} /> : null;
}

function ThreadMailButtonInner({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const mails = useLastLoadable(thread.mail.mails$);
  const open = useGet(thread.mail.open$);
  const openList = useSet(openThreadMailList$);
  const close = useSet(thread.mail.close$);
  const target = useGet(thread.sidebar.target$);
  const pending = useGet(thread.mail.pending$);
  // Keep an already-open empty list usable after its last draft is deleted.
  if (
    !open &&
    pending === null &&
    mails.state === "hasData" &&
    mails.data.length === 0
  ) {
    return null;
  }
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          if (!next && pending !== null) {
            details.cancel();
            return;
          }
          if (next) {
            openList(thread);
          } else {
            close();
          }
        }}
      >
        <PopoverTrigger
          render={
            <Button
              showTooltip
              type="button"
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className="shrink-0"
              aria-label={t(($) => {
                return $.chat.mail.manager.open;
              })}
            />
          }
        >
          <Mail size={18} />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          aria-label={t(($) => {
            return $.chat.mail.manager.title;
          })}
          finalFocus={
            target?.type === "email-draft" && target.fromMailList
              ? false
              : undefined
          }
          className={cn(
            "flex max-h-[min(600px,var(--available-height))] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden p-0",
            open && "[view-transition-name:thread-email-panel]",
            "[html:active-view-transition-type(thread-mail)_&]:transition-none [html:active-view-transition-type(thread-mail)_&]:data-starting-style:opacity-100 [html:active-view-transition-type(thread-mail)_&]:data-starting-style:[transform:none] [html:active-view-transition-type(thread-mail)_&]:data-ending-style:opacity-100 [html:active-view-transition-type(thread-mail)_&]:data-ending-style:[transform:none]",
          )}
        >
          <ThreadMailList thread={thread} />
        </PopoverContent>
      </Popover>
      <ThreadMailConfirmation thread={thread} />
    </>
  );
}

function ThreadMailList({ thread }: { readonly thread: ChatPanelSignals }) {
  return (
    <>
      <ThreadMailHeader thread={thread} />
      <ThreadMailSelection thread={thread} />
      <ThreadMailRows thread={thread} />
      <ThreadMailFooter thread={thread} />
    </>
  );
}

function ThreadMailHeader({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const manager = thread.mail;
  const mails = useLastLoadable(manager.mails$);
  const query = useGet(manager.query$);
  const setQuery = useSet(manager.setQuery$);
  const close = useSet(manager.close$);
  return (
    <div className="shrink-0 space-y-3 border-b border-border/60 p-4">
      <div className="flex items-center gap-2">
        <Mail size={18} className="text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium">
          {t(($) => {
            return $.chat.mail.manager.title;
          })}
          <span className="ml-2 text-xs text-muted-foreground">
            {mails.state === "hasData" ? mails.data.length : 0}
          </span>
        </h2>
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          onClick={close}
          aria-label={t(($) => {
            return $.chat.mail.manager.close;
          })}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="relative">
        <Search
          size={15}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="pl-9"
          aria-label={t(($) => {
            return $.chat.mail.manager.search;
          })}
          placeholder={t(($) => {
            return $.chat.mail.manager.search;
          })}
        />
      </div>
      <ThreadMailFilters thread={thread} />
    </div>
  );
}

function ThreadMailFilters({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const mails = useLastLoadable(thread.mail.mails$);
  const filter = useGet(thread.mail.filter$);
  const setFilter = useSet(thread.mail.setFilter$);
  const allMails = mails.state === "hasData" ? mails.data : [];
  const filters: readonly {
    readonly value: ThreadMailFilter;
    readonly label: string;
  }[] = [
    {
      value: "all",
      label: t(($) => {
        return $.chat.mail.manager.all;
      }),
    },
    {
      value: "draft",
      label: t(($) => {
        return $.chat.mail.manager.drafts;
      }),
    },
    {
      value: "sent",
      label: t(($) => {
        return $.chat.mail.manager.sent;
      }),
    },
  ];
  return (
    <ToggleGroup<ThreadMailFilter>
      aria-label={t(($) => {
        return $.chat.mail.manager.title;
      })}
      value={[filter]}
      onValueChange={(value) => {
        const next = value[0];
        if (next !== undefined) {
          setFilter(next);
        }
      }}
      className="gap-1"
    >
      {filters.map((item) => {
        const count = allMails.filter((mail) => {
          return item.value === "all" || mail.status === item.value;
        }).length;
        return (
          <Toggle
            key={item.value}
            value={item.value}
            variant="quiet"
            size="sm"
            aria-label={item.label}
          >
            {item.label}
            <span className="text-xs text-muted-foreground">{count}</span>
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}

function ThreadMailSelection({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const filtered = useLastLoadable(thread.mail.filtered$);
  const selected = useGet(thread.mail.selected$);
  const pending = useGet(thread.mail.pending$);
  const selectAll = useSet(thread.mail.selectAll$);
  const signal = useGet(pageSignal$);
  const rows = filtered.state === "hasData" ? filtered.data : [];
  const allSelected =
    rows.length > 0 &&
    rows.every((mail) => {
      return selected.has(mail.mailDraftId);
    });
  const someSelected = rows.some((mail) => {
    return selected.has(mail.mailDraftId);
  });
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
      <Checkbox
        id={`mail-select-all-${thread.threadId}`}
        checked={allSelected}
        indeterminate={someSelected && !allSelected}
        disabled={pending !== null || rows.length === 0}
        onCheckedChange={(checked) => {
          detach(selectAll(checked, signal), Reason.DomCallback);
        }}
      />
      <label
        htmlFor={`mail-select-all-${thread.threadId}`}
        className="cursor-pointer text-xs text-muted-foreground"
      >
        {t(($) => {
          return $.chat.mail.manager.selectAll;
        })}
      </label>
      <span className="ml-auto text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.chat.mail.manager.selected;
          },
          { quantity: selected.size },
        )}
      </span>
    </div>
  );
}

function ThreadMailRows({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const filtered = useLastLoadable(thread.mail.filtered$);
  const query = useGet(thread.mail.query$);
  const filter = useGet(thread.mail.filter$);
  const refresh = useSet(thread.mail.refresh$);
  const listRef = useSet(thread.mail.listRef$);
  const rows = filtered.state === "hasData" ? filtered.data : [];
  return (
    <div
      ref={filtered.state === "hasData" ? listRef : undefined}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    >
      {filtered.state === "hasError" ? (
        <div
          className="space-y-3 p-8 text-center text-sm text-muted-foreground"
          role="alert"
        >
          <p>
            {t(($) => {
              return $.chat.mail.manager.loadError;
            })}
          </p>
          <Button variant="outline" size="sm" onClick={refresh}>
            {t(($) => {
              return $.chat.mail.manager.retry;
            })}
          </Button>
        </div>
      ) : filtered.state === "loading" ? (
        <ThreadMailRowsSkeleton />
      ) : rows.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          {query || filter !== "all"
            ? t(($) => {
                return $.chat.mail.manager.noMatches;
              })
            : t(($) => {
                return $.chat.mail.manager.empty;
              })}
        </p>
      ) : (
        rows.map((mail) => {
          return (
            <ThreadMailRow key={mail.mailDraftId} thread={thread} mail={mail} />
          );
        })
      )}
    </div>
  );
}

function ThreadMailRowsSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.chat.mail.manager.loading;
      })}
    >
      {[0, 1, 2].map((row) => {
        return (
          <div
            key={row}
            aria-hidden="true"
            className="flex items-center gap-3 border-b border-border/40 px-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-4 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 items-center gap-2 px-4 py-4">
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
              <Skeleton className="h-6 w-12 shrink-0 rounded-md" />
              <Skeleton className="h-4 w-4 shrink-0" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThreadMailFooter({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const drafts = useLastLoadable(thread.mail.selectedDrafts$);
  const pending = useGet(thread.mail.pending$);
  const result = useGet(thread.mail.result$);
  const prepare = useSet(thread.mail.prepare$);
  const signal = useGet(pageSignal$);
  const draftCount = drafts.state === "hasData" ? drafts.data.length : 0;
  if (draftCount === 0) {
    return null;
  }
  const disabled = pending !== null;
  return (
    <div className="shrink-0 space-y-3 border-t border-border/60 p-4">
      <p className="text-xs text-muted-foreground" role="status">
        {result
          ? t(
              ($) => {
                return $.chat.mail.manager.result;
              },
              { succeeded: result.succeeded, failed: result.failed },
            )
          : t(($) => {
              return $.chat.mail.manager.draftOnly;
            })}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="text-destructive hover:text-destructive"
          onClick={() => {
            detach(prepare("delete", signal), Reason.DomCallback);
          }}
        >
          <Trash size={15} />
          {t(($) => {
            return $.chat.actions.delete;
          })}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          className="ml-auto"
          onClick={() => {
            detach(prepare("send", signal), Reason.DomCallback);
          }}
        >
          <Send size={15} />
          {t(($) => {
            return $.chat.actions.send;
          })}
        </Button>
      </div>
    </div>
  );
}

function ThreadMailRow({
  thread,
  mail,
}: {
  readonly thread: ChatPanelSignals;
  readonly mail: ThreadMailSummary;
}) {
  const { t } = useTranslation();
  const selected = useGet(thread.mail.selected$);
  const pending = useGet(thread.mail.pending$);
  const select = useSet(thread.mail.select$);
  const subject =
    mail.subject ||
    t(($) => {
      return $.chat.mail.manager.noSubject;
    });
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-border/40 px-4 last:border-b-0",
        selected.has(mail.mailDraftId) && "bg-state-selected",
      )}
    >
      <Checkbox
        checked={selected.has(mail.mailDraftId)}
        disabled={pending !== null}
        aria-label={t(
          ($) => {
            return $.chat.mail.manager.selectEmail;
          },
          { subject },
        )}
        onCheckedChange={(checked) => {
          select(mail.mailDraftId, checked);
        }}
      />
      <ThreadMailLink
        thread={thread}
        destination={{
          view: "detail",
          mailDraftId: mail.mailDraftId,
          fromList: true,
        }}
        disabled={pending !== null}
        className={cn(
          buttonVariants({ variant: "quiet" }),
          "h-auto min-w-0 flex-1 justify-start rounded-none py-4 text-left",
        )}
        aria-label={t(
          ($) => {
            return $.chat.mail.manager.openEmail;
          },
          { subject },
        )}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-medium">{subject}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">
            {mail.from}
          </p>
        </div>
        <span className="rounded-md bg-muted px-2 py-1 text-xs font-normal text-muted-foreground">
          {mail.status === "sent"
            ? t(($) => {
                return $.chat.mail.manager.sent;
              })
            : t(($) => {
                return $.chat.mail.manager.draft;
              })}
        </span>
        <ChevronRight size={14} className="text-muted-foreground" />
      </ThreadMailLink>
    </div>
  );
}

function ThreadMailConfirmation({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pending = useGet(thread.mail.pending$);
  const cancel = useSet(thread.mail.cancel$);
  const [confirmation, confirm] = useLoadableSet(thread.mail.confirm$);
  const busy = confirmation.state === "loading";
  const signal = useGet(pageSignal$);
  const sending = pending?.action === "send";
  const count = pending?.mails.length ?? 0;
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open, details) => {
        if (!open && busy) {
          details.cancel();
          return;
        }
        if (!open) {
          cancel();
        }
      }}
    >
      <DialogContent
        maxWidth="sm"
        showCloseButton={!busy}
        closeLabel={t(($) => {
          return $.chat.mail.manager.cancel;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {sending
              ? t(
                  ($) => {
                    return $.chat.mail.manager.sendTitle;
                  },
                  { quantity: count },
                )
              : t(
                  ($) => {
                    return $.chat.mail.manager.deleteTitle;
                  },
                  { quantity: count },
                )}
          </DialogTitle>
          <DialogDescription>
            {sending
              ? t(
                  ($) => {
                    return $.chat.mail.manager.sendDescription;
                  },
                  { quantity: count },
                )
              : t(
                  ($) => {
                    return $.chat.mail.manager.deleteDescription;
                  },
                  { quantity: count },
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={cancel}>
            {t(($) => {
              return $.chat.mail.manager.cancel;
            })}
          </Button>
          <Button
            variant={sending ? "default" : "destructive"}
            disabled={busy}
            onClick={() => {
              detach(confirm(signal), Reason.DomCallback);
            }}
          >
            {busy ? (
              <Loader2
                size={16}
                className="animate-spin motion-reduce:animate-none"
              />
            ) : sending ? (
              <Send size={16} />
            ) : (
              <Trash size={16} />
            )}
            {sending
              ? t(($) => {
                  return $.chat.actions.send;
                })
              : t(($) => {
                  return $.chat.actions.delete;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
