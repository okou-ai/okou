import type { UserNotification } from "@okouai/api-contracts/contracts/user-notifications";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Bell, ChevronRight } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  cn,
  useMediaQuery,
} from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  notificationInbox$,
  type NotificationInbox,
} from "../../signals/okou-page/user-notifications.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  formatChatTimestamp,
  formatLocalizedNumber,
  formatRelativeTimestamp,
} from "../../i18n/format.ts";
import { Markdown } from "../components/markdown.tsx";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";

function InboxSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.userNotifications.loading;
      })}
      className="space-y-6 px-4 py-5"
    >
      {[0, 1, 2].map((n) => {
        return (
          <div key={n} className="space-y-2" aria-hidden="true">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        );
      })}
    </div>
  );
}

function ReadError({ inbox }: { readonly inbox: NotificationInbox }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const request = useLoadable(inbox.readRequest$);
  const retry = useSet(inbox.markRead$);
  if (request.state !== "hasError") {
    return null;
  }
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 text-sm text-destructive"
    >
      <p>
        {t(($) => {
          return $.userNotifications.readFailed;
        })}
      </p>
      <Button
        variant="quiet"
        size="sm"
        onClick={() => {
          detach(retry(signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.userNotifications.retry;
        })}
      </Button>
    </div>
  );
}

function RichTextNotification({
  inbox,
  item,
}: {
  readonly inbox: NotificationInbox;
  readonly item: UserNotification;
}) {
  const { t } = useTranslation();
  const mounted = useSet(inbox.detailRef$);
  return (
    <>
      <div ref={mounted} className="min-w-0 space-y-5">
        <DialogHeader className="space-y-3 pr-7">
          <DialogDescription>
            {t(($) => {
              return $.userNotifications.sender;
            })}
          </DialogDescription>
          <DialogTitle className="text-2xl leading-tight">
            {item.title}
          </DialogTitle>
          <time
            dateTime={item.createdAt}
            className="block text-xs text-muted-foreground"
          >
            {formatChatTimestamp(item.createdAt)}
          </time>
        </DialogHeader>
        <Markdown
          source={item.payload.markdown}
          escapeHtml
          mediaPreview={false}
          className="text-sm! leading-relaxed!"
        />
      </div>
      <ReadError inbox={inbox} />
    </>
  );
}

function NotificationDetail({ inbox }: { readonly inbox: NotificationInbox }) {
  const { t } = useTranslation();
  const detail = useLoadable(inbox.detail$);
  const retry = useSet(inbox.retryDetail$);
  if (detail.state === "loading") {
    return (
      <>
        <DialogTitle className="sr-only">
          {t(($) => {
            return $.userNotifications.title;
          })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t(($) => {
            return $.userNotifications.loading;
          })}
        </DialogDescription>
        <InboxSkeleton />
      </>
    );
  }
  if (detail.state === "hasError") {
    return (
      <>
        <DialogTitle>
          {t(($) => {
            return $.userNotifications.title;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.userNotifications.detailFailed;
          })}
        </DialogDescription>
        <Button variant="outline" onClick={retry}>
          {t(($) => {
            return $.userNotifications.retry;
          })}
        </Button>
      </>
    );
  }
  const item = detail.data;
  if (!item) {
    return null;
  }
  // rich_text is informational. Future approval payloads must render their
  // own decision UI; a read receipt is never a confirm/approve operation.
  switch (item.payload.type) {
    case "rich_text": {
      return <RichTextNotification inbox={inbox} item={item} />;
    }
    default: {
      // A newer API can add a type while this browser still has older assets.
      // Unsupported content must not gain a rich-text renderer or read receipt.
      return (
        <>
          <DialogTitle>
            {t(($) => {
              return $.userNotifications.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.userNotifications.detailFailed;
            })}
          </DialogDescription>
        </>
      );
    }
  }
}

function InboxList({ inbox }: { readonly inbox: NotificationInbox }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const items = useLastLoadable(inbox.items$);
  const cursor = useLoadable(inbox.nextCursor$);
  const select = useSet(inbox.select$);
  const refresh = useSet(inbox.refresh$);
  const listRef = useSet(inbox.listRef$);
  const [more, loadMore] = useLoadableSet(inbox.loadMore$);
  if (items.state === "loading") {
    return <InboxSkeleton />;
  }
  if (items.state === "hasError") {
    return (
      <div
        role="status"
        className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.userNotifications.loadFailed;
          })}
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t(($) => {
            return $.userNotifications.retry;
          })}
        </Button>
      </div>
    );
  }
  if (items.data.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-gray-50 text-muted-foreground">
          <Bell size={20} aria-hidden="true" />
        </span>
        <p className="text-sm font-medium">
          {t(($) => {
            return $.userNotifications.empty;
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.userNotifications.emptyDescription;
          })}
        </p>
      </div>
    );
  }
  return (
    <div ref={listRef} className="max-h-112 min-h-0 overflow-y-auto p-1">
      {items.data.map((item) => {
        return (
          <button
            type="button"
            key={item.id}
            data-notification-id={item.id}
            className="group flex min-h-22 w-full items-start gap-2.5 rounded-lg px-3 py-3 text-left outline-none transition-colors hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              select(item.id);
            }}
          >
            <span className="mt-1.5 flex w-1.5 shrink-0">
              {!item.readAt && (
                <>
                  <span className="size-1.5 rounded-full bg-red-500" />
                  <span className="sr-only">
                    {t(($) => {
                      return $.userNotifications.unread;
                    })}
                  </span>
                </>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "line-clamp-2 text-sm leading-5",
                  !item.readAt && "font-semibold",
                )}
              >
                {item.title}
              </span>
              <span className="mt-1 block truncate text-xs text-muted-foreground">
                {item.summary}
              </span>
              <time
                dateTime={item.createdAt}
                className="mt-1.5 block text-xs text-muted-foreground"
              >
                {formatRelativeTimestamp(item.createdAt)}
              </time>
            </span>
            <ChevronRight
              className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden="true"
            />
          </button>
        );
      })}
      {more.state === "hasError" && (
        <p role="status" className="px-3 py-2 text-xs text-destructive">
          {t(($) => {
            return $.userNotifications.loadFailed;
          })}
        </p>
      )}
      {cursor.state === "hasData" && cursor.data && (
        <Button
          variant="quiet"
          size="sm"
          className="w-full"
          pending={more.state === "loading"}
          onClick={() => {
            detach(loadMore(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.userNotifications.loadMore;
          })}
        </Button>
      )}
    </div>
  );
}

