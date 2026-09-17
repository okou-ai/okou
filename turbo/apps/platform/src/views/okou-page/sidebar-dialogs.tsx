// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import {
  useGet,
  useSet,
  useLastResolved,
  useLoadable,
  type Loadable,
} from "ccstate-react";
import {
  File,
  Globe,
  Image,
  Loader2,
  MessagesSquare,
  Pin,
  PinOff,
  Presentation,
  Route,
  Search,
  User,
  Video,
  X,
} from "lucide-react";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { ChatSearchResult } from "@okouai/api-contracts/contracts/chat-threads";
import type { ArtifactCatalogKind } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import {
  Button,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  RunningIndicator,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useTranslation } from "react-i18next";
import { formatRelativeTimestamp } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { emptySearchImg } from "./platform-assets.ts";
import {
  chatListQuery$,
  pinAgentDialogQuery$,
  setChatListQuery$,
  setPinAgentDialogQuery$,
  setThreeColumnSearchFilter$,
  threeColumnSearchFilter$,
  type ThreeColumnSearchFilter,
} from "../../signals/okou-page/sidebar-state.ts";
import type { SubagentInfo } from "../../signals/agent.ts";
import { pinnedAgentIds$ } from "../../signals/okou-page/pinned-agents.ts";
import { sidebarActiveThreadIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { sidebarUnreadThreadIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
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
import { equalSets } from "../../lib/equality.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import {
  threeColumnAgentSearchResults$,
  threeColumnArtifactSearchResults$,
  threeColumnWorkflowSearchResults$,
  type ThreeColumnArtifactSearchItem,
} from "../../signals/okou-page/three-column-search-resources.ts";
import { ArtifactThumbnailImage } from "./artifact-thumbnail.tsx";

interface AgentDialogItem {
  readonly agentId: string;
  readonly displayName?: string | null;
}

function agentDialogLabel(agent: AgentDialogItem): string {
  return agent.displayName ?? agent.agentId;
}

export function agentDialogMatchesQuery(
  agent: AgentDialogItem,
  trimmedQuery: string,
): boolean {
  return (
    agent.agentId.toLowerCase().includes(trimmedQuery) ||
    (agent.displayName ?? "").toLowerCase().includes(trimmedQuery)
  );
}

export function AgentDialogSearch({
  query,
  setQuery,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <div className="px-5 pb-3">
      <div className="relative w-full">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => {
            return setQuery(e.target.value);
          }}
          placeholder={t(($) => {
            return $.sidebar.searchAgents;
          })}
          className={`pl-9 ${query ? "pr-9" : ""}`}
        />
        {query && <ClearSearchButton setQuery={setQuery} />}
      </div>
    </div>
  );
}

function ClearSearchButton({
  setQuery,
}: {
  readonly setQuery: (query: string) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <Button
      showTooltip
      type="button"
      onClick={() => {
        return setQuery("");
      }}
      variant="quiet"
      size="icon-xs"
      className="absolute right-1.5 top-1/2 shrink-0 -translate-y-1/2"
      aria-label={t(($) => {
        return $.sidebar.clearSearch;
      })}
    >
      <X size={14} />
    </Button>
  );
}

export function AgentDialogSection({
  label,
  children,
  className = "pb-2",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={`px-5 ${className}`}>
      <span className="px-1 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 flex flex-col">{children}</div>
    </div>
  );
}

