import { DEFAULT_AGENT_AVATAR_URL } from "@okouai/core/agent-avatar";
import { assistantName$ } from "../../signals/branding.ts";
// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastResolved,
  useLoadable,
  type Loadable,
} from "ccstate-react";
import { Loader2 } from "lucide-react";
import type { ChatSearchResult } from "@okouai/api-contracts/contracts/chat-threads";
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  RunningIndicator,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { formatRelativeTimestamp } from "../../i18n/format.ts";
import { emptySearchImg } from "./platform-assets.ts";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/okou-page/sidebar-state.ts";
import { sidebarActiveThreadIds$ } from "../../signals/chat-page/chat-thread-indicators.ts";
import { sidebarUnreadThreadIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  MAX_VISIBLE_SEARCH_RESULTS,
  workspaceSearchChatMessages$,
  workspaceSearchChatThreadMap$,
  threeColumnSearchChatThreads$,
  type WorkspaceSearchChatThread,
} from "../../signals/okou-page/workspace-chat-search.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  threadNumberShortcutsEnabled$,
  threadNumberShortcutIndex$,
} from "../../signals/okou-page/thread-number-shortcuts.ts";
import { ThreadNumberShortcutHint } from "./thread-number-shortcut-hint.tsx";
import { AvatarFromUrl, ChatThreadStateText } from "./sidebar-shared.tsx";

function ChatThreadCommandIndicator({
  threadId,
}: {
  readonly threadId: string;
}) {
  const running =
    useLastResolved(sidebarActiveThreadIds$)?.has(threadId) ?? false;
  const unread =
    useLastResolved(sidebarUnreadThreadIds$)?.has(threadId) ?? false;
  const indicator = running ? "running" : unread ? "unread" : null;
  if (indicator === null) {
    return null;
  }
  return (
    <>
      {indicator === "running" ? (
        <RunningIndicator />
      ) : (
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-sky-600" />
      )}
      <ChatThreadStateText state={indicator} />
    </>
  );
}

interface ChatMessageSnippetPart {
  readonly start: number;
  readonly text: string;
  readonly matched: boolean;
}

const CHAT_MESSAGE_SNIPPET_LENGTH = 140;

function avoidSplitSurrogateStart(content: string, start: number): number {
  if (start === 0) {
    return start;
  }
  const code = content.charCodeAt(start);
  return code >= 0xdc_00 && code <= 0xdf_ff ? start - 1 : start;
}

function avoidSplitSurrogateEnd(content: string, end: number): number {
  if (end === content.length) {
    return end;
  }
  const code = content.charCodeAt(end - 1);
  return code >= 0xd8_00 && code <= 0xdb_ff ? end + 1 : end;
}

function chatMessageSnippetParts(
  content: string,
  ranges: ChatSearchResult["matchedRanges"],
): ChatMessageSnippetPart[] {
  const validRanges = ranges.filter((range) => {
    return (
      range.start >= 0 && range.end > range.start && range.end <= content.length
    );
  });
  const firstRange = validRanges[0] ?? { start: 0, end: 0 };
  const matchLength = firstRange.end - firstRange.start;
  const contextLength = Math.max(0, CHAT_MESSAGE_SNIPPET_LENGTH - matchLength);
  let start = Math.max(0, firstRange.start - Math.floor(contextLength / 2));
  let end = Math.min(content.length, start + CHAT_MESSAGE_SNIPPET_LENGTH);
  start = Math.max(0, end - CHAT_MESSAGE_SNIPPET_LENGTH);
  start = avoidSplitSurrogateStart(content, start);
  end = avoidSplitSurrogateEnd(content, end);

  const visibleRanges = validRanges.flatMap((range) => {
    const visibleStart = Math.max(start, range.start);
    const visibleEnd = Math.min(end, range.end);
    return visibleStart < visibleEnd
      ? [{ start: visibleStart, end: visibleEnd }]
      : [];
  });
  const parts: ChatMessageSnippetPart[] = [];
  let cursor = start;
  for (const range of visibleRanges) {
    if (range.start > cursor) {
      parts.push({
        start: cursor,
        text: content.slice(cursor, range.start),
        matched: false,
      });
    }
    parts.push({
      start: range.start,
      text: content.slice(range.start, range.end),
      matched: true,
    });
    cursor = range.end;
  }
  if (cursor < end) {
    parts.push({
      start: cursor,
      text: content.slice(cursor, end),
      matched: false,
    });
  }
  return parts;
}

function ChatMessageSnippet({
  message,
}: {
  readonly message: ChatSearchResult;
}) {
  const content = message.matchedMessage.content;
  const parts = chatMessageSnippetParts(content, message.matchedRanges);
  return (
    <span
      className="block truncate text-xs text-muted-foreground"
      aria-label={content}
    >
      <span aria-hidden="true">… </span>
      {parts.map((part) => {
        return (
          <span
            key={`${part.start}-${part.matched ? "match" : "text"}`}
            className={part.matched ? "font-medium text-foreground" : undefined}
          >
            {part.text}
          </span>
        );
      })}
      <span aria-hidden="true"> …</span>
    </span>
  );
}

