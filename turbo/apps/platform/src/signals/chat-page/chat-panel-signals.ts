import type { ThinkingSummaries } from "./thread-activity-summary.ts";
import type { Root } from "hast";
import type { Command, Computed } from "ccstate";
import type {
  ChatRecommendedFollowup,
  ChatRunVideoOptionsRequest,
  GenerationTemplateRequest,
  ChatThreadArtifactRun,
  ChatThreadDraft,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatClipboardPayload } from "../okou-page/clipboard.ts";
import type {
  ChatEventGroup,
  UserMessageRenderDocument,
} from "./chat-event.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import type { HeaderAutomationSignals } from "./header-automation-menu.ts";
import type { ThreadSidebarSignals } from "./thread-sidebar.ts";
import type { BrowserSessionSignals } from "./browser-session-block.ts";
import type { EditorDocumentSnapshot } from "../okou-page/user-message-document-codec.ts";
import type {
  createChatThreadScrollSignals,
  ReadyScrollAfterRenderRequest,
  ScrollToEventOptions,
  ThreadScrollPosition,
} from "./chat-thread-scroll.ts";
import type { AssistantErrorRecovery } from "./assistant-error-recovery.ts";
import type { ComposerSignals } from "../okou-page/composer-signals.ts";
import type { ChatThreadFeedbackSignals } from "./chat-thread-feedback.ts";
import type { ChatThreadSharingSignals } from "./chat-thread-sharing.ts";
import type { ChatThreadPinSignals } from "./chat-thread-pin.ts";
import type { ChatForwardContext } from "./chat-forward.ts";
import type { ChatConversationLocatorSignals } from "./chat-conversation-locator.ts";
import type { RunDetailSignals } from "./run-detail.ts";

type RecommendedFollowup = ChatRecommendedFollowup;

export interface RecommendedFollowupSource {
  readonly eventId: string;
  readonly followups: readonly RecommendedFollowup[];
}

export type ThinkingIndicatorMode =
  | "waiting"
  | "waiting-queued"
  | "running"
  | "running-queued"
  | "finished"
  | null;

export interface EventImageGroupProjection {
  readonly role: ChatEventGroup["role"];
  readonly events: readonly {
    readonly userMessage?: UserMessageDocument;
    readonly userMessageRenderDocument?: UserMessageRenderDocument;
    readonly tree?: Root;
  }[];
}

/**
 * Message rendering and interaction signals owned by a chat thread.
 *
 * These are derived from chat events but are not part of the chat event data
 * source consumed by other features such as the composer.
 */
export interface MessageListSignals {
  readonly runDetails$: Computed<ReadonlyMap<string, RunDetailSignals>>;
  readonly setup$: Command<Promise<void>, [AbortSignal]>;
  readonly catchUp$: Command<Promise<void>, [AbortSignal]>;
  readonly scroll: ReturnType<typeof createChatThreadScrollSignals>;
  readonly sidebar: ThreadSidebarSignals;
  readonly latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  readonly latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  readonly visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly visibleRenderedChatGroupsReady$: Computed<Promise<boolean>>;
  readonly readyScrollAfterRenderRequest$: Computed<
    Promise<ReadyScrollAfterRenderRequest | null>
  >;
  readonly initialEventsReady$: Computed<boolean>;
  readonly assistantErrorRecovery$: Computed<
    Promise<AssistantErrorRecovery | null>
  >;
  readonly retryAssistantError$: Command<Promise<boolean>, [AbortSignal]>;
  readonly resetCodexSubscriptionAndRetry$: Command<
    Promise<boolean>,
    [AbortSignal]
  >;
  readonly eventImageGroups$: Computed<Promise<EventImageGroupProjection[]>>;
  readonly browserSessionSignals: BrowserSessionSignals;
  readonly subscribeBrowserSessions$: Command<Promise<void>, [AbortSignal]>;
  readonly hasEvents$: Computed<Promise<boolean>>;
  readonly thinkingIndicatorMode$: Computed<Promise<ThinkingIndicatorMode>>;
  readonly thinkingEventId$: Computed<Promise<string | null>>;
  readonly thinkingText$: Computed<Promise<string | null>>;
  readonly recommendedFollowupSource$: Computed<
    Promise<RecommendedFollowupSource | null>
  >;
  readonly donePhrase$: Computed<Promise<string>>;
  readonly loadMoreRenderedChatGroups$: Command<
    Promise<boolean>,
    [AbortSignal]
  >;
  readonly resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  readonly retryRichEventTree$: Command<
    Promise<void>,
    [ChatEvent, AbortSignal]
  >;
  readonly artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>;
  readonly reloadArtifacts$: Command<void, []>;
}

