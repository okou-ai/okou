import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  ChevronRight,
  CircleSlash,
  MessageCircle,
  Plug,
} from "lucide-react";
import { Button, cn, RunningIndicator } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ChatRelationMessage,
  RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ChatRelationList,
  ResourceChat,
} from "../../signals/chat-page/chat-relations.ts";
import {
  formatChatTimestamp,
  formatCompactChatTimestamp,
} from "../../i18n/format.ts";
import { messageDocumentToDisplayText } from "../../signals/okou-page/user-message-document-codec.ts";
import { chatThreadMetaMap$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import {
  ChatResourceSectionHeading,
  ChatResourceSectionToggle,
  RESOURCE_GLYPH_CLASS,
  RESOURCE_PREVIEW_LIMIT,
  RESOURCE_ROW_CLASS,
  RESOURCE_SECTION_CLASS,
} from "./chat-resource-section.tsx";
import { ExternalSourceMessageAnnotation } from "./external-source-message-annotation.tsx";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";

type AgentSourcePart = Extract<
  UserMessagePart,
  { type: "source"; kind: "agent" }
>;

function useAgentOrigin(thread: ChatPanelSignals): AgentSourcePart | null {
  const origin = useGet(thread.relations.origin$);
  return origin?.kind === "source" && origin.part.kind === "agent"
    ? origin.part
    : null;
}

// An agent origin is a chat, so it is listed with the other chats. Only
// sources outside Okou keep a section of their own.
export function ChatOrigin({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel];
  const origin = useGet(thread.relations.origin$);
  if (!enabled || origin?.kind !== "source" || origin.part.kind === "agent") {
    return null;
  }
  const part = origin.part;
  return (
    <section
      className={RESOURCE_SECTION_CLASS}
      aria-label={t(($) => {
        return $.chat.relations.origin;
      })}
    >
      <ChatResourceSectionHeading
        title={t(($) => {
          return $.chat.relations.origin;
        })}
      />
      {part.kind === "mcp" ? (
        <p className={cn(RESOURCE_ROW_CLASS, "hover:bg-transparent")}>
          <span className={RESOURCE_GLYPH_CLASS}>
            <Plug size={16} />
          </span>
          <span className="min-w-0 truncate">
            {part.clientName ??
              t(($) => {
                return $.chat.origins.mcp;
              })}
          </span>
        </p>
      ) : (
        <ExternalSourceMessageAnnotation
          part={part}
          compact
          // The row pads 8px; the 15px source mark then sits centred in the
          // 20px glyph slot, and the label starts on the other titles' 36px edge.
          className="flex h-8.5 min-w-0 items-center gap-[10.5px] rounded-lg pr-2 pl-[10.5px] text-[13px] leading-5 text-foreground transition-colors hover:bg-state-hover focus-visible:bg-state-hover"
        />
      )}
    </section>
  );
}

function OriginTag() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded-[5px] border border-border px-1.5 text-[11px] leading-4 text-muted-foreground">
      {t(($) => {
        return $.chat.relations.origin;
      })}
    </span>
  );
}

function ChatStatus({ status }: { readonly status: RelatedChat["status"] }) {
  const { t } = useTranslation();
  if (status !== "running" && status !== "queued") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {status === "running" && <RunningIndicator />}
      {t(($) => {
        return status === "running"
          ? $.chat.relations.running
          : $.chat.relations.queued;
      })}
    </span>
  );
}

function ChatTitle({
  threadId,
  fallback,
}: {
  readonly threadId: string;
  readonly fallback: string | null;
}) {
  const { t } = useTranslation();
  const thread = useGet(chatThreadMetaMap$).get(threadId);
  const title =
    (thread ? thread.title : fallback) ??
    t(($) => {
      return $.chat.relations.untitled;
    });
  return <HoverScrollTitle title={title} />;
}

function MessageTime({ value }: { readonly value: string }) {
  return (
    <time
      dateTime={value}
      aria-label={formatChatTimestamp(value)}
      className="shrink-0 tabular-nums"
    >
      {formatCompactChatTimestamp(value)}
    </time>
  );
}