/**
 * Trailing metadata for a spotlight row: the state dot sits in a fixed-width
 * slot ahead of the timestamp so the timestamps line up on the same rail as the
 * search input above, whether or not a row is unread.
 */
function SpotlightRowMeta({
  indicatorThreadId,
  timestamp,
  shortcutNumber,
}: {
  readonly indicatorThreadId: string;
  readonly timestamp: string;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2.5">
      {/* w-3.5 fits the widest indicator (RunningIndicator is 0.86rem) so the
          running dot is not squashed and the timestamp never shifts. */}
      <span className="flex w-3.5 shrink-0 justify-center">
        <ChatThreadCommandIndicator threadId={indicatorThreadId} />
      </span>
      <span className="text-xs text-[hsl(var(--gray-700))]">{timestamp}</span>
      <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
    </span>
  );
}

/**
 * `pl-1` rather than the usual `pl-2`: the agent avatar art carries ~4px of its
 * own margin, so the tighter box padding lands the avatar's ink on the same
 * rail as the search field's left border.
 */
const SPOTLIGHT_ROW_CLASS = "group w-full gap-3.5 py-2 pl-1 pr-2";

const SPOTLIGHT_AVATAR_CLASS =
  "h-8 w-8 shrink-0 rounded-lg object-cover object-top";

function SpotlightThreadCommandItem({
  thread,
  onSelect,
  shortcutNumber,
}: {
  readonly thread: WorkspaceSearchChatThread;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <CommandItem
      value={`spotlight-thread-${thread.id}`}
      onClick={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <AvatarFromUrl
        avatarUrl={DEFAULT_AGENT_AVATAR_URL}
        alt=""
        className={SPOTLIGHT_AVATAR_CLASS}
      />
      <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
        {thread.title}
      </span>
      <SpotlightRowMeta
        shortcutNumber={shortcutNumber}
        indicatorThreadId={thread.id}
        timestamp={formatRelativeTimestamp(thread.sortAt)}
      />
    </CommandItem>
  );
}

function SpotlightMessageCommandItem({
  message,
  thread,
  onSelect,
  shortcutNumber,
}: {
  readonly message: ChatSearchResult;
  readonly thread: WorkspaceSearchChatThread | undefined;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  const assistantName = useGet(assistantName$);
  const title = thread?.title ?? assistantName;

  return (
    <CommandItem
      value={`spotlight-message-${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
      onClick={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <AvatarFromUrl
        avatarUrl={DEFAULT_AGENT_AVATAR_URL}
        alt=""
        className={SPOTLIGHT_AVATAR_CLASS}
      />
      {/*
        A message result needs no type label: it is the only row that carries a
        second line, so the snippet already tells the two kinds apart.
      */}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm text-foreground">{title}</span>
        <ChatMessageSnippet message={message} />
      </span>
      <SpotlightRowMeta
        shortcutNumber={shortcutNumber}
        indicatorThreadId={message.chatThreadId}
        timestamp={formatRelativeTimestamp(message.matchedMessage.createdAt)}
      />
    </CommandItem>
  );
}

function SpotlightSearchInput() {
  const { t } = useTranslation("common");

  return (
    <div className="shrink-0 p-5">
      <div className="relative">
        <CommandInput
          placeholder={t(($) => {
            return $.sidebar.searchWorkspace;
          })}
          wrapperClassName="h-10"
          className="pr-12"
        />
        {/* Same keycap as the chat feedback toolbar's shortcut hints. */}
        <kbd className='pointer-events-none absolute right-3 top-1/2 inline-flex h-5 min-w-5 -translate-y-1/2 items-center justify-center rounded-md bg-background px-1 text-[10px] font-medium leading-none text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))] font-["-apple-system",BlinkMacSystemFont,"Segoe_UI",system-ui,sans-serif]'>
          {t(($) => {
            return $.sidebar.escapeShortcut;
          })}
        </kbd>
      </div>
    </div>
  );
}

interface SpotlightSearchResultsProps {
  readonly threads: readonly WorkspaceSearchChatThread[];
  readonly messages: readonly ChatSearchResult[];
  readonly threadMap: ReadonlyMap<string, WorkspaceSearchChatThread>;
  readonly searching: boolean;
  readonly showNoResults: boolean;
  readonly onSelectChatThread: (threadId: string) => void;
}

interface SpotlightQueryResult {
  readonly query: string;
}

function spotlightRowsFromLoadable<Result extends SpotlightQueryResult, Item>(
  loadable: Loadable<Result>,
  query: string,
  selectRows: (result: Result) => readonly Item[],
): readonly Item[] {
  if (loadable.state !== "hasData") {
    return [];
  }
  if (loadable.data.query !== query) {
    return [];
  }
  return selectRows(loadable.data);
}

function spotlightLoadableIsSearching<Result extends SpotlightQueryResult>(
  loadable: Loadable<Result>,
  query: string,
): boolean {
  if (loadable.state === "loading") {
    return true;
  }
  if (loadable.state !== "hasData") {
    return false;
  }
  return loadable.data.query !== query;
}

function SpotlightSearchResults({
  threads,
  messages,
  threadMap,
  searching,
  showNoResults,
  onSelectChatThread,
}: SpotlightSearchResultsProps) {
  const { t } = useTranslation("common");
  const numberShortcutsEnabled = useGet(threadNumberShortcutsEnabled$);
  const shortcutNumber = (index: number) => {
    return numberShortcutsEnabled && index < 9 ? index + 1 : undefined;
  };

  return (
    <CommandList className="min-h-[min(300px,65dvh)] max-h-[min(560px,65dvh)] overscroll-contain px-3 pb-4">
      {threads.length > 0 && (
        <CommandGroup
          heading={t(($) => {
            return $.sidebar.sections.threads;
          })}
        >
          {threads.map((thread, index) => {
            return (
              <SpotlightThreadCommandItem
                shortcutNumber={shortcutNumber(index)}
                key={thread.id}
                thread={thread}
                onSelect={() => {
                  return onSelectChatThread(thread.id);
                }}
              />
            );
          })}
        </CommandGroup>
      )}
      {messages.length > 0 && (
        <CommandGroup
          heading={t(($) => {
            return $.sidebar.sections.messages;
          })}
        >
          {messages.map((message, index) => {
            return (
              <SpotlightMessageCommandItem
                shortcutNumber={shortcutNumber(threads.length + index)}
                key={`${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
                message={message}
                thread={threadMap.get(message.chatThreadId)}
                onSelect={() => {
                  return onSelectChatThread(message.chatThreadId);
                }}
              />
            );
          })}
        </CommandGroup>
      )}
      {searching ? (
        <div
          className="flex items-center gap-2 py-2 pl-1 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t(($) => {
            return $.sidebar.searching;
          })}
        </div>
      ) : null}
      {showNoResults ? (
        // Same empty-state shape as the artifacts and workflows lists: a 96px-tall
        // scene illustration over a single line, centred in the list's minimum
        // height so the dialog does not resize as results come and go.
        <div className="flex min-h-[268px] flex-col items-center justify-center px-6 text-center">
          <img
            src={emptySearchImg}
            alt=""
            role="presentation"
            loading="lazy"
            className="h-24 w-36 object-contain"
          />
          <p className="mt-3 text-sm font-medium text-foreground">
            {t(($) => {
              return $.sidebar.noResults;
            })}
          </p>
        </div>
      ) : null}
    </CommandList>
  );
}