export interface SendMessageOptions {
  readonly revokesEventId?: string;
  readonly includeDraftAttachments?: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly editorDocument?: EditorDocumentSnapshot;
  readonly videoRunOptions?: ChatRunVideoOptionsRequest;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
}

export interface QueueMessageOptions {
  readonly computerUseHostId: string | null | undefined;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: EditorDocumentSnapshot;
  readonly videoRunOptions?: ChatRunVideoOptionsRequest;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
}

export interface ChatPanelSignals {
  readonly runDetails$: Computed<ReadonlyMap<string, RunDetailSignals>>;
  readonly threadId: string;
  readonly agentId: string;
  // -- Data signals ----------------------------------------------------------
  readonly threadDraft$: Computed<Promise<ChatThreadDraft | null>>;
  readonly threadMeta$: Computed<ThreadMeta | null>;
  readonly threadTitle$: Computed<string | null>;
  readonly threadTitleEmoji$: Computed<string | null>;
  readonly threadTitleText$: Computed<string>;
  readonly assistantErrorRecovery$: Computed<
    Promise<AssistantErrorRecovery | null>
  >;
  readonly retryAssistantError$: Command<Promise<boolean>, [AbortSignal]>;
  readonly resetCodexSubscriptionAndRetry$: Command<
    Promise<boolean>,
    [AbortSignal]
  >;
  readonly scrollContainerOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly composerLayoutOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollContentOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly scrollCommitOnRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly readyScrollAfterRenderRequest$: Computed<
    Promise<ReadyScrollAfterRenderRequest | null>
  >;
  /** The mounted scroll viewport, for readers that measure it themselves. */
  readonly scrollContainer$: Computed<HTMLElement | null>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly scrollToEvent$: Command<
    Promise<void>,
    [string, ScrollToEventOptions, AbortSignal]
  >;
  readonly scrollTo$: Command<void, [ThreadScrollPosition]>;
  readonly scrollToBottom$: Command<Promise<void>, [AbortSignal]>;
  readonly restoreScrollPosition$: Command<Promise<void>, [AbortSignal]>;
  readonly scrollToTop$: Command<Promise<void>, [AbortSignal]>;
  readonly containerEl$: Computed<HTMLElement | null>;
  readonly setContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly setMainContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // True when the event list is scrolled away from the bottom - drives the
  // feature-gated scroll-to-bottom button. Read-only outside scroll signals.
  readonly awayFromBottom$: Computed<boolean>;
  readonly composer: ComposerSignals;
  readonly feedback: ChatThreadFeedbackSignals;
  readonly sharing: ChatThreadSharingSignals;
  readonly pin: ChatThreadPinSignals;
  readonly locator: ChatConversationLocatorSignals;
  // -- Thread-owned automation resources -----------------------------------
  readonly headerAutomations: HeaderAutomationSignals;
  // -- Thread-owned utility sidebar -----------------------------------------
  readonly sidebar: ThreadSidebarSignals;
  // -- Per-thread UI state --------------------------------------------------
  readonly copiedEventId$: Computed<string | null>;
  readonly copyEvent$: Command<
    Promise<void>,
    [string, ChatClipboardPayload, AbortSignal]
  >;
  // -- Paged events (sole rendering path) ----------------------------------
  readonly latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  readonly latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  readonly initialEventsReady$: Computed<boolean>;
  readonly visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly visibleRenderedChatGroupsReady$: Computed<Promise<boolean>>;
  readonly eventImageGroups$: Computed<Promise<EventImageGroupProjection[]>>;
  readonly browserSessionSignals: BrowserSessionSignals;
  readonly hasEvents$: Computed<Promise<boolean>>;
  readonly thinkingIndicatorMode$: Computed<Promise<ThinkingIndicatorMode>>;
  readonly thinkingSummaries$: Computed<Promise<ThinkingSummaries | null>>;
  readonly thinkingRunId$: Computed<Promise<string | null>>;
  readonly recommendedFollowupSource$: Computed<
    Promise<RecommendedFollowupSource | null>
  >;
  readonly loadMoreRenderedChatGroups$: Command<
    Promise<boolean>,
    [AbortSignal]
  >;
  readonly resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  readonly retryRichEventTree$: Command<
    Promise<void>,
    [ChatEvent, AbortSignal]
  >;
  readonly subscribeChatThread$: Command<Promise<void>, [AbortSignal]>;
  // -- Thinking indicator ---------------------------------------------------
  readonly thinkingPhrase$: Computed<string>;
  readonly donePhrase$: Computed<Promise<string>>;
  // -- Artifacts ------------------------------------------------------------
  readonly artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>;
  readonly reloadArtifacts$: Command<void, []>;
}
