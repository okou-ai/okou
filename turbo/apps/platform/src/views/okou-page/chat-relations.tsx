import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { CircleSlash, MessageCircle, Plug } from "lucide-react";
import { Button, cn, RunningIndicator } from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { RelatedChat } from "@okouai/api-contracts/contracts/chat-relations";
import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import type { ResourceChat } from "../../signals/chat-page/chat-relations.ts";
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
          // The 15px source mark sits centred in the 20px glyph slot.
          className="flex h-8.5 min-w-0 items-center gap-[10.5px] rounded-lg pr-2 pl-[22.5px] text-[13px] leading-5 text-foreground transition-colors hover:bg-state-hover focus-visible:bg-state-hover"
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

function ResourceChatRow({
  chat,
  origin,
}: {
  readonly chat: ResourceChat;
  readonly origin: boolean;
}) {
  const { t } = useTranslation();
  if (chat.status === "unavailable") {
    return (
      <li>
        <span
          className={cn(
            RESOURCE_ROW_CLASS,
            "text-muted-foreground hover:bg-transparent",
          )}
        >
          <span className={RESOURCE_GLYPH_CLASS}>
            <CircleSlash size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.relations.unavailable;
            })}
          </span>
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
        <span className={RESOURCE_GLYPH_CLASS}>
          <MessageCircle size={16} />
        </span>
        <ChatTitle threadId={chat.threadId} fallback={chat.title} />
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
  const originListed =
    origin !== null &&
    items.some((chat) => {
      return chat.threadId === origin.threadId;
    });
  if (data && items.length === 0 && !data.failed && origin === null) {
    return null;
  }
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
        {origin && !originListed && <UnlistedOriginRow part={origin} />}
        {items
          .slice(0, expanded ? undefined : RESOURCE_PREVIEW_LIMIT)
          .map((chat) => {
            return (
              <ResourceChatRow
                key={chat.threadId}
                chat={chat}
                origin={chat.threadId === origin?.threadId}
              />
            );
          })}
      </ul>
      {items.length > RESOURCE_PREVIEW_LIMIT && (
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
