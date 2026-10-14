import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import { Button, cn, LazySpinner } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type {
  ChatRelationMessage,
  ChatCommunication,
  RelatedChat,
} from "@okouai/api-contracts/contracts/chat-relations";
import {
  formatChatTimestamp,
  formatCompactChatTimestamp,
  formatLocalizedNumber,
} from "../../i18n/format.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type {
  ChatRelationList,
  ChatRelationSignals,
  RelationPage,
} from "../../signals/chat-page/chat-relations.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { messageDocumentToDisplayText } from "../../signals/okou-page/user-message-document-codec.ts";
import { Link } from "../router/link.tsx";
import { ExternalSourceMessageAnnotation } from "./external-source-message-annotation.tsx";

function RelationsLoading() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t(($) => {
        return $.chat.relations.loading;
      })}
      className="flex h-12 items-center justify-center text-muted-foreground"
    >
      <LazySpinner size={16} aria-hidden="true" />
    </div>
  );
}

function RelationList<T>({
  list,
  data,
  renderItem,
  reload,
  title,
}: {
  readonly list: ChatRelationList<T>;
  readonly data: Loadable<RelationPage<T>>;
  readonly renderItem: (item: T) => ReactNode;
  readonly reload: () => void;
  readonly title?: string;
}) {
  const { t } = useTranslation();
  const [loadingMore, more] = useLoadableSet(list.more$);
  const signal = useGet(pageSignal$);
  if (data.state === "hasData" && data.data.items.length === 0) {
    return null;
  }
  if (data.state === "loading") {
    return <RelationsLoading />;
  }
  return (
    <section aria-label={title} className="space-y-1">
      {title && <h4 className="px-2 text-xs text-muted-foreground">{title}</h4>}
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
          <Button variant="quiet" size="sm" onClick={reload}>
            {t(($) => {
              return $.chat.resources.retry;
            })}
          </Button>
        </div>
      ) : (
        <>
          <ul className="m-0 list-none p-0">
            {data.data.items.map(renderItem)}
          </ul>
          {data.data.nextCursor && (
            <Button
              variant="quiet"
              size="sm"
              className="mt-1 w-full justify-start text-muted-foreground"
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
      )}
    </section>
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
      className="space-y-1"
    >
      <h4 className="px-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.relations.origin;
        })}
      </h4>
      {part.kind === "agent" ? (
        <Link
          pathname={ROUTES.chat}
          options={{
            pathParams: { threadId: part.threadId },
            hash: `run-${part.runId}`,
          }}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-state-hover"
          title={part.titleSnapshot}
        >
          <MessageCircle size={16} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{part.titleSnapshot}</span>
          <ArrowUpRight size={14} className="shrink-0 text-muted-foreground" />
        </Link>
      ) : part.kind === "mcp" ? (
        <p className="px-2 py-2 text-sm">
          {part.clientName ??
            t(($) => {
              return $.chat.origins.mcp;
            })}
        </p>
      ) : (
        <ExternalSourceMessageAnnotation
          part={part}
          compact
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-sm"
        />
      )}
    </section>
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
      <span className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
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
      className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-state-hover"
      title={title}
    >
      <MessageCircle size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span
        role="img"
        aria-label={status}
        title={status}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          chat.status === "running"
            ? "bg-emerald-500"
            : chat.status === "queued"
              ? "border border-amber-500"
              : "bg-muted-foreground/40",
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
      {message.direction === "sent" ? (
        <ArrowUpRight size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <ArrowDownLeft size={14} className="shrink-0 text-muted-foreground" />
      )}
      <span className="sr-only">
        {t(($) => {
          return message.direction === "sent"
            ? $.chat.relations.sent
            : $.chat.relations.received;
        })}
      </span>
      <span className="min-w-0 flex-1 truncate">{preview}</span>
      <MessageTime value={message.createdAt} />
    </>
  );
  return (
    <li>
      {unavailable && message.direction === "sent" ? (
        <div
          className="flex min-w-0 items-center gap-2 px-2 py-2 text-xs text-muted-foreground"
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
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-state-hover"
          title={preview}
        >
          {content}
        </Link>
      )}
    </li>
  );
}