export function ThreeColumnSearchDialog({
  open,
  onOpenChange,
  onSelectChatThread,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectChatThread: (threadId: string) => void;
}) {
  const { t } = useTranslation("common");
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const signal = useGet(pageSignal$);
  const threadMatches = useGet(threeColumnSearchChatThreads$);
  const shortcutIndex = useSet(threadNumberShortcutIndex$);
  const threadMap = useGet(workspaceSearchChatThreadMap$);
  const messageLoadable = useLoadable(workspaceSearchChatMessages$);
  const trimmedQuery = query.trim().toLowerCase();
  const messageMatches = spotlightRowsFromLoadable(
    messageLoadable,
    trimmedQuery,
    (result) => {
      return result.chatMessages;
    },
  );
  const visibleMessages = messageMatches.slice(
    0,
    MAX_VISIBLE_SEARCH_RESULTS - threadMatches.length,
  );
  const resultCount = threadMatches.length + visibleMessages.length;
  const visibleSearching = spotlightLoadableIsSearching(
    messageLoadable,
    trimmedQuery,
  );
  const showNoResults = !visibleSearching && resultCount === 0;
  const selectThread = (threadId: string) => {
    onOpenChange(false);
    onSelectChatThread(threadId);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      smMaxWidth={820}
      position="top"
      scrollable={false}
      showCloseButton={false}
      contentClassName="gap-0"
      commandClassName="min-h-0 gap-0"
      commandProps={{
        mode: "none",
        autoHighlight: true,
        loopFocus: true,
        value: query,
        onValueChange: (value, eventDetails) => {
          if (eventDetails.reason === "item-press") {
            eventDetails.cancel();
            return;
          }
          detach(setQuery(value, signal), Reason.DomCallback);
        },
      }}
    >
      <div
        className="contents"
        onKeyDownCapture={(event) => {
          const index = shortcutIndex(event.nativeEvent);
          if (index === undefined) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const threadId =
            threadMatches[index]?.id ??
            visibleMessages[index - threadMatches.length]?.chatThreadId;
          if (threadId) {
            selectThread(threadId);
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>
            {t(($) => {
              return $.sidebar.searchWorkspace;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.sidebar.searchWorkspace;
            })}
          </DialogDescription>
        </DialogHeader>
        <SpotlightSearchInput />
        {trimmedQuery && (
          <>
            <span role="status" className="sr-only">
              {t(
                ($) => {
                  return $.sidebar.resultCount;
                },
                { count: resultCount },
              )}
            </span>
            <SpotlightSearchResults
              threads={threadMatches}
              messages={visibleMessages}
              threadMap={threadMap}
              searching={visibleSearching}
              showNoResults={showNoResults}
              onSelectChatThread={selectThread}
            />
          </>
        )}
      </div>
    </CommandDialog>
  );
}
