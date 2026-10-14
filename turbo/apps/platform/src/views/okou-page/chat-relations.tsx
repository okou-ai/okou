import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { Button, cn } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ChatRelationMessage,
  RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import {
  formatChatTimestamp,
  formatLocalizedNumber,
} from "../../i18n/format.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ChatRelationList,
  ChatRelationSignals,
} from "../../signals/chat-page/chat-relations.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { messageDocumentToDisplayText } from "../../signals/okou-page/user-message-document-codec.ts";
import { ChatThreadLinkChip } from "../components/chat-thread-link-chip.tsx";
import { Link } from "../router/link.tsx";
import { ExternalSourceMessageAnnotation } from "./external-source-message-annotation.tsx";

function RelationList<T>({
  list,
  renderItem,
  reload,
}: {
  readonly list: ChatRelationList<T>;
  readonly renderItem: (item: T) => ReactNode;
  readonly reload: () => void;
}) {
  const { t } = useTranslation();
  const data = useLastLoadable(list.data$);
  const [loadingMore, more] = useLoadableSet(list.more$);
  const signal = useGet(pageSignal$);
  if (data.state === "hasError") {
    return (
      <div role="alert" className="px-2 text-xs text-muted-foreground">
        <p>
          {t(($) => {
            return $.chat.relations.loadFailed;
          })}
        </p>
        <Button variant="quiet" size="sm" onClick={reload}>
          {t(($) => {
            return $.chat.resources.retry;
          })}
        </Button>
      </div>
    );
  }
  if (data.state !== "hasData") {
    return (
      <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.relations.loading;
        })}
      </p>
    );
  }
  return (
    <>
      {data.data.items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.relations.empty;
          })}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">{data.data.items.map(renderItem)}</ul>
      )}
      {data.data.nextCursor && (
        <Button
          variant="quiet"
          size="sm"
          className="mt-1 w-full justify-start"
          disabled={loadingMore.state === "loading"}
          onClick={() => {
            detach(more(signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.relations.more;
          })}
        </Button>
      )}
      {loadingMore.state === "hasError" && (
        <p role="alert" className="px-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.relations.loadFailed;
          })}
        </p>
      )}
    </>
  );
}

function Origin({ signals }: { readonly signals: ChatRelationSignals }) {
  const { t } = useTranslation();
  const origin = useGet(signals.origin$);
  if (origin?.kind !== "source") {
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {t(($) => {
          return origin === null
            ? $.chat.relations.loading
            : origin.kind === "not-started"
              ? $.chat.relations.notStarted
              : $.chat.relations.unknownOrigin;
        })}
      </p>
    );
  }
  const part = origin.part;
  if (part.kind === "agent") {
    return (
      <div className="px-2">
        <ChatThreadLinkChip
          threadId={part.threadId}
          hash={`run-${part.runId}`}
          title={part.titleSnapshot}
        />
      </div>
    );
  }
  if (part.kind === "mcp") {
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {part.clientName ??
          t(($) => {
            return $.chat.origins.mcp;
          })}
      </p>
    );
  }
  return (
    <ExternalSourceMessageAnnotation
      part={part}
      className="flex h-8 max-w-full items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground"
    />
  );
}

function RelatedChatLink({ chat }: { readonly chat: RelatedChat }) {
  const { t } = useTranslation();
  const title =
    chat.title ??
    t(($) => {
      return $.chat.relations.untitled;
    });
  if (chat.status === "unavailable") {
    return (
      <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.relations.unavailable;
        })}
      </span>
    );
  }
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId: chat.threadId } }}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-state-hover"
      title={title}
    >
      <MessageCircle size={14} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t(($) => {
          return chat.status === "running"
            ? $.chat.relations.running
            : chat.status === "queued"
              ? $.chat.relations.queued
              : $.chat.relations.idle;
        })}
      </span>
    </Link>
  );
}

