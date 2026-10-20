import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, CircleSlash } from "lucide-react";
import { Button, cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ChatRelationMessage,
  RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import {
  formatChatTimestamp,
  formatCompactChatTimestamp,
} from "../../i18n/format.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ChatRelationList,
  ChatRelationSignals,
  ResourceChat,
} from "../../signals/chat-page/chat-relations.ts";
import { chatThreadMetaMap$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { messageDocumentToDisplayText } from "../../signals/okou-page/user-message-document-codec.ts";
import { Link } from "../router/link.tsx";
import {
  ChatResourceSectionHeading,
  ChatResourceSectionToggle,
  RESOURCE_PREVIEW_LIMIT,
} from "./chat-resource-section.tsx";
import { ExternalSourceMessageAnnotation } from "./external-source-message-annotation.tsx";
import { HoverScrollTitle } from "./hover-scroll-title.tsx";

export function ChatOrigin({ thread }: { readonly thread: ChatPanelSignals }) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ChatResourcePanel];
  return enabled ? <Origin signals={thread.relations} /> : null;
}

function AgentOriginLink({
  part,
}: {
  readonly part: Extract<UserMessagePart, { type: "source"; kind: "agent" }>;
}) {
  const { t } = useTranslation();
  const thread = useGet(chatThreadMetaMap$).get(part.threadId);
  const title =
    (thread ? thread.title : part.titleSnapshot) ??
    t(($) => {
      return $.chat.relations.untitled;
    });
  return (
    <Link
      pathname={ROUTES.chat}
      options={{
        pathParams: { threadId: part.threadId },
        hash: `run-${part.runId}`,
      }}
      className="min-w-0 truncate rounded-lg px-1.5 py-1 text-xs leading-4.5 text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground focus-visible:bg-gray-50"
      title={title}
    >
      {title}
    </Link>
  );
}

function Origin({ signals }: { readonly signals: ChatRelationSignals }) {
  const { t } = useTranslation();
  const origin = useGet(signals.origin$);
  if (origin?.kind !== "source") {
    return null;
  }
  const part = origin.part;
  return (
    <section
      aria-label={t(($) => {
        return $.chat.relations.origin;
      })}
      className="flex min-h-10.5 shrink-0 items-center gap-1.5 border-divider px-4 py-1.5 has-[+div:not(:empty)]:border-b"
    >
      <h4 className="shrink-0 text-xs leading-4.5 text-muted-foreground">
        {t(($) => {
          return $.chat.relations.origin;
        })}
      </h4>
      {part.kind === "agent" ? (
        <AgentOriginLink part={part} />
      ) : part.kind === "mcp" ? (
        <p className="min-w-0 truncate px-1.5 py-1 text-xs leading-4.5 text-muted-foreground">
          {part.clientName ??
            t(($) => {
              return $.chat.origins.mcp;
            })}
        </p>
      ) : (
        <ExternalSourceMessageAnnotation
          part={part}
          compact
          className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-xs leading-4.5 text-muted-foreground"
        />
      )}
    </section>
  );
}

function RelatedChatLink({
  chat,
  title,
}: {
  readonly chat: RelatedChat;
  readonly title: string;
}) {
  const { t } = useTranslation();
  if (chat.status === "unavailable") {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.75 text-[13px] leading-5 text-muted-foreground">
        <CircleSlash size={16} className="shrink-0" />
        <span className="truncate">
          {t(($) => {
            return $.chat.relations.unavailable;
          })}
        </span>
      </span>
    );
  }
  const status = t(($) => {
    return chat.status === "running"
      ? $.chat.relations.running
      : chat.status === "queued"
        ? $.chat.relations.queued
        : $.chat.relations.idle;
  });
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId: chat.threadId } }}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.75 text-[13px] leading-5 transition-colors hover:bg-gray-50 focus-visible:bg-gray-50"
    >
      <HoverScrollTitle title={title} />
      <span
        role="img"
        aria-label={status}
        title={status}
        className={cn(
          "shrink-0 rounded-full",
          chat.status === "idle"
            ? "sr-only"
            : chat.status === "running"
              ? "size-1.5 bg-emerald-500"
              : "size-1.5 border border-amber-500",
        )}
      />
    </Link>
  );
}

function MessageTime({ value }: { readonly value: string }) {
  return (
    <time
      dateTime={value}
      title={formatChatTimestamp(value)}
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
    >
      {formatCompactChatTimestamp(value)}
    </time>
  );
}