function InboxHeader({ inbox }: { readonly inbox: NotificationInbox }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const summary = useLastLoadable(inbox.summary$);
  const refreshSummary = useSet(inbox.refreshSummary$);
  const [markAll, readAll] = useLoadableSet(inbox.markAllRead$);
  const count =
    summary.state === "hasData" ? summary.data.unreadCount : undefined;
  return (
    <>
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-sm font-semibold">
            {t(($) => {
              return $.userNotifications.title;
            })}
          </h2>
          {count !== undefined && (
            <span className="whitespace-nowrap rounded-full bg-gray-50 px-2 py-0.5 text-xs text-muted-foreground">
              {formatLocalizedNumber(count)}
            </span>
          )}
        </div>
        <Button
          variant="quiet"
          size="sm"
          className="px-2 text-xs"
          pending={markAll.state === "loading"}
          disabled={count === undefined || count === 0}
          onClick={() => {
            detach(readAll(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.userNotifications.readAll;
          })}
        </Button>
      </div>
      {markAll.state === "hasError" && (
        <p role="status" className="px-3 py-2 text-xs text-destructive">
          {t(($) => {
            return $.userNotifications.readFailed;
          })}
        </p>
      )}
      {summary.state === "hasError" && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground"
        >
          <p>
            {t(($) => {
              return $.userNotifications.countUnavailable;
            })}
          </p>
          <Button variant="quiet" size="sm" onClick={refreshSummary}>
            {t(($) => {
              return $.userNotifications.retry;
            })}
          </Button>
        </div>
      )}
    </>
  );
}

function NotificationInboxView() {
  const { t } = useTranslation();
  const inbox = useGet(notificationInbox$);
  const summary = useLastLoadable(inbox.summary$);
  const open = useGet(inbox.open$);
  const selectedId = useGet(inbox.selectedId$);
  const lastSelectedId = useGet(inbox.lastSelectedId$);
  const setOpen = useSet(inbox.setOpen$);
  const closeDetail = useSet(inbox.closeDetail$);
  const count =
    summary.state === "hasData" ? summary.data.unreadCount : undefined;
  const id = inbox.descriptionId;
  return (
    <>
      <Popover open={open && selectedId === null} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <IconButton
              type="button"
              aria-label={t(($) => {
                return $.userNotifications.title;
              })}
              aria-describedby={id}
              className="relative size-8 shrink-0 text-muted-foreground pointer-coarse:size-11"
            />
          }
        >
          <Bell className="size-4" aria-hidden="true" />
          {count !== undefined && count > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 size-2 rounded-full border border-background bg-red-500"
            />
          )}
          <span id={id} className="sr-only">
            {count === undefined
              ? t(($) => {
                  return $.userNotifications.countUnavailable;
                })
              : t(
                  ($) => {
                    return $.userNotifications.unreadCount;
                  },
                  { count },
                )}
          </span>
        </PopoverTrigger>
        <PopoverContent
          aria-label={t(($) => {
            return $.userNotifications.title;
          })}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          // Returning content resolves asynchronously. The list's mount ref
          // restores the selected row after it exists, preserving its scroll.
          initialFocus={lastSelectedId ? false : undefined}
          finalFocus={selectedId ? false : undefined}
          className="flex max-h-[var(--available-height)] w-100 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-1"
        >
          <InboxHeader inbox={inbox} />
          <InboxList inbox={inbox} />
        </PopoverContent>
      </Popover>
      <Dialog
        open={selectedId !== null}
        onOpenChange={(value) => {
          if (!value) {
            closeDetail();
          }
        }}
      >
        <DialogContent
          maxWidth={560}
          closeLabel={t(($) => {
            return $.userNotifications.close;
          })}
          finalFocus={() => {
            return (
              document.querySelector<HTMLElement>(
                `[data-notification-id="${lastSelectedId}"]`,
              ) ?? document.getElementById(id)?.closest<HTMLElement>("button")
            );
          }}
        >
          <NotificationDetail inbox={inbox} />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UserNotificationsEntry({
  desktop = false,
}: {
  readonly desktop?: boolean;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.UserNotifications];
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  return enabled && desktop === isDesktop ? <NotificationInboxView /> : null;
}