function MessageRow({ message }: { readonly message: ChatRelationMessage }) {
  const { t } = useTranslation();
  const text = message.userMessage
    ? messageDocumentToDisplayText(message.userMessage)
    : null;
  return (
    <li className="space-y-1 border-l border-border py-2 pl-3">
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>
          {t(($) => {
            return message.direction === "sent"
              ? $.chat.relations.sent
              : $.chat.relations.received;
          })}
        </span>
        <time dateTime={message.createdAt}>
          {formatChatTimestamp(message.createdAt)}
        </time>
      </div>
      <p className="line-clamp-3 break-words text-xs" title={text ?? undefined}>
        {text ??
          t(($) => {
            return $.chat.relations.messageUnavailable;
          })}
      </p>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <Link
          pathname={ROUTES.chat}
          options={{
            pathParams: { threadId: message.sourceChatThreadId },
            hash: `run-${message.sourceRunId}`,
          }}
          className="rounded-sm hover:text-foreground hover:underline"
        >
          {t(($) => {
            return $.chat.relations.sourceRun;
          })}
        </Link>
        {message.targetRunId ? (
          <Link
            pathname={ROUTES.chat}
            options={{
              pathParams: { threadId: message.targetChatThreadId },
              hash: `run-${message.targetRunId}`,
            }}
            className="rounded-sm hover:text-foreground hover:underline"
          >
            {t(($) => {
              return $.chat.relations.targetRun;
            })}
          </Link>
        ) : (
          <>
            <Link
              pathname={ROUTES.chat}
              options={{ pathParams: { threadId: message.targetChatThreadId } }}
              className="rounded-sm hover:text-foreground hover:underline"
            >
              {t(($) => {
                return $.chat.origins.openChat;
              })}
            </Link>
            <span>
              {t(($) => {
                return $.chat.relations.notConsumed;
              })}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

function Communications({
  signals,
}: {
  readonly signals: ChatRelationSignals;
}) {
  const { t } = useTranslation();
  const reload = useSet(signals.reload$);
  const toggle = useSet(signals.togglePeer$);
  const selectedPeer = useGet(signals.selectedPeer$);
  const messages = useGet(signals.messages$);
  return (
    <section
      aria-label={t(($) => {
        return $.chat.relations.communications;
      })}
    >
      <h4 className="px-2 pb-1 text-xs font-medium">
        {t(($) => {
          return $.chat.relations.communications;
        })}
      </h4>
      <RelationList
        list={signals.communications}
        reload={reload}
        renderItem={(chat) => {
          const expanded = selectedPeer === chat.threadId;
          return (
            <li key={chat.threadId} className="py-0.5">
              <div className="flex items-center">
                <RelatedChatLink chat={chat} />
                <Button
                  variant="quiet"
                  size="icon-sm"
                  aria-expanded={expanded}
                  aria-label={t(
                    ($) => {
                      return $.chat.relations.toggleMessages;
                    },
                    {
                      title:
                        chat.title ??
                        t(($) => {
                          return $.chat.relations.untitled;
                        }),
                    },
                  )}
                  onClick={() => {
                    toggle(chat.threadId);
                  }}
                >
                  {expanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )}
                </Button>
              </div>
              <p
                className={cn(
                  "px-2 text-xs text-muted-foreground",
                  expanded && "pb-2",
                )}
              >
                {t(
                  ($) => {
                    return $.chat.relations.counts;
                  },
                  {
                    sent: formatLocalizedNumber(chat.sentCount),
                    received: formatLocalizedNumber(chat.receivedCount),
                  },
                )}
                <span className="ml-2">
                  {formatChatTimestamp(chat.lastMessageAt)}
                </span>
              </p>
              {expanded && messages && (
                <div className="ml-3 pl-2">
                  <RelationList
                    list={messages}
                    reload={reload}
                    renderItem={(message) => {
                      return <MessageRow key={message.id} message={message} />;
                    }}
                  />
                </div>
              )}
            </li>
          );
        }}
      />
    </section>
  );
}

function RelationshipsInner({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const signals = thread.relations;
  const reload = useSet(signals.reload$);
  return (
    <section
      className="mb-4 space-y-3"
      aria-label={t(($) => {
        return $.chat.relations.title;
      })}
    >
      <div className="flex items-center justify-between px-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t(($) => {
            return $.chat.relations.title;
          })}
        </h3>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.relations.refresh;
          })}
          onClick={reload}
        >
          <RefreshCw size={13} />
        </Button>
      </div>
      <div>
        <h4 className="px-2 pb-1 text-xs font-medium">
          {t(($) => {
            return $.chat.relations.origin;
          })}
        </h4>
        <Origin signals={signals} />
      </div>
      <section
        aria-label={t(($) => {
          return $.chat.relations.created;
        })}
      >
        <h4 className="px-2 pb-1 text-xs font-medium">
          {t(($) => {
            return $.chat.relations.created;
          })}
        </h4>
        <RelationList
          list={signals.children}
          reload={reload}
          renderItem={(chat) => {
            return (
              <li key={chat.id} className="ml-3 border-l border-border pl-2">
                <RelatedChatLink chat={chat} />
              </li>
            );
          }}
        />
      </section>
      <Communications signals={signals} />
    </section>
  );
}

export function ChatRelationships({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  return useGet(featureSwitch$)[FeatureSwitchKey.ChatRelations] ? (
    <RelationshipsInner thread={thread} />
  ) : null;
}