export function AgentDialogAgentButton({
  agent,
  onSelect,
  avatar,
  subtitle,
}: {
  readonly agent: AgentDialogItem;
  readonly onSelect: () => void;
  readonly avatar?: ReactNode;
  readonly subtitle?: ReactNode;
}) {
  const label = agentDialogLabel(agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
    >
      {avatar ?? (
        <AgentAvatarImg
          name={agent.agentId}
          alt={label}
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function AgentCommandSearch({
  query,
  setQuery,
  placeholder,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly placeholder: string;
}) {
  return (
    <div className="px-5 pb-3">
      <div className="relative w-full">
        <CommandInput
          placeholder={placeholder}
          className={query ? "pr-7" : ""}
        />
        {query && <ClearSearchButton setQuery={setQuery} />}
      </div>
    </div>
  );
}

function AgentCommandSection({
  label,
  children,
  className = "pb-2",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <CommandGroup
      heading={label}
      className={`px-5 ${className} [&_[data-slot=command-group-items]]:mt-1 [&_[data-slot=command-group-items]]:flex [&_[data-slot=command-group-items]]:flex-col`}
    >
      {children}
    </CommandGroup>
  );
}

function AgentCommandAgentContent({
  agent,
  avatar,
  subtitle,
}: {
  readonly agent: AgentDialogItem;
  readonly avatar?: ReactNode;
  readonly subtitle?: ReactNode;
}) {
  const label = agentDialogLabel(agent);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
      {avatar ?? (
        <AgentAvatarImg
          name={agent.agentId}
          alt={label}
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * Trailing pin toggle for a pin-dialog row. It stays hidden until the command highlights
 * the row — hovering or arrowing onto it — so a resting row never shows the
 * pin glyph the rest of the app uses to mean "already pinned".
 */
function AgentCommandPinToggle({
  label,
  icon,
  onToggle,
  disabled,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onToggle: () => void;
  readonly disabled: boolean;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="xs"
      disabled={disabled}
      className="ml-auto shrink-0 gap-1.5 opacity-0 group-data-[highlighted]:opacity-100 focus-visible:opacity-100"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {icon}
      {label}
    </Button>
  );
}

/** Keep a dialog's pinned section in the same order as the sidebar. */
function agentsInRenderOrder(
  subagents: readonly SubagentInfo[],
  renderOrder: readonly string[],
): SubagentInfo[] {
  const agentById = new Map(
    subagents.map((agent) => {
      return [agent.agentId, agent];
    }),
  );
  return renderOrder
    .map((id) => {
      return agentById.get(id);
    })
    .filter((agent): agent is SubagentInfo => {
      return agent !== undefined;
    });
}

function filterAgentDialogItems<T extends AgentDialogItem>(
  agents: readonly T[],
  trimmedQuery: string,
): T[] {
  if (!trimmedQuery) {
    return [...agents];
  }
  return agents.filter((agent) => {
    return agentDialogMatchesQuery(agent, trimmedQuery);
  });
}

type ChatThreadCommandIndicatorValue = "running" | "unread" | null;

function chatThreadCommandIndicator(
  threadId: string,
  activeThreadIds: ReadonlySet<string> | undefined,
  unreadThreadIds: ReadonlySet<string> | undefined,
): ChatThreadCommandIndicatorValue {
  if (activeThreadIds?.has(threadId)) {
    return "running";
  }
  return unreadThreadIds?.has(threadId) ? "unread" : null;
}

function ChatThreadCommandIndicator({
  indicator,
}: {
  readonly indicator: ChatThreadCommandIndicatorValue;
}) {
  const { t } = useTranslation("agents");

  if (indicator === "running") {
    return <RunningIndicator />;
  }
  if (indicator === "unread") {
    return (
      <span
        aria-label={t(($) => {
          return $.status.unread;
        })}
        className="h-2 w-2 rounded-full bg-sky-600"
      />
    );
  }
  return null;
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
 * filter row above, whether or not a row is unread.
 */
function SpotlightRowMeta({
  indicator,
  timestamp,
  shortcutNumber,
}: {
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly timestamp: string;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2.5">
      {/* w-3.5 fits the widest indicator (RunningIndicator is 0.86rem) so the
          running dot is not squashed and the timestamp never shifts. */}
      <span className="flex w-3.5 shrink-0 justify-center">
        <ChatThreadCommandIndicator indicator={indicator} />
      </span>
      <span className="text-xs text-[hsl(var(--gray-700))]">{timestamp}</span>
      <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
    </span>
  );
}

/**
 * `pl-1` rather than the usual `pl-2`: the agent avatar art carries ~4px of its
 * own margin, so the tighter box padding lands the avatar's ink on the same
 * rail as the filter row and the search field's left border.
 */
const SPOTLIGHT_ROW_CLASS = "group w-full gap-3.5 py-2 pl-1 pr-2";

const SPOTLIGHT_AVATAR_CLASS =
  "h-8 w-8 shrink-0 rounded-lg object-cover object-top";

function SpotlightThreadCommandItem({
  thread,
  indicator,
  onSelect,
  shortcutNumber,
}: {
  readonly thread: WorkspaceSearchChatThread;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <CommandItem
      value={`spotlight-thread-${thread.id}`}
      onSelect={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <AgentAvatarImg
        name={thread.agentId}
        alt=""
        className={SPOTLIGHT_AVATAR_CLASS}
      />
      <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
        {thread.title}
      </span>
      <SpotlightRowMeta
        shortcutNumber={shortcutNumber}
        indicator={indicator}
        timestamp={formatRelativeTimestamp(thread.sortAt)}
      />
    </CommandItem>
  );
}

function SpotlightMessageCommandItem({
  message,
  thread,
  indicator,
  onSelect,
  shortcutNumber,
}: {
  readonly message: ChatSearchResult;
  readonly thread: WorkspaceSearchChatThread | undefined;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  const title = thread?.title ?? message.agentName;

  return (
    <CommandItem
      value={`spotlight-message-${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
      onSelect={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <AgentAvatarImg
        name={thread?.agentId ?? message.agentName}
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
        indicator={indicator}
        timestamp={formatRelativeTimestamp(message.matchedMessage.createdAt)}
      />
    </CommandItem>
  );
}

const SPOTLIGHT_RESOURCE_ICON_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground";
const SPOTLIGHT_ARTIFACT_THUMBNAIL_WIDTH_PX = 64;

function SpotlightAgentCommandItem({
  agent,
  onSelect,
  shortcutNumber,
}: {
  readonly agent: SubagentInfo;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <CommandItem
      value={`spotlight-agent-${agent.agentId}`}
      onSelect={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <AgentAvatarImg
        name={agent.agentId}
        alt=""
        className={SPOTLIGHT_AVATAR_CLASS}
      />
      <span className="min-w-0 flex-1 truncate text-left text-sm text-foreground">
        {agentDialogLabel(agent)}
      </span>
      <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
    </CommandItem>
  );
}

function SpotlightWorkflowCommandItem({
  workflow,
  onSelect,
  shortcutNumber,
}: {
  readonly workflow: WorkflowSummary;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  const title = workflow.displayName ?? workflow.name;
  return (
    <CommandItem
      value={`spotlight-workflow-${workflow.id}`}
      onSelect={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <span className={SPOTLIGHT_RESOURCE_ICON_CLASS} aria-hidden="true">
        <Route size={16} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm text-foreground">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          /{workflow.name}
        </span>
      </span>
      <SpotlightRowMeta
        shortcutNumber={shortcutNumber}
        indicator={null}
        timestamp={formatRelativeTimestamp(workflow.createdAt)}
      />
    </CommandItem>
  );
}

function artifactKindLabel(kind: ArtifactCatalogKind): string {
  switch (kind) {
    case "presentation": {
      return i18n.t(($) => {
        return $.artifacts.kinds.presentation;
      });
    }
    case "hosted-site": {
      return i18n.t(($) => {
        return $.artifacts.kinds.hostedSite;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.artifacts.kinds.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.artifacts.kinds.video;
      });
    }
    case "avatar": {
      return i18n.t(($) => {
        return $.artifacts.kinds.avatar;
      });
    }
    case "shared-thread": {
      return i18n.t(($) => {
        return $.artifacts.kinds.sharedConversation;
      });
    }
    case "file": {
      return i18n.t(($) => {
        return $.artifacts.kinds.file;
      });
    }
  }
}

function SpotlightArtifactKindIcon({
  kind,
}: {
  readonly kind: ArtifactCatalogKind;
}) {
  const icon =
    kind === "presentation" ? (
      <Presentation size={16} />
    ) : kind === "hosted-site" ? (
      <Globe size={16} />
    ) : kind === "image" ? (
      <Image size={16} />
    ) : kind === "video" ? (
      <Video size={16} />
    ) : kind === "avatar" ? (
      <User size={16} />
    ) : kind === "shared-thread" ? (
      <MessagesSquare size={16} />
    ) : (
      <File size={16} />
    );
  return (
    <span
      className={SPOTLIGHT_RESOURCE_ICON_CLASS}
      aria-hidden="true"
      data-testid={`spotlight-artifact-kind-icon-${kind}`}
    >
      {icon}
    </span>
  );
}

function SpotlightArtifactThumbnail({
  artifact,
}: {
  readonly artifact: ThreeColumnArtifactSearchItem;
}) {
  const thumbnailUrl = useLastResolved(artifact.thumbnailUrl$);
  if (!thumbnailUrl) {
    return <SpotlightArtifactKindIcon kind={artifact.kind} />;
  }
  return (
    <ArtifactThumbnailImage
      src={r2ImageTransformUrl(thumbnailUrl, {
        width: SPOTLIGHT_ARTIFACT_THUMBNAIL_WIDTH_PX,
        fit: "scale-down",
      })}
      load={artifact.thumbnailLoad}
      loading="eager"
      className="h-8 w-8 shrink-0 rounded-lg bg-gray-50 object-cover"
      fallback={<SpotlightArtifactKindIcon kind={artifact.kind} />}
      testId="spotlight-artifact-thumbnail"
    />
  );
}

function SpotlightArtifactCommandItem({
  artifact,
  onSelect,
  shortcutNumber,
}: {
  readonly artifact: ThreeColumnArtifactSearchItem;
  readonly onSelect: () => void;
  readonly shortcutNumber: number | undefined;
}) {
  return (
    <CommandItem
      value={`spotlight-artifact-${artifact.id}`}
      onSelect={onSelect}
      className={SPOTLIGHT_ROW_CLASS}
    >
      <SpotlightArtifactThumbnail artifact={artifact} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-sm text-foreground">
          {artifact.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {artifactKindLabel(artifact.kind)}
        </span>
      </span>
      <SpotlightRowMeta
        shortcutNumber={shortcutNumber}
        indicator={null}
        timestamp={formatRelativeTimestamp(artifact.createdAt)}
      />
    </CommandItem>
  );
}

function SpotlightFilterButton({
  active,
  label,
  onSelect,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    // Reserve the outline border in both states so selecting a filter does not
    // shift its label or the neighboring buttons.
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      variant={active ? "outline" : "quiet"}
      size="xs"
      className="border aria-[selected=false]:border-transparent"
      onClick={onSelect}
    >
      {label}
    </Button>
  );
}

function SpotlightSearchInput() {
  const { t } = useTranslation("agents");

  return (
    // `p-5` all round: the 20px bottom padding is what balances the air above
    // and below the filter row (see SpotlightSearchFilterBar's `mb-3`).
    <div className="p-5">
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

function SpotlightSearchFilterBar({
  filter,
  resultCount,
  onSelect,
}: {
  readonly filter: ThreeColumnSearchFilter;
  readonly resultCount: number;
  readonly onSelect: (filter: ThreeColumnSearchFilter) => void;
}) {
  const { t } = useTranslation("agents");
  const options: readonly {
    readonly value: ThreeColumnSearchFilter;
    readonly label: string;
  }[] = [
    {
      value: "all",
      label: t(($) => {
        return $.sidebar.filterAll;
      }),
    },
    {
      value: "chats",
      label: t(($) => {
        return $.sidebar.sections.chats;
      }),
    },
    {
      value: "messages",
      label: t(($) => {
        return $.sidebar.sections.messages;
      }),
    },
    {
      value: "agents",
      label: t(($) => {
        return $.sidebar.sections.agents;
      }),
    },
    {
      value: "workflows",
      label: t(($) => {
        return $.sidebar.sections.workflows;
      }),
    },
    {
      value: "artifacts",
      label: t(($) => {
        return $.sidebar.sections.artifacts;
      }),
    },
  ];

  return (
    // No divider: the search field and the list are already separated by their
    // own padding, and a full-bleed rule ran into the dialog's 24px corners.
    <div className="mb-3 flex h-7 items-center justify-between px-5">
      <div
        role="tablist"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {options.map((option) => {
          return (
            <SpotlightFilterButton
              key={option.value}
              active={filter === option.value}
              label={option.label}
              onSelect={() => {
                return onSelect(option.value);
              }}
            />
          );
        })}
      </div>
      <span
        className="ml-2 shrink-0 text-xs text-muted-foreground"
        role="status"
      >
        {t(
          ($) => {
            return $.sidebar.resultCount;
          },
          { count: resultCount },
        )}
      </span>
    </div>
  );
}

interface SpotlightSearchResultsProps {
  readonly threads: readonly WorkspaceSearchChatThread[];
  readonly messages: readonly ChatSearchResult[];
  readonly agents: readonly SubagentInfo[];
  readonly workflows: readonly WorkflowSummary[];
  readonly artifacts: readonly ThreeColumnArtifactSearchItem[];
  readonly threadMap: ReadonlyMap<string, WorkspaceSearchChatThread>;
  readonly activeThreadIds: ReadonlySet<string> | undefined;
  readonly unreadThreadIds: ReadonlySet<string> | undefined;
  readonly searching: boolean;
  readonly showNoResults: boolean;
  readonly onSelectChatThread: (threadId: string) => void;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectWorkflow: (workflowId: string) => void;
  readonly onSelectArtifact: (artifact: ThreeColumnArtifactSearchItem) => void;
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

function spotlightFilterShows(
  filter: ThreeColumnSearchFilter,
  category: Exclude<ThreeColumnSearchFilter, "all">,
): boolean {
  return filter === "all" || filter === category;
}

function spotlightVisibleSearchIsPending({
  showThreads,
  threadSearching,
  showMessages,
  showAgents,
  showWorkflows,
  showArtifacts,
  messageSearching,
  agentSearching,
  workflowSearching,
  artifactSearching,
}: {
  readonly showThreads: boolean;
  readonly threadSearching: boolean;
  readonly showMessages: boolean;
  readonly showAgents: boolean;
  readonly showWorkflows: boolean;
  readonly showArtifacts: boolean;
  readonly messageSearching: boolean;
  readonly agentSearching: boolean;
  readonly workflowSearching: boolean;
  readonly artifactSearching: boolean;
}): boolean {
  return (
    (showThreads && threadSearching) ||
    (showMessages && messageSearching) ||
    (showAgents && agentSearching) ||
    (showWorkflows && workflowSearching) ||
    (showArtifacts && artifactSearching)
  );
}

function SpotlightSearchResults({
  threads,
  messages,
  agents,
  workflows,
  artifacts,
  threadMap,
  activeThreadIds,
  unreadThreadIds,
  searching,
  showNoResults,
  onSelectChatThread,
  onSelectAgent,
  onSelectWorkflow,
  onSelectArtifact,
}: SpotlightSearchResultsProps) {
  const { t } = useTranslation("agents");
  const numberShortcutsEnabled = useGet(threadNumberShortcutsEnabled$);
  const shortcutNumber = (index: number) => {
    return numberShortcutsEnabled && index < 9 ? index + 1 : undefined;
  };

  return (
    // `px-3` pairs with each row's `pl-1` / `pr-2` to put row content on the
    // same 20px rail as the search field and the filter row, while the row's
    // hover fill still bleeds past it.
    <CommandList className="min-h-[300px] max-h-[min(560px,65vh)] px-3 pb-4">
      {/*
        No group heading: the filter row above already names what is listed, and
        "Best matches" was labelling the only group there is.
      */}
      <CommandGroup className="[&_[data-slot=command-group-items]]:flex [&_[data-slot=command-group-items]]:flex-col">
        {threads.map((thread, index) => {
          return (
            <SpotlightThreadCommandItem
              shortcutNumber={shortcutNumber(index)}
              key={thread.id}
              thread={thread}
              indicator={chatThreadCommandIndicator(
                thread.id,
                activeThreadIds,
                unreadThreadIds,
              )}
              onSelect={() => {
                return onSelectChatThread(thread.id);
              }}
            />
          );
        })}
        {messages.map((message, index) => {
          return (
            <SpotlightMessageCommandItem
              shortcutNumber={shortcutNumber(threads.length + index)}
              key={`${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
              message={message}
              thread={threadMap.get(message.chatThreadId)}
              indicator={chatThreadCommandIndicator(
                message.chatThreadId,
                activeThreadIds,
                unreadThreadIds,
              )}
              onSelect={() => {
                return onSelectChatThread(message.chatThreadId);
              }}
            />
          );
        })}
        {agents.map((agent, index) => {
          return (
            <SpotlightAgentCommandItem
              shortcutNumber={shortcutNumber(
                threads.length + messages.length + index,
              )}
              key={agent.agentId}
              agent={agent}
              onSelect={() => {
                return onSelectAgent(agent.agentId);
              }}
            />
          );
        })}
        {workflows.map((workflow, index) => {
          return (
            <SpotlightWorkflowCommandItem
              shortcutNumber={shortcutNumber(
                threads.length + messages.length + agents.length + index,
              )}
              key={workflow.id}
              workflow={workflow}
              onSelect={() => {
                return onSelectWorkflow(workflow.id);
              }}
            />
          );
        })}
        {artifacts.map((artifact, index) => {
          return (
            <SpotlightArtifactCommandItem
              shortcutNumber={shortcutNumber(
                threads.length +
                  messages.length +
                  agents.length +
                  workflows.length +
                  index,
              )}
              key={artifact.id}
              artifact={artifact}
              onSelect={() => {
                return onSelectArtifact(artifact);
              }}
            />
          );
        })}
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
      </CommandGroup>
      {showNoResults ? (
        // Same empty-state shape as the artifacts and workflows lists: a 96px
        // spot illustration over a single line, centred in the list's minimum
        // height so the dialog does not resize as results come and go.
        <div className="flex min-h-[268px] flex-col items-center justify-center px-6 text-center">
          <img
            src={emptySearchImg}
            alt=""
            role="presentation"
            loading="lazy"
            className="h-24 w-24 object-contain opacity-80"
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
  onSelectAgent,
  onSelectWorkflow,
  onSelectArtifact,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectChatThread: (threadId: string) => void;
  readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectWorkflow: (workflowId: string) => void;
  readonly onSelectArtifact: (artifact: ThreeColumnArtifactSearchItem) => void;
}) {
  const { t } = useTranslation("agents");
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const signal = useGet(pageSignal$);
  const filter = useGet(threeColumnSearchFilter$);
  const setFilter = useSet(setThreeColumnSearchFilter$);
  const threadLoadable = useLoadable(threeColumnSearchChatThreads$);
  const shortcutIndex = useSet(threadNumberShortcutIndex$);
  const threadMap = useGet(workspaceSearchChatThreadMap$);
  const messageLoadable = useLoadable(workspaceSearchChatMessages$);
  const agentLoadable = useLoadable(threeColumnAgentSearchResults$);
  const workflowLoadable = useLoadable(threeColumnWorkflowSearchResults$);
  const artifactLoadable = useLoadable(threeColumnArtifactSearchResults$);
  const activeThreadIds = useLastResolved(sidebarActiveThreadIds$, {
    equalityFn: equalSets,
  });
  const unreadThreadIds = useLastResolved(sidebarUnreadThreadIds$, {
    equalityFn: equalSets,
  });
  const trimmedQuery = query.trim().toLowerCase();
  const threadMatches = spotlightRowsFromLoadable(
    threadLoadable,
    trimmedQuery,
    (result) => {
      return result.chatThreads;
    },
  );
  const messageMatches = spotlightRowsFromLoadable(
    messageLoadable,
    trimmedQuery,
    (result) => {
      return result.chatMessages;
    },
  );
  const agentMatches = spotlightRowsFromLoadable(
    agentLoadable,
    trimmedQuery,
    (result) => {
      return result.agents;
    },
  );
  const workflowMatches = spotlightRowsFromLoadable(
    workflowLoadable,
    trimmedQuery,
    (result) => {
      return result.workflows;
    },
  );
  const artifactMatches = spotlightRowsFromLoadable(
    artifactLoadable,
    trimmedQuery,
    (result) => {
      return result.artifacts;
    },
  );
  const showThreads = spotlightFilterShows(filter, "chats");
  const showMessages = spotlightFilterShows(filter, "messages");
  const showAgents = spotlightFilterShows(filter, "agents");
  const showWorkflows = spotlightFilterShows(filter, "workflows");
  const showArtifacts = spotlightFilterShows(filter, "artifacts");
  const visibleThreads = showThreads ? threadMatches : [];
  const visibleMessages = showMessages ? messageMatches : [];
  const visibleAgents = showAgents ? agentMatches : [];
  const visibleWorkflows = showWorkflows ? workflowMatches : [];
  const visibleArtifacts = showArtifacts ? artifactMatches : [];
  const resultCount =
    visibleThreads.length +
    visibleMessages.length +
    visibleAgents.length +
    visibleWorkflows.length +
    visibleArtifacts.length;
  const visibleSearching = spotlightVisibleSearchIsPending({
    showThreads,
    threadSearching: spotlightLoadableIsSearching(threadLoadable, trimmedQuery),
    showMessages,
    showAgents,
    showWorkflows,
    showArtifacts,
    messageSearching: spotlightLoadableIsSearching(
      messageLoadable,
      trimmedQuery,
    ),
    agentSearching: spotlightLoadableIsSearching(agentLoadable, trimmedQuery),
    workflowSearching: spotlightLoadableIsSearching(
      workflowLoadable,
      trimmedQuery,
    ),
    artifactSearching: spotlightLoadableIsSearching(
      artifactLoadable,
      trimmedQuery,
    ),
  });
  const showNoResults = !visibleSearching && resultCount === 0;
  const selectThread = (threadId: string) => {
    onOpenChange(false);
    onSelectChatThread(threadId);
  };
  const selectAgent = (agentId: string) => {
    onOpenChange(false);
    onSelectAgent(agentId);
  };
  const selectWorkflow = (workflowId: string) => {
    onOpenChange(false);
    onSelectWorkflow(workflowId);
  };
  const selectArtifact = (artifact: ThreeColumnArtifactSearchItem) => {
    onOpenChange(false);
    onSelectArtifact(artifact);
  };

  const resultSelections = [
    ...visibleThreads.map((thread) => {
      return () => {
        selectThread(thread.id);
      };
    }),
    ...visibleMessages.map((message) => {
      return () => {
        selectThread(message.chatThreadId);
      };
    }),
    ...visibleAgents.map((agent) => {
      return () => {
        selectAgent(agent.agentId);
      };
    }),
    ...visibleWorkflows.map((workflow) => {
      return () => {
        selectWorkflow(workflow.id);
      };
    }),
    ...visibleArtifacts.map((artifact) => {
      return () => {
        selectArtifact(artifact);
      };
    }),
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      smMaxWidth={820}
      showCloseButton={false}
      contentClassName="gap-0"
      commandClassName="gap-0"
      commandProps={{
        shouldFilter: false,
        loop: true,
        value: query,
        onValueChange: (value) => {
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
          resultSelections[index]?.();
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
        <SpotlightSearchFilterBar
          filter={filter}
          resultCount={resultCount}
          onSelect={setFilter}
        />
        <SpotlightSearchResults
          threads={visibleThreads}
          messages={visibleMessages}
          agents={visibleAgents}
          workflows={visibleWorkflows}
          artifacts={visibleArtifacts}
          threadMap={threadMap}
          activeThreadIds={activeThreadIds}
          unreadThreadIds={unreadThreadIds}
          searching={visibleSearching}
          showNoResults={showNoResults}
          onSelectChatThread={selectThread}
          onSelectAgent={selectAgent}
          onSelectWorkflow={selectWorkflow}
          onSelectArtifact={selectArtifact}
        />
      </div>
    </CommandDialog>
  );
}

export function PinAgentDialog({
  open,
  onOpenChange,
  subagents,
  saving,
  onSetAgentPinned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subagents: SubagentInfo[];
  saving: boolean;
  onSetAgentPinned: (agentId: string, pinned: boolean) => Promise<void>;
}) {
  const { t } = useTranslation("agents");
  const query = useGet(pinAgentDialogQuery$);
  const setQuery = useSet(setPinAgentDialogQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinnedRenderOrder = pinnedIds;

  const pinnedIdSet = new Set(pinnedIds);
  const trimmedQuery = query.trim().toLowerCase();
  const matches = filterAgentDialogItems(subagents, trimmedQuery);
  const pinnable = matches.filter((agent) => {
    return !pinnedIdSet.has(agent.agentId);
  });
  const matchedIds = new Set(
    matches.map((agent) => {
      return agent.agentId;
    }),
  );
  const alreadyPinned = agentsInRenderOrder(
    subagents,
    pinnedRenderOrder,
  ).filter((agent) => {
    return matchedIds.has(agent.agentId);
  });

  const saveAgentPinned = async (agent: SubagentInfo, pinned: boolean) => {
    await onSetAgentPinned(agent.agentId, pinned);
    toast.success(
      pinned
        ? t(
            ($) => {
              return $.sidebar.pinSuccess;
            },
            { agentName: agentDialogLabel(agent) },
          )
        : t(
            ($) => {
              return $.sidebar.unpinSuccess;
            },
            { agentName: agentDialogLabel(agent) },
          ),
    );
  };
  const setAgentPinned = (agent: SubagentInfo, pinned: boolean) => {
    detach(saveAgentPinned(agent, pinned), Reason.DomCallback);
  };
  const pinLabel = t(($) => {
    return $.sidebar.addPin;
  });
  const unpinLabel = t(($) => {
    return $.sidebar.unpin;
  });

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      smMaxWidth="xl"
      contentClassName="gap-0"
      commandClassName="gap-0"
      commandProps={{
        shouldFilter: false,
        loop: true,
        value: query,
        onValueChange: setQuery,
      }}
    >
      <DialogHeader className="px-5 pt-5 pb-3">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.sidebar.pinAgent;
          })}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground mt-1">
          {t(($) => {
            return $.sidebar.pinAgentDescription;
          })}
        </DialogDescription>
      </DialogHeader>

      <AgentCommandSearch
        query={query}
        setQuery={setQuery}
        placeholder={t(($) => {
          return $.sidebar.searchAgents;
        })}
      />

      <CommandList data-testid="pin-agent-dialog-list">
        {matches.length === 0 && (
          <p className="px-6 py-3 text-xs text-muted-foreground">
            {trimmedQuery
              ? t(($) => {
                  return $.sidebar.noResults;
                })
              : t(($) => {
                  return $.sidebar.noAgentsToPin;
                })}
          </p>
        )}
        {pinnable.length > 0 && (
          <AgentCommandSection
            label={t(($) => {
              return $.sidebar.sections.others;
            })}
          >
            {pinnable.map((agent) => {
              return (
                <CommandItem
                  key={agent.agentId}
                  value={agent.agentId}
                  disabled={saving}
                  onSelect={() => {
                    return setAgentPinned(agent, true);
                  }}
                  className="group w-full gap-2 px-1 py-2"
                >
                  <AgentCommandAgentContent agent={agent} />
                  <AgentCommandPinToggle
                    label={pinLabel}
                    icon={<Pin size={16} />}
                    disabled={saving}
                    onToggle={() => {
                      return setAgentPinned(agent, true);
                    }}
                  />
                </CommandItem>
              );
            })}
          </AgentCommandSection>
        )}
        {alreadyPinned.length > 0 && (
          <AgentCommandSection
            label={t(($) => {
              return $.sidebar.pinned;
            })}
            className="pb-3"
          >
            {alreadyPinned.map((agent) => {
              return (
                <CommandItem
                  key={agent.agentId}
                  value={agent.agentId}
                  disabled={saving}
                  onSelect={() => {
                    return setAgentPinned(agent, false);
                  }}
                  className="group w-full gap-2 px-1 py-2"
                >
                  <AgentCommandAgentContent agent={agent} />
                  <AgentCommandPinToggle
                    label={unpinLabel}
                    icon={<PinOff size={16} />}
                    disabled={saving}
                    onToggle={() => {
                      return setAgentPinned(agent, false);
                    }}
                  />
                </CommandItem>
              );
            })}
          </AgentCommandSection>
        )}
      </CommandList>
    </CommandDialog>
  );
}
