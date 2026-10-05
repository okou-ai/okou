import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Search, SquarePen } from "lucide-react";
import { Button } from "@okouai/ui";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { chatThreadOnlyArchived$ } from "../../signals/chat-page/chat-thread-only-archived.ts";
import { chatThreadOnlyMuted$ } from "../../signals/chat-page/chat-thread-only-muted.ts";
import { chatThreadOnlyUnread$ } from "../../signals/chat-page/chat-thread-only-unread.ts";
import {
  createNewChatThread$,
  newChatThreadDisabled$,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import type {
  SidebarChatThreadListSignals,
  SidebarChatThreadScrollSignals,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import {
  selectChatThreadFilter$,
  type ChatThreadFilter,
} from "../../signals/okou-page/chat-thread-filter-selection.ts";
import {
  PWA_CHAT_THREAD_ROW_HEIGHT,
  pwaChatThreadScrollSignals$,
} from "../../signals/okou-page/pwa-chat-list.ts";
import { openThreeColumnSearchDialog$ } from "../../signals/okou-page/sidebar-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { PwaAgentSwitcher } from "./pwa-agent-switcher.tsx";
import { OverlayScrollArea } from "./sidebar-scroll.tsx";
import { ChatThreadItem, ChatThreadsListMenu } from "./sidebar-threads.tsx";

function useSelectFilter() {
  const selectFilter = useSet(selectChatThreadFilter$);
  const signal = useGet(pageSignal$);
  return (filter: ChatThreadFilter) => {
    detach(selectFilter(filter, signal), Reason.DomCallback);
  };
}

function PwaChatListHeader() {
  const { t } = useTranslation();
  const currentAgentId = useLastResolved(currentChatAgentId$);
  const createNewChat = useSet(createNewChatThread$);
  const rootSignal = useGet(rootSignal$);
  const newChatDisabled = useGet(newChatThreadDisabled$);
  const openSearch = useSet(openThreeColumnSearchDialog$);

  return (
    <header className="shrink-0 px-4 pt-2">
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <PwaAgentSwitcher />
        </div>
        <Button
          variant="quiet"
          size="icon"
          iconSize="lg"
          className="min-h-11 min-w-11 shrink-0"
          disabled={!currentAgentId || newChatDisabled}
          aria-label={t(($) => {
            return $.chat.newChat;
          })}
          onClick={() => {
            if (currentAgentId) {
              detach(
                createNewChat(currentAgentId, "main", rootSignal),
                Reason.DomCallback,
              );
            }
          }}
        >
          <SquarePen aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="quiet"
          size="icon"
          iconSize="lg"
          className="min-h-11 min-w-11 shrink-0"
          aria-label={t(($) => {
            return $.appShell.sidebar.searchWorkspace;
          })}
          onClick={openSearch}
        >
          <Search aria-hidden="true" />
        </Button>
        <ChatThreadsListMenu showMarkAllRead touch />
      </div>
    </header>
  );
}

function ShowAllChatsButton() {
  const { t } = useTranslation();
  const selectFilter = useSelectFilter();
  return (
    <Button
      variant="quiet"
      className="min-h-11"
      onClick={() => {
        selectFilter("all");
      }}
    >
      {t(($) => {
        return $.chat.sidebar.showAllChats;
      })}
    </Button>
  );
}

function PwaChatListEmpty({
  hasHiddenArchivedThreads,
}: {
  hasHiddenArchivedThreads: boolean;
}) {
  const { t } = useTranslation();
  const unread = useGet(chatThreadOnlyUnread$);
  const archived = useGet(chatThreadOnlyArchived$);
  const muted = useGet(chatThreadOnlyMuted$);
  const selectFilter = useSelectFilter();
  const message = unread
    ? t(($) => {
        return $.chat.sidebar.noUnread;
      })
    : archived
      ? t(($) => {
          return $.chat.sidebar.noArchived;
        })
      : muted
        ? t(($) => {
            return $.chat.sidebar.noMuted;
          })
        : hasHiddenArchivedThreads
          ? t(($) => {
              return $.chat.sidebar.allArchived;
            })
          : t(($) => {
              return $.chat.sidebar.empty;
            });

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center text-muted-foreground">
      <MessageSquare size={28} aria-hidden="true" />
      <p className="text-sm">{message}</p>
      {unread || archived || muted ? <ShowAllChatsButton /> : null}
      {hasHiddenArchivedThreads ? (
        <Button
          variant="quiet"
          className="min-h-11"
          onClick={() => {
            selectFilter("archived");
          }}
        >
          {t(($) => {
            return $.chat.sidebar.showArchivedChats;
          })}
        </Button>
      ) : null}
    </div>
  );
}

function PwaChatThreads({
  listSignals,
  scrollSignals,
}: {
  listSignals: SidebarChatThreadListSignals;
  scrollSignals: SidebarChatThreadScrollSignals;
}) {
  const { t } = useTranslation();
  const count = useGet(listSignals.count$);
  const rowCount = useGet(listSignals.rowCount$);
  const window = useGet(listSignals.window$);
  const hasHiddenArchivedThreads = useGet(
    listSignals.hasHiddenArchivedThreads$,
  );

  if (count === 0) {
    return (
      <PwaChatListEmpty hasHiddenArchivedThreads={hasHiddenArchivedThreads} />
    );
  }

  return (
    <OverlayScrollArea
      scrollSignals={scrollSignals}
      className="min-h-0 flex-1"
      contentClassName="px-3 pb-3"
      aria-label={t(($) => {
        return $.chat.sidebar.chatThreads;
      })}
    >
      <div
        className="relative w-full"
        style={{ height: rowCount * PWA_CHAT_THREAD_ROW_HEIGHT }}
      >
        {window.items.map((signals, offset) => {
          const index = window.startIndex + offset;
          return (
            <div
              key={signals.threadId}
              className="absolute left-0 top-0 w-full pb-1"
              style={{
                transform: `translateY(${index * PWA_CHAT_THREAD_ROW_HEIGHT}px)`,
              }}
            >
              <ChatThreadItem
                signals={signals}
                shortcutNumber={undefined}
                touch
              />
            </div>
          );
        })}
        {window.showAllChatsRow ? (
          <div
            className="absolute left-0 top-0 flex h-14 w-full items-center"
            style={{
              transform: `translateY(${(rowCount - 1) * PWA_CHAT_THREAD_ROW_HEIGHT}px)`,
            }}
          >
            <ShowAllChatsButton />
          </div>
        ) : null}
      </div>
    </OverlayScrollArea>
  );
}

function PwaChatListContent() {
  const { t } = useTranslation();
  const scrollSignals = useGet(pwaChatThreadScrollSignals$);
  const list = useLoadable(scrollSignals.list$);

  if (list.state === "loading") {
    return (
      <div className="space-y-3 px-4 py-3" aria-busy="true">
        {[0, 1, 2, 3, 4, 5].map((index) => {
          return <Skeleton key={index} className="h-11 w-full" />;
        })}
      </div>
    );
  }
  if (list.state === "hasError") {
    return (
      <p role="alert" className="px-4 py-8 text-sm text-muted-foreground">
        {t(($) => {
          return $.appShell.pwaNavigation.chatListUnavailable;
        })}
      </p>
    );
  }
  return (
    <PwaChatThreads listSignals={list.data} scrollSignals={scrollSignals} />
  );
}

export function PwaChatListPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PwaChatListHeader />
      <PwaChatListContent />
    </div>
  );
}