// A card opens the run its message started: the other chat for a sent
// message, this chat for a received one. Its full text is there.
function MessageCard({
  message,
  unavailable,
}: {
  readonly message: ChatRelationMessage;
  readonly unavailable: boolean;
}) {
  const { t } = useTranslation();
  const text = message.userMessage
    ? messageDocumentToDisplayText(message.userMessage)
    : null;
  const linked = !(unavailable && message.direction === "sent");
  const content = (
    <>
      <span className="flex items-center gap-1.5 text-xs leading-4 text-muted-foreground">
        <span className="font-medium">
          {t(($) => {
            return message.direction === "sent"
              ? $.chat.relations.sent
              : $.chat.relations.received;
          })}
        </span>
        <span className="flex-1" />
        <MessageTime value={message.createdAt} />
        {/* Reserved even at rest, so revealing it never moves the time. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {linked && (
            <ArrowUpRight
              aria-hidden="true"
              size={13}
              className="text-foreground opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-visible/message:opacity-100"
            />
          )}
        </span>
      </span>
      <span
        className={cn(
          "mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5",
          linked ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {text ||
          t(($) => {
            return $.chat.relations.messageUnavailable;
          })}
      </span>
    </>
  );
  return (
    <li>
      {linked ? (
        <Link
          pathname={ROUTES.chat}
          options={{
            pathParams: { threadId: message.targetChatThreadId },
            hash: message.targetRunId
              ? `run-${message.targetRunId}`
              : undefined,
          }}
          className="group/message block rounded-lg bg-nested-fill px-2 pb-2.5 pt-2 transition-colors hover:bg-state-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {content}
        </Link>
      ) : (
        <div className="block rounded-lg border border-dashed border-border px-2 pb-2.5 pt-2">
          {content}
        </div>
      )}
    </li>
  );
}

function MessageCards({
  id,
  list,
  unavailable,
  retry,
}: {
  readonly id: string;
  readonly list: ChatRelationList<ChatRelationMessage>;
  readonly unavailable: boolean;
  readonly retry: () => void;
}) {
  const { t } = useTranslation();
  const data = useLastLoadable(list.data$);
  if (data.state === "loading") {
    return null;
  }
  if (data.state === "hasError") {
    return (
      <div
        role="alert"
        className="mb-1 ml-7 flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"
      >
        <p>
          {t(($) => {
            return $.chat.relations.loadFailed;
          })}
        </p>
        <Button variant="quiet" size="xs" onClick={retry}>
          {t(($) => {
            return $.chat.resources.retry;
          })}
        </Button>
      </div>
    );
  }
  // Indented so the text starts on the chat titles' edge.
  return (
    <ul id={id} className="m-0 mb-1 ml-7 mt-0.5 grid list-none gap-1 p-0">
      {data.data.items.map((message) => {
        return (
          <MessageCard
            key={message.id}
            message={message}
            unavailable={unavailable}
          />
        );
      })}
    </ul>
  );
}

// The title opens the chat, as on every other row; the caret in the glyph
// slot opens its message history. Two targets, told apart by place.
function ExchangedChatRow({
  chat,
  thread,
  title,
  titleText,
  origin,
}: {
  readonly chat: ResourceChat;
  readonly thread: ChatPanelSignals;
  readonly title: ReactNode;
  readonly titleText: string;
  readonly origin: boolean;
}) {
  const { t } = useTranslation();
  const signals = thread.relations;
  const selectedPeer = useGet(signals.selectedPeer$);
  const messages = useGet(signals.messages$);
  const toggle = useSet(signals.togglePeer$);
  const retry = useSet(signals.retry$);
  const unavailable = chat.status === "unavailable";
  const expanded = selectedPeer === chat.threadId;
  const messagesId = `${thread.threadId}-messages-${chat.threadId}`;
  const rowContent = (
    <>
      {title}
      {origin && <OriginTag />}
      <ChatStatus status={chat.status} />
    </>
  );
  return (
    <li>
      <div className="relative">
        {unavailable ? (
          <span
            className={cn(
              RESOURCE_ROW_CLASS,
              "pl-9 text-muted-foreground hover:bg-transparent",
            )}
          >
            {rowContent}
          </span>
        ) : (
          <Link
            pathname={ROUTES.chat}
            options={{ pathParams: { threadId: chat.threadId } }}
            className={cn(RESOURCE_ROW_CLASS, "pl-9")}
          >
            {rowContent}
          </Link>
        )}
        <Button
          variant="quiet"
          size="icon-xs"
          className="absolute top-1/2 left-1.5 size-6 -translate-y-1/2 text-muted-foreground hover:bg-state-hover hover:text-foreground [&_svg]:size-3.5"
          aria-expanded={expanded}
          aria-controls={expanded ? messagesId : undefined}
          aria-label={t(
            ($) => {
              return $.chat.relations.toggleMessages;
            },
            { title: titleText },
          )}
          onClick={() => {
            toggle(chat.threadId);
          }}
        >
          <ChevronRight
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </Button>
      </div>
      {expanded && messages && (
        <MessageCards
          id={messagesId}
          list={messages}
          unavailable={unavailable}
          retry={retry}
        />
      )}
    </li>
  );
}

function ResourceChatRow({
  chat,
  origin,
  thread,
}: {
  readonly chat: ResourceChat;
  readonly origin: boolean;
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const meta = useGet(chatThreadMetaMap$).get(chat.threadId);
  const unavailable = chat.status === "unavailable";
  const glyph = (
    <span className={RESOURCE_GLYPH_CLASS}>
      {unavailable ? <CircleSlash size={16} /> : <MessageCircle size={16} />}
    </span>
  );
  const title = unavailable ? (
    <span className="min-w-0 flex-1 truncate text-muted-foreground">
      {t(($) => {
        return $.chat.relations.unavailable;
      })}
    </span>
  ) : (
    <ChatTitle threadId={chat.threadId} fallback={chat.title} />
  );
  if (chat.exchanged) {
    return (
      <ExchangedChatRow
        chat={chat}
        thread={thread}
        title={title}
        titleText={
          unavailable
            ? t(($) => {
                return $.chat.relations.unavailable;
              })
            : ((meta ? meta.title : chat.title) ??
              t(($) => {
                return $.chat.relations.untitled;
              }))
        }
        origin={origin}
      />
    );
  }
  if (unavailable) {
    return (
      <li>
        <span
          className={cn(
            RESOURCE_ROW_CLASS,
            "text-muted-foreground hover:bg-transparent",
          )}
        >
          {glyph}
          {title}
          {origin && <OriginTag />}
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        pathname={ROUTES.chat}
        options={{ pathParams: { threadId: chat.threadId } }}
        className={RESOURCE_ROW_CLASS}
      >
        {glyph}
        {title}
        {origin && <OriginTag />}
        <ChatStatus status={chat.status} />
      </Link>
    </li>
  );
}

// The parent is not always among the chats this one exchanged messages with.
function UnlistedOriginRow({ part }: { readonly part: AgentSourcePart }) {
  return (
    <li>
      <Link
        pathname={ROUTES.chat}
        options={{
          pathParams: { threadId: part.threadId },
          hash: `run-${part.runId}`,
        }}
        className={RESOURCE_ROW_CLASS}
      >
        <span className={RESOURCE_GLYPH_CLASS}>
          <MessageCircle size={16} />
        </span>
        <ChatTitle threadId={part.threadId} fallback={part.titleSnapshot} />
        <OriginTag />
      </Link>
    </li>
  );
}

function RelationshipsInner({ thread }: { readonly thread: ChatPanelSignals }) {
  const chatsId = `${thread.threadId}-resource-chats`;
  const { t } = useTranslation();
  const signals = thread.relations;
  const retry = useSet(signals.retry$);
  const chats = useLastLoadable(signals.chats.data$);
  const origin = useAgentOrigin(thread);
  const expanded = useGet(thread.resources.expandedSections$).chats;
  const toggleSection = useSet(thread.resources.toggleSection$);
  if (chats.state === "loading") {
    return null;
  }
  const data = chats.state === "hasData" ? chats.data : null;
  const items = data?.items ?? [];
  if (data && items.length === 0 && !data.failed && origin === null) {
    return null;
  }
  // The origin always leads the list, so the preview never hides it.
  const listedOrigin = items.find((chat) => {
    return chat.threadId === origin?.threadId;
  });
  const others = items.filter((chat) => {
    return chat !== listedOrigin;
  });
  const originRows = origin ? 1 : 0;
  return (
    <section
      className={RESOURCE_SECTION_CLASS}
      aria-label={t(($) => {
        return $.chat.relations.chats;
      })}
    >
      <ChatResourceSectionHeading
        title={t(($) => {
          return $.chat.relations.chats;
        })}
      />
      {(!data || data.failed) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground"
        >
          <p>
            {t(($) => {
              return $.chat.relations.loadFailed;
            })}
          </p>
          <Button variant="quiet" size="sm" onClick={retry}>
            {t(($) => {
              return $.chat.resources.retry;
            })}
          </Button>
        </div>
      )}
      <ul id={chatsId} className="m-0 list-none p-0">
        {listedOrigin ? (
          <ResourceChatRow chat={listedOrigin} origin thread={thread} />
        ) : (
          origin && <UnlistedOriginRow part={origin} />
        )}
        {others
          .slice(0, expanded ? undefined : RESOURCE_PREVIEW_LIMIT - originRows)
          .map((chat) => {
            return (
              <ResourceChatRow
                key={chat.threadId}
                chat={chat}
                origin={false}
                thread={thread}
              />
            );
          })}
      </ul>
      {others.length + originRows > RESOURCE_PREVIEW_LIMIT && (
        <ChatResourceSectionToggle
          expanded={expanded}
          controls={chatsId}
          onToggle={(trigger) => {
            toggleSection("chats", trigger);
          }}
        />
      )}
    </section>
  );
}

export function ChatRelationships({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  return useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel] ? (
    <RelationshipsInner thread={thread} />
  ) : null;
}