function CommunicationSummary({ chat }: { readonly chat: ChatCommunication }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 pb-2 pl-8 pr-10 text-xs text-muted-foreground">
      {chat.sentCount > 0 && (
        <span
          className="flex items-center gap-1"
          title={t(($) => {
            return $.chat.relations.sent;
          })}
        >
          <ArrowUpRight size={12} />
          <span className="sr-only">
            {t(($) => {
              return $.chat.relations.sent;
            })}{" "}
          </span>
          {formatLocalizedNumber(chat.sentCount)}
        </span>
      )}
      {chat.receivedCount > 0 && (
        <span
          className="flex items-center gap-1"
          title={t(($) => {
            return $.chat.relations.received;
          })}
        >
          <ArrowDownLeft size={12} />
          <span className="sr-only">
            {t(($) => {
              return $.chat.relations.received;
            })}{" "}
          </span>
          {formatLocalizedNumber(chat.receivedCount)}
        </span>
      )}
      <span className="ml-auto">
        <MessageTime value={chat.lastMessageAt} />
      </span>
    </div>
  );
}

function Communications({
  signals,
  data,
}: {
  readonly signals: ChatRelationSignals;
  readonly data: Loadable<RelationPage<ChatCommunication>>;
}) {
  const { t } = useTranslation();
  const reload = useSet(signals.reload$);
  const toggle = useSet(signals.togglePeer$);
  const selectedPeer = useGet(signals.selectedPeer$);
  const messages = useGet(signals.messages$);
  return (
    <RelationList
      title={t(($) => {
        return $.chat.relations.communications;
      })}
      list={signals.communications}
      data={data}
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
                      chat.status === "unavailable"
                        ? t(($) => {
                            return $.chat.relations.unavailable;
                          })
                        : (chat.title ??
                          t(($) => {
                            return $.chat.relations.untitled;
                          })),
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
            {!expanded && <CommunicationSummary chat={chat} />}
            {expanded && messages && (
              <div className="ml-6 pb-1">
                <Messages
                  list={messages}
                  reload={reload}
                  unavailable={chat.status === "unavailable"}
                />
              </div>
            )}
          </li>
        );
      }}
    />
  );
}

function Messages({
  list,
  reload,
  unavailable,
}: {
  readonly list: ChatRelationList<ChatRelationMessage>;
  readonly reload: () => void;
  readonly unavailable: boolean;
}) {
  const data = useLastLoadable(list.data$);
  return (
    <RelationList
      list={list}
      data={data}
      reload={reload}
      renderItem={(message) => {
        return (
          <MessageRow
            key={message.id}
            message={message}
            unavailable={unavailable}
          />
        );
      }}
    />
  );
}

function RelationshipsInner({ thread }: { readonly thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const signals = thread.relations;
  const reload = useSet(signals.reload$);
  const children = useLastLoadable(signals.children.data$);
  const communications = useLastLoadable(signals.communications.data$);
  const origin = useGet(signals.origin$);
  const loading =
    origin === null ||
    children.state === "loading" ||
    communications.state === "loading";
  const empty =
    origin !== null &&
    !(origin.kind === "source" && origin.part.kind === "agent") &&
    children.state === "hasData" &&
    children.data.items.length === 0 &&
    communications.state === "hasData" &&
    communications.data.items.length === 0;
  return (
    <section
      className="space-y-4"
      aria-label={t(($) => {
        return $.chat.relations.title;
      })}
    >
      <div className="flex items-center justify-between px-2">
        <h3 className="text-sm font-medium">
          {t(($) => {
            return $.chat.relations.title;
          })}
        </h3>
        <Button
          variant="quiet"
          size="icon-sm"
          disabled={loading}
          aria-label={t(($) => {
            return $.chat.relations.refresh;
          })}
          onClick={reload}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {loading ? (
        <RelationsLoading />
      ) : (
        <>
          <Origin signals={signals} />
          <RelationList
            title={t(($) => {
              return $.chat.relations.created;
            })}
            list={signals.children}
            data={children}
            reload={reload}
            renderItem={(chat) => {
              return (
                <li
                  key={chat.id}
                  className="relative pl-5 before:absolute before:inset-y-0 before:left-2 before:border-l before:border-border after:absolute after:left-2 after:top-1/2 after:w-3 after:border-t after:border-border last:before:bottom-1/2"
                >
                  <RelatedChatLink chat={chat} />
                </li>
              );
            }}
          />
          <Communications signals={signals} data={communications} />
          {empty && (
            <p className="px-2 pb-2 text-sm leading-relaxed text-muted-foreground">
              {t(($) => {
                return $.chat.relations.parallelHint;
              })}
            </p>
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
  return useGet(featureSwitch$)[FeatureSwitchKey.ChatRelations] ? (
    <RelationshipsInner thread={thread} />
  ) : null;
}