function MessageRow({
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
  const preview =
    text ||
    t(($) => {
      return $.chat.relations.messageUnavailable;
    });
  const content = (
    <>
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium">
          {t(($) => {
            return message.direction === "sent"
              ? $.chat.relations.sent
              : $.chat.relations.received;
          })}
        </span>
        <MessageTime value={message.createdAt} />
      </span>
      <span className="block whitespace-pre-wrap break-words text-[13px] leading-5.25">
        {preview}
      </span>
    </>
  );
  return (
    <li>
      {unavailable && message.direction === "sent" ? (
        <div
          className="block min-w-0 space-y-1.5 px-2 py-3 text-muted-foreground"
          title={preview}
        >
          {content}
        </div>
      ) : (
        <Link
          pathname={ROUTES.chat}
          options={{
            pathParams: { threadId: message.targetChatThreadId },
            hash: message.targetRunId
              ? `run-${message.targetRunId}`
              : undefined,
          }}
          className="block min-w-0 space-y-1.5 rounded-lg px-2 py-3 transition-colors hover:bg-state-hover"
          title={preview}
        >
          {content}
        </Link>
      )}
    </li>
  );
}

function ResourceChatRow({
  chat,
  signals,
}: {
  readonly chat: ResourceChat;
  readonly signals: ChatRelationSignals;
}) {
  const { t } = useTranslation();
  const thread = useGet(chatThreadMetaMap$).get(chat.threadId);
  const title =
    chat.status === "unavailable"
      ? t(($) => {
          return $.chat.relations.unavailable;
        })
      : ((thread ? thread.title : chat.title) ??
        t(($) => {
          return $.chat.relations.untitled;
        }));
  const retry = useSet(signals.retry$);
  const toggle = useSet(signals.togglePeer$);
  const selectedPeer = useGet(signals.selectedPeer$);
  const messages = useGet(signals.messages$);
  const emptyPeers = useGet(signals.confirmedEmptyPeers$);
  const signal = useGet(pageSignal$);
  const expanded = selectedPeer === chat.threadId;
  return (
    <li>
      <div className="flex min-w-0 items-center gap-1">
        <RelatedChatLink chat={chat} title={title} />
        {!emptyPeers.includes(chat.threadId) && (
          <Button
            variant="quiet"
            size="icon-xs"
            className="shrink-0 hover:bg-gray-50 focus-visible:bg-gray-50 [&_svg]:size-3"
            aria-expanded={expanded}
            aria-label={t(
              ($) => {
                return $.chat.relations.toggleMessages;
              },
              { title },
            )}
            onClick={(event) => {
              detach(
                toggle(chat.threadId, event.currentTarget, signal),
                Reason.DomCallback,
              );
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </Button>
        )}
      </div>
      {expanded && messages && (
        <Messages
          list={messages}
          retry={retry}
          unavailable={chat.status === "unavailable"}
        />
      )}
    </li>
  );
}

function Messages({
  list,
  retry,
  unavailable,
}: {
  readonly list: ChatRelationList<ChatRelationMessage>;
  readonly retry: () => void;
  readonly unavailable: boolean;
}) {
  const { t } = useTranslation();
  const data = useLastLoadable(list.data$);
  if (
    data.state === "loading" ||
    (data.state === "hasData" && data.data.items.length === 0)
  ) {
    return null;
  }
  return (
    <div className="mb-2 mt-1 max-h-80 overflow-y-auto overscroll-contain rounded-lg bg-gray-50 p-1">
      {data.state === "hasError" ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground"
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
      ) : (
        <ul className="m-0 list-none divide-y divide-border-on-fill p-0">
          {data.data.items.map((message) => {
            return (
              <MessageRow
                key={message.id}
                message={message}
                unavailable={unavailable}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RelationshipsInner({ thread }: { readonly thread: ChatPanelSignals }) {
  const chatsId = `${thread.threadId}-resource-messages`;
  const { t } = useTranslation();
  const signals = thread.relations;
  const retry = useSet(signals.retry$);
  const chats = useLastLoadable(signals.chats.data$);
  const expanded = useGet(thread.resources.expandedSections$).messages;
  const toggleSection = useSet(thread.resources.toggleSection$);
  if (chats.state === "loading") {
    return null;
  }
  const data = chats.state === "hasData" ? chats.data : null;
  if (data && data.items.length === 0 && !data.failed) {
    return null;
  }
  return (
    <section
      className="py-3"
      aria-label={t(($) => {
        return $.chat.relations.communications;
      })}
    >
      <ChatResourceSectionHeading
        title={t(($) => {
          return $.chat.relations.communications;
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
      {data && (
        <>
          <ul id={chatsId} className="m-0 list-none p-0">
            {data.items
              .slice(0, expanded ? undefined : RESOURCE_PREVIEW_LIMIT)
              .map((chat) => {
                return (
                  <ResourceChatRow
                    key={chat.threadId}
                    chat={chat}
                    signals={signals}
                  />
                );
              })}
          </ul>
          {data.items.length > RESOURCE_PREVIEW_LIMIT && (
            <ChatResourceSectionToggle
              expanded={expanded}
              controls={chatsId}
              onToggle={(trigger) => {
                toggleSection("messages", trigger);
              }}
            />
          )}
        </>
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
