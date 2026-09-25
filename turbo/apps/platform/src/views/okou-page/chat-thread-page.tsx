import type { ChatLayoutSignals } from "../../signals/chat-page/chat-layout.ts";
import type { ThinkingSummaries } from "../../signals/chat-page/thread-activity-summary.ts";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { Toolbar } from "@base-ui/react/toolbar";
import type {
  FormEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import {
  useGet,
  useLoadable,
  useSet,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import type { TFunction } from "i18next";
import { equalArrays, equalSets } from "../../lib/equality.ts";
import { useTranslation } from "react-i18next";
import {
  formatAppNumber,
  formatChatTimestamp,
  formatLocalizedNumber,
} from "../../i18n/format.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";
import {
  runUsagePopoverOpenRunId$,
  setRunUsagePopoverOpenRunId$,
} from "../../signals/chat-page/run-usage-popover.ts";
import {
  AlertCircle,
  Coffee,
  Flag,
  Hand,
  Heart,
  Leaf,
  Lightbulb,
  Plane,
  Smile,
  Trophy,
  Image,
  ChartLine,
  Globe,
  Video,
  File,
  Copy,
  Check,
  SwatchBook,
  ArrowDown,
  ArrowUpRight,
  ChevronRight,
  Link as LinkIcon,
  Coins,
  Loader2,
  Play,
  MessageCircle,
  SmilePlus,
  Package,
  Route,
  Search,
  Target,
  X,
  Clock,
  Hourglass,
  Share2,
  type LucideIcon,
} from "lucide-react";
import {
  cn,
  getShortcutLabel,
  getShortcutParts,
  Button,
  CopyButton,
  ShareLinkButton,
  Checkbox,
  Input,
  Skeleton,
  ScrollBar,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  BrandLangfuse,
  BrandSlack,
  ElapsedTime,
  LazySpinner,
  ThinkingMessages,
  useMediaQuery,
  buttonVariants,
} from "@okouai/ui";
import { RUN_ERROR_GUIDANCE } from "@okouai/api-contracts/contracts/errors";
import {
  knownRunFailureReasonSchema,
  type KnownRunFailureReason,
} from "@okouai/api-contracts/contracts/run-failure-reasons";
import type {
  ChatEventUsagePayload,
  ChatRecommendedFollowup,
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isChatEventContentTextType } from "@okouai/api-contracts/contracts/chat-events";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
} from "../../signals/okou-page/user-message-document-codec.ts";
import { generationTemplateKind } from "@okouai/core/generation-template-kind";
import type {
  ChatThreadWorkflowAutomation,
  WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import { getModelDisplayName } from "@okouai/core/model-display-name";
import { emptyChatImg, thinkingSpinnerImg } from "./platform-assets.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ChatThreadPinButton } from "./chat-thread-header-actions.tsx";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { Markdown, MarkdownEventBody } from "../components/markdown.tsx";
import { hasChatEventBodyContent } from "../../signals/chat-page/chat-event-body-blocks.ts";
import { i18n } from "../../i18n/index.ts";
import { artifactFallbackSubtitle } from "./artifact-display.ts";
import { runChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  CHAT_INLINE_IMAGE_PREVIEW_CLASS,
  CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS,
  ChatImagePreviewLink,
  ChatVideoPreviewButton,
} from "./chat-body-cards.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ChatConversationLandingHighlight,
  ChatConversationLocator,
} from "./chat-conversation-locator.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isStandalonePwa } from "../../lib/keyboard-dismiss-gesture.ts";
import {
  captureChatWorkHistoryExpanded,
  captureRecommendedFollowupSelected,
  captureRecommendedFollowupsShown,
} from "../../lib/posthog.ts";
import { buildCreditUsageDisplayRows } from "../../lib/credit-usage-display.ts";
import {
  FileAttachmentChip,
  PreviewableAudioAttachmentChip,
  PreviewableFileAttachmentChip,
} from "./attachment-chips.tsx";
import { DiscordMark } from "./components/discord-mark.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import type {
  ArtifactKind,
  ArtifactSignals,
} from "../../signals/chat-page/artifact-card-signals.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
} from "../../signals/chat-page/connector-action-block.ts";
import {
  chatEventDisplayError,
  isRenderableAssistantEvent,
} from "../../signals/chat-page/chat-event-display.ts";
import {
  buildRunWorkFolding,
  runWorkExpandedKeys$,
  runWorkExpandedKeysForScrollTarget,
  runWorkSectionForGroup,
  toggleRunWorkExpanded$,
  type RunWorkFolding,
  type RunWorkSection,
} from "../../signals/chat-page/run-work-folding.ts";
import {
  chatGroupForSharing,
  shareableEventFromChatEvent,
} from "../../signals/chat-page/chat-thread-sharing.ts";
import {
  ChatShareMarqueeViewport,
  clickTargetsExistingInteraction,
} from "./chat-share-marquee.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import {
  defaultBuiltinConnectorAccountOptions,
  defaultCustomConnectorAccountOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { customConnectors$ } from "../../signals/okou-page/settings/custom-connectors.ts";
import {
  openImageLightbox$ as openAttachmentImageLightbox$,
  openVideoLightbox$ as openAttachmentVideoLightbox$,
} from "../../signals/okou-page/attachment-chips.ts";
import { openMarkdownArtifact$ } from "../../signals/okou-page/markdown-artifact-preview.ts";
import {
  writeToClipboard,
  type ChatClipboardAttachment,
} from "../../signals/okou-page/clipboard.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import type {
  HeaderAutomationSignals,
  HeaderWorkflowAutomationEntry,
} from "../../signals/chat-page/header-automation-menu.ts";
import {
  activeThreadSidebar$,
  openThreadAutomations$,
  openThreadBrowserSession$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import type { ThreadSidebarSignals } from "../../signals/chat-page/thread-sidebar.ts";
import {
  ThreadSidebarSlot,
  useOpenThreadArtifacts,
} from "./thread-sidebar.tsx";
import { ChatThreadSidebarShell } from "./chat-thread-sidebar-shell.tsx";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import {
  closeChatThreadEmojiMenu$,
  emojiMenuThreadId$,
  emojiMenuTitle$,
  openChatThreadEmojiMenu$,
} from "../../signals/okou-page/sidebar-state.ts";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/okou-page/cron.ts";
import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  formatWorkflowIntervalSeconds,
  GMAIL_TEXT_FIELDS,
  getWorkflowIntervalSecondOptions,
  gmailMatcherDefaultValue,
} from "../workflows-page/workflow-shared.tsx";
import {
  WorkflowAutomationCard,
  type WorkflowAutomationCardRow,
} from "../workflows-page/workflow-automation-card.tsx";
import {
  renameChatThread$,
  type EnrichedChatEvent,
  type ChatEventGroup,
  type UserMessageFeedbackNoteRenderPart,
  type UserMessageRenderDocument,
  type UserMessageRenderPart,
} from "../../signals/chat-page/chat-event.ts";
import type {
  ChatInputEvent,
  ChatEvent,
} from "../../signals/chat-page/chat-event-types.ts";
import { optimisticEventIds$ } from "../../signals/chat-page/optimistic-chat-events.ts";
import type { ChatRunModelSelection } from "../../signals/chat-page/chat-event-state.ts";
import type { AgentReferenceSignals } from "../../signals/chat-page/agent-reference-signals.ts";
import type { RunDetailSignals } from "../../signals/chat-page/run-detail.ts";
import type { AssistantErrorRecovery } from "../../signals/chat-page/assistant-error-recovery.ts";
import { localizedRunError } from "../../lib/run-error.ts";
import { PlainTextWithLinks } from "../components/plain-text-with-links.tsx";
import { userMessageFileAttachments } from "../../signals/chat-page/user-message-files.ts";
import type {
  ChatPanelSignals,
  RecommendedFollowupSource,
  ThinkingIndicatorMode,
} from "../../signals/chat-page/chat-panel-signals.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
  CHAT_THREAD_EMOJI_OPTIONS,
} from "../../signals/chat-page/chat-thread-title.ts";
import {
  chatThreadEmojiActiveCategory$,
  chatThreadEmojiGroups$,
  chatThreadEmojiPendingJump$,
  chatThreadEmojiPreview$,
  chatThreadEmojiQuery$,
  filterChatThreadEmojiGroups,
  setChatThreadEmojiActiveCategory$,
  setChatThreadEmojiPendingJump$,
  setChatThreadEmojiPreview$,
  setChatThreadEmojiQuery$,
  type ChatThreadEmojiItem,
} from "../../signals/chat-page/chat-thread-emoji.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { ChatComposer } from "./chat-composer.tsx";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ChatFeedbackSelection } from "./chat-feedback-selection.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./sidebar-shared.tsx";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import { setBillingSubPage$ } from "../../signals/okou-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  billingStatusAsync$,
  creditPurchaseOrigin$,
  type CreditCheckoutSelection,
  startCheckout$,
  startCreditCheckout$,
} from "../../signals/okou-page/billing.ts";
import { orgPlanCapabilitiesFromBilling } from "../../signals/okou-page/org-plan-capabilities.ts";
import {
  currentLeftPane$,
  currentRightPane$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import type { ChatThreadPaneState } from "../../signals/chat-page/chat-thread-pane-state.ts";
import {
  chatThreadContainerElement$,
  setChatKeyboardScrollRoot$,
} from "../../signals/chat-page/chat-keyboard.ts";
import { ChatCard } from "./components/chat-card.tsx";
import { ChatCardDetails } from "./components/chat-card-details.tsx";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import {
  ChatAssistantMessageBody,
  ChatUserMessageBubble,
  CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS,
  CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS,
  CHAT_THREAD_ASSISTANT_RESPONSE_COLUMN_CLASS,
  CHAT_THREAD_CONTENT_MAIN_CLASS,
  CHAT_THREAD_MESSAGE_LIST_CLASS,
  CHAT_THREAD_MESSAGE_ROW_GAP_CLASS,
  CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
  CHAT_THREAD_RESPONSE_FLUSH_CLASS,
  CHAT_THREAD_RESPONSE_LINE_CLASS,
  CHAT_THREAD_RESPONSE_LEADING_ICON_CLASS,
  CHAT_THREAD_RESPONSE_SUPPORTING_TEXT_CLASS,
  CHAT_THREAD_RESPONSE_COMPACT_STACK_CLASS,
  CHAT_THREAD_RESPONSE_STACK_CLASS,
  CHAT_THREAD_WORK_HISTORY_MARKDOWN_CLASS,
  CHAT_THREAD_WORK_HISTORY_TEXT_CLASS,
  CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_USER_MESSAGE_ROW_CLASS,
} from "./chat-message-surface.tsx";
import { SCROLL_FADE_Y_END } from "./scroll-fade.ts";

type RecommendedFollowup = ChatRecommendedFollowup;

type UserMessageNonContentPart = Extract<
  UserMessagePart,
  { readonly type: "source" | "automation" | "goal" }
>;

type UserMessageAnnotationRenderPart = Extract<
  UserMessageRenderPart,
  { readonly type: "source" | "automation" | "goal" }
>;

function isUserMessageNonContentPart(
  part: UserMessagePart,
): part is UserMessageNonContentPart {
  return (
    part.type === "source" || part.type === "automation" || part.type === "goal"
  );
}

type UserMessageHiddenPart = Extract<
  UserMessagePart,
  {
    readonly type: "source" | "automation" | "goal" | "model";
  }
>;

function isUserMessageHiddenPart(
  part: UserMessagePart,
): part is UserMessageHiddenPart {
  return isUserMessageNonContentPart(part) || part.type === "model";
}

function isInputChatEvent(event: ChatEvent): event is ChatInputEvent {
  return (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.goal" ||
    event.eventType === "input.rejected"
  );
}

function asInputChatEvent(event: ChatEvent): ChatInputEvent | undefined {
  return isInputChatEvent(event) ? event : undefined;
}

function modelSelectionFromUserMessage(
  document: UserMessageDocument | undefined,
): ChatRunModelSelection | undefined {
  const modelPart = document?.parts.find((part) => {
    return part.type === "model";
  });
  return modelPart?.type === "model"
    ? {
        selectedModel: modelPart.selectedModel,
        ...(modelPart.serviceTier === undefined
          ? {}
          : { serviceTier: modelPart.serviceTier }),
      }
    : undefined;
}

function modelChangeRunKey(
  inputEvent: ChatInputEvent,
  modelSelection: ChatRunModelSelection | undefined,
): string | undefined {
  if (inputEvent.runId !== undefined) {
    return `run:${inputEvent.runId}`;
  }
  if (modelSelection !== undefined) {
    return `event:${inputEvent.id}`;
  }
  return undefined;
}

type RunModelChange =
  | {
      readonly kind: "model";
      readonly selection: ChatRunModelSelection;
    }
  | {
      readonly kind: "fast-mode";
      readonly enabled: boolean;
    };

function fastModeEnabled(selection: ChatRunModelSelection): boolean {
  return selection.serviceTier === "priority";
}

function runModelDisplayName(
  t: TFunction<"common">,
  selection: ChatRunModelSelection,
): string {
  const model = getModelDisplayName(selection.selectedModel);
  return fastModeEnabled(selection)
    ? t(
        ($) => {
          return $.chat.run.fastModelName;
        },
        { model },
      )
    : model;
}

function modelChangesByEventId(
  groups: readonly ChatEventGroup[],
): ReadonlyMap<string, RunModelChange> {
  const changes = new Map<string, RunModelChange>();
  let previousRunKey: string | undefined;
  let previousSelection: ChatRunModelSelection | undefined;
  let hasPreviousRun = false;

  for (const group of groups) {
    for (const event of group.events) {
      const inputEvent = asInputChatEvent(event);
      if (inputEvent === undefined) {
        continue;
      }
      const selection = modelSelectionFromUserMessage(inputEvent.userMessage);
      const runKey = modelChangeRunKey(inputEvent, selection);
      if (runKey === undefined || runKey === previousRunKey) {
        continue;
      }
      if (
        hasPreviousRun &&
        previousSelection !== undefined &&
        selection !== undefined
      ) {
        if (selection.selectedModel !== previousSelection.selectedModel) {
          changes.set(event.id, { kind: "model", selection });
        } else if (
          fastModeEnabled(selection) !== fastModeEnabled(previousSelection)
        ) {
          changes.set(event.id, {
            kind: "fast-mode",
            enabled: fastModeEnabled(selection),
          });
        }
      }
      previousRunKey = runKey;
      previousSelection = selection;
      hasPreviousRun = true;
    }
  }

  return changes;
}

function userMessageNonContentPart(
  document: UserMessageDocument | undefined,
): UserMessageNonContentPart | undefined {
  return document?.parts.find(isUserMessageNonContentPart);
}

function userMessageAnnotationRenderPart(
  document: UserMessageRenderDocument | undefined,
): UserMessageAnnotationRenderPart | undefined {
  return document?.parts.find(
    (renderPart): renderPart is UserMessageAnnotationRenderPart => {
      return (
        renderPart.type === "source" ||
        renderPart.type === "automation" ||
        renderPart.type === "goal"
      );
    },
  );
}

function eventNonContentPart(
  event: EnrichedChatEvent,
): UserMessageNonContentPart | undefined {
  return userMessageNonContentPart(
    isInputChatEvent(event) ? event.userMessage : undefined,
  );
}

function ChatThreadHeaderIconButton({
  icon,
  label,
  tooltip = label,
  open,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tooltip?: string;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="quiet"
              size="icon-sm"
              iconSize="md"
              className={cn(
                "shrink-0 duration-150",
                open &&
                  "bg-primary/10 text-selected-foreground hover:text-selected-foreground",
              )}
              aria-label={label}
              aria-pressed={open}
              onClick={onClick}
            >
              {icon}
            </Button>
          }
        />
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactsButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const sidebarTarget = useGet(thread.sidebar.target$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openThreadArtifacts = useOpenThreadArtifacts(thread);
  return (
    <ChatThreadHeaderIconButton
      icon={<Package size={18} />}
      label={t(($) => {
        return $.chat.thread.openArtifacts;
      })}
      open={sidebarTarget?.type === "artifacts"}
      onClick={() => {
        reloadArtifacts();
        openThreadArtifacts();
      }}
    />
  );
}
// Loads automations and only renders once this thread has at least one linked
// automation.
export function AutomationMenuButton({
  thread,
  ariaLabel,
}: {
  thread: ChatPanelSignals;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const reloadAutomations = useSet(thread.headerAutomations.reloadAutomations$);
  const openAutomationSidebar = useSet(openThreadAutomations$);
  const sidebarTarget = useGet(thread.sidebar.target$);
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const open = sidebarTarget?.type === "automations";

  // Show the opener when the thread has a workflow automation.
  if (workflowAutomations.length === 0) {
    return null;
  }

  return (
    <ChatThreadHeaderIconButton
      icon={<Clock size={18} />}
      label={
        ariaLabel ??
        t(($) => {
          return $.chat.automations.title;
        })
      }
      tooltip={t(($) => {
        return $.chat.automations.open;
      })}
      open={open}
      onClick={() => {
        reloadAutomations();
        openAutomationSidebar(thread);
      }}
    />
  );
}

function BrowserMenuButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const sidebarTarget = useGet(thread.sidebar.target$);
  const openBrowserSidebar = useSet(openThreadBrowserSession$);
  return (
    <ChatThreadHeaderIconButton
      icon={<Globe size={18} />}
      label={t(($) => {
        return $.chat.thread.openBrowser;
      })}
      open={sidebarTarget?.type === "browser"}
      onClick={() => {
        openBrowserSidebar(thread.threadId);
      }}
    />
  );
}

export function ChatThreadHeaderTitle({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const threadTitle = useGet(thread.threadTitle$)?.trim() ?? "";
  const threadTitleEmoji = useGet(thread.threadTitleEmoji$);
  const threadTitleText = useGet(thread.threadTitleText$);
  const optimisticCreateUnsettled = useGet(thread.optimisticCreateUnsettled$);
  const openRenameChatThreadDialog = useSet(
    openRenameChatThreadDialogForThreadId$,
  );
  const pageSignal = useGet(pageSignal$);

  function openRenameDialog(event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    detach(
      openRenameChatThreadDialog(thread.threadId, pageSignal),
      Reason.DomCallback,
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {!optimisticCreateUnsettled && (
        <ChatThreadEmojiMenuButton
          threadId={thread.threadId}
          title={threadTitle}
          emoji={threadTitleEmoji}
        />
      )}
      {threadTitleText && (
        <span
          className="min-w-0 truncate text-sm font-medium text-foreground"
          data-testid="chat-thread-header-title"
          onDoubleClick={
            optimisticCreateUnsettled ? undefined : openRenameDialog
          }
        >
          {threadTitleText}
        </span>
      )}
    </div>
  );
}

const CHAT_THREAD_HEADER_CLASS =
  "flex h-14 shrink-0 items-center justify-between bg-transparent px-6";

function ChatThreadHeader({ thread }: { thread: ChatPanelSignals }) {
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  // Only mount one emoji picker for the thread's shared menu state.
  return isDesktop ? <DesktopChatThreadHeader thread={thread} /> : null;
}

export function SettledChatThreadActions({
  thread,
  children,
}: {
  thread: ChatPanelSignals;
  children: ReactNode;
}) {
  return useGet(thread.optimisticCreateUnsettled$) ? null : children;
}

function DesktopChatThreadHeader({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const headerActionsEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatThreadHeaderActions];
  const pageSignal = useGet(pageSignal$);
  const sharingPhase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const startSharing = useSet(thread.sharing.start$);
  const closeSharing = useSet(thread.sharing.close$);
  if (sharingPhase !== "idle") {
    return (
      <header className={CHAT_THREAD_HEADER_CLASS}>
        <span className="text-sm font-medium text-foreground">
          {t(
            ($) => {
              return $.chat.sharing.selectedCount;
            },
            { count: selectedCount },
          )}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <SelectAllSharedMessagesButton
            thread={thread}
            disabled={sharingPhase !== "selecting"}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              detach(
                closeSharing(pageSignal),
                Reason.DomCallback,
                "close shared thread selection",
              );
            }}
          >
            {t(($) => {
              return $.chat.sharing.cancel;
            })}
          </Button>
        </div>
      </header>
    );
  }

  return (
    <header className={CHAT_THREAD_HEADER_CLASS}>
      {headerActionsEnabled ? (
        <div className="flex min-w-0 items-center gap-2 pr-3">
          <ChatThreadHeaderTitle thread={thread} />
          <SettledChatThreadActions thread={thread}>
            <ChatThreadPinButton thread={thread} />
          </SettledChatThreadActions>
        </div>
      ) : (
        <ChatThreadHeaderTitle thread={thread} />
      )}
      <SettledChatThreadActions thread={thread}>
        <div className="flex shrink-0 items-center gap-0.5">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    onClick={() => {
                      detach(
                        startSharing(pageSignal),
                        Reason.DomCallback,
                        "start shared thread selection",
                      );
                    }}
                    variant="quiet"
                    size="icon-sm"
                    iconSize="md"
                    className="shrink-0 duration-150"
                    aria-label={t(($) => {
                      return $.chat.sharing.start;
                    })}
                  >
                    <Share2 size={18} />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {t(($) => {
                  return $.chat.sharing.start;
                })}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <AutomationMenuButton thread={thread} />
          <BrowserMenuButton thread={thread} />
          <ArtifactsButton thread={thread} />
        </div>
      </SettledChatThreadActions>
    </header>
  );
}

function useChatThreadEmojiMenuActions({
  threadId,
  title,
}: {
  threadId: string;
  title: string | null | undefined;
}) {
  const emojiMenuThreadId = useGet(emojiMenuThreadId$);
  const emojiMenuTitle = useGet(emojiMenuTitle$);
  const openChatThreadEmojiMenu = useSet(openChatThreadEmojiMenu$);
  const closeChatThreadEmojiMenu = useSet(closeChatThreadEmojiMenu$);
  const renameChatThread = useSet(renameChatThread$);
  const pageSignal = useGet(pageSignal$);
  const open = emojiMenuThreadId === threadId;

  function closeMenu() {
    closeChatThreadEmojiMenu();
  }

  function selectEmoji(nextEmoji: string) {
    const activeThreadId = emojiMenuThreadId;
    if (!activeThreadId) {
      return;
    }
    detach(
      (async () => {
        await renameChatThread(
          {
            threadId: activeThreadId,
            title: applyChatThreadEmoji(emojiMenuTitle ?? title, nextEmoji),
          },
          pageSignal,
        );
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  }

  function clearEmoji() {
    const activeThreadId = emojiMenuThreadId;
    if (!activeThreadId) {
      return;
    }
    const nextTitle = removeChatThreadEmoji(emojiMenuTitle ?? title);
    if (!nextTitle) {
      closeMenu();
      return;
    }
    detach(
      (async () => {
        await renameChatThread(
          { threadId: activeThreadId, title: nextTitle },
          pageSignal,
        );
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  }

  return { open, openChatThreadEmojiMenu, closeMenu, selectEmoji, clearEmoji };
}

function ChatThreadEmojiMenuButton({
  emoji,
  threadId,
  title,
}: {
  emoji: string | null | undefined;
  threadId: string;
  title: string | null | undefined;
}) {
  const { t } = useTranslation();
  const chatThreadContainerElement = useSet(chatThreadContainerElement$);
  const { open, openChatThreadEmojiMenu, closeMenu, selectEmoji, clearEmoji } =
    useChatThreadEmojiMenuActions({ threadId, title });
  const setEmojiQuery = useSet(setChatThreadEmojiQuery$);
  const setEmojiActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const setEmojiPendingJump = useSet(setChatThreadEmojiPendingJump$);
  const setEmojiPreview = useSet(setChatThreadEmojiPreview$);

  return (
    <TooltipProvider delay={200}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setEmojiQuery("");
            setEmojiActiveCategory(null);
            setEmojiPendingJump(null);
            setEmojiPreview(null);
            openChatThreadEmojiMenu({ threadId, title });
          } else {
            closeMenu();
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    aria-label={t(($) => {
                      return $.chat.thread.changeIcon;
                    })}
                    aria-keyshortcuts="Shift+F2"
                    variant="quiet"
                    size="icon-xs"
                    iconSize="md"
                    className="shrink-0"
                  >
                    {emoji ? (
                      <span
                        aria-hidden="true"
                        className="font-family-emoji text-base leading-none"
                      >
                        {emoji}
                      </span>
                    ) : (
                      <SmilePlus size={18} aria-hidden="true" />
                    )}
                  </Button>
                }
              />
            }
          />
          <TooltipContent
            role="tooltip"
            side="bottom"
            className="flex flex-col items-center gap-1 py-1.5"
          >
            <span>
              {t(($) => {
                return $.chat.thread.icon;
              })}
            </span>
            <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
              {getShortcutLabel("shift+f2")}
            </kbd>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          className="w-80 p-0"
          finalFocus={() => {
            // An open header replaced at a breakpoint keeps the new picker's focus.
            if (!open) {
              // Restore the keyboard root after the portal has detached.
              queueMicrotask(() => {
                chatThreadContainerElement(threadId)?.focus({
                  preventScroll: true,
                });
              });
            }
            return false;
          }}
        >
          <ChatThreadEmojiPicker
            hasEmoji={Boolean(emoji)}
            onSelect={selectEmoji}
            onRemove={clearEmoji}
          />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

function useFrequentlyUsedEmoji(): ChatThreadEmojiItem[] {
  const { t } = useTranslation();
  const labels = [
    t(($) => {
      return $.chat.thread.emoji.done;
    }),
    t(($) => {
      return $.chat.thread.emoji.urgent;
    }),
    t(($) => {
      return $.chat.thread.emoji.no;
    }),
    t(($) => {
      return $.chat.thread.emoji.risk;
    }),
    t(($) => {
      return $.chat.thread.emoji.idea;
    }),
    t(($) => {
      return $.chat.thread.emoji.question;
    }),
    t(($) => {
      return $.chat.thread.emoji.waiting;
    }),
    t(($) => {
      return $.chat.thread.emoji.watching;
    }),
    t(($) => {
      return $.chat.thread.emoji.shipped;
    }),
  ];
  return CHAT_THREAD_EMOJI_OPTIONS.map((option, index) => {
    return { emoji: option.emoji, name: labels[index] ?? option.emoji };
  });
}

// unicode-emoji-json ships the CLDR group names, so key the rail icons off the
// same strings the sections are titled with.
function chatThreadEmojiCategoryIcon(group: string): LucideIcon {
  switch (group) {
    case "People & Body": {
      return Hand;
    }
    case "Animals & Nature": {
      return Leaf;
    }
    case "Food & Drink": {
      return Coffee;
    }
    case "Travel & Places": {
      return Plane;
    }
    case "Activities": {
      return Trophy;
    }
    case "Objects": {
      return Lightbulb;
    }
    case "Symbols": {
      return Heart;
    }
    case "Flags": {
      return Flag;
    }
    default: {
      return Smile;
    }
  }
}

const CHAT_THREAD_EMOJI_FREQUENT_CATEGORY = "frequently-used";

interface ChatThreadEmojiCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  items: ChatThreadEmojiItem[];
  showShortcutDigits: boolean;
  // The emoji dataset names an emoji the way a shortcode does; the frequently
  // used row names it the way this product does ("Done", "Urgent"), which is
  // translated and must not be dressed up as a shortcode.
  shortcodeNames: boolean;
}

function chatThreadEmojiDisplayName(
  name: string,
  shortcodeNames: boolean,
): string {
  return shortcodeNames ? `:${name.replace(/\s+/g, "_")}:` : name;
}

function chatThreadEmojiSectionId(key: string): string {
  return `chat-thread-emoji-section-${encodeURIComponent(key)}`;
}

// The category whose title is pinned right now: the last section that has
// already reached the top of the feed.
function pinnedChatThreadEmojiCategory(feed: HTMLElement): string | null {
  const sections = Array.from(
    feed.querySelectorAll<HTMLElement>("[data-chat-thread-emoji-section]"),
  );
  let pinned: string | null = null;
  for (const section of sections) {
    if (section.offsetTop > feed.scrollTop + 1) {
      break;
    }
    pinned = section.dataset.chatThreadEmojiSection ?? null;
  }
  return pinned;
}

// Where the feed lands when it jumps to a section. A short final category
// cannot scroll all the way to its own offset, so clamp to the last reachable
// position: the jump and the arrival check have to agree on the same number.
function chatThreadEmojiScrollTarget(
  feed: HTMLElement,
  section: HTMLElement,
): number {
  return Math.min(section.offsetTop, feed.scrollHeight - feed.clientHeight);
}

// Returns whether the feed will actually move. A jump that scrolls nowhere
// emits no scroll event, so the caller must not wait for one.
function scrollChatThreadEmojiCategoryIntoView(key: string): boolean {
  const section = document.getElementById(chatThreadEmojiSectionId(key));
  const feed = section?.closest<HTMLElement>("[data-chat-thread-emoji-feed]");
  if (!section || !feed || typeof feed.scrollTo !== "function") {
    return false;
  }
  const top = chatThreadEmojiScrollTarget(feed, section);
  if (Math.abs(top - feed.scrollTop) <= 1) {
    return false;
  }
  feed.scrollTo({ top, behavior: "smooth" });
  return true;
}

function chatThreadEmojiCategories(
  frequentLabel: string,
  frequentItems: ChatThreadEmojiItem[],
  groups: { name: string; emojis: ChatThreadEmojiItem[] }[] | null,
): ChatThreadEmojiCategory[] {
  return [
    {
      key: CHAT_THREAD_EMOJI_FREQUENT_CATEGORY,
      label: frequentLabel,
      icon: Clock,
      items: frequentItems,
      showShortcutDigits: true,
      shortcodeNames: false,
    },
    ...(groups ?? []).map((group) => {
      return {
        key: group.name,
        label: group.name,
        icon: chatThreadEmojiCategoryIcon(group.name),
        items: group.emojis,
        showShortcutDigits: false,
        shortcodeNames: true,
      };
    }),
  ];
}

function ChatThreadEmojiCategoryRail({
  categories,
  onSelect,
}: {
  categories: ChatThreadEmojiCategory[];
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  // Held here rather than in the picker so that following the feed re-renders
  // the rail alone, not the ~1,900 emoji buttons below it.
  const activeCategory = useGet(chatThreadEmojiActiveCategory$);
  const selectedCategory =
    activeCategory ?? CHAT_THREAD_EMOJI_FREQUENT_CATEGORY;

  // These buttons scroll one continuous feed. Toolbar owns keyboard focus;
  // the pinned section owns the current-location indicator independently.
  return (
    <Toolbar.Root
      aria-label={t(($) => {
        return $.chat.thread.emojiCategories;
      })}
      // 7px top and bottom keeps the buttons clear of the popover edge and of
      // the divider; the active bar then sits inside the bottom gap.
      className="flex gap-0.5 border-b border-border px-2 py-[7px]"
    >
      {categories.map((category) => {
        const CategoryIcon = category.icon;
        const selected = category.key === selectedCategory;
        return (
          <Toolbar.Button
            key={category.key}
            type="button"
            aria-current={selected ? "location" : undefined}
            aria-controls={chatThreadEmojiSectionId(category.key)}
            aria-label={category.label}
            title={category.label}
            className={cn(
              "relative flex h-8 flex-1 items-center justify-center rounded-lg transition-colors hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover focus-visible:text-foreground",
              selected ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => {
              onSelect(category.key);
            }}
          >
            <CategoryIcon size={16} aria-hidden="true" />
            {selected && (
              <span
                aria-hidden="true"
                // -8px == the row's 7px bottom padding plus its 1px border, so
                // the bar seats on the divider instead of floating above it.
                className="absolute -bottom-2 h-0.5 w-4 rounded-t-sm bg-primary"
              />
            )}
          </Toolbar.Button>
        );
      })}
    </Toolbar.Root>
  );
}

function ChatThreadEmojiPicker({
  hasEmoji,
  onSelect,
  onRemove,
}: {
  hasEmoji: boolean;
  onSelect: (emoji: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const query = useGet(chatThreadEmojiQuery$);
  const setQuery = useSet(setChatThreadEmojiQuery$);
  const groups = useLastResolved(chatThreadEmojiGroups$) ?? null;
  const frequentlyUsedEmoji = useFrequentlyUsedEmoji();
  const setActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const setPendingJump = useSet(setChatThreadEmojiPendingJump$);

  const isSearching = query.trim().length > 0;
  const searchResults =
    isSearching && groups ? filterChatThreadEmojiGroups(groups, query) : [];

  const categories = chatThreadEmojiCategories(
    t(($) => {
      return $.chat.thread.frequentlyUsed;
    }),
    frequentlyUsedEmoji,
    groups,
  );
  function jumpToCategory(key: string): void {
    if (isSearching) {
      setQuery("");
    }
    setActiveCategory(key);
    // The sections may only mount once the query clears, so scroll on the next
    // frame rather than against the pre-clear layout. Only hold the highlight
    // when the feed really moves — otherwise no scroll event would arrive to
    // release the hold and the rail would stop following the feed for good.
    window.requestAnimationFrame(() => {
      setPendingJump(scrollChatThreadEmojiCategoryIntoView(key) ? key : null);
    });
  }

  return (
    <div className="flex flex-col">
      <ChatThreadEmojiCategoryRail
        categories={categories}
        onSelect={jumpToCategory}
      />
      <div
        // The gap below the field belongs to this row, because a search hides
        // the sections and puts a bare result grid under it. 12px here plus
        // the title's own pt-1 puts the first title the same 16px below the
        // field as every later title sits below the grid above it.
        className="flex items-center gap-2 px-2 pb-3 pt-2"
      >
        <div className="relative flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={t(($) => {
              return $.chat.thread.searchEmoji;
            })}
            placeholder={t(($) => {
              return $.chat.thread.searchEmoji;
            })}
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="h-8 pl-8"
          />
        </div>
        {hasEmoji && (
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            onClick={onRemove}
          >
            {t(($) => {
              return $.chat.actions.remove;
            })}
          </button>
        )}
      </div>
      <ChatThreadEmojiFeed
        categories={categories}
        searchResults={isSearching ? searchResults : null}
        onSelect={onSelect}
      />
      <ChatThreadEmojiPreview />
    </div>
  );
}

// Names whichever emoji the pointer or keyboard is on, so the grid stays a
// grid of glyphs and the reader still gets a label for the one in question.
function ChatThreadEmojiPreview() {
  const { t } = useTranslation();
  const preview = useGet(chatThreadEmojiPreview$);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-2">
      {preview ? (
        <>
          <span
            aria-hidden="true"
            className="font-family-emoji text-lg leading-none"
          >
            {preview.emoji}
          </span>
          <span className="truncate text-xs font-medium text-muted-foreground">
            {preview.name}
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground/70">
          {t(($) => {
            return $.chat.thread.pickEmoji;
          })}
        </span>
      )}
    </div>
  );
}

function ChatThreadEmojiFeed({
  categories,
  searchResults,
  onSelect,
}: {
  categories: ChatThreadEmojiCategory[];
  searchResults: ChatThreadEmojiItem[] | null;
  onSelect: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const setActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const pendingJump = useGet(chatThreadEmojiPendingJump$);
  const setPendingJump = useSet(setChatThreadEmojiPendingJump$);
  const setPreview = useSet(setChatThreadEmojiPreview$);

  // One delegated listener on the feed rather than a pair on each of the ~1,900
  // buttons. Pointer and keyboard both report through it.
  function previewEmojiUnder(target: EventTarget): void {
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest<HTMLElement>("[data-chat-thread-emoji]");
    const emoji = button?.dataset.chatThreadEmoji;
    const name = button?.dataset.chatThreadEmojiName;
    setPreview(emoji && name ? { emoji, name } : null);
  }

  function handleScroll(event: ReactUIEvent<HTMLDivElement>): void {
    const feed = event.currentTarget;
    if (pendingJump !== null) {
      const target = feed.querySelector<HTMLElement>(
        `[data-chat-thread-emoji-section="${pendingJump}"]`,
      );
      // Release the hold once the jump lands, and also when its section is no
      // longer around to land on, so the hold can never outlive the jump.
      if (
        !target ||
        Math.abs(chatThreadEmojiScrollTarget(feed, target) - feed.scrollTop) <=
          1
      ) {
        setPendingJump(null);
      }
      return;
    }
    setActiveCategory(pinnedChatThreadEmojiCategory(feed));
  }

  // Scrolling by hand aborts an in-flight smooth scroll, so the jump will never
  // reach its target: hand the feed back the highlight immediately.
  function releasePendingJump(): void {
    if (pendingJump !== null) {
      setPendingJump(null);
    }
  }

  return (
    <div
      data-chat-thread-emoji-feed=""
      // relative so each section's offsetTop is measured against the feed.
      className="relative max-h-72 overflow-y-auto px-2 pb-2"
      onScroll={handleScroll}
      onWheel={releasePendingJump}
      onTouchStart={releasePendingJump}
      onPointerDown={releasePendingJump}
      onMouseOver={(event) => {
        previewEmojiUnder(event.target);
      }}
      onFocus={(event) => {
        previewEmojiUnder(event.target);
      }}
      onMouseLeave={() => {
        setPreview(null);
      }}
    >
      {searchResults !== null ? (
        searchResults.length > 0 ? (
          <ChatThreadEmojiGrid items={searchResults} onSelect={onSelect} />
        ) : (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.thread.noEmojiFound;
            })}
          </p>
        )
      ) : (
        categories.map((category) => {
          return (
            <ChatThreadEmojiSection
              key={category.key}
              categoryKey={category.key}
              label={category.label}
              items={category.items}
              onSelect={onSelect}
              showShortcutDigits={category.showShortcutDigits}
              shortcodeNames={category.shortcodeNames}
            />
          );
        })
      )}
    </div>
  );
}

function ChatThreadEmojiSection({
  categoryKey,
  label,
  items,
  onSelect,
  showShortcutDigits = false,
  shortcodeNames = true,
}: {
  categoryKey: string;
  label: string;
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
  shortcodeNames?: boolean;
}) {
  const { t } = useTranslation();
  // Ctrl+Shift is a shared prefix for every digit shortcut, so surface it once
  // as a quiet hint next to the label rather than repeating it on each emoji.
  // getShortcutParts keeps the modifiers OS-aware (⌃⇧ on Mac, Ctrl+Shift else).
  const shortcutHint = showShortcutDigits
    ? `${formatModifierPrefix(getShortcutParts("ctrl+shift"))} + ${t(($) => {
        return $.chat.shortcuts.number;
      })}`
    : null;
  return (
    <div
      id={chatThreadEmojiSectionId(categoryKey)}
      data-chat-thread-emoji-section={categoryKey}
      // The pinned title's fade has to sit below its text, so the space that
      // separates it from the previous grid cannot come from the sticky box
      // itself. Carry it here instead, at twice the 8px left under the label,
      // so the title reads as a heading for its own grid and not as a caption
      // for the one above it. The first section has no grid above it — the
      // search row already spaces it off the field.
      className="mt-3 first:mt-0"
    >
      <div
        // Fade to transparent at the lower edge so emoji dissolve as they
        // scroll under the pinned title instead of colliding with it. The
        // fade has to live below the text, so pb-2 doubles as the gap to the
        // grid; from-75% keeps the whole label — descenders included — on the
        // solid part of that 28px box rather than over the fading part.
        className="sticky top-0 z-10 flex items-baseline justify-between gap-2 bg-gradient-to-b from-popover from-75% to-transparent pb-2 pt-1"
      >
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {shortcutHint && (
          <span className="text-[11px] text-muted-foreground/70">
            {shortcutHint}
          </span>
        )}
      </div>
      <ChatThreadEmojiGrid
        items={items}
        onSelect={onSelect}
        showShortcutDigits={showShortcutDigits}
        shortcodeNames={shortcodeNames}
      />
    </div>
  );
}

// Join modifier keycap labels the way each platform reads them: Mac symbols
// run together (⌃⇧), word labels are joined with "+" (Ctrl+Shift).
function formatModifierPrefix(modifiers: string[]): string {
  const usesWords = /[A-Za-z]/.test(modifiers[0] ?? "");
  return modifiers.join(usesWords ? "+" : "");
}

function ChatThreadEmojiGrid({
  items,
  onSelect,
  showShortcutDigits = false,
  shortcodeNames = true,
}: {
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
  shortcodeNames?: boolean;
}) {
  // Nine columns so the nine frequently-used digit shortcuts sit on a single
  // row; every other emoji group uses the same width to stay aligned.
  return (
    <div className="grid grid-cols-9 gap-0.5">
      {items.map((item, index) => {
        // Ctrl+Shift+1-9 set the first nine "frequently used" icons. Keep a
        // faint digit in the corner and reveal the full combo on hover so the
        // shortcut is discoverable without cluttering the grid.
        const shortcutDigit =
          showShortcutDigits && index < 9 ? index + 1 : null;
        const shortcutLabel =
          shortcutDigit !== null
            ? getShortcutLabel(`ctrl+shift+${shortcutDigit}`)
            : undefined;
        return (
          <button
            key={`${item.name}-${item.emoji}`}
            type="button"
            aria-label={item.name}
            data-chat-thread-emoji={item.emoji}
            data-chat-thread-emoji-name={chatThreadEmojiDisplayName(
              item.name,
              shortcodeNames,
            )}
            title={shortcutLabel}
            // The focus ring is inset because the feed scrolls: an offset ring
            // on the outer columns and on the first and last rows would be
            // clipped by the feed's own overflow box.
            className="relative flex aspect-square items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              onSelect(item.emoji);
            }}
          >
            <span aria-hidden="true" className="font-family-emoji">
              {item.emoji}
            </span>
            {shortcutDigit !== null && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 right-0.5 text-[9px] leading-none text-muted-foreground/60"
              >
                {shortcutDigit}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatHeaderWorkflowAutomationRun(value: string | null): string {
  if (!value) {
    return i18n.t(($) => {
      return $.chat.automations.noRuns;
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return i18n.t(($) => {
      return $.chat.automations.noRuns;
    });
  }
  return date.toLocaleString(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatHeaderWorkflowAutomationNextRun(value: string | null): string {
  if (!value) {
    return i18n.t(($) => {
      return $.chat.automations.noUpcomingRun;
    });
  }
  return formatHeaderWorkflowAutomationRun(value);
}

function formatHeaderClockTime(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2020, 0, 1, hour, minute));
}

function formatHeaderIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return i18n.t(
      ($) => {
        return $.chat.automations.everyHour;
      },
      { count: hours },
    );
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return i18n.t(
      ($) => {
        return $.chat.automations.everyMinute;
      },
      { count: minutes },
    );
  }
  return i18n.t(
    ($) => {
      return $.chat.automations.everySecond;
    },
    { count: seconds },
  );
}

function headerCronRuleLabel(
  cronExpression: string,
  sourceTimezone: string,
  displayTimezone: string,
): string {
  const [minutePart, hourPart, dayOfMonth = "*", , dayOfWeek = "*"] =
    cronExpression.split(" ");
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return i18n.t(
      ($) => {
        return $.chat.automations.cronWithTimezone;
      },
      {
        expression: cronExpression,
        timezone: sourceTimezone,
      },
    );
  }
  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    sourceTimezone,
    displayTimezone,
  );
  const time = formatHeaderClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*") {
    return i18n.t(
      ($) => {
        return $.chat.automations.monthlyAt;
      },
      {
        day: dayOfMonth,
        time,
      },
    );
  }
  if (dayOfWeek === "1-5") {
    return i18n.t(
      ($) => {
        return $.chat.automations.weekdayAt;
      },
      { time },
    );
  }
  if (dayOfWeek !== "*") {
    const days = dayOfWeek
      .split(",")
      .map((day) => {
        const weekday = Number(day);
        return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
          ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
              weekday: "long",
            }).format(new Date(2020, 0, 5 + weekday))
          : undefined;
      })
      .filter(Boolean)
      .join(", ");
    return days
      ? i18n.t(
          ($) => {
            return $.chat.automations.weeklyOnAt;
          },
          { days, time },
        )
      : i18n.t(
          ($) => {
            return $.chat.automations.weeklyAt;
          },
          { time },
        );
  }
  return i18n.t(
    ($) => {
      return $.chat.automations.dailyAt;
    },
    { time },
  );
}

function headerWorkflowAutomationRule(
  automation: HeaderWorkflowAutomationEntry,
): string {
  const source = automation.automation;
  if (source.kind !== "schedule") {
    return automation.summary;
  }
  const schedule = source.schedule;
  if (schedule.type === "loop") {
    return formatHeaderIntervalSeconds(schedule.intervalSeconds);
  }
  if (schedule.type === "once") {
    const { date, hour, minute } = atTimeInTimezone(
      schedule.atTime,
      automation.timezone,
    );
    return i18n.t(
      ($) => {
        return $.chat.automations.onceAt;
      },
      {
        date,
        time: formatHeaderClockTime(hour, minute),
      },
    );
  }
  return headerCronRuleLabel(
    schedule.cronExpression,
    schedule.timezone,
    automation.timezone,
  );
}

type HeaderGmailNewMessageAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { readonly eventType: "gmail-new-message" }
>;
type HeaderGmailTextField = keyof NonNullable<
  HeaderGmailNewMessageAutomation["eventConfig"]["match"]
>;
type HeaderGmailTextMatcher = NonNullable<
  NonNullable<
    HeaderGmailNewMessageAutomation["eventConfig"]["match"]
  >[HeaderGmailTextField]
>;

function quotedAutomationValue(value: string): string {
  return `"${value}"`;
}

function headerGmailFieldLabel(field: HeaderGmailTextField): string {
  switch (field) {
    case "from": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.from;
      });
    }
    case "subject": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.subject;
      });
    }
    case "body": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.body;
      });
    }
    case "to": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.to;
      });
    }
    case "cc": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.cc;
      });
    }
  }
}

function headerGmailMatcherParts(
  field: HeaderGmailTextField,
  matcher: HeaderGmailTextMatcher,
): string[] {
  const fieldLabel = headerGmailFieldLabel(field);
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.contains;
        },
        {
          field: fieldLabel,
          value: quotedAutomationValue(matcher.contains),
        },
      ),
    );
  }
  if (matcher.containsAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.containsAny;
        },
        {
          field: fieldLabel,
          values: matcher.containsAny.map(quotedAutomationValue).join(", "),
        },
      ),
    );
  }
  if (matcher.doesNotContain) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.doesNotContain;
        },
        {
          field: fieldLabel,
          value: quotedAutomationValue(matcher.doesNotContain),
        },
      ),
    );
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.doesNotContainAny;
        },
        {
          field: fieldLabel,
          values: matcher.doesNotContainAny
            .map(quotedAutomationValue)
            .join(", "),
        },
      ),
    );
  }
  return parts;
}

function headerGmailMatchSummary(
  config: HeaderGmailNewMessageAutomation["eventConfig"],
): string {
  const parts: string[] = config.threadId
    ? [
        i18n.t(
          ($) => {
            return $.chat.automations.matchSummary.threadIdIs;
          },
          {
            value: quotedAutomationValue(config.threadId),
          },
        ),
      ]
    : [];
  if (config.match) {
    for (const { field } of GMAIL_TEXT_FIELDS) {
      const matcher = config.match[field];
      if (matcher) {
        parts.push(...headerGmailMatcherParts(field, matcher));
      }
    }
  }
  return parts.length > 0
    ? parts.join("; ")
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.allInboundMessages;
      });
}

function headerAutomationFilterSummary(
  values: readonly string[] | undefined,
  fallback: string,
): string {
  return values?.join(", ") ?? fallback;
}

function headerNotionParentPageSummary(
  title: string | null | undefined,
): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.parentPage;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredParentPage;
      });
}

function headerNotionDatabaseSummary(title: string | null | undefined): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.database;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredDatabase;
      });
}

function headerNotionPageSummary(title: string | null | undefined): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.page;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredPage;
      });
}

function headerWorkflowAutomationMatchSummary(
  automation: ChatThreadWorkflowAutomation,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "gmail-label-applied": {
      return i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.label;
        },
        {
          value: quotedAutomationValue(automation.eventConfig.labelName),
        },
      );
    }
    case "github-pull-request": {
      return `${automation.eventConfig.repository} · ${automation.eventConfig.action}`;
    }
    case "gmail-new-message": {
      return headerGmailMatchSummary(automation.eventConfig);
    }
    case "github-workflow-run-completed":
    case "github-workflow-job-completed": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.conclusions,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyResult;
        }),
      );
    }
    case "github-pull-request-review-submitted": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.reviewStates,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyReview;
        }),
      );
    }
    case "github-deployment-status-created": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.states,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyDeploymentState;
        }),
      );
    }
    case "github-issue-comment-created": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.commentPrefixes,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyComment;
        }),
      );
    }
    case "google-calendar-event-created":
    case "google-calendar-event-updated":
    case "google-calendar-event-cancelled": {
      return i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.calendar;
        },
        {
          value: quotedAutomationValue(automation.eventConfig.calendarId),
        },
      );
    }
    case "google-meet-transcript-generated": {
      return i18n.t(($) => {
        return $.chat.automations.matchSummary.meetingsYouOrganize;
      });
    }
    case "notion-child-page-created": {
      return headerNotionParentPageSummary(
        automation.eventConfig.parentPage.title,
      );
    }
    case "notion-database-item-created": {
      return headerNotionDatabaseSummary(
        automation.eventConfig.dataSource.title,
      );
    }
    case "notion-page-content-updated": {
      if (automation.eventConfig.scope.type === "page") {
        return headerNotionPageSummary(automation.eventConfig.scope.page.title);
      }
      return headerNotionDatabaseSummary(
        automation.eventConfig.scope.dataSource.title,
      );
    }
    default: {
      return null;
    }
  }
}

function headerWorkflowAutomationRows(
  automation: HeaderWorkflowAutomationEntry,
): readonly WorkflowAutomationCardRow[] {
  const rows: WorkflowAutomationCardRow[] = [
    {
      label: i18n.t(($) => {
        return $.chat.automations.status;
      }),
      value: automation.enabled
        ? i18n.t(($) => {
            return $.chat.automations.active;
          })
        : i18n.t(($) => {
            return $.chat.automations.disabled;
          }),
    },
    {
      label:
        automation.automation.kind === "schedule"
          ? i18n.t(($) => {
              return $.chat.automations.schedule;
            })
          : i18n.t(($) => {
              return $.chat.automations.automation;
            }),
      value: headerWorkflowAutomationRule(automation),
    },
    {
      label: i18n.t(($) => {
        return $.chat.automations.lastRun;
      }),
      value: formatHeaderWorkflowAutomationRun(automation.automation.lastRunAt),
    },
  ];
  if (automation.automation.kind === "schedule") {
    rows.push({
      label: i18n.t(($) => {
        return $.chat.automations.nextRun;
      }),
      value: formatHeaderWorkflowAutomationNextRun(
        automation.automation.nextRunAt,
      ),
    });
  }
  const matchSummary = headerWorkflowAutomationMatchSummary(
    automation.automation,
  );
  if (matchSummary) {
    rows.splice(1, 0, {
      label: i18n.t(($) => {
        return $.chat.automations.match;
      }),
      value: matchSummary,
    });
  }
  return rows;
}

function HeaderWorkflowAutomationCard({
  automation,
  headerAutomations,
  threadSidebar,
}: {
  automation: HeaderWorkflowAutomationEntry;
  headerAutomations: HeaderAutomationSignals;
  threadSidebar: ThreadSidebarSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const editingAutomationId = useGet(threadSidebar.editingAutomationId$);
  const setEditingAutomationId = useSet(threadSidebar.setEditingAutomationId$);
  const [runningLoadable, runNow] = useLoadableSet(headerAutomations.runNow$);
  const running = runningLoadable.state === "loading";
  const title =
    automation.workflowDisplayName?.trim() || automation.workflowName;
  const rows = headerWorkflowAutomationRows(automation);
  const editing = editingAutomationId === automation.id;

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-normal leading-snug text-muted-foreground">
          {title}
        </p>
        <Link
          pathname={ROUTES.workflowDetailAutomations}
          options={{
            pathParams: {
              workflowId: automation.workflowId,
            },
          }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        >
          {t(($) => {
            return $.chat.actions.view;
          })}
          <ArrowUpRight size={12} />
        </Link>
      </div>
      <WorkflowAutomationCard
        rows={rows}
        dimmed={!automation.enabled}
        actions={
          <>
            {automation.automation.kind === "schedule" ||
            (automation.automation.kind === "event" &&
              (automation.automation.eventType === "gmail-new-message" ||
                automation.automation.eventType === "gmail-label-applied")) ? (
              <button
                type="button"
                className="rounded-md px-1 py-1 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                onClick={() => {
                  setEditingAutomationId(automation.id);
                }}
              >
                {t(($) => {
                  return $.chat.actions.edit;
                })}
              </button>
            ) : null}
            <Button
              type="button"
              variant="neutral"
              size="sm"
              className="ml-auto h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium"
              disabled={running}
              onClick={() => {
                detach(
                  runNow(automation.id, pageSignal),
                  Reason.DomCallback,
                  "run header workflow automation now",
                );
              }}
            >
              {running ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {running
                ? t(($) => {
                    return $.chat.automations.starting;
                  })
                : t(($) => {
                    return $.chat.automations.runNow;
                  })}
            </Button>
          </>
        }
      />
      <HeaderWorkflowAutomationEditDialog
        automation={automation.automation}
        headerAutomations={headerAutomations}
        displayTimezone={automation.timezone}
        open={editing}
        onOpenChange={(open) => {
          setEditingAutomationId(open ? automation.id : null);
        }}
      />
    </div>
  );
}

function HeaderWorkflowAutomationEditDialog({
  automation,
  headerAutomations,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly automation: ChatThreadWorkflowAutomation;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        maxWidth={
          automation.kind === "event" &&
          automation.eventType === "gmail-new-message"
            ? "2xl"
            : "lg"
        }
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.automations.edit;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.automations.editDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        {automation.kind === "schedule" ? (
          <HeaderScheduleAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            displayTimezone={displayTimezone}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-new-message" ? (
          <HeaderGmailNewMessageAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-label-applied" ? (
          <HeaderGmailLabelAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function localDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function scheduleFromHeaderAutomationForm(
  automation: Extract<ChatThreadWorkflowAutomation, { kind: "schedule" }>,
  form: FormData,
): WorkflowSchedule | null {
  const schedule = automation.schedule;
  if (schedule.type === "loop") {
    const intervalSeconds = Number(form.get("intervalSeconds"));
    return Number.isInteger(intervalSeconds) && intervalSeconds > 0
      ? { type: "loop", intervalSeconds }
      : null;
  }
  if (schedule.type === "once") {
    const rawAtTime = String(form.get("atTime") ?? "");
    if (!rawAtTime) {
      return null;
    }
    const atTime = new Date(rawAtTime);
    return Number.isNaN(atTime.getTime())
      ? null
      : {
          type: "once",
          atTime: atTime.toISOString(),
          timezone: schedule.timezone,
        };
  }
  const cronExpression = String(form.get("cronExpression") ?? "").trim();
  return cronExpression
    ? {
        type: "cron",
        cronExpression,
        timezone: schedule.timezone,
      }
    : null;
}

function HeaderScheduleAutomationEditForm({
  automation,
  headerAutomations,
  displayTimezone,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { kind: "schedule" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly displayTimezone: string;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateSchedule$,
  );
  const saving = updateLoadable.state === "loading";
  const schedule = automation.schedule;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const scheduleValue = scheduleFromHeaderAutomationForm(
          automation,
          new FormData(event.currentTarget),
        );
        if (!scheduleValue) {
          return;
        }
        detach(
          (async () => {
            await updateAutomation(
              { automationId: automation.id, schedule: scheduleValue },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow schedule automation",
        );
      }}
    >
      {schedule.type === "loop" ? (
        <HeaderIntervalField
          disabled={saving}
          defaultIntervalSeconds={schedule.intervalSeconds}
        />
      ) : null}
      {schedule.type === "once" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.automations.runAt;
          })}
          <Input
            name="atTime"
            aria-label={t(($) => {
              return $.chat.automations.runAt;
            })}
            type="datetime-local"
            defaultValue={localDateTimeInputValue(schedule.atTime)}
            disabled={saving}
          />
          <span>
            {t(
              ($) => {
                return $.chat.automations.displaysIn;
              },
              {
                timezone: displayTimezone,
              },
            )}
          </span>
        </label>
      ) : null}
      {schedule.type === "cron" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.automations.cronExpression;
          })}
          <Input
            name="cronExpression"
            aria-label={t(($) => {
              return $.chat.automations.cronExpression;
            })}
            defaultValue={schedule.cronExpression}
            disabled={saving}
          />
          <span>
            {t(
              ($) => {
                return $.chat.automations.runsIn;
              },
              {
                timezone: schedule.timezone,
              },
            )}
          </span>
        </label>
      ) : null}
      <HeaderAutomationEditFooter saving={saving} onCancel={onDone} />
    </form>
  );
}

function HeaderAutomationEditFooter({
  saving,
  onCancel,
}: {
  saving: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={saving}
        onClick={onCancel}
      >
        {t(($) => {
          return $.chat.actions.cancel;
        })}
      </Button>
      <Button type="submit" disabled={saving}>
        {saving ? <Loader2 size={14} className="animate-spin" /> : null}
        {t(($) => {
          return $.chat.automations.save;
        })}
      </Button>
    </DialogFooter>
  );
}

function HeaderIntervalField({
  disabled,
  defaultIntervalSeconds,
}: {
  readonly disabled: boolean;
  readonly defaultIntervalSeconds: number;
}) {
  const { t } = useTranslation();
  const intervalItems = getWorkflowIntervalSecondOptions(
    defaultIntervalSeconds,
  ).map((seconds) => {
    return {
      value: String(seconds),
      label: formatWorkflowIntervalSeconds(seconds),
    };
  });
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {t(($) => {
        return $.chat.automations.every;
      })}
      <Select
        items={intervalItems}
        name="intervalSeconds"
        defaultValue={String(defaultIntervalSeconds)}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label={t(($) => {
            return $.chat.automations.every;
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {intervalItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function HeaderGmailThreadIdFields({
  threadId,
  disabled,
}: {
  readonly threadId: string | null | undefined;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  if (!threadId) {
    return null;
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      <Input
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdField;
        })}
        value={t(($) => {
          return $.chat.automations.gmail.threadId;
        })}
        readOnly
        disabled
      />
      <Input
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdOperator;
        })}
        value={t(($) => {
          return $.chat.automations.gmail.is;
        })}
        readOnly
        disabled
      />
      <Input
        name="threadId"
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdValue;
        })}
        defaultValue={threadId}
        disabled={disabled}
        required
      />
    </div>
  );
}

function HeaderGmailTextMatcherFields({
  eventConfig,
  disabled,
}: {
  readonly eventConfig: HeaderGmailNewMessageAutomation["eventConfig"];
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {GMAIL_TEXT_FIELDS.map(({ field }) => {
        const label = headerGmailFieldLabel(field);
        return (
          <div key={field} className="grid grid-cols-3 gap-2">
            <Input
              name={`${field}Contains`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.contains;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "contains",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.contains;
                },
                { field: label },
              )}
            />
            <Input
              name={`${field}ContainsAny`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.containsAny;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "containsAny",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.containsAny;
                },
                { field: label },
              )}
            />
            <Input
              name={`${field}DoesNotContain`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.doesNotContain;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "doesNotContain",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.doesNotContain;
                },
                { field: label },
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

function HeaderGmailNewMessageAutomationEditForm({
  automation,
  headerAutomations,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { eventType: "gmail-new-message" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly onDone: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateGmailNewMessage$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateAutomation(
              {
                automationId: automation.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  automation.eventConfig,
                ),
              },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow Gmail automation",
        );
      }}
    >
      <HeaderGmailThreadIdFields
        threadId={automation.eventConfig.threadId}
        disabled={saving}
      />
      <HeaderGmailTextMatcherFields
        eventConfig={automation.eventConfig}
        disabled={saving}
      />
      <HeaderAutomationEditFooter saving={saving} onCancel={onDone} />
    </form>
  );
}

function HeaderGmailLabelAutomationEditForm({
  automation,
  headerAutomations,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { eventType: "gmail-label-applied" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly onDone: () => void;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateGmailLabelApplied$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const eventConfig = buildGmailLabelAppliedEventConfig(
          new FormData(event.currentTarget),
        );
        if (!eventConfig) {
          return;
        }
        detach(
          (async () => {
            await updateAutomation(
              { automationId: automation.id, eventConfig },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow Gmail label automation",
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.automations.gmail.labelName;
        })}
        <Input
          name="labelName"
          aria-label={t(($) => {
            return $.chat.automations.gmail.labelName;
          })}
          required
          defaultValue={automation.eventConfig.labelName}
          disabled={saving}
          placeholder={t(($) => {
            return $.chat.automations.gmail.labelPlaceholder;
          })}
        />
      </label>
      <HeaderAutomationEditFooter saving={saving} onCancel={onDone} />
    </form>
  );
}
function HeaderAutomationSidebar({
  thread,
  onClose,
}: {
  thread: ChatPanelSignals;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const isEmpty = workflowAutomations.length === 0;
  const loading = isEmpty && workflowAutomationsLoadable.state === "loading";

  return (
    <aside
      aria-label={t(($) => {
        return $.chat.automations.title;
      })}
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
      data-testid="automation-sidebar"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {t(($) => {
              return $.chat.automations.title;
            })}
          </div>
        </div>
        <Button
          showTooltip
          type="button"
          onClick={onClose}
          aria-label={t(($) => {
            return $.chat.automations.close;
          })}
          variant="quiet"
          size="icon-sm"
        >
          <X size={16} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="grid gap-3">
            <Skeleton className="h-36 rounded-lg" />
            <Skeleton className="h-36 rounded-lg" />
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.automations.empty;
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            {workflowAutomations.map((automation) => {
              return (
                <HeaderWorkflowAutomationCard
                  key={automation.id}
                  automation={automation}
                  headerAutomations={thread.headerAutomations}
                  threadSidebar={thread.sidebar}
                />
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// SessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

function ChatThreadAppSkeletonHandoff({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const initialEventsReady = useGet(thread.initialEventsReady$);
  const hideAppSkeletonOnContentReadyRef = useSet(
    hideAppSkeletonOnContentReadyRef$,
  );
  if (!initialEventsReady) {
    return null;
  }
  return <span ref={hideAppSkeletonOnContentReadyRef} hidden />;
}

function ChatThread({
  isMain,
  thread,
}: {
  isMain?: boolean;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const setContainerRef = useSet(
    isMain ? thread.setMainContainerRef$ : thread.setContainerRef$,
  );

  return (
    <section
      aria-label={t(($) => {
        return $.chat.thread.ariaLabel;
      })}
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={thread.threadId}
      ref={setContainerRef}
      tabIndex={-1}
    >
      <ChatThreadContent thread={thread} />
      {isMain ? <ChatThreadAppSkeletonHandoff thread={thread} /> : null}
    </section>
  );
}

function MissingChatThread({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.chat.thread.ariaLabel;
      })}
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={threadId}
      tabIndex={-1}
    >
      <ChatThreadNotFound />
    </section>
  );
}

function ChatThreadPane({
  isMain,
  pane,
}: {
  isMain?: boolean;
  pane: Exclude<ChatThreadPaneState, null>;
}) {
  return pane.kind === "thread" ? (
    <ChatThread isMain={isMain} thread={pane.thread} />
  ) : (
    <MissingChatThread threadId={pane.threadId} />
  );
}

function ChatThreadArea({
  leftPane,
  rightPane,
}: {
  leftPane: ChatThreadPaneState;
  rightPane: ChatThreadPaneState;
}) {
  const setKeyboardScrollRoot = useSet(setChatKeyboardScrollRoot$);

  return (
    <div
      ref={setKeyboardScrollRoot}
      className="flex w-full flex-1 min-w-0 min-h-0 bg-transparent"
    >
      {leftPane && <ChatThreadPane isMain pane={leftPane} />}
      {rightPane && (
        <>
          <div className="w-px shrink-0 bg-divider/60" aria-hidden="true" />
          <ChatThreadPane pane={rightPane} />
        </>
      )}
    </div>
  );
}

function ThreadAutomationsSidebarSlot({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const close = useSet(thread.sidebar.close$);
  return <HeaderAutomationSidebar thread={thread} onClose={close} />;
}

export function ChatThreadPage({
  layout,
}: {
  readonly layout: ChatLayoutSignals;
}) {
  const activeThreadSidebar = useGet(activeThreadSidebar$);
  const leftPane = useGet(currentLeftPane$);
  const rightPane = useGet(currentRightPane$);
  return withChatScrollLayout(
    <>
      <ChatThreadSidebarShell
        layout={layout}
        animateEntry={activeThreadSidebar?.animateEntry ?? true}
        open={activeThreadSidebar !== null}
        sidebar={
          activeThreadSidebar ? (
            activeThreadSidebar.target.type === "automations" ? (
              <ThreadAutomationsSidebarSlot
                thread={activeThreadSidebar.thread}
              />
            ) : (
              <ThreadSidebarSlot
                thread={activeThreadSidebar.thread}
                target={activeThreadSidebar.target}
              />
            )
          ) : null
        }
      >
        <ChatThreadArea leftPane={leftPane} rightPane={rightPane} />
      </ChatThreadSidebarShell>
      <ChatConnectorActionConnectModal />
    </>,
  );
}

function resolveSessionError(
  renderedGroupsReadyLoadable: Loadable<boolean>,
): string | null {
  if (renderedGroupsReadyLoadable.state === "hasError") {
    return renderedGroupsReadyLoadable.error instanceof Error
      ? renderedGroupsReadyLoadable.error.message
      : i18n.t(($) => {
          return $.chat.errors.loadMessages;
        });
  }
  return null;
}

const CHAT_RENDER_LOAD_MORE_TOP_THRESHOLD_PX = 100;

function renderedChatEventKeys(
  groups: readonly ChatEventGroup[],
): readonly string[] {
  return groups.flatMap((group) => {
    return group.events.map((event) => {
      return `${event.id}:${event.isQueued ? "queued" : "active"}`;
    });
  });
}

function chatGroupsContainEvent(
  groups: readonly ChatEventGroup[],
  eventId: string | undefined,
): boolean {
  return groups.some((group) => {
    return group.events.some((event) => {
      return event.id === eventId;
    });
  });
}

function ChatThreadScrollCommitMarker({
  thread,
  renderedGroups,
}: {
  thread: ChatPanelSignals;
  renderedGroups: ChatEventGroup[] | undefined;
}) {
  const readyScrollRequestLoadable = useLoadable(
    thread.readyScrollAfterRenderRequest$,
  );
  const commitScroll = useSet(thread.scrollCommitOnRef$);
  if (
    renderedGroups === undefined ||
    readyScrollRequestLoadable.state !== "hasData" ||
    readyScrollRequestLoadable.data === null
  ) {
    return null;
  }

  const readyScrollRequest = readyScrollRequestLoadable.data;
  if (
    !equalArrays(
      readyScrollRequest.renderedEventKeys,
      renderedChatEventKeys(renderedGroups),
    )
  ) {
    return null;
  }

  const { activeGroups, queuedGroups } =
    splitQueuedEventsForThinkingIndicator(renderedGroups);
  const { request } = readyScrollRequest;
  const targetEventId = request.position?.targetEventId;
  const activeTargetRendered = chatGroupsContainEvent(
    activeGroups,
    targetEventId,
  );
  const targetMovedToQueue = chatGroupsContainEvent(
    queuedGroups,
    targetEventId,
  );
  const activeEventsRendered = activeGroups.some((group) => {
    return group.events.length > 0;
  });
  if (
    !activeEventsRendered ||
    (request.position !== null && !activeTargetRendered && !targetMovedToQueue)
  ) {
    return null;
  }

  const commitToTail = request.position === null || targetMovedToQueue;
  return (
    <span
      key={request.revision}
      ref={commitScroll}
      data-chat-scroll-commit-revision={request.revision}
      data-chat-scroll-commit-to-tail={commitToTail ? "" : undefined}
      aria-hidden
      className="hidden"
    />
  );
}

function assistantGroupIdForRunWorkIndicator(
  groups: readonly ChatEventGroup[],
  runWorkFolding: RunWorkFolding | null,
): string | null {
  const anchorEventId = runWorkFolding?.statusTail?.anchorEventId;
  if (anchorEventId === undefined) {
    return null;
  }
  return (
    groups.find((group) => {
      return group.events.some((event) => {
        return event.id === anchorEventId;
      });
    })?.beginEventId ?? null
  );
}

function ChatThreadRenderedEventGroups({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const resolvedRenderedGroups = useLastResolved(
    thread.visibleRenderedChatGroups$,
    { equalityFn: equalArrays },
  );
  const renderedGroups = resolvedRenderedGroups ?? [];
  const { activeGroups: renderedActiveGroups } =
    splitQueuedEventsForThinkingIndicator(renderedGroups);
  const modelChanges = modelChangesByEventId(renderedActiveGroups);
  const scrollTargetEventId =
    useGet(thread.threadScrollPosition$)?.targetEventId ?? null;
  const runWorkFolding = buildRunWorkFolding(
    renderedActiveGroups,
    new Set(modelChanges.keys()),
  );
  const runWorkExpandedKeys = useGet(runWorkExpandedKeys$);
  const effectiveRunWorkExpandedKeys = runWorkExpandedKeysForScrollTarget(
    runWorkFolding,
    runWorkExpandedKeys,
    scrollTargetEventId,
  );
  const toggleRunWorkExpanded = useSet(toggleRunWorkExpanded$);
  const visibleGroups = runWorkFolding?.visibleGroups ?? renderedActiveGroups;
  const resolvedThinkingIndicatorMode =
    useLastResolved(thread.thinkingIndicatorMode$) ?? null;
  const thinkingIndicatorMode = runWorkFolding?.statusTail?.events.length
    ? null
    : resolvedThinkingIndicatorMode;
  const runIndicatorAssistantGroupId = assistantGroupIdForRunWorkIndicator(
    visibleGroups,
    runWorkFolding,
  );

  return withChatScrollLayout(
    <>
      <ChatThreadEventGroups
        thread={thread}
        groups={visibleGroups}
        modelChanges={modelChanges}
        runWorkFolding={runWorkFolding}
        runWorkExpandedKeys={effectiveRunWorkExpandedKeys}
        onToggleRunWork={toggleRunWorkExpanded}
        thinkingIndicatorMode={thinkingIndicatorMode}
        runIndicatorAssistantGroupId={runIndicatorAssistantGroupId}
      />
      <ChatThreadScrollCommitMarker
        thread={thread}
        renderedGroups={resolvedRenderedGroups}
      />
      <ChatThreadThinkingIndicator
        thread={thread}
        mode={
          runIndicatorAssistantGroupId === null ? thinkingIndicatorMode : null
        }
      />
    </>,
  );
}

function ChatThreadSessionError({ thread }: { thread: ChatPanelSignals }) {
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  if (!sessionError) {
    return null;
  }
  return (
    <div className="flex-1 flex items-center justify-center py-16">
      <div className="flex items-center gap-2 text-destructive">
        <AlertCircle size={16} />
        <p className="text-sm">{sessionError}</p>
      </div>
    </div>
  );
}

function ChatThreadEmptyState({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const initialEventsReady = useGet(thread.initialEventsReady$);
  const hasEvents = useLastResolved(thread.hasEvents$);
  if (!initialEventsReady || hasEvents !== false) {
    return null;
  }
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
      <img
        src={emptyChatImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="h-24 w-24 object-contain opacity-80"
      />
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.thread.empty;
        })}
      </p>
    </div>
  );
}

function ChatThreadEventsMain({ thread }: { thread: ChatPanelSignals }) {
  const initialEventsReady = useGet(thread.initialEventsReady$);
  const renderedGroupsReady = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const showTranscript =
    renderedGroupsReady.state === "hasError" ||
    (initialEventsReady &&
      renderedGroupsReady.state === "hasData" &&
      renderedGroupsReady.data);
  const scrollContentOnRef = useSet(thread.scrollContentOnRef$);

  return withChatScrollLayout(
    <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
      <div
        ref={scrollContentOnRef}
        data-message-container
        className={cn(
          CHAT_THREAD_MESSAGE_LIST_CLASS,
          // Preserve the mounted layout for scroll restoration while loading.
          !showTranscript && "invisible",
        )}
      >
        <ChatThreadSessionError thread={thread} />
        <ChatThreadEmptyState thread={thread} />
        <ChatThreadRenderedEventGroups thread={thread} />
        <ChatThreadNextRunModelNotice thread={thread} />
      </div>
    </main>,
  );
}

function ChatThreadThinkingIndicator({
  thread,
  mode,
}: {
  thread: ChatPanelSignals;
  mode: ThinkingIndicatorMode;
}) {
  const sharingPhase = useGet(thread.sharing.phase$);
  return sharingPhase === "idle" ? (
    <ThinkingIndicator thread={thread} mode={mode} />
  ) : null;
}

function ChatThreadNextRunModelNotice({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const selectedSelection = useLastResolved(
    thread.composer.model.modelSelection$,
  );
  const runningSelection = useLastResolved(
    thread.composer.model.runningModelSelection$,
  );
  if (
    selectedSelection === undefined ||
    selectedSelection === null ||
    runningSelection === undefined ||
    runningSelection === null
  ) {
    return withChatScrollLayout(null);
  }

  const selectedRunSelection: ChatRunModelSelection = {
    selectedModel: selectedSelection.selectedModel,
    ...(selectedSelection.codexServiceTier === "fast"
      ? { serviceTier: "priority" as const }
      : {}),
  };
  let label: string;
  if (selectedRunSelection.selectedModel !== runningSelection.selectedModel) {
    label = t(
      ($) => {
        return $.chat.run.selectedModelAppliesAfterCurrentRun;
      },
      { model: runModelDisplayName(t, selectedRunSelection) },
    );
  } else if (
    fastModeEnabled(selectedRunSelection) !== fastModeEnabled(runningSelection)
  ) {
    label = fastModeEnabled(selectedRunSelection)
      ? t(($) => {
          return $.chat.run.fastModeWillBeOn;
        })
      : t(($) => {
          return $.chat.run.fastModeWillBeOff;
        });
  } else {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(<RunSectionDividerRow label={label} announce />);
}

// An assistant group whose events are all bookkeeping — a run's terminal event,
// usage — puts nothing on screen, so it must not break a stack of user
// messages that visually sit right on top of each other.
function groupRendersContent(
  group: ChatEventGroup,
  runWorkSection: RunWorkSection | null,
): boolean {
  if (runWorkSection !== null) {
    return true;
  }
  if (group.role === "user") {
    return group.events.some(rendersUserBubble);
  }
  return group.events.some(isRenderableAssistantEvent);
}

// A user group can be on screen for its fold alone, with every message in it
// rendering as a card or as nothing, and there is no bubble to stack against.
function groupHasUserBubble(group: ChatEventGroup): boolean {
  return group.events.some(rendersUserBubble);
}

function createRunWorkSectionControl(
  section: RunWorkSection | null,
  expandedKeys: ReadonlySet<string>,
  onToggle: (key: string) => void,
): RunWorkSectionControl | undefined {
  if (section === null) {
    return undefined;
  }
  const { key, ...control } = section;
  const expanded = expandedKeys.has(key);
  return {
    ...control,
    expanded,
    onToggle: () => {
      if (!expanded) {
        captureChatWorkHistoryExpanded({
          workStatus: section.endTime === undefined ? "active" : "completed",
        });
      }
      onToggle(key);
    },
  };
}

function ChatThreadEventGroups({
  thread,
  groups,
  modelChanges,
  runWorkFolding,
  runWorkExpandedKeys,
  onToggleRunWork,
  thinkingIndicatorMode,
  runIndicatorAssistantGroupId,
}: {
  thread: ChatPanelSignals;
  groups: readonly ChatEventGroup[];
  modelChanges: ReadonlyMap<string, RunModelChange>;
  runWorkFolding: RunWorkFolding | null;
  runWorkExpandedKeys: ReadonlySet<string>;
  onToggleRunWork: (key: string) => void;
  thinkingIndicatorMode: ThinkingIndicatorMode;
  runIndicatorAssistantGroupId: string | null;
}) {
  // A run that ends re-forms the groups around it, so the messages the user
  // sent back to back can land in separate groups with nothing rendered in
  // between. Tracking the last group that actually put something on screen
  // keeps the stack from springing open the moment a run finishes.
  let previousVisibleGroup: ChatEventGroup | undefined;

  return (
    <>
      {groups.map((group) => {
        const runWorkSection = runWorkSectionForGroup(runWorkFolding, group);
        const stackFirstOnPrevious =
          previousVisibleGroup !== undefined &&
          previousVisibleGroup.role === "user" &&
          groupHasUserBubble(previousVisibleGroup);
        if (groupRendersContent(group, runWorkSection)) {
          previousVisibleGroup = group;
        }
        const runIndicatorMode =
          group.beginEventId === runIndicatorAssistantGroupId &&
          thinkingIndicatorMode !== null
            ? thinkingIndicatorMode
            : undefined;
        return (
          <div
            key={runWorkSection?.key ?? group.beginEventId}
            className="contents"
          >
            <SelectablePagedGroupRow
              group={group}
              thread={thread}
              modelChanges={modelChanges}
              stackFirstOnPrevious={stackFirstOnPrevious}
              runWorkSection={createRunWorkSectionControl(
                runWorkSection,
                runWorkExpandedKeys,
                onToggleRunWork,
              )}
              runIndicatorMode={runIndicatorMode}
              statusTailEvents={runWorkFolding?.statusTail?.events.filter(
                (event) => {
                  return group.events.includes(event);
                },
              )}
            />
          </div>
        );
      })}
    </>
  );
}

function firstRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  return events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function formatCompactDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return i18n.t(
      ($) => {
        return $.chat.run.duration.secondsShort;
      },
      {
        count: totalSeconds,
      },
    );
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return i18n.t(
      ($) => {
        return $.chat.run.duration.minutesShort;
      },
      {
        count: totalMinutes,
      },
    );
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  const hours = i18n.t(
    ($) => {
      return $.chat.run.duration.hoursShort;
    },
    { count: totalHours },
  );
  if (remainingMinutes === 0) {
    return hours;
  }
  const minutes = i18n.t(
    ($) => {
      return $.chat.run.duration.minutesShort;
    },
    { count: remainingMinutes },
  );
  return `${hours} ${minutes}`;
}

const RUN_SECTION_LABEL_CLASS =
  "min-w-0 max-w-full shrink-0 break-words font-serif text-sm leading-5 italic text-muted-foreground/50";
const RUN_SECTION_ROW_CLASS =
  "@[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

function RunSectionDivider({
  label,
  labelPosition = "left",
  className,
}: {
  label: string;
  labelPosition?: "left" | "right";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-5 items-center gap-2",
        CHAT_THREAD_RESPONSE_LINE_CLASS,
        labelPosition === "right" && "flex-row-reverse",
        className,
      )}
    >
      <p
        className={cn(
          RUN_SECTION_LABEL_CLASS,
          labelPosition === "right" && "text-right",
        )}
      >
        {label}
      </p>
      <div role="separator" className="h-px flex-1 bg-divider/40" />
    </div>
  );
}

function RunSectionDividerRow({
  label,
  announce = false,
}: {
  label: string;
  announce?: boolean;
}) {
  return (
    <div
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      className={RUN_SECTION_ROW_CLASS}
    >
      <div className="hidden @[900px]:block" />
      <div className="min-w-0">
        <RunSectionDivider label={label} labelPosition="right" />
      </div>
    </div>
  );
}

function ModelChangeDividerRow({ change }: { change: RunModelChange }) {
  const { t } = useTranslation();
  return <RunSectionDividerRow label={modelChangeLabel(t, change)} />;
}

function modelChangeLabel(
  t: TFunction<"common">,
  change: RunModelChange,
): string {
  return change.kind === "model"
    ? t(
        ($) => {
          return $.chat.run.modelChangedTo;
        },
        { model: runModelDisplayName(t, change.selection) },
      )
    : change.enabled
      ? t(($) => {
          return $.chat.run.fastModeOn;
        })
      : t(($) => {
          return $.chat.run.fastModeOff;
        });
}

function FoldedModelChangeDivider({ change }: { change: RunModelChange }) {
  const { t } = useTranslation();
  return (
    <RunSectionDivider
      label={modelChangeLabel(t, change)}
      labelPosition="right"
    />
  );
}

function RunWorkSectionRow({
  startTime,
  endTime,
  stepCount,
  collapsible,
  expanded,
  onToggle,
}: {
  startTime: number;
  endTime?: number;
  stepCount: number;
  collapsible: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const content = (
    <>
      <span className={CHAT_THREAD_RESPONSE_LEADING_ICON_CLASS}>
        <Hourglass aria-hidden />
      </span>
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1",
          CHAT_THREAD_RESPONSE_SUPPORTING_TEXT_CLASS,
        )}
      >
        <ElapsedTime startTime={startTime} endTime={endTime}>
          {(elapsedTime) => {
            const duration = formatCompactDuration(
              Math.max(1, Math.round(elapsedTime / 1000)),
            );
            return endTime === undefined
              ? t(
                  ($) => {
                    return $.chat.run.workingFor;
                  },
                  { duration },
                )
              : t(
                  ($) => {
                    return $.chat.run.workedFor;
                  },
                  { duration },
                );
          }}
        </ElapsedTime>
        {stepCount > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>
              {t(
                ($) => {
                  return $.activity.events.steps;
                },
                {
                  count: stepCount,
                  formattedCount: formatAppNumber(stepCount),
                },
              )}
            </span>
          </>
        ) : null}
      </span>
      {collapsible ? (
        <ChevronRight
          aria-hidden
          size={16}
          className={cn(
            "ml-1 shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
      ) : null}
    </>
  );
  const className = cn(
    "inline-flex min-h-9 w-fit items-center gap-0 rounded-lg pr-1 font-normal text-muted-foreground",
    CHAT_THREAD_RESPONSE_LINE_CLASS,
  );
  return (
    <div
      data-chat-run-work
      data-chat-selection-actions-disabled
      className="flex min-h-9 items-center"
    >
      {collapsible ? (
        <Button
          type="button"
          variant="quiet"
          size="xs"
          aria-expanded={expanded}
          aria-label={t(($) => {
            return expanded
              ? $.chat.run.collapseWorkHistory
              : $.chat.run.expandWorkHistory;
          })}
          onClick={onToggle}
          data-chat-run-work-range
          // The hover surface needs an inset on the side its glyph starts on,
          // otherwise the hourglass sits flush against the left edge while the
          // chevron keeps `pr-1`. The negative margin spends that inset on the
          // overhang, so the glyph still starts on the response column.
          className={cn(className, "h-auto p-0 pl-1.5 pr-1 -ml-1.5")}
        >
          {content}
        </Button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </div>
  );
}

function isRejectedGoalUserMessage(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "input.rejected" &&
    eventNonContentPart(event)?.type === "goal"
  );
}

function isGoalUserMessage(
  event: EnrichedChatEvent,
): event is EnrichedChatEvent & ChatInputEvent {
  return (
    isInputChatEvent(event) &&
    !isRejectedGoalUserMessage(event) &&
    eventNonContentPart(event)?.type === "goal"
  );
}

function ChatThreadSkeletonOverlay({ thread }: { thread: ChatPanelSignals }) {
  const initialEventsReady = useGet(thread.initialEventsReady$);
  if (initialEventsReady) {
    return null;
  }

  // The transcript hides its content while loading. Keep this placeholder
  // transparent so the workspace's pane-sized gradient remains continuous.
  return (
    <div
      data-chat-skeleton
      className="absolute inset-0 z-10 overflow-hidden pointer-events-none"
    >
      <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
        <div
          className={cn(
            "opacity-0 animate-chat-skeleton-reveal",
            CHAT_THREAD_MESSAGE_LIST_CLASS,
          )}
        >
          <ChatSkeleton />
        </div>
      </main>
    </div>
  );
}

function ChatThreadEventsPane({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const scrollContainerOnRef = useSet(thread.scrollContainerOnRef$);
  const loadMoreRenderedChatGroups = useSet(thread.loadMoreRenderedChatGroups$);
  const pageSignal = useGet(pageSignal$);
  const standalonePwa = isStandalonePwa();
  const phase = useGet(thread.sharing.phase$);
  const selectRange = useSet(thread.sharing.selectRange$);
  const selectAll = useSet(thread.sharing.selectAll$);
  const clearSelection = useSet(thread.sharing.clear$);

  const handleScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (
      event.currentTarget.scrollTop > CHAT_RENDER_LOAD_MORE_TOP_THRESHOLD_PX
    ) {
      return;
    }
    detach(loadMoreRenderedChatGroups(pageSignal), Reason.DomCallback);
  };

  return (
    <ScrollArea.Root className="relative flex-1 min-h-0 isolate">
      <ChatShareMarqueeViewport
        phase={phase}
        onViewportRef={scrollContainerOnRef}
        onScroll={handleScroll}
        selectRange={selectRange}
        selectAll={selectAll}
        clearSelection={clearSelection}
        tooLargeLabel={t(($) => {
          return $.chat.sharing.tooLarge;
        })}
        viewportClassName={cn(
          "absolute inset-0 focus:outline-none [overflow-anchor:none]",
          SCROLL_FADE_Y_END,
          standalonePwa && "overscroll-contain",
        )}
      >
        <ScrollArea.Content>
          <ChatThreadEventsMain thread={thread} />
        </ScrollArea.Content>
      </ChatShareMarqueeViewport>
      <ScrollBar data-testid="chat-message-scrollbar" />
      <ChatThreadSkeletonOverlay thread={thread} />
      <ScrollToBottomButton thread={thread} />
      <ChatConversationLocator thread={thread} />
    </ScrollArea.Root>
  );
}

function ChatThreadNotFound() {
  const { t } = useTranslation();
  return (
    <main
      data-chat-thread-not-found
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-16 text-center"
    >
      <h1 className="text-lg font-semibold text-foreground">
        {t(($) => {
          return $.chat.thread.notFound;
        })}
      </h1>
    </main>
  );
}

function ChatThreadContent({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const threadMeta = useGet(thread.threadMeta$);
  const sharingPhase = useGet(thread.sharing.phase$);
  if (!threadMeta) {
    return <ChatThreadNotFound />;
  }

  return (
    <>
      <ChatThreadHeader thread={thread} />

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-w-0 flex-col">
          <ChatThreadEventsPane thread={thread} />
          <ChatThreadBottomBar thread={thread} />
        </div>
      </div>

      {sharingPhase === "idle" ? (
        <ChatFeedbackSelection
          feedback={thread.feedback}
          sourceAgentId={threadMeta.agentId}
          sourceThreadTitle={
            threadMeta.title ??
            t(($) => {
              return $.chat.newChat;
            })
          }
        />
      ) : null}
    </>
  );
}

function SelectAllSharedMessagesButton({
  thread,
  disabled,
}: {
  thread: ChatPanelSignals;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const selectAll = useSet(thread.sharing.selectAll$);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => {
        if (selectAll() === "too-large") {
          toast.error(
            t(($) => {
              return $.chat.sharing.tooLarge;
            }),
          );
        }
      }}
    >
      {t(($) => {
        return $.chat.sharing.selectAll;
      })}
    </Button>
  );
}

function CloseSharedThreadButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const close = useSet(thread.sharing.close$);
  const pageSignal = useGet(pageSignal$);
  return (
    <Button
      variant="outline"
      onClick={() => {
        detach(
          close(pageSignal),
          Reason.DomCallback,
          "close shared thread selection",
        );
      }}
    >
      {t(($) => {
        return $.chat.sharing.close;
      })}
    </Button>
  );
}

function ChatThreadBottomBar({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const sharedThreadId = useGet(thread.sharing.createdSharedThreadId$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createSharedThread] = useLoadableSet(
    thread.sharing.create$,
  );
  if (phase === "idle") {
    return withChatScrollLayout(<ChatThreadComposer thread={thread} />);
  }

  const creating = createLoadable.state === "loading";
  const shareUrl = sharedThreadId
    ? `${window.location.origin}/share/threads/${sharedThreadId}`
    : null;
  return withChatScrollLayout(
    <footer className="relative shrink-0 border-t border-border/60 px-4 py-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-2">
        {shareUrl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              readOnly
              value={shareUrl}
              aria-label={t(($) => {
                return $.chat.sharing.shareLink;
              })}
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button
                onClick={() => {
                  detach(
                    (async () => {
                      const copied = await writeToClipboard(shareUrl);
                      if (copied) {
                        toast.success(
                          t(($) => {
                            return $.chat.sharing.linkCopied;
                          }),
                        );
                        return;
                      }
                      toast.error(
                        t(($) => {
                          return $.chat.sharing.copyFailed;
                        }),
                      );
                    })(),
                    Reason.DomCallback,
                    "copy shared thread link",
                  );
                }}
              >
                <Copy size={16} />
                {t(($) => {
                  return $.chat.sharing.copyLink;
                })}
              </Button>
              <CloseSharedThreadButton thread={thread} />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t(
                  ($) => {
                    return $.chat.sharing.selectedCount;
                  },
                  { count: selectedCount },
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(($) => {
                  return $.chat.sharing.publicDescription;
                })}
              </p>
              {createLoadable.state === "hasError" ? (
                <p className="mt-0.5 text-xs text-destructive">
                  {t(($) => {
                    return $.chat.sharing.createFailed;
                  })}
                </p>
              ) : null}
            </div>
            <Button
              disabled={selectedCount === 0 || creating}
              onClick={() => {
                detach(
                  createSharedThread(pageSignal),
                  Reason.DomCallback,
                  "create shared thread",
                );
              }}
            >
              {creating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Share2 size={16} />
              )}
              {t(($) => {
                return $.chat.sharing.create;
              })}
            </Button>
          </div>
        )}
      </div>
    </footer>,
  );
}

function ScrollToBottomButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const awayFromBottom = useGet(thread.awayFromBottom$);
  const scrollToBottom = useSet(thread.scrollToBottom$);
  const pageSignal = useGet(pageSignal$);
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  const skeletonVisible = renderedGroupsReadyLoadable.state === "loading";

  if (!awayFromBottom || skeletonVisible || sessionError) {
    return null;
  }

  return (
    <IconTooltipButton
      type="button"
      data-scroll-to-bottom
      aria-label={t(($) => {
        return $.chat.thread.scrollToBottom;
      })}
      onClick={() => {
        detach(scrollToBottom(pageSignal), Reason.DomCallback);
      }}
      className="absolute bottom-4 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-background-hover hover:text-foreground"
    >
      <ArrowDown size={18} />
    </IconTooltipButton>
  );
}

function RecommendedFollowupIcon({
  followup,
}: {
  followup: RecommendedFollowup;
}) {
  if (followup.kind !== "generate") {
    return <MessageCircle size={16} />;
  }

  if (followup.generationType === "image") {
    return <Image size={16} />;
  }
  if (followup.generationType === "video") {
    return <Video size={16} />;
  }
  if (followup.generationType === "presentation") {
    return <ChartLine size={16} />;
  }
  if (followup.generationType === "website") {
    return <LinkIcon size={16} />;
  }
  return <Package size={16} />;
}

function recommendedFollowupShownKey(
  source: RecommendedFollowupSource,
): string {
  return [
    source.eventId,
    source.followups.length,
    ...source.followups.map((followup) => {
      return `${followup.kind}:${followup.generationType ?? ""}`;
    }),
  ].join("|");
}

function reportRecommendedFollowupsShown(
  element: HTMLDivElement | null,
  source: RecommendedFollowupSource,
): void {
  if (!element) {
    return;
  }

  const shownKey = recommendedFollowupShownKey(source);
  if (element.dataset.followupsShownKey === shownKey) {
    return;
  }
  element.dataset.followupsShownKey = shownKey;

  captureRecommendedFollowupsShown({
    messageId: source.eventId,
    followups: source.followups,
  });
}

function RecommendedFollowupList({
  thread,
  source,
}: {
  thread: ChatPanelSignals;
  source: RecommendedFollowupSource;
}) {
  const { t } = useTranslation();
  // Quick replies only on actual mobile/touch text-entry devices, mirroring the
  // composer auto-focus heuristic. A desktop window dragged narrow must still
  // render the flat list, so container width is not the deciding factor.
  const showFollowupCards = isMobileTextInputDevice();
  const selectOrAppendComposerText = useSet(
    thread.composer.editor.selectOrAppendText$,
  );
  const handleRecommendedFollowupsRef = (element: HTMLDivElement | null) => {
    reportRecommendedFollowupsShown(element, source);
  };

  const handleSelect = (
    followup: RecommendedFollowup,
    followupIndex: number,
  ) => {
    captureRecommendedFollowupSelected({
      messageId: source.eventId,
      followupIndex,
      followupCount: source.followups.length,
      followup,
    });
    selectOrAppendComposerText(followup.prompt);
  };

  return (
    <div
      ref={handleRecommendedFollowupsRef}
      role="group"
      aria-label={t(($) => {
        return $.chat.run.keepGoing;
      })}
      // The layout is decided by the device, not by width, so it is not
      // observable through a media query. Tests and e2e read this instead of
      // the styling classes.
      data-followup-layout={showFollowupCards ? "quick-reply-rail" : "rows"}
      className={cn(
        // The flat list pulls out by the row buttons' own px-2 so its text
        // aligns with the message column. The rail carries a deeper inner
        // offset of its own, so it stays flush with the column and the
        // composer instead of pulling out to meet them.
        showFollowupCards
          ? "flex items-stretch gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "-mx-2",
      )}
    >
      {source.followups.map((followup, followupIndex) => {
        return (
          <button
            key={followup.prompt}
            type="button"
            title={followup.prompt}
            className={cn(
              "group flex text-left transition-colors",
              // A quick reply sizes to its own text, so a short suggestion
              // stays small and more than one fits on screen. The rail equalises
              // their heights, which is why the contents align to the top: a
              // one-line reply has to start on the same line as its two-line
              // neighbour rather than float in the middle of the taller box.
              //
              // `active:` rather than `hover:` carries the press: Tailwind gates
              // `hover:` behind `(hover: hover)`, which is exactly the devices
              // this branch never runs on. Rest already sits on the hover layer,
              // so hover and press each take the next step up the ladder.
              showFollowupCards
                ? "max-w-[min(17rem,72%)] shrink-0 items-start gap-1.5 rounded-surface bg-state-hover px-4 py-3 hover:bg-state-selected active:bg-state-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                : "min-h-8 w-full items-center gap-0 rounded-lg px-2 py-1 hover:bg-state-hover",
            )}
            onClick={() => {
              handleSelect(followup, followupIndex);
            }}
          >
            <span
              className={cn(
                "text-muted-foreground transition-colors group-hover:text-foreground",
                // A quick reply drops the 28px response rail, but keeps the
                // icon for `generate`: mispicking one there costs a real
                // generation rather than another message. `h-6` is one line
                // box, so the glyph centres on the first line of a wrapped
                // suggestion instead of on the whole text block.
                showFollowupCards
                  ? "inline-flex h-6 shrink-0 items-center justify-center"
                  : CHAT_THREAD_RESPONSE_LEADING_ICON_CLASS,
                showFollowupCards && followup.kind !== "generate" && "hidden",
              )}
            >
              <RecommendedFollowupIcon followup={followup} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words group-hover:text-foreground",
                CHAT_THREAD_RESPONSE_SUPPORTING_TEXT_CLASS,
                // Prompt length is unbounded server-side, so a runaway
                // suggestion is clamped rather than allowed to grow the rail.
                // Two lines is also the rail's ceiling: every card matches the
                // tallest one, so this bounds the whole block.
                showFollowupCards && "line-clamp-2",
              )}
            >
              {followup.prompt}
            </span>
            <ArrowUpRight
              aria-hidden
              size={16}
              className={cn(
                "pointer-events-none ml-3 shrink-0 text-muted-foreground/60 opacity-0 transition-colors group-hover:text-foreground group-hover:opacity-100",
                showFollowupCards && "hidden",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function splitQueuedEventsForThinkingIndicator(groups: ChatEventGroup[]): {
  activeGroups: ChatEventGroup[];
  queuedGroups: ChatEventGroup[];
} {
  const activeGroups: ChatEventGroup[] = [];
  const queuedEvents: EnrichedChatEvent[] = [];

  for (const group of groups) {
    if (group.role !== "user") {
      activeGroups.push(group);
      continue;
    }

    const activeEvents: EnrichedChatEvent[] = [];
    for (const event of group.events) {
      if (event.isQueued) {
        queuedEvents.push(event);
      } else {
        activeEvents.push(event);
      }
    }

    if (activeEvents.length > 0) {
      activeGroups.push({
        ...group,
        beginEventId: activeEvents[0]!.id,
        events: activeEvents,
      });
    }
  }

  return {
    activeGroups,
    queuedGroups:
      queuedEvents.length > 0
        ? [
            {
              beginEventId: queuedEvents[0]!.id,
              role: "user",
              events: queuedEvents,
            },
          ]
        : [],
  };
}

function ChatThreadComposer({ thread }: { thread: ChatPanelSignals }) {
  const composerLayoutRef = useSet(thread.composerLayoutOnRef$);
  const standalonePwa = isStandalonePwa();

  // The pane's canvas runs behind the composer the way it runs behind the
  // header. A fill of its own can only match a flat canvas, and a gradient
  // palette's is not one, so the footer stays transparent and the transcript's
  // own edge fade handles the boundary above it.
  return (
    <footer
      data-chat-composer
      ref={composerLayoutRef}
      className="relative shrink-0 pb-safe-or-2"
    >
      {/* `overflow-y-auto` clips at this element's padding box. The composer's
          focus veil is offset down and blurred well past the gap the footer
          leaves, so it is still painting at that boundary and gets sliced off in
          a hard line across the card's full width. Pad out far enough for
          `--okou-composer-focus-veil` to finish and take the same amount back
          with a negative margin, so the veil fades out instead of ending in a
          seam while the footer keeps its height. */}
      <div
        className={cn(
          "-mb-8 overflow-y-auto [scrollbar-gutter:stable] pb-10 pl-4 pr-4 pt-3 sm:pl-6 sm:pr-6",
          standalonePwa && "overscroll-contain",
        )}
      >
        <div className="mx-auto max-w-[900px]">
          <ChatComposer signals={thread.composer} />
          <PersonalClaudeCodeDeviceAuthDialog />
          <PersonalCodexDeviceAuthDialog />
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder while session loads
// ---------------------------------------------------------------------------

function ChatEventSkeletonPair({ compact = false }: { compact?: boolean }) {
  return (
    <>
      {/* User bubble skeleton */}
      <div
        data-chat-event-skeleton="user"
        aria-hidden
        className="flex justify-end"
      >
        <Skeleton
          className={cn("h-10 rounded-xl", compact ? "w-[45%]" : "w-[60%]")}
        />
      </div>
      {/* Assistant bubble skeleton */}
      <div
        data-chat-event-skeleton="assistant"
        aria-hidden
        className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
      >
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton
            className={cn("h-4 rounded-lg", compact ? "w-[85%]" : "w-[90%]")}
          />
          <Skeleton
            className={cn("h-4 rounded-lg", compact ? "w-[60%]" : "w-[75%]")}
          />
          {!compact && <Skeleton className="h-4 w-[40%] rounded-lg" />}
        </div>
      </div>
    </>
  );
}

function ChatSkeleton() {
  return (
    <>
      <ChatEventSkeletonPair />
      <ChatEventSkeletonPair compact />
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — shown the entire time a run is active
// ---------------------------------------------------------------------------

interface ServerThinkingLabel {
  readonly id: string;
  readonly messages: ThinkingSummaries["messages"];
}

function ShimmerText({
  ariaLabel,
  children,
  className,
}: {
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      className={cn(
        // The bright band lives in the label's own background gradient, so the
        // only thing that moves is the gradient's paint origin; nothing here
        // moves a box that holds glyphs. `contain: paint` keeps the per-frame
        // repaint inside the label. The `-webkit-` clip stays beside
        // `bg-clip-text` because Tailwind emits only the unprefixed property.
        // Chromium treats the two as aliases, so dropping the prefixed one is
        // a browser-support decision rather than a styling change.
        "h-auto min-w-0 flex-1 animate-shimmer truncate bg-shimmer-text bg-clip-text [background-size:200%_100%] [-webkit-background-clip:text] [-webkit-text-fill-color:transparent] [contain:paint]",
        CHAT_THREAD_RESPONSE_SUPPORTING_TEXT_CLASS,
        className,
      )}
      aria-label={ariaLabel}
    >
      {children}
    </p>
  );
}

function ThinkingLabel({
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
}: {
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  const { t } = useTranslation();
  const openQueueDrawer = useSet(openQueueDrawer$);

  if (isQueued) {
    const waitingIn = t(($) => {
      return $.chat.run.waitingIn;
    });
    const queueEllipsis = t(($) => {
      return $.chat.run.queueEllipsis;
    });
    return (
      <ShimmerText>
        {waitingIn}{" "}
        <button
          type="button"
          onClick={() => {
            openQueueDrawer();
          }}
          className="cursor-pointer underline underline-offset-2"
        >
          {queueEllipsis}
        </button>
      </ShimmerText>
    );
  }

  if (serverThinkingLabel) {
    return (
      <ShimmerText>
        <ThinkingMessages
          key={serverThinkingLabel.id}
          messages={serverThinkingLabel.messages}
          fallback={thinkingLabel}
        />
      </ShimmerText>
    );
  }

  return <ShimmerText>{thinkingLabel}</ShimmerText>;
}

function ThinkingLoader() {
  return (
    <span
      aria-hidden
      data-thinking-loader="spinner"
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      <img
        src={thinkingSpinnerImg}
        alt=""
        // The 48px asset has a 4px inset. A 17px canvas makes its visible
        // mark match the perceived size of the 16px line icons.
        className="size-[17px] max-w-none shrink-0 animate-spin [animation-duration:1.4s] will-change-transform motion-reduce:animate-none"
      />
    </span>
  );
}

function InlineThinkingRow({
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
}: {
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-0 h-5",
        CHAT_THREAD_RESPONSE_LINE_CLASS,
      )}
    >
      <span className={CHAT_THREAD_RESPONSE_LEADING_ICON_CLASS}>
        <ThinkingLoader />
      </span>
      <ThinkingLabel
        isQueued={isQueued}
        thinkingLabel={thinkingLabel}
        serverThinkingLabel={serverThinkingLabel}
      />
    </div>
  );
}

function FinishedRunRow({
  thread,
  source,
}: {
  thread: ChatPanelSignals;
  source: RecommendedFollowupSource | null;
}) {
  const { t } = useTranslation();
  const donePhrase =
    useLastResolved(thread.donePhrase$) ??
    t(($) => {
      return $.chat.run.done.default;
    });
  const runFinishedAt = useLastResolved(thread.latestRunFinishCreatedAt$);
  const label =
    source && runFinishedAt
      ? t(
          ($) => {
            return $.chat.run.keepGoingAt;
          },
          {
            timestamp: formatChatTimestamp(runFinishedAt),
          },
        )
      : source
        ? t(($) => {
            return $.chat.run.keepGoing;
          })
        : donePhrase;

  return (
    <div className={CHAT_THREAD_RESPONSE_COMPACT_STACK_CLASS}>
      <RunSectionDivider
        label={label}
        className={CHAT_THREAD_RESPONSE_FLUSH_CLASS}
      />
      {source ? (
        <RecommendedFollowupList thread={thread} source={source} />
      ) : null}
    </div>
  );
}

function WaitingForAssistantResponse({
  thread,
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
  inAssistantGroup,
}: {
  thread: ChatPanelSignals;
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
  inAssistantGroup: boolean;
}) {
  const thinkingIndicatorProps = isQueued
    ? {}
    : { "data-thinking-indicator": true };

  if (inAssistantGroup) {
    return (
      <div
        {...thinkingIndicatorProps}
        data-role="assistant-thinking"
        className="animate-thinking-in min-w-0"
      >
        <InlineThinkingRow
          isQueued={isQueued}
          thinkingLabel={thinkingLabel}
          serverThinkingLabel={serverThinkingLabel}
        />
      </div>
    );
  }

  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant"
      className="animate-thinking-in flex flex-col gap-2"
    >
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS}>
        <AssistantBubbleAvatar thread={thread} />
        <div
          className={cn(
            "relative flex min-w-0 flex-col gap-2",
            CHAT_THREAD_ASSISTANT_RESPONSE_COLUMN_CLASS,
          )}
        >
          <ChatAssistantMessageBody>
            <InlineThinkingRow
              isQueued={isQueued}
              thinkingLabel={thinkingLabel}
              serverThinkingLabel={serverThinkingLabel}
            />
          </ChatAssistantMessageBody>
        </div>
      </div>
    </div>
  );
}

function AssistantThinkingStatusRow({
  active,
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
  thread,
  recommendedFollowupSource,
  inAssistantGroup,
}: {
  active: boolean;
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
  thread: ChatPanelSignals;
  recommendedFollowupSource: RecommendedFollowupSource | null;
  inAssistantGroup: boolean;
}) {
  const thinkingIndicatorProps =
    active && !isQueued ? { "data-thinking-indicator": true } : {};

  const content = active ? (
    <InlineThinkingRow
      isQueued={isQueued}
      thinkingLabel={thinkingLabel}
      serverThinkingLabel={serverThinkingLabel}
    />
  ) : (
    <FinishedRunRow thread={thread} source={recommendedFollowupSource} />
  );
  if (inAssistantGroup) {
    return (
      <div
        {...thinkingIndicatorProps}
        data-role="assistant-thinking"
        className="animate-thinking-in min-w-0"
      >
        {content}
      </div>
    );
  }
  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant-thinking"
      className={RUN_SECTION_ROW_CLASS}
    >
      <div className="hidden @[900px]:block" />
      <div className="min-w-0">{content}</div>
    </div>
  );
}

function runStatusIndicatorActive(mode: ThinkingIndicatorMode): boolean {
  return mode !== null && mode !== "finished";
}

function thinkingIndicatorQueued(mode: ThinkingIndicatorMode): boolean {
  return mode === "waiting-queued" || mode === "running-queued";
}

function thinkingIndicatorUsesStatusRow(mode: ThinkingIndicatorMode): boolean {
  return mode === "running" || mode === "running-queued" || mode === "finished";
}

function equalRecommendedFollowupSources(
  previous: RecommendedFollowupSource | null,
  next: RecommendedFollowupSource | null,
): boolean {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.eventId === next.eventId &&
      previous.followups === next.followups)
  );
}

function ThinkingIndicator({
  thread,
  mode,
  inAssistantGroup = false,
}: {
  thread: ChatPanelSignals;
  mode: ThinkingIndicatorMode;
  inAssistantGroup?: boolean;
}) {
  const summaries = useLastResolved(thread.thinkingSummaries$);
  const thinkingRunId = useLastResolved(thread.thinkingRunId$);
  const recommendedFollowupSource =
    useLastResolved(thread.recommendedFollowupSource$, {
      equalityFn: equalRecommendedFollowupSources,
    }) ?? null;
  const thinkingLabel = useGet(thread.thinkingPhrase$);
  const active = runStatusIndicatorActive(mode);
  const isQueued = thinkingIndicatorQueued(mode);
  const serverThinkingLabel =
    summaries && summaries.runId === thinkingRunId && active && !isQueued
      ? { id: summaries.runId, messages: summaries.messages }
      : undefined;

  if (mode === null) {
    return null;
  }

  // Active and finished states share the response line metrics.
  if (thinkingIndicatorUsesStatusRow(mode)) {
    return (
      <AssistantThinkingStatusRow
        active={active}
        isQueued={isQueued}
        thinkingLabel={thinkingLabel}
        serverThinkingLabel={serverThinkingLabel}
        thread={thread}
        recommendedFollowupSource={recommendedFollowupSource}
        inAssistantGroup={inAssistantGroup}
      />
    );
  }

  // Waiting for first assistant response — show bubble with avatar
  return (
    <WaitingForAssistantResponse
      thread={thread}
      isQueued={isQueued}
      thinkingLabel={thinkingLabel}
      serverThinkingLabel={serverThinkingLabel}
      inAssistantGroup={inAssistantGroup}
    />
  );
}

function ChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);

  if (!active) {
    return null;
  }

  return <ActiveChatConnectorActionConnectModal />;
}

function ActiveChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);
  const close = useSet(closeChatConnectorActionConnectDialog$);
  const runCallback = useSet(runChatActionCallback$);
  const pageSignal = useGet(pageSignal$);
  const customConnectors = useLastResolved(customConnectors$);

  if (!active) {
    return null;
  }

  const onSuccess = async () => {
    if (active.callbackPrompt && active.threadId) {
      await runCallback(
        {
          threadId: active.threadId,
          agentId: active.agentId,
          callbackPrompt: active.callbackPrompt,
        },
        pageSignal,
      );
    }
  };

  if (active.kind === "custom") {
    const connector = customConnectors?.find((candidate) => {
      return candidate.slug === active.connectorSlug;
    });
    const accountOptions = connector
      ? defaultCustomConnectorAccountOptions(connector)
      : null;
    return connector && accountOptions ? (
      <CustomConnectorConnectDialog
        connector={connector}
        agentId={active.agentId}
        accountOptions={accountOptions}
        onClose={close}
        onSuccess={onSuccess}
      />
    ) : null;
  }

  const accountOptions = defaultBuiltinConnectorAccountOptions(
    active.catalogItem,
  );
  if (!accountOptions) {
    return null;
  }
  const reconnectAuthMethod =
    accountOptions.account.intent === "reconnect"
      ? active.catalogItem.connection?.authMethod
      : undefined;

  return (
    <ConnectModal
      item={active.catalogItem}
      agentId={active.agentId}
      accountOptions={accountOptions}
      reconnectAuthMethod={reconnectAuthMethod}
      onClose={close}
      onSuccess={onSuccess}
    />
  );
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?|psd)$/i.test(
    filename,
  );
}

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_TOP_UP_OPTIONS = [100_000, 200_000, 300_000] as const;

function formatCreditsUsd(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  return dollars.toLocaleString(i18n.resolvedLanguage, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  });
}

function customCreditsFromForm(form: HTMLFormElement | null): number | null {
  const element = form?.elements.namedItem("customUsd");
  if (!(element instanceof HTMLInputElement)) {
    return null;
  }

  const usd = Number(element.value);
  const credits = usd * CREDITS_PER_DOLLAR;
  if (!Number.isInteger(credits) || credits < 1000 || credits > 10_000_000) {
    return null;
  }
  return credits;
}

/** Let resolved billing copy wrap to its actual height, including longer
 * translations, without leaving an unused second line under short copy. */
const BILLING_NOTICE_DESCRIPTION_CLASS =
  "text-sm leading-5 text-muted-foreground";

/** A personal usage limit can resolve to an account plus two exhausted windows.
 * Ordinary usage limits need only their actual description height. */
const USAGE_RECOVERY_DESCRIPTION_CLASS = "min-h-20 @[640px]:min-h-10";

/**
 * The billing notice's action is the other row an asynchronous read introduces:
 * it appears only once `billingStatusAsync$` and `isOrgAdmin$` resolve, and the
 * credits-available state replaces the whole body without one. Below the card's
 * 640px breakpoint the body is a column, so mounting that row late would add its
 * own height plus the container gap and resize the transcript. Every billing
 * state therefore keeps this slot, filled or empty, at the shared action height,
 * and the error card's pending state reserves the same box for its own details
 * trigger.
 */
const CHAT_NOTICE_ACTION_SLOT_CLASS = "flex min-h-8 shrink-0 items-center";

/**
 * Recovery controls keep a one-row floor while classification loads, then grow
 * only when the controls actually wrap. Reserving a hypothetical second row
 * leaves resolved mobile cards with false bottom padding.
 */
const ASSISTANT_ERROR_ACTION_SLOT_CLASS =
  "flex min-h-8 shrink-0 items-center justify-end";

/** Let translated recovery actions fit narrow chat cards without clipping. */
const ERROR_CARD_ACTION_CLASS =
  "h-auto min-h-8 max-w-full shrink-0 whitespace-normal break-words py-1 text-center";

function creditsAvailableCopy(): {
  readonly headline: string;
  readonly helper: string;
} {
  return {
    headline: i18n.t(($) => {
      return $.chat.billing.creditsAvailable;
    }),
    helper: i18n.t(($) => {
      return $.chat.billing.creditsAdded;
    }),
  };
}

function insufficientCreditsCopy(params: {
  readonly canBuyCredits: boolean;
  readonly roleResolved: boolean;
  readonly canManageBilling: boolean;
}): { readonly headline: string; readonly helper: string } {
  const headline = params.canBuyCredits
    ? i18n.t(($) => {
        return $.chat.billing.outOfCredits;
      })
    : i18n.t(($) => {
        return $.chat.billing.upgradeToRun;
      });
  if (!params.roleResolved) {
    return {
      headline,
      helper: i18n.t(($) => {
        return $.chat.billing.checkingPermissions;
      }),
    };
  }
  if (!params.canManageBilling) {
    return {
      headline,
      helper: !params.canBuyCredits
        ? i18n.t(($) => {
            return $.chat.billing.askAdminUpgrade;
          })
        : i18n.t(($) => {
            return $.chat.billing.askAdminCredits;
          }),
    };
  }
  return {
    headline,
    helper: !params.canBuyCredits
      ? i18n.t(($) => {
          return $.chat.billing.upgradeToContinue;
        })
      : i18n.t(($) => {
          return $.chat.billing.addCreditsToContinue;
        }),
  };
}

function PaidCreditCheckoutActions({
  preparing,
  handleCreditClick,
}: {
  readonly preparing: boolean;
  readonly handleCreditClick: (
    selection: CreditCheckoutSelection,
    newTab: boolean,
  ) => void;
}) {
  const { t } = useTranslation();
  const submitCustomCredits = (
    form: HTMLFormElement | null,
    newTab: boolean,
  ) => {
    if (preparing) {
      return;
    }
    const credits = customCreditsFromForm(form);
    if (credits === null) {
      toast.error(
        t(($) => {
          return $.chat.billing.customAmountError;
        }),
      );
      return;
    }
    handleCreditClick({ credits, customAmount: true }, newTab);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {CREDIT_TOP_UP_OPTIONS.map((credits) => {
          return (
            <Button
              key={credits}
              type="button"
              onClick={(event) => {
                handleCreditClick({ credits }, event.metaKey || event.ctrlKey);
              }}
              disabled={preparing}
              variant="default"
              size="sm"
              className="disabled:opacity-60"
            >
              {formatCreditsUsd(credits)}
            </Button>
          );
        })}
        <details
          className="group flex"
          onToggle={(event) => {
            if (event.currentTarget.open) {
              event.currentTarget.querySelector("input")?.focus();
            }
          }}
        >
          <summary
            role="button"
            className={cn(
              buttonVariants({ size: "sm", variant: "outline" }),
              "list-none group-open:hidden [&::-webkit-details-marker]:hidden",
            )}
          >
            {t(($) => {
              return $.chat.billing.custom;
            })}
          </summary>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitCustomCredits(event.currentTarget, false);
            }}
          >
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-sm text-muted-foreground">
                $
              </span>
              <Input
                type="text"
                inputMode="numeric"
                name="customUsd"
                defaultValue="100"
                onInput={(event) => {
                  event.currentTarget.value = event.currentTarget.value.replace(
                    /\D/g,
                    "",
                  );
                }}
                aria-label={t(($) => {
                  return $.chat.billing.customDollarAmount;
                })}
                className="h-8 w-24 pr-2 pl-5"
              />
            </div>
            <Button
              type="button"
              onClick={(event) => {
                submitCustomCredits(
                  event.currentTarget.form,
                  event.metaKey || event.ctrlKey,
                );
              }}
              disabled={preparing}
              variant="default"
              size="sm"
              className="disabled:opacity-60"
            >
              {preparing
                ? t(($) => {
                    return $.billing.common.preparing;
                  })
                : t(($) => {
                    return $.chat.billing.buy;
                  })}
            </Button>
          </form>
        </details>
      </div>
    </div>
  );
}

function InsufficientCreditsCard() {
  const { t } = useTranslation();
  const billingLoadable = useLoadable(billingStatusAsync$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const [creditCheckoutLoadable, creditCheckout] =
    useLoadableSet(startCreditCheckout$);
  const openSettings = useSet(openSettingsDialogAt$);
  const setSubPage = useSet(setBillingSubPage$);
  const pageSignal = useGet(pageSignal$);
  const creditPurchaseOrigin = useGet(creditPurchaseOrigin$);

  const billingResolved = billingLoadable.state === "hasData";
  const credits = billingResolved ? billingLoadable.data.credits : null;
  const canBuyCredits = billingResolved
    ? orgPlanCapabilitiesFromBilling(billingLoadable.data).canBuyCredits
    : false;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const roleResolved = isAdminLoadable.state === "hasData";
  const canManageBilling = roleResolved ? isAdminLoadable.data : false;
  const hasAvailableCredits = canBuyCredits && credits !== null && credits > 0;
  const shouldStartProCheckout = !canBuyCredits;
  // Credits on hand leave the reserved action slot empty, the way this notice
  // has always read once a purchase lands.
  const canShowBillingAction =
    billingResolved && canManageBilling && !hasAvailableCredits;
  const checkoutRedirecting = checkoutLoadable.state === "loading";
  const creditCheckoutPreparing =
    creditCheckoutLoadable.state === "loading" ||
    creditPurchaseOrigin === "chat";

  // Credits arriving while the card is on screen replaces this copy and the
  // action inside the element below, rather than swapping the element itself:
  // `docs/chat-cards.md` keeps the mounted card's box in layout through every
  // asynchronous state change.
  const { headline, helper } = hasAvailableCredits
    ? creditsAvailableCopy()
    : insufficientCreditsCopy({
        canBuyCredits,
        roleResolved: billingResolved && roleResolved,
        canManageBilling: billingResolved && canManageBilling,
      });

  const openBilling = () => {
    setSubPage(false);
    detach(openSettings("billing", pageSignal), Reason.DomCallback);
  };

  const handleUpgradeClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (shouldStartProCheckout) {
      const newTab = event.metaKey || event.ctrlKey;
      detach(
        checkout("pro", newTab, undefined, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    openBilling();
  };

  const handleCreditClick = (
    selection: CreditCheckoutSelection,
    newTab: boolean,
  ) => {
    detach(
      creditCheckout(selection, newTab, "chat", pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="flex flex-col justify-between gap-3 p-3 @[640px]:flex-row @[640px]:items-center">
      <div className="min-w-0">
        <p
          className={cn(
            "break-words text-[0.9375rem] font-medium",
            hasAvailableCredits
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-foreground",
          )}
        >
          {headline}
        </p>
        <p className={cn("mt-1", BILLING_NOTICE_DESCRIPTION_CLASS)}>{helper}</p>
      </div>
      <div className={CHAT_NOTICE_ACTION_SLOT_CLASS}>
        {!canShowBillingAction ? null : shouldStartProCheckout ? (
          <Button
            type="button"
            onClick={handleUpgradeClick}
            disabled={checkoutRedirecting}
            variant="default"
            size="sm"
            className={cn(ERROR_CARD_ACTION_CLASS, "disabled:opacity-60")}
          >
            {checkoutRedirecting
              ? t(($) => {
                  return $.chat.billing.redirecting;
                })
              : t(($) => {
                  return $.chat.billing.upgradeToPro;
                })}
          </Button>
        ) : (
          <PaidCreditCheckoutActions
            preparing={creditCheckoutPreparing}
            handleCreditClick={handleCreditClick}
          />
        )}
      </div>
    </div>
  );
}

function isBillingRecoveryError(error: string): boolean {
  const normalized = error.trim().toLowerCase();
  return normalized === "insufficient_credits" || normalized === "pro_required";
}

function assistantRecoveryResetTexts(
  recovery: AssistantErrorRecovery,
): readonly string[] {
  const resetTexts = recovery.resetWindows.flatMap((window) => {
    if (!window.resetAt) {
      return [];
    }
    const formatted = formatSubscriptionUsageReset(window.resetAt);
    if (!formatted) {
      return [];
    }
    if (recovery.resetWindows.length === 1) {
      return [
        "fallbackText" in formatted
          ? formatted.fallbackText
          : formatted.absoluteResetText,
      ];
    }
    const time =
      "fallbackText" in formatted ? window.resetAt : formatted.absoluteText;
    return [
      i18n.t(
        ($) => {
          return window.limitWindow === "five-hour"
            ? $.chat.errors.recovery.fiveHourReset
            : $.chat.errors.recovery.weeklyReset;
        },
        { time },
      ),
    ];
  });
  if (resetTexts.length > 0) {
    return resetTexts;
  }
  if (!recovery.retryLabel) {
    return [];
  }
  return [
    i18n.t(
      ($) => {
        return $.chat.errors.recovery.resetsAt;
      },
      { time: recovery.retryLabel },
    ),
  ];
}

function AssistantRecoveryActionSpinner({ loading }: { loading: boolean }) {
  return loading ? <Loader2 size={16} className="animate-spin" /> : null;
}

function hasAssistantRecoveryModelPicker(
  recovery: AssistantErrorRecovery,
): boolean {
  return (
    recovery.kind === "subscription-error" ||
    recovery.kind === "usage-limit" ||
    recovery.kind === "model-capacity" ||
    recovery.kind === "model-unavailable" ||
    recovery.kind === "safety-policy-refusal" ||
    (recovery.kind === "provider-retryable" &&
      recovery.failureReason !== "guest_root_filesystem_full" &&
      recovery.failureReason !== "codex_access_program_unavailable")
  );
}

/**
 * The retry reads the thread's persisted model, so the card's actions wait for
 * the selection write this picker starts. `onSelect` is owned by the actions
 * row, which disables its buttons while the write is pending.
 */
function AssistantRecoveryModelPicker({
  recovery,
  thread,
  onSelect,
}: {
  readonly recovery: AssistantErrorRecovery;
  readonly thread: ChatPanelSignals;
  readonly onSelect: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  const modelSelection =
    useLastResolved(thread.composer.model.modelSelection$) ?? null;
  if (!hasAssistantRecoveryModelPicker(recovery)) {
    return null;
  }
  const handleModelSelection = (
    selection: ModelProviderSelection | null,
  ): void => {
    if (!selection) {
      return;
    }
    onSelect(selection);
  };
  return (
    <ModelProviderPicker
      value={modelSelection}
      onChange={handleModelSelection}
      placeholder={t(($) => {
        return $.chat.errors.recovery.selectModel;
      })}
      triggerClassName="h-8 w-auto min-w-24 max-w-36 bg-background text-sm"
      compactTrigger
    />
  );
}

function AssistantRecoveryDestinationAction({
  recovery,
}: {
  readonly recovery: AssistantErrorRecovery;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  if (recovery.kind === "provider-settings") {
    return (
      <Button
        type="button"
        size="sm"
        variant="neutral"
        className={ERROR_CARD_ACTION_CLASS}
        onClick={() => {
          detach(openSettings("model", pageSignal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.runErrors.actions.openModelProviders;
        })}
      </Button>
    );
  }
  if (recovery.kind === "new-chat-required") {
    return (
      <Link
        pathname="/"
        className={cn(
          buttonVariants({ size: "sm", variant: "neutral" }),
          ERROR_CARD_ACTION_CLASS,
        )}
      >
        {t(($) => {
          return $.chat.errors.recovery.newChat;
        })}
      </Link>
    );
  }
  if (recovery.kind === "terms-acceptance-required") {
    return (
      <a
        href="https://claude.ai"
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          buttonVariants({ size: "sm", variant: "neutral" }),
          ERROR_CARD_ACTION_CLASS,
        )}
      >
        {t(($) => {
          return $.chat.errors.recovery.openClaude;
        })}
      </a>
    );
  }
  return null;
}

function AssistantRecoveryActions({
  recovery,
  thread,
}: {
  recovery: AssistantErrorRecovery;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [retryLoadable, retry] = useLoadableSet(thread.retryAssistantError$);
  const [resetLoadable, resetAndRetry] = useLoadableSet(
    thread.resetCodexSubscriptionAndRetry$,
  );
  const [selectModelLoadable, selectModel] = useLoadableSet(
    thread.composer.model.setModelSelection$,
  );
  const retrying = retryLoadable.state === "loading";
  const resetting = resetLoadable.state === "loading";
  const selectingModel = selectModelLoadable.state === "loading";
  const actionsDisabled = retrying || resetting || selectingModel;
  const resetAction = recovery.actions.resetAndTryAgain;
  const hasRetryAction = recovery.actions.tryAgain !== null;
  const continueAction =
    recovery.kind === "execution-timeout" ||
    recovery.kind === "autonomy-budget-exhausted" ||
    recovery.kind === "output-token-limit";

  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
      <AssistantRecoveryModelPicker
        recovery={recovery}
        thread={thread}
        onSelect={(selection) => {
          detach(selectModel(selection, pageSignal), Reason.DomCallback);
        }}
      />
      {hasRetryAction && (
        <Button
          type="button"
          size="sm"
          variant="neutral"
          className={ERROR_CARD_ACTION_CLASS}
          disabled={actionsDisabled}
          onClick={() => {
            detach(retry(pageSignal), Reason.DomCallback);
          }}
        >
          <AssistantRecoveryActionSpinner loading={retrying} />
          {continueAction
            ? t(($) => {
                return $.chat.errors.recovery.continue;
              })
            : t(($) => {
                return $.chat.errors.recovery.tryAgain;
              })}
        </Button>
      )}
      {resetAction && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={ERROR_CARD_ACTION_CLASS}
          disabled={actionsDisabled}
          onClick={() => {
            detach(resetAndRetry(pageSignal), Reason.DomCallback);
          }}
        >
          <AssistantRecoveryActionSpinner loading={resetting} />
          {t(
            ($) => {
              return $.chat.errors.recovery.resetUsageRemaining;
            },
            { value: formatLocalizedNumber(resetAction.resetsRemaining) },
          )}
        </Button>
      )}
      <AssistantRecoveryDestinationAction recovery={recovery} />
    </div>
  );
}

/**
 * The contents of one error card, chosen by the caller and handed to the single
 * `AssistantErrorCard` element it keeps mounted. `docs/chat-cards.md` requires
 * the sized element itself to survive every asynchronous state change: the
 * failure-recovery classification lands after the transcript has already
 * scrolled, and replacing the card component at that moment removes its box
 * from layout for one pass, which makes WebKit clamp the transcript's scroll
 * offset by the card's own height. Equal heights do not prevent that; only the
 * retained element does.
 */
interface AssistantErrorCardContent {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: ReactNode;
  readonly descriptionTitle?: string;
  readonly descriptionClassName?: string;
  readonly details?: ReactNode;
  readonly actions?: ReactNode;
  readonly reserveActions?: boolean;
  readonly testId?: string;
}

/**
 * The classification behind this card resolves over two chained requests, so
 * `pending` is the state before either landed. It keeps the settled card's own
 * frame and renders its synchronous supporting copy invisibly, so short cards
 * can hug their content without collapsing during classification. Usage limits
 * reserve the account-and-window rows that load from the provider. Recovery
 * controls stay inline; only multiline or unusually long raw diagnostics keep
 * a details dialog.
 */
function AssistantErrorCard({
  icon: Icon,
  title,
  description,
  descriptionTitle,
  descriptionClassName,
  details,
  actions,
  reserveActions = false,
  testId,
  pending = false,
}: AssistantErrorCardContent & { readonly pending?: boolean }) {
  const hasDescription = Boolean(description);
  const accessibleDescription =
    descriptionTitle ??
    (typeof description === "string" ? description : undefined);
  return (
    <div
      role="status"
      data-testid={pending ? "assistant-error-card-loading" : testId}
      className="flex w-full flex-col justify-between gap-3 p-3 text-foreground @[640px]:flex-row @[640px]:items-center"
    >
      <div className="flex min-w-0 items-start gap-2.5 @[640px]:flex-1">
        {pending ? (
          <Loader2
            size={16}
            className="mt-1 shrink-0 animate-spin text-muted-foreground"
          />
        ) : (
          <Icon size={16} className="mt-1 shrink-0 text-brand-text" />
        )}
        <div className="min-w-0">
          <div
            className={cn(
              "min-h-6 break-words text-[0.9375rem] font-medium leading-6",
              pending && "invisible",
            )}
            aria-hidden={pending ? true : undefined}
          >
            {title}
          </div>
          {hasDescription && (
            <div
              data-testid="assistant-error-description"
              className={cn(
                "mt-0.5 break-words text-sm leading-5 text-muted-foreground",
                descriptionClassName,
                pending && "invisible",
              )}
              title={pending ? undefined : accessibleDescription}
              aria-hidden={pending ? true : undefined}
            >
              {description}
            </div>
          )}
        </div>
      </div>
      {pending ? (
        reserveActions ? (
          <div className={ASSISTANT_ERROR_ACTION_SLOT_CLASS} />
        ) : null
      ) : actions !== undefined || details !== undefined ? (
        <div className={ASSISTANT_ERROR_ACTION_SLOT_CLASS}>
          {actions !== undefined ? (
            actions
          ) : (
            <ChatCardDetails title={title}>{details}</ChatCardDetails>
          )}
        </div>
      ) : null}
    </div>
  );
}

type StructuredFailureTitle = () => string;

const STRUCTURED_FAILURE_TITLES = Object.freeze({
  session_history_limit: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.sessionHistoryTitle;
    });
  },
  guest_root_filesystem_full: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.filesystemFullTitle;
    });
  },
  execution_timeout: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.timeoutTitle;
    });
  },
  insufficient_credits: () => {
    return i18n.t(($) => {
      return $.chat.billing.outOfCredits;
    });
  },
  provider_insufficient_credits: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.providerBalanceTitle;
    });
  },
  invalid_api_key: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.invalidApiKeyTitle;
    });
  },
  invalid_credentials: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.invalidCredentialsTitle;
    });
  },
  terms_acceptance_required: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.termsTitle;
    });
  },
  context_window_exceeded: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.contextWindowTitle;
    });
  },
  input_too_large: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.inputTooLargeTitle;
    });
  },
  output_token_limit: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.outputLimitTitle;
    });
  },
  provider_rate_limited: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.providerRateLimitedTitle;
    });
  },
  provider_overloaded: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.capacityTitle;
    });
  },
  provider_stream_timeout: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.providerStreamTimeoutTitle;
    });
  },
  provider_queue_timeout: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.providerQueueTimeoutTitle;
    });
  },
  codex_access_program_unavailable: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.accessProgramTitle;
    });
  },
  provider_server_error: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.providerServerErrorTitle;
    });
  },
  response_connection_lost: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.connectionLostTitle;
    });
  },
  safety_policy_refusal: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.safetyTitle;
    });
  },
  reconnect_required: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.reconnectTitle;
    });
  },
  unsupported_model: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.unavailableTitle;
    });
  },
  usage_limit: () => {
    return i18n.t(($) => {
      return $.chat.errors.recovery.usageFallbackTitle;
    });
  },
} satisfies Record<KnownRunFailureReason, StructuredFailureTitle>);

function structuredFailureTitle(reason: KnownRunFailureReason): string {
  return STRUCTURED_FAILURE_TITLES[reason]();
}

type StructuredFailureDescription = (t: TFunction<"common">) => string;

const FAILURE_DESCRIPTIONS = Object.freeze({
  newChat: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.newChatDescription;
    });
  },
  filesystemFull: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.filesystemFullDescription;
    });
  },
  timeout: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.timeoutDescription;
    });
  },
  providerBalance: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.providerBalanceDescription;
    });
  },
  providerConnection: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.providerConnectionDescription;
    });
  },
  terms: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.termsDescription;
    });
  },
  inputTooLarge: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.inputTooLargeDescription;
    });
  },
  outputLimit: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.outputLimitDescription;
    });
  },
  capacity: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.capacityDescription;
    });
  },
  accessProgram: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.accessProgramDescription;
    });
  },
  safety: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.safetyDescription;
    });
  },
  unavailable: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.unavailableDescription;
    });
  },
  usage: (t: TFunction<"common">) => {
    return t(($) => {
      return $.chat.errors.recovery.usageDescription;
    });
  },
});

const STRUCTURED_FAILURE_DESCRIPTIONS = Object.freeze({
  session_history_limit: FAILURE_DESCRIPTIONS.newChat,
  guest_root_filesystem_full: FAILURE_DESCRIPTIONS.filesystemFull,
  execution_timeout: FAILURE_DESCRIPTIONS.timeout,
  insufficient_credits: () => {
    return "";
  },
  provider_insufficient_credits: FAILURE_DESCRIPTIONS.providerBalance,
  invalid_api_key: FAILURE_DESCRIPTIONS.providerConnection,
  invalid_credentials: FAILURE_DESCRIPTIONS.providerConnection,
  terms_acceptance_required: FAILURE_DESCRIPTIONS.terms,
  context_window_exceeded: FAILURE_DESCRIPTIONS.newChat,
  input_too_large: FAILURE_DESCRIPTIONS.inputTooLarge,
  output_token_limit: FAILURE_DESCRIPTIONS.outputLimit,
  provider_rate_limited: FAILURE_DESCRIPTIONS.capacity,
  provider_overloaded: FAILURE_DESCRIPTIONS.capacity,
  provider_stream_timeout: FAILURE_DESCRIPTIONS.capacity,
  provider_queue_timeout: FAILURE_DESCRIPTIONS.capacity,
  codex_access_program_unavailable: FAILURE_DESCRIPTIONS.accessProgram,
  provider_server_error: FAILURE_DESCRIPTIONS.capacity,
  response_connection_lost: FAILURE_DESCRIPTIONS.capacity,
  safety_policy_refusal: FAILURE_DESCRIPTIONS.safety,
  reconnect_required: FAILURE_DESCRIPTIONS.providerConnection,
  unsupported_model: FAILURE_DESCRIPTIONS.unavailable,
  usage_limit: FAILURE_DESCRIPTIONS.usage,
} satisfies Record<KnownRunFailureReason, StructuredFailureDescription>);

function structuredFailureDescription(
  reason: KnownRunFailureReason,
  t: TFunction<"common">,
): string {
  return STRUCTURED_FAILURE_DESCRIPTIONS[reason](t);
}

function structuredFailureIcon(reason: KnownRunFailureReason): LucideIcon {
  if (
    reason === "execution_timeout" ||
    reason === "output_token_limit" ||
    reason === "provider_rate_limited" ||
    reason === "provider_stream_timeout" ||
    reason === "provider_queue_timeout" ||
    reason === "usage_limit"
  ) {
    return Clock;
  }
  if (reason === "safety_policy_refusal") {
    return Hand;
  }
  if (
    reason === "invalid_api_key" ||
    reason === "invalid_credentials" ||
    reason === "reconnect_required" ||
    reason === "terms_acceptance_required" ||
    reason === "context_window_exceeded" ||
    reason === "input_too_large" ||
    reason === "session_history_limit"
  ) {
    return AlertCircle;
  }
  return Coffee;
}

function structuredFailureHasActions(reason: KnownRunFailureReason): boolean {
  return reason !== "insufficient_credits" && reason !== "input_too_large";
}

function assistantRecoveryTitle(
  recovery: AssistantErrorRecovery,
  t: TFunction<"common">,
): string {
  if (recovery.kind === "subscription-error") {
    return t(($) => {
      return $.chat.errors.genericTitle;
    });
  }
  if (recovery.kind === "autonomy-budget-exhausted") {
    return t(($) => {
      return $.chat.errors.recovery.autonomyLimitTitle;
    });
  }
  if (recovery.kind === "usage-limit" && recovery.framework !== null) {
    const framework =
      recovery.framework === "codex"
        ? t(($) => {
            return $.chat.errors.recovery.codex;
          })
        : t(($) => {
            return $.chat.errors.recovery.claudeCode;
          });
    return t(
      ($) => {
        return $.chat.errors.recovery.usageTitle;
      },
      { framework },
    );
  }
  if (recovery.failureReason) {
    return structuredFailureTitle(recovery.failureReason);
  }
  if (recovery.kind === "execution-timeout") {
    return t(($) => {
      return $.chat.errors.recovery.timeoutTitle;
    });
  }
  if (recovery.kind === "model-unavailable") {
    return t(($) => {
      return $.chat.errors.recovery.unavailableTitle;
    });
  }
  if (recovery.kind === "model-capacity") {
    return t(($) => {
      return $.chat.errors.recovery.capacityTitle;
    });
  }
  return t(($) => {
    return $.chat.errors.recovery.usageFallbackTitle;
  });
}

function assistantRecoverySourceDescription(
  recovery: AssistantErrorRecovery,
  t: TFunction<"common">,
): string | null {
  if (recovery.personalSubscription === null) {
    return null;
  }
  if (recovery.personalSubscription === "disconnected") {
    return t(($) => {
      return $.chat.errors.recovery.personalAccountDisconnected;
    });
  }
  return recovery.accountLabel
    ? t(
        ($) => {
          return $.chat.errors.recovery.personalAccount;
        },
        { account: recovery.accountLabel },
      )
    : null;
}

interface AssistantRecoveryDescription {
  readonly content: ReactNode;
  readonly title: string;
}

function textAssistantRecoveryDescription(
  text: string,
): AssistantRecoveryDescription {
  return { content: text, title: text };
}

function assistantRecoveryDescription(
  recovery: AssistantErrorRecovery,
  t: TFunction<"common">,
): AssistantRecoveryDescription {
  if (recovery.kind === "usage-limit") {
    const sourceDescription = assistantRecoverySourceDescription(recovery, t);
    const resetTexts = assistantRecoveryResetTexts(recovery);
    const details = [sourceDescription, ...resetTexts].filter(
      (part): part is string => {
        return Boolean(part);
      },
    );
    if (details.length === 0) {
      return textAssistantRecoveryDescription(
        t(($) => {
          return $.chat.errors.recovery.usageDescription;
        }),
      );
    }
    return {
      title: details.join(" · "),
      content: (
        <>
          {sourceDescription && <div>{sourceDescription}</div>}
          {resetTexts.length > 0 && (
            <div className="flex flex-col @[640px]:flex-row @[640px]:flex-wrap @[640px]:gap-x-4">
              {resetTexts.map((resetText) => {
                return <span key={resetText}>{resetText}</span>;
              })}
            </div>
          )}
        </>
      ),
    };
  }
  if (recovery.kind === "subscription-error") {
    return textAssistantRecoveryDescription(
      localizedRunError(recovery.providerMessage),
    );
  }
  if (recovery.failureReason) {
    return textAssistantRecoveryDescription(
      structuredFailureDescription(recovery.failureReason, t),
    );
  }
  if (recovery.kind === "execution-timeout") {
    return textAssistantRecoveryDescription(
      t(($) => {
        return $.chat.errors.recovery.timeoutDescription;
      }),
    );
  }
  if (recovery.kind === "autonomy-budget-exhausted") {
    return textAssistantRecoveryDescription(
      t(($) => {
        return $.chat.errors.recovery.autonomyLimitDescription;
      }),
    );
  }
  if (recovery.kind === "model-unavailable") {
    return textAssistantRecoveryDescription(
      t(($) => {
        return $.chat.errors.recovery.unavailableDescription;
      }),
    );
  }
  if (recovery.kind === "model-capacity") {
    return textAssistantRecoveryDescription(
      t(($) => {
        return $.chat.errors.recovery.capacityDescription;
      }),
    );
  }
  return textAssistantRecoveryDescription("");
}

function assistantRecoveryIcon(recovery: AssistantErrorRecovery): LucideIcon {
  if (recovery.kind === "autonomy-budget-exhausted") {
    return Hand;
  }
  if (recovery.failureReason) {
    return structuredFailureIcon(recovery.failureReason);
  }
  return recovery.kind === "usage-limit" ||
    recovery.kind === "execution-timeout"
    ? Clock
    : Coffee;
}

function assistantErrorRecoveryContent(
  recovery: AssistantErrorRecovery,
  thread: ChatPanelSignals,
  t: TFunction<"common">,
): AssistantErrorCardContent {
  const hasActions =
    recovery.kind !== "input-too-large" &&
    (recovery.failureReason === null ||
      structuredFailureHasActions(recovery.failureReason));
  const description = assistantRecoveryDescription(recovery, t);
  return {
    icon: assistantRecoveryIcon(recovery),
    title: assistantRecoveryTitle(recovery, t),
    description: description.content,
    descriptionTitle: description.title,
    ...(recovery.kind === "usage-limit" &&
    (recovery.personalSubscription !== null || recovery.resetWindows.length > 0)
      ? { descriptionClassName: USAGE_RECOVERY_DESCRIPTION_CLASS }
      : {}),
    ...(hasActions
      ? {
          actions: (
            <AssistantRecoveryActions recovery={recovery} thread={thread} />
          ),
        }
      : {}),
    reserveActions: hasActions,
    testId: "assistant-error-recovery",
  };
}

/** Owns the settings command so the card's contents stay hook-free. */
function ModelSettingsButton() {
  const { t } = useTranslation();
  const openSettings = useSet(openSettingsDialogAt$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Button
      type="button"
      size="sm"
      variant="neutral"
      className={ERROR_CARD_ACTION_CLASS}
      onClick={() => {
        detach(openSettings("model", pageSignal), Reason.DomCallback);
      }}
    >
      {t(($) => {
        return $.chat.errors.noModelProviderAction;
      })}
    </Button>
  );
}

function noModelProviderErrorContent(
  t: TFunction<"common">,
): AssistantErrorCardContent {
  return {
    icon: AlertCircle,
    title: t(($) => {
      return $.chat.errors.genericTitle;
    }),
    description: t(($) => {
      return $.chat.errors.noModelProviderPrefix;
    }),
    actions: <ModelSettingsButton />,
    reserveActions: true,
  };
}

/**
 * Returns null for the billing errors that own a different card. That choice
 * reads the failure text the card mounts with, so it cannot change while the
 * card is on screen: the recovery classification never claims
 * `insufficient_credits` or `pro_required`.
 */
function isLegacyUsageLimitError(
  error: string,
  failureReason: string | undefined,
): boolean {
  if (failureReason !== undefined) {
    return failureReason === "usage_limit";
  }
  return (
    /you(?:'|’)ve hit your (?:usage|session|weekly|5[- ]hour|opus(?:\s+[\w.-]+)?|sonnet(?:\s+[\w.-]+)?|haiku(?:\s+[\w.-]+)?) limit\b/iu.test(
      error,
    ) || /\bclaude(?: code)? (?:rate|usage) limit reached\b/iu.test(error)
  );
}

function structuredUsageDescriptionClass(
  error: string,
  reason: KnownRunFailureReason,
): string {
  return reason === "usage_limit" && isLegacyUsageLimitError(error, undefined)
    ? USAGE_RECOVERY_DESCRIPTION_CLASS
    : "";
}

function assistantErrorFallbackContent(
  error: string,
  failureReason: string | undefined,
  t: TFunction<"common">,
): AssistantErrorCardContent | null {
  const knownReason = knownRunFailureReasonSchema.safeParse(failureReason);
  if (
    isBillingRecoveryError(error) ||
    (knownReason.success && knownReason.data === "insufficient_credits")
  ) {
    return null;
  }

  if (knownReason.success) {
    return {
      icon: structuredFailureIcon(knownReason.data),
      title: structuredFailureTitle(knownReason.data),
      description: structuredFailureDescription(knownReason.data, t),
      descriptionClassName: structuredUsageDescriptionClass(
        error,
        knownReason.data,
      ),
      reserveActions: structuredFailureHasActions(knownReason.data),
    };
  }

  if (error.trim().toLowerCase() === "run cancelled") {
    return {
      icon: Hand,
      title: t(($) => {
        return $.chat.errors.runCancelled;
      }),
      description: "",
    };
  }

  const noProviderGuidance = RUN_ERROR_GUIDANCE.NO_MODEL_PROVIDER;
  const isNoModelProvider =
    noProviderGuidance !== undefined &&
    error.toLowerCase().includes(noProviderGuidance.title.toLowerCase());

  if (isNoModelProvider) {
    return noModelProviderErrorContent(t);
  }

  const incompatibleGuidance = RUN_ERROR_GUIDANCE.PROVIDER_INCOMPATIBLE;
  const isProviderIncompatible =
    (incompatibleGuidance !== undefined &&
      error.toLowerCase().includes(incompatibleGuidance.title.toLowerCase())) ||
    error.includes("Cannot continue session") ||
    error.includes("Invalid signature in thinking block");

  if (isProviderIncompatible) {
    return {
      icon: AlertCircle,
      title: t(($) => {
        return $.chat.errors.genericTitle;
      }),
      description: t(($) => {
        return $.chat.errors.providerIncompatiblePrefix;
      }),
      actions: (
        <Link
          pathname="/"
          className={cn(
            buttonVariants({ size: "sm", variant: "neutral" }),
            ERROR_CARD_ACTION_CLASS,
          )}
        >
          {t(($) => {
            return $.chat.errors.providerIncompatibleAction;
          })}
        </Link>
      ),
      reserveActions: true,
    };
  }

  const deletedGuidance = RUN_ERROR_GUIDANCE.PROVIDER_DELETED;
  const isProviderDeleted =
    deletedGuidance !== undefined &&
    (error.toLowerCase().includes(deletedGuidance.title.toLowerCase()) ||
      error.toLowerCase().includes(deletedGuidance.guidance.toLowerCase()));

  if (isProviderDeleted) {
    return {
      icon: AlertCircle,
      title: t(($) => {
        return $.chat.errors.genericTitle;
      }),
      description: t(($) => {
        return $.chat.errors.providerDeletedPrefix;
      }),
      actions: (
        <Link
          pathname="/"
          className={cn(
            buttonVariants({ size: "sm", variant: "neutral" }),
            ERROR_CARD_ACTION_CLASS,
          )}
        >
          {t(($) => {
            return $.chat.errors.providerDeletedAction;
          })}
        </Link>
      ),
      reserveActions: true,
    };
  }

  const description = localizedRunError(error);
  const showDetails = /[\r\n]/u.test(description) || description.length > 240;
  const legacyUsageLimit = isLegacyUsageLimitError(error, failureReason);
  return {
    icon: AlertCircle,
    title: t(($) => {
      return $.chat.errors.genericTitle;
    }),
    // Keep multiline and unusually long diagnostics in the read-only dialog;
    // the notice row should remain a compact recovery surface.
    description: showDetails ? "" : description,
    ...(showDetails
      ? {
          details: (
            <Markdown className="!text-muted-foreground" source={description} />
          ),
        }
      : {}),
    reserveActions: showDetails || legacyUsageLimit,
  };
}

function AssistantErrorContent({
  error,
  eventId,
  failureReason,
  thread,
}: {
  error: string;
  eventId: string;
  failureReason: string | undefined;
  thread: ChatPanelSignals;
}) {
  return (
    <ChatCard data-testid="assistant-error-card-shell" className="w-full">
      <AssistantErrorState
        error={error}
        eventId={eventId}
        failureReason={failureReason}
        thread={thread}
      />
    </ChatCard>
  );
}

function AssistantErrorState({
  error,
  eventId,
  failureReason,
  thread,
}: {
  error: string;
  eventId: string;
  failureReason: string | undefined;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  // `useLastLoadable` reports `loading` only for the first classification and
  // keeps the settled value across later recomputations, so the spinner marks
  // the one read the reader has to wait through instead of flashing on every
  // appended event.
  const loadable = useLastLoadable(thread.assistantErrorRecovery$);
  const pendingEventId = useLastResolved(thread.assistantErrorRecoveryEventId$);
  const fallback = assistantErrorFallbackContent(error, failureReason, t);
  if (fallback === null) {
    return <InsufficientCreditsCard />;
  }
  const resolved = loadable.state === "hasData" ? loadable.data : null;
  const recovery = resolved?.sourceEventId === eventId ? resolved : null;
  // The classification resolves after the first paint and selects contents,
  // not a component: choosing between two card components here would remove
  // the mounted card and move the transcript by its height.
  const content = recovery
    ? assistantErrorRecoveryContent(recovery, thread, t)
    : fallback;
  return (
    <AssistantErrorCard
      {...content}
      pending={loadable.state === "loading" && pendingEventId === eventId}
    />
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const agentId = thread.agentId;
  return (
    <Link
      pathname="/agents/:agentId"
      options={{ pathParams: { agentId } }}
      className={`${CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS} transition-colors duration-150 hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
      aria-label={t(($) => {
        return $.chat.agentPage.viewAgentProfile;
      })}
    >
      <AgentAvatarImg
        name={agentId}
        alt=""
        className={CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS}
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Paged event rendering — renders from visibleRenderedChatGroups$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious = false,
  runWorkSection,
  runIndicatorMode,
  statusTailEvents,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  stackFirstOnPrevious?: boolean;
  runWorkSection?: RunWorkSectionControl;
  runIndicatorMode?: Exclude<ThinkingIndicatorMode, null>;
  statusTailEvents?: readonly EnrichedChatEvent[];
}) {
  if (group.role === "user") {
    return (
      <PagedUserGroup
        group={group}
        thread={thread}
        modelChanges={modelChanges}
        stackFirstOnPrevious={stackFirstOnPrevious}
      />
    );
  }
  return (
    <PagedAssistantGroup
      group={group}
      thread={thread}
      modelChanges={modelChanges}
      runWorkSection={runWorkSection}
      runIndicatorMode={runIndicatorMode}
      statusTailEvents={statusTailEvents}
    />
  );
}

function SelectablePagedGroupRow({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious,
  runWorkSection,
  runIndicatorMode,
  statusTailEvents,
}: Parameters<typeof PagedGroupRow>[0]) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedEventIds = useGet(thread.sharing.selectedEventIds$);
  const toggle = useSet(thread.sharing.toggle$);
  const sharing = phase !== "idle";
  const displayGroup = sharing ? chatGroupForSharing(group) : group;
  const content = (
    <PagedGroupRow
      group={displayGroup}
      thread={thread}
      modelChanges={modelChanges}
      stackFirstOnPrevious={sharing ? false : stackFirstOnPrevious}
      runWorkSection={sharing ? undefined : runWorkSection}
      runIndicatorMode={sharing ? undefined : runIndicatorMode}
      statusTailEvents={sharing ? undefined : statusTailEvents}
    />
  );
  const events = displayGroup.events.flatMap((event) => {
    const shareable = shareableEventFromChatEvent(event);
    return shareable ? [shareable] : [];
  });
  if (phase === "idle" || events.length === 0) {
    return content;
  }
  const selectedCount = events.filter((event) => {
    return selectedEventIds.has(event.id);
  }).length;
  const selected = selectedCount > 0;
  const allSelected = selectedCount === events.length;
  const indeterminate = selected && !allSelected;

  const toggleGroup = () => {
    if (phase !== "selecting") {
      return;
    }
    const result = toggle(events[0]!.id, events);
    if (result === "too-large") {
      toast.error(
        t(($) => {
          return $.chat.sharing.tooLarge;
        }),
      );
    }
  };

  return (
    <div
      data-chat-share-selectable-group
      data-chat-share-group-event-id={events[0]?.id}
      data-chat-scroll-anchor-alias-event-ids={
        group.role === "assistant"
          ? [
              ...group.events,
              ...(runWorkSection
                ? [
                    ...runWorkSection.hiddenGroups,
                    ...runWorkSection.hiddenGroupsAfterAnchor,
                  ].flatMap((hiddenGroup) => {
                    return hiddenGroup.events;
                  })
                : []),
            ]
              .map((event) => {
                return event.id;
              })
              .join(" ")
          : undefined
      }
      className={cn(
        "relative -my-1 flex flex-col rounded-lg py-1 transition-colors",
        CHAT_THREAD_MESSAGE_ROW_GAP_CLASS,
        selected && "bg-state-selected",
        phase === "selecting" &&
          (!selected
            ? "cursor-pointer hover:bg-state-hover"
            : "cursor-pointer hover:bg-state-selected-hover"),
      )}
      onClick={(event) => {
        const selection = window.getSelection();
        const selectsTextInGroup =
          selection !== null &&
          !selection.isCollapsed &&
          selection.rangeCount > 0 &&
          event.currentTarget.contains(
            selection.getRangeAt(0).commonAncestorContainer,
          );
        if (
          !selectsTextInGroup &&
          !clickTargetsExistingInteraction(event.target)
        ) {
          toggleGroup();
        }
      }}
    >
      {content}
      <Checkbox
        checked={allSelected}
        indeterminate={indeterminate}
        disabled={phase !== "selecting"}
        aria-label={t(($) => {
          return allSelected
            ? $.chat.sharing.deselectGroup
            : $.chat.sharing.selectGroup;
        })}
        className="absolute -right-9 top-1/2 -translate-y-1/2 lg:-right-10"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onCheckedChange={toggleGroup}
      />
    </div>
  );
}

function PagedUserGroup({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious = false,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  stackFirstOnPrevious?: boolean;
}) {
  return (
    <>
      {group.events.map((event, index) => {
        const modelChange = modelChanges.get(event.id);
        const previousEvent = group.events[index - 1];
        // Anything the user sent back to back is one thing they said, so the
        // whole run closes up — including the message the run started from and
        // the first correction after it, which is the seam this rule used to
        // leave wide. Adjacency is the whole condition on purpose. Anything
        // that belongs between two messages — a model change, or a message that
        // renders as its own card rather than a bubble — ends the stack.
        const stackedOnPrevious =
          modelChange === undefined &&
          rendersUserBubble(event) &&
          (previousEvent !== undefined
            ? rendersUserBubble(previousEvent)
            : stackFirstOnPrevious);
        return (
          <div key={event.id} className="contents">
            {modelChange === undefined ? null : (
              <ModelChangeDividerRow change={modelChange} />
            )}
            <PagedUserMessage
              event={event}
              thread={thread}
              stackedOnPrevious={stackedOnPrevious}
            />
          </div>
        );
      })}
    </>
  );
}

// A user event does not always render as a bubble: a workflow run, a historical
// goal, and a rejected historical goal each render as their own card or as
// nothing at all.
function rendersUserBubble(event: EnrichedChatEvent): boolean {
  return (
    !isRejectedGoalUserMessage(event) &&
    !isWorkflowUserMessage(event) &&
    !isGoalUserMessage(event)
  );
}

function isWorkflowUserMessage(
  event: EnrichedChatEvent,
): event is EnrichedChatEvent & ChatInputEvent {
  return (
    isInputChatEvent(event) && eventNonContentPart(event)?.type === "automation"
  );
}

interface ResolvedMessageAttachment {
  readonly id: string | null;
  readonly filename: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly isImage: boolean;
  readonly kind: ReturnType<typeof classifyChatAttachment>;
  readonly signals: ArtifactSignals;
}

type OpenMessageImagePreview = (attachment: ResolvedMessageAttachment) => void;

function userMessageRenderAttachments(
  document: UserMessageRenderDocument | undefined,
): ResolvedMessageAttachment[] {
  return (document?.parts ?? []).flatMap((renderPart) => {
    if (renderPart.type !== "file") {
      return [];
    }
    const { part, signals } = renderPart;
    return [
      {
        id: part.fileId,
        filename: part.filenameSnapshot,
        url: signals.url,
        contentType: part.contentType,
        isImage:
          signals.kind === "image" || isImageFilename(part.filenameSnapshot),
        kind: signals.kind,
        signals,
      },
    ];
  });
}

function clipboardAttachmentsFromUserMessage(
  document: UserMessageDocument,
  attachments: readonly ChatClipboardAttachment[],
): ChatClipboardAttachment[] {
  const attachmentById = new Map(
    attachments.flatMap((attachment) => {
      return attachment.id ? [[attachment.id, attachment] as const] : [];
    }),
  );
  return document.parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const attachment = attachmentById.get(part.fileId);
    return attachment
      ? [
          {
            id: attachment.id,
            url: attachment.url,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
          },
        ]
      : [];
  });
}

// Images and videos render as thumbnails, every other attachment as a chip.
// The two shapes never share a row, so they are grouped before rendering.
function isMediaAttachment(attachment: ResolvedMessageAttachment): boolean {
  return attachment.isImage || attachment.kind === "video";
}

function MessageAttachment({
  attachment: a,
  onImageClick,
}: {
  attachment: ResolvedMessageAttachment;
  onImageClick: OpenMessageImagePreview;
}) {
  const { t } = useTranslation();
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);

  if (a.isImage) {
    return (
      <ChatImagePreviewLink
        alt={a.filename}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: a.filename,
          },
        )}
        load={a.signals.previewImageLoad}
        imageClassName="block h-full w-full object-contain"
        linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
        onPreview={() => {
          onImageClick(a);
        }}
        placeholderClassName="h-full w-full"
        resourceUrl$={a.signals.linkUrl$}
        thumbnailUrl$={a.signals.thumbnailUrl$}
        url={a.url}
      />
    );
  }
  if (a.kind === "video") {
    return (
      <ChatVideoPreviewButton
        resourceUrl$={a.signals.resourceUrl$}
        posterLoad={a.signals.previewImageLoad}
        previewImageUrl$={a.signals.previewImageUrl$}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: a.filename,
          },
        )}
        buttonClassName={CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS}
        filename={a.filename}
        onPreview={() => {
          openVideoLightbox({
            url: a.url,
            filename: a.filename,
            preview: a.signals,
            shareAvailable: false,
          });
        }}
        posterClassName="h-full w-full"
        videoClassName="h-full w-full object-contain"
      />
    );
  }
  if (
    a.kind === "markdown" ||
    a.kind === "text" ||
    a.kind === "json" ||
    a.kind === "csv" ||
    a.kind === "pdf" ||
    a.kind === "html"
  ) {
    return (
      <PreviewableFileAttachmentChip
        filename={a.filename}
        url={a.url}
        kind={a.kind}
        preview={a.signals}
        shareAvailable={false}
        text$={a.signals.text$}
      />
    );
  }
  if (a.kind === "audio") {
    return (
      <PreviewableAudioAttachmentChip
        filename={a.filename}
        url={a.url}
        contentType={a.contentType}
        preview={a.signals}
        shareAvailable={false}
      />
    );
  }
  return (
    <FileAttachmentChip
      filename={a.filename}
      url={a.url}
      contentType={a.contentType}
      preview={a.signals}
      shareAvailable={false}
    />
  );
}

function UserMessageAttachmentRow({
  attachments,
  onImageClick,
  testId,
}: {
  attachments: ResolvedMessageAttachment[];
  onImageClick: OpenMessageImagePreview;
  testId: string;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid={testId}>
      {attachments.map((a) => {
        return (
          <MessageAttachment
            key={a.id ?? a.url}
            attachment={a}
            onImageClick={onImageClick}
          />
        );
      })}
    </div>
  );
}

function UserMessageAttachments({
  attachments,
  onImageClick,
}: {
  attachments: ReturnType<typeof userMessageRenderAttachments>;
  onImageClick: OpenMessageImagePreview;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex max-w-[85%] flex-col items-end gap-2 self-end">
      <UserMessageAttachmentRow
        attachments={attachments.filter(isMediaAttachment)}
        onImageClick={onImageClick}
        testId="message-media-attachments"
      />
      <UserMessageAttachmentRow
        attachments={attachments.filter((a) => {
          return !isMediaAttachment(a);
        })}
        onImageClick={onImageClick}
        testId="message-file-attachments"
      />
    </div>
  );
}

function RunLogsAction({ runId }: { runId: string }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              pathname="/activities/:activityRunId"
              options={{ pathParams: { activityRunId: runId } }}
              aria-label={t(($) => {
                return $.chat.run.viewLogs;
              })}
              className={cn(
                buttonVariants({
                  variant: "quiet",
                  size: "icon-xs",
                  iconSize: "sm",
                }),
                "text-muted-foreground/60",
              )}
            >
              <ChartLine />
            </Link>
          }
        />
        <TooltipContent side="bottom">
          {t(($) => {
            return $.chat.run.viewActivityLogs;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// The row below a user message is part of that message's frame, not a thing the
// copy button brings with it. It stays even when there is no button to show —
// a message nobody can copy, or a mode that offers no per-message action — so
// the burst spacing that is measured against it does not collapse.
function UserMessageActions({
  showCopy,
  runId,
  onCopy,
}: {
  showCopy: boolean;
  runId: string | undefined;
  onCopy: () => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const showActivityLogs = useGet(featureSwitch$)[FeatureSwitchKey.OkouDebug];
  return (
    <div
      data-chat-user-message-actions
      className={CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS}
    >
      {showActivityLogs && runId && <RunLogsAction runId={runId} />}
      {showCopy ? (
        <CopyButton
          copyAction={onCopy}
          render={({ onClick, ref }, { copied }) => {
            return (
              <Button
                ref={ref}
                type="button"
                variant="quiet"
                size="icon-xs"
                iconSize="sm"
                showTooltip
                onClick={onClick}
                className="text-muted-foreground/60"
                aria-label={t(($) => {
                  return $.chat.actions.copyMessage;
                })}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            );
          }}
        />
      ) : null}
    </div>
  );
}

function generationTemplateTypeLabel(
  value: GenerationTemplateRequest | undefined,
): string | null {
  if (!value) {
    return null;
  }
  switch (generationTemplateKind(value)) {
    case "avatar": {
      return i18n.t(($) => {
        return $.artifacts.templates.avatar;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.templates.categories.video;
      });
    }
    case "illustration": {
      return i18n.t(($) => {
        return $.chat.templates.categories.illustration;
      });
    }
    case "workflow": {
      return i18n.t(($) => {
        return $.chat.templates.categories.workflow;
      });
    }
    case "website": {
      return i18n.t(($) => {
        return $.chat.templates.categories.website;
      });
    }
    case "custom": {
      // The catalog's own name, the same word the picker tab uses. What a
      // custom template produces lives on its row, which this label cannot
      // read, so naming the catalog is the honest answer here.
      return i18n.t(($) => {
        return $.templates.custom;
      });
    }
    case "presentation": {
      return i18n.t(($) => {
        return $.chat.templates.categories.presentation;
      });
    }
  }
}

const annotationIconImgs = {
  feishu: settingsIconAssetUrl("lark"),
  lark: settingsIconAssetUrl("lark"),
  teams: settingsIconAssetUrl("teams"),
  telegram: settingsIconAssetUrl("telegram"),
  github: settingsIconAssetUrl("github"),
  agentphone: settingsIconAssetUrl("imessage"),
} as const;

function MessageAnnotation({
  renderPart,
}: {
  renderPart: UserMessageAnnotationRenderPart;
}) {
  const { t } = useTranslation();
  const className =
    "mb-1.5 inline-flex h-7 max-w-[85%] items-center gap-1.5 self-end " +
    "rounded-md px-1.5 text-xs font-medium text-muted-foreground";
  if (renderPart.type === "automation") {
    const { part } = renderPart;
    const content = (
      <>
        <Route size={15} className="shrink-0" />
        <span className="min-w-0 truncate">{part.workflowName}</span>
      </>
    );
    if (part.workflowId !== undefined) {
      const workflowTitle =
        part.workflowName.trim() ||
        t(($) => {
          return $.chat.templates.categories.workflow;
        });
      return (
        <Link
          pathname={ROUTES.workflowDetailAutomations}
          options={{ pathParams: { workflowId: part.workflowId } }}
          aria-label={t(
            ($) => {
              return $.chat.workflows.open;
            },
            { title: workflowTitle },
          )}
          className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
          title={part.workflowName}
        >
          {content}
        </Link>
      );
    }
    return (
      <div
        aria-label={t(
          ($) => {
            return $.chat.workflows.named;
          },
          {
            title: part.workflowName,
          },
        )}
        className={className}
        title={part.workflowName}
      >
        {content}
      </div>
    );
  }
  if (renderPart.type === "goal") {
    return (
      <div
        aria-label={t(($) => {
          return $.chat.queue.goal;
        })}
        className={className}
      >
        <Target size={15} className="shrink-0" />
        <span>
          {t(($) => {
            return $.chat.queue.goal;
          })}
        </span>
      </div>
    );
  }
  return (
    <SourceMessageAnnotation renderPart={renderPart} className={className} />
  );
}

function sourceMessageLinkText(
  t: TFunction<"common">,
  part: Extract<
    UserMessageAnnotationRenderPart,
    { type: "source"; kind: "external" }
  >["part"],
) {
  const opensChat =
    part.kind === "feishu" ||
    part.kind === "lark" ||
    (part.kind === "telegram" &&
      /^https:\/\/t\.me\/[a-z\d_]+$/iu.test(part.href ?? "")) ||
    (part.kind === "teams" &&
      part.href?.startsWith("https://teams.microsoft.com/l/chat/") === true);
  const openLabel =
    part.kind === "agentphone"
      ? t(($) => {
          return $.chat.origins.openMessages;
        })
      : opensChat
        ? t(($) => {
            return $.chat.origins.openChat;
          })
        : t(($) => {
            return $.chat.origins.openMessage;
          });
  return { opensChat, openLabel };
}

function sourceMessageLabel(
  t: TFunction<"common">,
  kind: Extract<
    UserMessageAnnotationRenderPart,
    { type: "source"; kind: "external" }
  >["part"]["kind"],
): string {
  switch (kind) {
    case "discord": {
      return t(($) => {
        return $.chat.origins.discord;
      });
    }
    case "slack": {
      return t(($) => {
        return $.chat.origins.slack;
      });
    }
    case "feishu": {
      return t(($) => {
        return $.chat.origins.feishu;
      });
    }
    case "lark": {
      return t(($) => {
        return $.chat.origins.lark;
      });
    }
    case "teams": {
      return t(($) => {
        return $.chat.origins.teams;
      });
    }
    case "telegram": {
      return t(($) => {
        return $.chat.origins.telegram;
      });
    }
    case "github": {
      return t(($) => {
        return $.chat.origins.github;
      });
    }
    case "agentphone": {
      return t(($) => {
        return $.chat.origins.agentphone;
      });
    }
  }
}

function SourceMessageAnnotation({
  renderPart,
  className,
}: {
  renderPart: Extract<UserMessageAnnotationRenderPart, { type: "source" }>;
  className: string;
}) {
  const { t } = useTranslation();
  if (renderPart.kind === "agent") {
    return (
      <AgentRunSourceMessageAnnotation
        part={renderPart.part}
        className={className}
        signals={renderPart.signals}
      />
    );
  }
  const { part } = renderPart;
  // Historical messages used "feishu" for both platforms; their link can
  // identify Lark. New messages already carry the canonical source kind.
  const sourceKind =
    part.kind === "feishu" &&
    part.href?.startsWith("https://applink.larksuite.com/") === true
      ? "lark"
      : part.kind;
  const sourceLabel = sourceMessageLabel(t, sourceKind);
  const { opensChat, openLabel } = sourceMessageLinkText(t, part);
  const ariaLabel =
    opensChat && sourceKind !== "feishu" && sourceKind !== "lark"
      ? t(
          ($) => {
            return $.chat.origins.openChatIn;
          },
          { integration: sourceLabel },
        )
      : sourceKind === "slack"
        ? t(($) => {
            return $.chat.origins.openSlackMessage;
          })
        : sourceKind === "discord"
          ? t(($) => {
              return $.chat.origins.openDiscordMessage;
            })
          : sourceKind === "feishu" || sourceKind === "lark"
            ? t(($) => {
                return $.chat.origins[
                  sourceKind === "lark" ? "openLarkChat" : "openFeishuChat"
                ];
              })
            : sourceKind === "teams"
              ? t(($) => {
                  return $.chat.origins.openTeamsMessage;
                })
              : sourceKind === "telegram"
                ? t(($) => {
                    return $.chat.origins.openTelegramMessage;
                  })
                : sourceKind === "github"
                  ? t(($) => {
                      return $.chat.origins.openGithubMessage;
                    })
                  : openLabel;
  const content = (
    <>
      {sourceKind === "slack" ? (
        <BrandSlack size={15} className="shrink-0" />
      ) : sourceKind === "discord" ? (
        <DiscordMark size={15} />
      ) : (
        <img
          src={annotationIconImgs[sourceKind]}
          alt=""
          className="size-[15px] shrink-0 object-contain"
        />
      )}
      <span className="shrink-0">{sourceLabel}</span>
      {part.href ? (
        <>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{openLabel}</span>
          <ArrowUpRight size={12} className="shrink-0" />
        </>
      ) : null}
    </>
  );
  if (!part.href) {
    return <div className={className}>{content}</div>;
  }
  return (
    <a
      href={part.href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
    >
      {content}
    </a>
  );
}

function AgentRunSourceMessageAnnotation({
  part,
  className,
  signals,
}: {
  part: Extract<
    Extract<UserMessageNonContentPart, { type: "source" }>,
    { kind: "agent" }
  >;
  className: string;
  signals: AgentReferenceSignals;
}) {
  const { t } = useTranslation();
  const agent = useLastResolved(signals.agent$);
  return (
    <Link
      pathname={ROUTES.chat}
      options={{
        pathParams: { threadId: part.threadId },
        hash: `run-${part.runId}`,
      }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedChat;
        },
        { title: part.titleSnapshot },
      )}
      className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
      title={part.titleSnapshot}
    >
      <AvatarFromUrl
        avatarUrl={agent?.avatarUrl}
        alt=""
        className="size-4 shrink-0 overflow-hidden rounded-full object-cover object-top"
        size={16}
      />
      <span className="min-w-0 truncate">{part.titleSnapshot}</span>
    </Link>
  );
}

// File chips carry their own border, so they need more breathing room from the
// surrounding sentence than a borderless inline mention does.
const INLINE_FILE_REFERENCE_SPACING_CLASS = "mx-1";
const STRUCTURED_INLINE_REFERENCE_CLASS =
  "relative -top-px mx-0.5 inline-flex h-7 max-w-[240px] items-center " +
  "gap-1.5 rounded-md bg-orange-500/10 px-2 align-middle text-[13px] " +
  "font-medium text-orange-600 dark:bg-orange-400/15 dark:text-orange-300";
const STRUCTURED_INLINE_INTERACTIVE_CLASS =
  "transition-colors hover:bg-orange-500/15 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-orange-500/30 " +
  "active:bg-orange-500/20 dark:hover:bg-orange-400/20 " +
  "dark:active:bg-orange-400/25";
const STRUCTURED_INLINE_LINK_REFERENCE_CLASS = `${STRUCTURED_INLINE_REFERENCE_CLASS} ${STRUCTURED_INLINE_INTERACTIVE_CLASS}`;

function UserMessageTemplateReference({
  part,
}: {
  part: Extract<UserMessagePart, { type: "template" }>;
}) {
  const typeLabel = generationTemplateTypeLabel(part.template);
  const label = `${typeLabel ?? part.template.type} · ${part.titleSnapshot}`;
  return (
    <span
      data-structured-template-reference=""
      className={STRUCTURED_INLINE_REFERENCE_CLASS}
      title={label}
    >
      <SwatchBook size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{part.titleSnapshot}</span>
    </span>
  );
}

function UserMessageFileReference({
  part,
  signals,
}: {
  part: Extract<UserMessagePart, { type: "file" }>;
  signals: ArtifactSignals;
}) {
  const { t } = useTranslation();
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);
  let reference: ReactNode;
  if (signals.kind === "video") {
    reference = (
      <ChatVideoPreviewButton
        resourceUrl$={signals.resourceUrl$}
        posterLoad={signals.previewImageLoad}
        previewImageUrl$={signals.previewImageUrl$}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: part.filenameSnapshot,
          },
        )}
        buttonClassName={CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS}
        filename={part.filenameSnapshot}
        onPreview={() => {
          openVideoLightbox({
            url: signals.url,
            filename: part.filenameSnapshot,
            preview: signals,
            shareAvailable: false,
          });
        }}
        posterClassName="h-full w-full"
        videoClassName="h-full w-full object-contain"
      />
    );
  } else if (
    signals.kind === "markdown" ||
    signals.kind === "text" ||
    signals.kind === "json" ||
    signals.kind === "csv" ||
    signals.kind === "pdf" ||
    signals.kind === "html"
  ) {
    reference = (
      <PreviewableFileAttachmentChip
        filename={part.filenameSnapshot}
        url={signals.url}
        kind={signals.kind}
        preview={signals}
        shareAvailable={false}
      />
    );
  } else if (signals.kind === "audio") {
    reference = (
      <PreviewableAudioAttachmentChip
        filename={part.filenameSnapshot}
        url={signals.url}
        contentType={part.contentType}
        preview={signals}
        shareAvailable={false}
      />
    );
  } else {
    reference = (
      <FileAttachmentChip
        contentType={part.contentType}
        filename={part.filenameSnapshot}
        preview={signals}
        shareAvailable={false}
        url={signals.url}
      />
    );
  }
  return (
    <span
      className={`${INLINE_FILE_REFERENCE_SPACING_CLASS} inline-flex align-middle`}
    >
      {reference}
    </span>
  );
}

function UserMessageChatThreadReference({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId } }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedChat;
        },
        { title },
      )}
      className={STRUCTURED_INLINE_LINK_REFERENCE_CLASS}
      title={title}
    >
      <MessageCircle size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}

function UserMessageAgentReference({
  agentId,
  name,
  signals,
}: {
  agentId: string;
  name: string;
  signals: AgentReferenceSignals;
}) {
  const { t } = useTranslation();
  const agent = useLastResolved(signals.agent$);
  return (
    <Link
      pathname={ROUTES.agentChat}
      options={{ pathParams: { agentId } }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedAgent;
        },
        { name },
      )}
      className={STRUCTURED_INLINE_LINK_REFERENCE_CLASS}
      title={name}
    >
      <AvatarFromUrl
        avatarUrl={agent?.avatarUrl}
        alt=""
        className="size-4 shrink-0 overflow-hidden rounded-full object-cover object-top"
        size={16}
      />
      <span className="min-w-0 truncate">{name}</span>
    </Link>
  );
}

function UserMessageFeedbackNote({
  note,
}: {
  note: readonly UserMessageFeedbackNoteRenderPart[];
}) {
  const partOccurrences = new Map<string, number>();
  return (
    <div>
      {note.map((renderPart) => {
        const identity = JSON.stringify(renderPart.part);
        const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
        partOccurrences.set(identity, occurrence);
        const key = `${identity}:${String(occurrence)}`;
        if (renderPart.type === "chat_thread") {
          return (
            <UserMessageChatThreadReference
              key={key}
              threadId={renderPart.part.threadId}
              title={renderPart.part.titleSnapshot}
            />
          );
        }
        if (renderPart.type === "agent") {
          return (
            <UserMessageAgentReference
              key={key}
              agentId={renderPart.part.agentId}
              name={renderPart.part.nameSnapshot}
              signals={renderPart.signals}
            />
          );
        }
        if (renderPart.type === "template") {
          return (
            <UserMessageTemplateReference key={key} part={renderPart.part} />
          );
        }
        return <PlainTextWithLinks key={key} text={renderPart.part.text} />;
      })}
    </div>
  );
}

type UserMessageFeedbackRenderPart = Extract<
  UserMessageRenderPart,
  { type: "feedback" }
>;

function equalFeedbackSources(
  left: UserMessageFeedbackRenderPart["part"]["source"],
  right: UserMessageFeedbackRenderPart["part"]["source"],
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.status === right.status &&
    left.sentId === right.sentId
  );
}

function userMessageFeedbackHeading(
  parts: readonly UserMessageFeedbackRenderPart[],
  agentRunSourceTitle: string | undefined,
): string {
  if (agentRunSourceTitle) {
    return parts.length === 1
      ? i18n.t(
          ($) => {
            return $.chat.feedback.forwardPartHeading;
          },
          { title: agentRunSourceTitle },
        )
      : i18n.t(
          ($) => {
            return $.chat.feedback.forwardPartsHeading;
          },
          { count: parts.length, title: agentRunSourceTitle },
        );
  }
  const source = parts[0]?.part.source;
  if (!source) {
    return parts.length === 1
      ? i18n.t(($) => {
          return $.chat.feedback.partHeading;
        })
      : i18n.t(
          ($) => {
            return $.chat.feedback.partsHeading;
          },
          {
            count: parts.length,
          },
        );
  }
  const description =
    source.status === "draft"
      ? i18n.t(($) => {
          return $.chat.feedback.emailDraftDescription;
        })
      : i18n.t(($) => {
          return $.chat.feedback.sentEmailDescription;
        });
  return parts.length === 1
    ? i18n.t(
        ($) => {
          return $.chat.feedback.sourcePartHeading;
        },
        { description },
      )
    : i18n.t(
        ($) => {
          return $.chat.feedback.sourcePartsHeading;
        },
        {
          count: parts.length,
          description,
        },
      );
}

function UserMessageFeedbackGroup({
  parts,
  agentRunSourceTitle,
}: {
  parts: readonly UserMessageFeedbackRenderPart[];
  agentRunSourceTitle: string | undefined;
}) {
  const partOccurrences = new Map<string, number>();
  let firstPart = true;
  return (
    <div data-structured-feedback-group="" className="space-y-3">
      <div>{userMessageFeedbackHeading(parts, agentRunSourceTitle)}</div>
      {parts.map((renderPart) => {
        const identity = JSON.stringify(renderPart.part);
        const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
        partOccurrences.set(identity, occurrence);
        const showDivider = !firstPart;
        firstPart = false;
        return (
          <div key={`${identity}:${String(occurrence)}`} className="space-y-3">
            {showDivider ? (
              <div
                data-structured-feedback-divider=""
                className="border-t border-border-on-fill"
              />
            ) : null}
            <blockquote
              data-structured-feedback-quote=""
              className="border-l-2 border-border-on-fill pl-3 text-muted-foreground"
            >
              {renderPart.part.quote}
            </blockquote>
            <UserMessageFeedbackNote note={renderPart.note} />
          </div>
        );
      })}
    </div>
  );
}

type UserMessageContentRenderPart = Exclude<
  UserMessageRenderPart,
  {
    readonly type: "source" | "automation" | "goal" | "model";
  }
>;
type UserMessageStandaloneRenderPart = Exclude<
  UserMessageContentRenderPart,
  { readonly type: "feedback" }
>;

function UserMessagePartView({
  renderPart,
}: {
  renderPart: UserMessageStandaloneRenderPart;
}): ReactNode {
  if (renderPart.type === "text") {
    return <PlainTextWithLinks text={renderPart.part.text} />;
  }
  if (renderPart.type === "chat_thread") {
    return (
      <UserMessageChatThreadReference
        threadId={renderPart.part.threadId}
        title={renderPart.part.titleSnapshot}
      />
    );
  }
  if (renderPart.type === "agent") {
    return (
      <UserMessageAgentReference
        agentId={renderPart.part.agentId}
        name={renderPart.part.nameSnapshot}
        signals={renderPart.signals}
      />
    );
  }
  if (renderPart.type === "template") {
    return <UserMessageTemplateReference part={renderPart.part} />;
  }
  if (renderPart.type === "file") {
    return (
      <UserMessageFileReference
        part={renderPart.part}
        signals={renderPart.signals}
      />
    );
  }
  void (renderPart satisfies never);
  return null;
}

function UserMessageView({
  document,
  elevatedFileIds,
}: {
  document: UserMessageRenderDocument;
  elevatedFileIds: ReadonlySet<string>;
}) {
  const partOccurrences = new Map<string, number>();
  const agentRunSourceTitle = document.parts.find((renderPart) => {
    return renderPart.type === "source" && renderPart.kind === "agent";
  })?.part.titleSnapshot;
  const bodyParts = document.parts.filter(
    (renderPart): renderPart is UserMessageContentRenderPart => {
      return (
        !isUserMessageHiddenPart(renderPart.part) &&
        !isElevatedUserMessagePart(renderPart, elevatedFileIds)
      );
    },
  );
  if (bodyParts.length === 0) {
    return null;
  }
  const renderedParts: ReactNode[] = [];
  let index = 0;
  while (index < bodyParts.length) {
    const renderPart = bodyParts[index];
    if (!renderPart) {
      break;
    }
    if (renderPart.type === "feedback") {
      const feedbackParts: UserMessageFeedbackRenderPart[] = [renderPart];
      let nextIndex = index + 1;
      while (nextIndex < bodyParts.length) {
        const candidate = bodyParts[nextIndex];
        if (
          candidate?.type !== "feedback" ||
          !equalFeedbackSources(renderPart.part.source, candidate.part.source)
        ) {
          break;
        }
        feedbackParts.push(candidate);
        nextIndex += 1;
      }
      renderedParts.push(
        <UserMessageFeedbackGroup
          key={`feedback:${String(index)}`}
          parts={feedbackParts}
          agentRunSourceTitle={agentRunSourceTitle}
        />,
      );
      index = nextIndex;
      continue;
    }
    const identity = JSON.stringify(renderPart.part);
    const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
    partOccurrences.set(identity, occurrence);
    renderedParts.push(
      <UserMessagePartView
        key={`${identity}:${String(occurrence)}`}
        renderPart={renderPart}
      />,
    );
    index += 1;
  }
  return (
    <div data-structured-user-message="" className="whitespace-pre-wrap">
      {renderedParts}
    </div>
  );
}

function isElevatedUserMessagePart(
  renderPart: UserMessageRenderPart,
  elevatedFileIds: ReadonlySet<string>,
): boolean {
  return (
    renderPart.type === "file" && elevatedFileIds.has(renderPart.part.fileId)
  );
}

function UserMessageContent({
  document,
  attachments,
  onImageClick,
  leading,
}: {
  document: UserMessageRenderDocument;
  attachments: ReturnType<typeof userMessageRenderAttachments>;
  onImageClick: OpenMessageImagePreview;
  /** Sits directly left of the bubble, for example the pending spinner. */
  leading?: ReactNode;
}) {
  // Attachments read as their own object, so they all sit above the bubble
  // instead of interrupting the sentence they were dropped into. Attachments
  // without an id cannot be matched to a document part, so they stay inline.
  const elevatedAttachments = attachments.filter((attachment) => {
    return attachment.id !== null;
  });
  const elevatedFileIds = new Set(
    elevatedAttachments.flatMap((attachment) => {
      return attachment.id ? [attachment.id] : [];
    }),
  );
  const hasBody = document.parts.some((renderPart) => {
    return (
      !isUserMessageHiddenPart(renderPart.part) &&
      !isElevatedUserMessagePart(renderPart, elevatedFileIds)
    );
  });

  return (
    <>
      <UserMessageAttachments
        attachments={elevatedAttachments}
        onImageClick={onImageClick}
      />
      {hasBody ? (
        // The bubble gets its own full-width row so `leading` can sit against
        // its left edge while the bubble's `max-w-[85%]` still resolves against
        // the whole message width.
        <div className="flex w-full items-start justify-end gap-2">
          {leading}
          <ChatUserMessageBubble>
            <div className="px-4 py-3">
              <UserMessageView
                document={document}
                elevatedFileIds={elevatedFileIds}
              />
            </div>
          </ChatUserMessageBubble>
        </div>
      ) : null}
    </>
  );
}

function UserMessageTextActions({
  event,
  text,
  thread,
}: {
  event: EnrichedChatEvent & ChatInputEvent;
  text: string;
  thread: ChatPanelSignals;
}) {
  const copyEvent = useSet(thread.copyEvent$);
  const pageSignal = useGet(pageSignal$);
  const sharingPhase = useGet(thread.sharing.phase$);
  if (sharingPhase !== "idle") {
    return null;
  }

  return (
    <UserMessageActions
      showCopy
      runId={event.runId}
      onCopy={() => {
        return copyEvent({ text, attachments: [] }, pageSignal);
      }}
    />
  );
}

function WorkflowUserMessage({
  event,
  thread,
}: {
  event: EnrichedChatEvent & ChatInputEvent;
  thread: ChatPanelSignals;
}) {
  const turnOnRef = useSet(thread.locator.turnOnRef$);
  const renderPart = userMessageAnnotationRenderPart(
    event.userMessageRenderDocument,
  );
  if (renderPart?.type !== "automation") {
    return null;
  }
  const { part } = renderPart;
  const workflowBody =
    messageDocumentToDisplayText(event.userMessage)?.trim() ||
    part.automationBrief?.trim();
  const bubbleClassName =
    "rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden whitespace-pre-wrap transition-colors duration-150 bg-gray-200 text-foreground";
  const body = workflowBody ? (
    <div className={bubbleClassName}>
      <div className="px-4 py-3">{workflowBody}</div>
    </div>
  ) : null;

  return (
    <div
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className="relative group"
      ref={turnOnRef}
    >
      <ChatConversationLandingHighlight thread={thread} eventId={event.id} />
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <MessageAnnotation renderPart={renderPart} />
          {body}
          {workflowBody ? (
            <UserMessageTextActions
              event={event}
              text={workflowBody}
              thread={thread}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GoalUserMessage({
  event,
  thread,
}: {
  event: EnrichedChatEvent & ChatInputEvent;
  thread: ChatPanelSignals;
}) {
  const turnOnRef = useSet(thread.locator.turnOnRef$);
  const renderPart = userMessageAnnotationRenderPart(
    event.userMessageRenderDocument,
  );
  if (renderPart?.type !== "goal") {
    return null;
  }
  const { part } = renderPart;
  const goalBrief = part.goalBrief.trim();
  return (
    <div
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className="relative group"
      ref={turnOnRef}
    >
      <ChatConversationLandingHighlight thread={thread} eventId={event.id} />
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <MessageAnnotation renderPart={renderPart} />
          {goalBrief ? (
            <div className="rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden ring-1 ring-emerald-900/10 bg-gray-200 text-foreground">
              <div className="px-4 py-3 whitespace-pre-wrap">{goalBrief}</div>
            </div>
          ) : null}
          {goalBrief ? (
            <UserMessageTextActions
              event={event}
              text={goalBrief}
              thread={thread}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function resolvePagedUserMessageRendering({
  renderDocument,
}: {
  renderDocument: UserMessageRenderDocument | undefined;
}) {
  const canonicalUserMessage = renderDocument?.document;
  const userMessageAttachments = canonicalUserMessage
    ? userMessageFileAttachments(canonicalUserMessage)
    : undefined;
  const copyText = canonicalUserMessage
    ? (messageDocumentToPrompt(canonicalUserMessage) ?? "")
    : "";
  const clipboardAttachments = canonicalUserMessage
    ? clipboardAttachmentsFromUserMessage(
        canonicalUserMessage,
        userMessageAttachments ?? [],
      )
    : [];

  return {
    canonicalUserMessage,
    clipboardAttachments,
    copyText,
  };
}

function inputPromptRunAnchor(inputEvent: ChatInputEvent | undefined) {
  return inputEvent?.eventType === "input.prompt" && inputEvent.runId
    ? `run-${inputEvent.runId}`
    : undefined;
}

/**
 * The message is still page-local until a persistent event with the same id
 * replaces it, so the spinner subscribes on its own instead of making the whole
 * message row re-render on every optimistic change.
 */
function OptimisticSpinner({ eventId }: { eventId: string }) {
  // Streaming deltas rebuild the optimistic buffer, so compare the ids instead
  // of the set identity: a pending message keeps every other spinner idle.
  const optimisticEventIds = useGet(optimisticEventIds$, {
    equalityFn: equalSets,
  });
  // The slot repeats the bubble's own padding and line metrics so the spinner
  // centers on the first line of text however many lines the message wraps to.
  // It stays reserved when the message is confirmed, so the bubble never
  // reflows.
  return (
    <div
      aria-hidden
      className="flex shrink-0 py-3 text-[0.9375rem] leading-[1.7]"
    >
      <span className="flex h-[1.7em] w-3.5 items-center">
        {optimisticEventIds.has(eventId) ? (
          <LazySpinner
            size={14}
            data-optimistic-user-message
            className="text-muted-foreground"
          />
        ) : null}
      </span>
    </div>
  );
}

function PagedUserMessage({
  event,
  thread,
  stackedOnPrevious = false,
}: {
  event: EnrichedChatEvent;
  thread: ChatPanelSignals;
  stackedOnPrevious?: boolean;
}) {
  const turnOnRef = useSet(thread.locator.turnOnRef$);
  const inputEvent = asInputChatEvent(event);
  const renderDocument = event.userMessageRenderDocument;
  const { canonicalUserMessage, clipboardAttachments, copyText } =
    resolvePagedUserMessageRendering({
      renderDocument,
    });
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox: OpenMessageImagePreview = (attachment) => {
    openImageLightbox({
      threadId: thread.threadId,
      url: attachment.url,
      filename: attachment.filename,
      preview: attachment.signals,
      // The user's own attachment, not a published artifact: previewing it
      // offers no sharing controls.
      shareAvailable: false,
    });
  };
  const copyEvent = useSet(thread.copyEvent$);
  const sharingPhase = useGet(thread.sharing.phase$);
  const allAttachments = userMessageRenderAttachments(renderDocument);
  const canCopy =
    canonicalUserMessage !== undefined ||
    copyText.trim().length > 0 ||
    clipboardAttachments.length > 0;

  const handleCopy = () => {
    return copyEvent(
      {
        text: copyText,
        attachments: clipboardAttachments,
        ...(canonicalUserMessage ? { userMessage: canonicalUserMessage } : {}),
      },
      pageSignal,
    );
  };

  if (isRejectedGoalUserMessage(event)) {
    return null;
  }

  if (isWorkflowUserMessage(event)) {
    return <WorkflowUserMessage event={event} thread={thread} />;
  }

  if (isGoalUserMessage(event)) {
    return <GoalUserMessage event={event} thread={thread} />;
  }

  const nonContentRenderPart = userMessageAnnotationRenderPart(renderDocument);
  const annotationPart =
    nonContentRenderPart?.type === "source" ? nonContentRenderPart : undefined;
  return (
    <div
      id={inputPromptRunAnchor(inputEvent)}
      ref={turnOnRef}
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className={cn(
        "relative group",
        stackedOnPrevious && CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
      )}
    >
      <ChatConversationLandingHighlight thread={thread} eventId={event.id} />
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          {annotationPart ? (
            <MessageAnnotation renderPart={annotationPart} />
          ) : null}
          {renderDocument ? (
            <>
              <UserMessageContent
                document={renderDocument}
                attachments={allAttachments}
                onImageClick={openLightbox}
                leading={<OptimisticSpinner eventId={event.id} />}
              />
              {/* The row belongs to the bubble, not to the button inside it.
                  Sharing hides the button and a message nobody can copy has
                  none, and in both cases the next message in the burst is
                  still pulled up by the height this row holds. */}
              <UserMessageActions
                showCopy={canCopy && sharingPhase === "idle"}
                runId={sharingPhase === "idle" ? inputEvent?.runId : undefined}
                onCopy={handleCopy}
              />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type RunWorkSectionControl = Omit<RunWorkSection, "key"> & {
  readonly expanded: boolean;
  readonly onToggle: () => void;
};

type PagedAssistantGroupProps = {
  readonly group: ChatEventGroup;
  readonly thread: ChatPanelSignals;
  readonly modelChanges: ReadonlyMap<string, RunModelChange>;
  readonly runWorkSection?: RunWorkSectionControl;
  readonly runIndicatorMode?: Exclude<ThinkingIndicatorMode, null>;
  readonly statusTailEvents?: readonly EnrichedChatEvent[];
};

type PagedAssistantHistoryItem =
  | {
      readonly kind: "assistant";
      readonly event: EnrichedChatEvent;
    }
  | {
      readonly kind: "model-change";
      readonly eventId: string;
      readonly change: RunModelChange;
    };

type PagedAssistantTimelineItem =
  | PagedAssistantHistoryItem
  | {
      readonly kind: "run-work";
      readonly control: RunWorkSectionControl;
      readonly historyItems: readonly PagedAssistantHistoryItem[];
    }
  | {
      readonly kind: "run-work-main";
      readonly event: EnrichedChatEvent;
    };

function assistantTimelineItems(
  events: readonly EnrichedChatEvent[],
): PagedAssistantHistoryItem[] {
  return events.filter(isRenderableAssistantEvent).map((event) => {
    return { kind: "assistant", event };
  });
}

function foldedRunWorkTimelineItems(
  groups: readonly ChatEventGroup[],
  modelChanges: ReadonlyMap<string, RunModelChange>,
): PagedAssistantHistoryItem[] {
  return groups.flatMap((group) => {
    return group.events.flatMap((event): PagedAssistantHistoryItem[] => {
      const change = modelChanges.get(event.id);
      if (change !== undefined) {
        return [{ kind: "model-change", eventId: event.id, change }];
      }
      return isRenderableAssistantEvent(event)
        ? [{ kind: "assistant", event }]
        : [];
    });
  });
}

function buildPagedAssistantTimeline({
  group,
  modelChanges,
  runWorkSection,
}: Pick<
  PagedAssistantGroupProps,
  "group" | "modelChanges" | "runWorkSection"
>): PagedAssistantTimelineItem[] {
  const items: PagedAssistantTimelineItem[] = [];
  if (runWorkSection === undefined) {
    items.push(...assistantTimelineItems(group.events));
    return items;
  }

  const anchorIndex = group.events.findIndex((event) => {
    return event.id === runWorkSection.anchorEventId;
  });
  if (anchorIndex === -1) {
    items.push(...assistantTimelineItems(group.events));
    return items;
  }

  const historyItems: PagedAssistantHistoryItem[] = [];
  const showAllHistory = runWorkSection.expanded || !runWorkSection.collapsible;
  if (showAllHistory) {
    historyItems.push(
      ...foldedRunWorkTimelineItems(runWorkSection.hiddenGroups, modelChanges),
    );
  }
  historyItems.push(
    ...assistantTimelineItems(group.events.slice(0, anchorIndex)),
  );
  items.push({ kind: "run-work", control: runWorkSection, historyItems });
  const anchorEvent = group.events[anchorIndex];
  if (anchorEvent !== undefined) {
    items.push({
      kind: "run-work-main",
      event: anchorEvent,
    });
  }
  if (showAllHistory) {
    items.push(
      ...foldedRunWorkTimelineItems(
        runWorkSection.hiddenGroupsAfterAnchor,
        modelChanges,
      ),
    );
  }
  return items;
}

function PagedAssistantTimeline({
  items,
  thread,
  mainActions,
  workHistory = false,
}: {
  items: readonly PagedAssistantTimelineItem[];
  thread: ChatPanelSignals;
  mainActions?: ReactNode;
  workHistory?: boolean;
}) {
  return items.map((item) => {
    if (item.kind === "model-change") {
      return (
        <FoldedModelChangeDivider key={item.eventId} change={item.change} />
      );
    }
    if (item.kind === "run-work") {
      return (
        <div
          key="run-work:history"
          data-chat-run-work-history
          className={CHAT_THREAD_RESPONSE_COMPACT_STACK_CLASS}
        >
          <RunWorkSectionRow
            startTime={item.control.startTime}
            endTime={item.control.endTime}
            stepCount={item.control.stepCount}
            collapsible={item.control.collapsible}
            expanded={item.control.expanded}
            onToggle={item.control.onToggle}
          />
          {item.historyItems.length === 0 ? null : (
            <div
              data-chat-run-work-history-list
              className={cn(
                "ml-2 w-[calc(100%-0.5rem)] border-l border-border/70 pl-[15px]",
                CHAT_THREAD_RESPONSE_COMPACT_STACK_CLASS,
              )}
            >
              <PagedAssistantTimeline
                items={item.historyItems}
                thread={thread}
                workHistory
              />
            </div>
          )}
        </div>
      );
    }
    if (item.kind === "run-work-main") {
      return (
        <div
          key={item.event.id}
          data-chat-run-work-main
          className={CHAT_THREAD_RESPONSE_STACK_CLASS}
        >
          <PagedAssistantEventItem event={item.event} thread={thread} />
          {mainActions}
        </div>
      );
    }
    return (
      <PagedAssistantEventItem
        key={item.event.id}
        event={item.event}
        thread={thread}
        workHistory={workHistory}
      />
    );
  });
}

function PagedRunWorkAssistantContent({
  group,
  thread,
  modelChanges,
  runWorkSection,
  runIndicatorMode,
  statusTailEvents,
}: Pick<
  PagedAssistantGroupProps,
  | "group"
  | "thread"
  | "modelChanges"
  | "runWorkSection"
  | "runIndicatorMode"
  | "statusTailEvents"
>) {
  const timelineItems = buildPagedAssistantTimeline({
    group: {
      ...group,
      events: group.events.filter((event) => {
        return !statusTailEvents?.includes(event);
      }),
    },
    modelChanges,
    runWorkSection,
  });
  const mainEvent = runWorkSection
    ? group.events.find((event) => {
        return event.id === runWorkSection.anchorEventId;
      })
    : undefined;
  const mainActions =
    mainEvent !== undefined ? (
      <PagedGroupActions
        group={group}
        content={mainEvent.content ?? ""}
        thread={thread}
        shareEvents={[mainEvent]}
        relatedArtifacts={runWorkSection?.remainingArtifactCards}
        embedded
      />
    ) : undefined;

  return withChatScrollLayout(
    <>
      <PagedAssistantTimeline
        items={timelineItems}
        thread={thread}
        mainActions={mainActions}
      />
      {(statusTailEvents?.length ?? 0) > 0 || runIndicatorMode !== undefined ? (
        <div
          data-chat-run-status-tail
          className={CHAT_THREAD_RESPONSE_STACK_CLASS}
        >
          {statusTailEvents?.length ? (
            statusTailEvents.map((event) => {
              return (
                <PagedAssistantEventItem
                  key={event.id}
                  event={event}
                  thread={thread}
                />
              );
            })
          ) : runIndicatorMode !== undefined ? (
            <ThinkingIndicator
              thread={thread}
              mode={runIndicatorMode}
              inAssistantGroup
            />
          ) : null}
        </div>
      ) : null}
    </>,
  );
}

function PagedAssistantGroup({
  group,
  thread,
  modelChanges,
  runWorkSection,
  runIndicatorMode,
  statusTailEvents,
}: PagedAssistantGroupProps) {
  const turnOnRef = useSet(thread.locator.turnOnRef$);
  const hasRenderableEvent = group.events.some((event) => {
    return isRenderableAssistantEvent(event);
  });
  if (!hasRenderableEvent && !runWorkSection) {
    return null;
  }

  const groupElementId = `chat-event-group-${group.beginEventId}`;
  const runId = firstRunIdForEvents(group.events);
  const fullContent = group.events
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");
  const usesRunWorkPresentation =
    runWorkSection !== undefined ||
    runIndicatorMode !== undefined ||
    (statusTailEvents?.length ?? 0) > 0;

  return (
    <div
      id={groupElementId}
      ref={turnOnRef}
      data-role="assistant"
      data-chat-run-id={runId}
      data-turn-created-at={group.events[0]?.createdAt}
      className={CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS}
    >
      <ChatConversationLandingHighlight
        thread={thread}
        eventId={
          runWorkSection?.anchorEventId ??
          group.events.find(isRenderableAssistantEvent)?.id
        }
      />
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS}>
        <AssistantBubbleAvatar thread={thread} />
        <div
          className={cn(
            "relative",
            CHAT_THREAD_RESPONSE_STACK_CLASS,
            CHAT_THREAD_ASSISTANT_RESPONSE_COLUMN_CLASS,
          )}
        >
          {usesRunWorkPresentation ? (
            <PagedRunWorkAssistantContent
              group={group}
              thread={thread}
              modelChanges={modelChanges}
              runWorkSection={runWorkSection}
              runIndicatorMode={runIndicatorMode}
              statusTailEvents={statusTailEvents}
            />
          ) : (
            <PagedAssistantTimeline
              items={buildPagedAssistantTimeline({
                group,
                modelChanges,
                runWorkSection: undefined,
              })}
              thread={thread}
            />
          )}
        </div>
      </div>
      {!usesRunWorkPresentation ? (
        <PagedGroupActions
          group={group}
          content={fullContent}
          thread={thread}
          shareEvents={group.events}
        />
      ) : null}
    </div>
  );
}

function PagedAssistantEventItem({
  event,
  thread,
  workHistory = false,
}: {
  event: EnrichedChatEvent;
  thread: ChatPanelSignals;
  workHistory?: boolean;
}) {
  const retryRichEventTree = useSet(thread.retryRichEventTree$);
  const pageSignal = useGet(pageSignal$);
  const error = chatEventDisplayError(event);
  if (error) {
    return (
      <div
        className={cn(
          "min-w-0 text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere]",
          workHistory && CHAT_THREAD_WORK_HISTORY_TEXT_CLASS,
        )}
        data-chat-scroll-anchor-event-id={event.id}
        data-chat-run-id={event.runId}
      >
        <AssistantErrorContent
          error={error}
          eventId={event.id}
          failureReason={
            event.eventType === "run.failed" ? event.failureReason : undefined
          }
          thread={thread}
        />
      </div>
    );
  }

  if (
    (isChatEventContentTextType(event.eventType) && event.content) ||
    hasChatEventBodyContent(event)
  ) {
    return (
      <ChatAssistantMessageBody
        className={cn(
          CHAT_THREAD_RESPONSE_LINE_CLASS,
          CHAT_THREAD_RESPONSE_FLUSH_CLASS,
          workHistory && CHAT_THREAD_WORK_HISTORY_TEXT_CLASS,
        )}
        data-chat-scroll-anchor-event-id={event.id}
        data-chat-run-id={event.runId}
      >
        <MarkdownEventBody
          chatBubble
          className={
            workHistory ? CHAT_THREAD_WORK_HISTORY_MARKDOWN_CLASS : undefined
          }
          tree={event.tree}
          mediaPreview
          onRetry={
            event.richContentError
              ? () => {
                  detach(
                    retryRichEventTree(event, pageSignal),
                    Reason.DomCallback,
                  );
                }
              : undefined
          }
        />
      </ChatAssistantMessageBody>
    );
  }

  return null;
}

function formatCredits(value: number): string {
  return value.toLocaleString(i18n.resolvedLanguage);
}

function UsageChip({
  usage,
  title,
  ariaLabel,
  open,
  setOpen,
}: {
  usage: ChatEventUsagePayload;
  title: string;
  ariaLabel: string;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const total = formatCredits(usage.totalCredits);
  const displayRows = buildCreditUsageDisplayRows(
    usage.breakdown.flatMap((kindBreakdown) => {
      return kindBreakdown.providers.map((providerBreakdown) => {
        return {
          kind: kindBreakdown.kind,
          provider: providerBreakdown.provider,
          credits: Math.max(0, providerBreakdown.credits),
        };
      });
    }),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground/70 hover:bg-state-hover hover:text-foreground transition-colors duration-150"
            aria-label={`${ariaLabel} ${total}`}
          >
            <Coins size={16} />
            <span>{total}</span>
          </button>
        }
      />
      <PopoverContent side="bottom" align="start" className="w-72 p-3">
        <div className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>{title}</span>
          <span>{total}</span>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {displayRows.map((row) => {
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.label}
                </span>
                <span className="shrink-0 text-foreground">
                  {formatCredits(row.credits)}
                </span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RunUsageChip({
  runId,
  usage,
}: {
  runId: string;
  usage: ChatEventUsagePayload;
}) {
  const { t } = useTranslation();
  const openRunId = useGet(runUsagePopoverOpenRunId$);
  const setOpenRunId = useSet(setRunUsagePopoverOpenRunId$);

  return (
    <UsageChip
      usage={usage}
      title={t(($) => {
        return $.chat.run.creditUsage;
      })}
      ariaLabel={t(($) => {
        return $.chat.run.creditUsage;
      })}
      open={openRunId === runId}
      setOpen={(open) => {
        setOpenRunId(open ? runId : null);
      }}
    />
  );
}

type RelatedArtifactCard =
  RunWorkSectionControl["remainingArtifactCards"][number];

function relatedArtifactDisplayName(card: RelatedArtifactCard): string {
  const label = card.label?.trim();
  if (label && label !== card.signals.url) {
    return label;
  }
  const { filename, kind, url } = card.signals;
  if (filename !== url || kind !== "html") {
    return filename;
  }
  return URL.canParse(url) ? new URL(url).hostname || filename : filename;
}

function relatedArtifactHost(url: string): string | null {
  return URL.canParse(url) ? new URL(url).hostname || null : null;
}

function RelatedArtifactIcon({ kind }: { readonly kind: ArtifactKind }) {
  const Icon = kind === "image" ? Image : kind === "video" ? Video : File;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-muted-foreground transition-colors group-hover/artifact:text-foreground">
      <Icon aria-hidden size={16} />
    </span>
  );
}

function RelatedArtifactRow({ card }: { readonly card: RelatedArtifactCard }) {
  const { t } = useTranslation();
  const openArtifact = useSet(openMarkdownArtifact$);
  const name = relatedArtifactDisplayName(card);
  const host = relatedArtifactHost(card.signals.url);
  const kind = artifactFallbackSubtitle(
    card.signals.kind,
    card.signals.filename,
  );
  return (
    <Button
      type="button"
      variant="quiet"
      className="group/artifact h-auto w-full justify-start gap-3 rounded-xl px-3 py-2.5 text-left font-normal"
      aria-label={t(
        ($) => {
          return $.chat.attachments.previewFile;
        },
        { filename: name },
      )}
      title={card.signals.url}
      data-chat-run-related-artifact-url={card.signals.url}
      onClick={() => {
        openArtifact(card, "lightbox");
      }}
    >
      <RelatedArtifactIcon kind={card.signals.kind} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {kind}
          {host ? ` · ${host}` : ""}
        </span>
      </span>
      <ChevronRight
        aria-hidden
        size={16}
        className="shrink-0 text-muted-foreground/60"
      />
    </Button>
  );
}

function RelatedArtifactsDialog({
  cards,
}: {
  readonly cards: RunWorkSectionControl["remainingArtifactCards"];
}) {
  const { t } = useTranslation();
  if (cards.length === 0) {
    return null;
  }
  const title = t(($) => {
    return $.chat.run.relatedArtifacts;
  });
  const formattedCount = formatAppNumber(cards.length);
  const triggerLabel = t(
    ($) => {
      return $.chat.run.relatedArtifactCount;
    },
    {
      count: cards.length,
      formattedCount,
    },
  );
  return (
    <Dialog>
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={
                  <Button
                    type="button"
                    variant="quiet"
                    size="xs"
                    iconSize="sm"
                    className="gap-1.5 px-2 text-xs text-muted-foreground/60 tabular-nums"
                    aria-label={triggerLabel}
                    data-testid="chat-run-related-artifacts-trigger"
                  >
                    <Package />
                    <span>{triggerLabel}</span>
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="bottom">{title}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent
        aria-describedby={undefined}
        smMaxWidth="xl"
        contentClassName="flex flex-col overflow-hidden gap-0 p-0"
        data-testid="chat-run-related-artifacts-dialog"
      >
        <DialogHeader className="shrink-0 px-5 pb-4 pt-5 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold">
            <span>{title}</span>
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-gray-50 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {formattedCount}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/60 p-2">
          {cards.map((card) => {
            return <RelatedArtifactRow key={card.signals.url} card={card} />;
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RunLangfuseLink({ signals }: { readonly signals: RunDetailSignals }) {
  const { t } = useTranslation();
  const detail = useLoadable(signals.detail$);
  const url =
    detail.state === "hasData" ? detail.data?.langfuseTraceUrl : undefined;
  if (!url) {
    return null;
  }
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t(($) => {
                return $.chat.run.viewLangfuseTrace;
              })}
              className={cn(
                buttonVariants({
                  variant: "quiet",
                  size: "icon-xs",
                  iconSize: "sm",
                }),
                "text-muted-foreground/60",
              )}
            >
              <BrandLangfuse aria-hidden />
            </a>
          }
        />
        <TooltipContent side="bottom">
          {t(($) => {
            return $.chat.run.viewLangfuseTrace;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function RunLangfuseAction({
  thread,
  runId,
}: {
  readonly thread: ChatPanelSignals;
  readonly runId: string;
}) {
  const runDetails = useGet(thread.runDetails$);
  const signals = runDetails.get(runId);
  return signals ? <RunLangfuseLink signals={signals} /> : null;
}

function MessageShareAction({
  onShare,
}: {
  onShare: (revert: () => void) => void;
}) {
  const { t } = useTranslation();
  return (
    <ShareLinkButton
      onShare={onShare}
      render={({ onClick, ref }, { copied }) => {
        const copiedLabel = t(($) => {
          return $.chat.sharing.shareLinkCopied;
        });
        if (copied) {
          // The button itself confirms the copy; no toast or tooltip.
          return (
            <Button
              ref={ref}
              type="button"
              variant="quiet"
              size="xs"
              onClick={onClick}
              className="gap-1 px-1.5 text-muted-foreground"
              aria-label={copiedLabel}
              data-testid="chat-message-share"
            >
              <Check />
              {copiedLabel}
            </Button>
          );
        }
        return (
          <TooltipProvider delay={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    ref={ref}
                    type="button"
                    variant="quiet"
                    size="icon-xs"
                    iconSize="sm"
                    onClick={onClick}
                    className="text-muted-foreground/60"
                    aria-label={t(($) => {
                      return $.chat.actions.shareMessage;
                    })}
                    data-testid="chat-message-share"
                  >
                    <Share2 />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {t(($) => {
                  return $.chat.actions.shareMessage;
                })}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      }}
    />
  );
}

function PagedGroupPrimaryActions({
  firstRunId,
  thread,
  hasContent,
  usage,
  onCopy,
  onShare,
  relatedArtifacts,
}: {
  firstRunId: string | undefined;
  thread: ChatPanelSignals;
  hasContent: boolean;
  usage: ChatEventUsagePayload | undefined;
  onCopy: () => Promise<boolean>;
  onShare: ((revert: () => void) => void) | undefined;
  relatedArtifacts?: RunWorkSectionControl["remainingArtifactCards"];
}) {
  const { t } = useTranslation();
  const switches = useGet(featureSwitch$);
  const showDebugActions = switches[FeatureSwitchKey.OkouDebug];
  const showShare = switches[FeatureSwitchKey.ChatMessageShare] && onShare;
  const hasLeadingIconAction = Boolean(
    (showDebugActions && firstRunId) || hasContent,
  );
  return (
    <div
      className={cn(
        "flex items-center gap-1",
        // Icon buttons keep their 28px hit target centered around the 16px
        // glyph. Let the target overhang so the visible glyph, not its box,
        // starts on the response column.
        hasLeadingIconAction && "-ml-1.5",
      )}
      data-testid="chat-event-actions"
    >
      {showDebugActions && firstRunId && (
        <RunLangfuseAction thread={thread} runId={firstRunId} />
      )}
      {hasContent && (
        <CopyButton
          copyAction={onCopy}
          render={({ onClick, ref }, { copied }) => {
            return (
              <TooltipProvider delay={300}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        ref={ref}
                        type="button"
                        variant="quiet"
                        size="icon-xs"
                        iconSize="sm"
                        onClick={onClick}
                        className="text-muted-foreground/60"
                        aria-label={t(($) => {
                          return $.chat.actions.copyMessage;
                        })}
                      >
                        {copied ? <Check /> : <Copy />}
                      </Button>
                    }
                  />
                  <TooltipContent side="bottom">
                    {copied
                      ? t(($) => {
                          return $.chat.actions.copied;
                        })
                      : t(($) => {
                          return $.chat.actions.copyMessage;
                        })}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          }}
        />
      )}
      {showShare && <MessageShareAction onShare={showShare} />}
      {relatedArtifacts ? (
        <RelatedArtifactsDialog cards={relatedArtifacts} />
      ) : null}
      {usage && firstRunId && <RunUsageChip runId={firstRunId} usage={usage} />}
    </div>
  );
}

function PagedGroupActions({
  group,
  content,
  thread,
  shareEvents,
  relatedArtifacts,
  embedded = false,
}: {
  group: ChatEventGroup;
  content: string;
  thread: ChatPanelSignals;
  /** The assistant events this action bar shares, with their user prompt. */
  shareEvents: readonly EnrichedChatEvent[];
  relatedArtifacts?: RunWorkSectionControl["remainingArtifactCards"];
  embedded?: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
  const copyEvent = useSet(thread.copyEvent$);
  const shareMessage = useSet(thread.sharing.shareMessage$);
  const sharingPhase = useGet(thread.sharing.phase$);
  if (sharingPhase !== "idle") {
    return null;
  }

  const firstRunId = group.events.find((m) => {
    return m.runId;
  })?.runId;
  const usage = group.usage;
  const hasContent = content.length > 0;

  const handleCopy = () => {
    return copyEvent({ text: content, attachments: [] }, pageSignal);
  };
  // Only persisted output messages can be shared; streaming text has no seqId.
  const shareEventIds = shareEvents
    .filter((event) => {
      return (
        event.eventType === "output.message" &&
        event.seqId !== undefined &&
        Boolean(event.content)
      );
    })
    .map((event) => {
      return event.id;
    });
  const handleShare =
    shareEventIds.length > 0
      ? (revert: () => void) => {
          const share = async () => {
            if (!(await shareMessage(shareEventIds, pageSignal))) {
              revert();
            }
          };
          detach(share(), Reason.DomCallback, "share chat message");
        }
      : undefined;

  const actions = (
    <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS}>
      <PagedGroupPrimaryActions
        firstRunId={firstRunId}
        thread={thread}
        hasContent={hasContent}
        usage={usage}
        onCopy={handleCopy}
        onShare={handleShare}
        relatedArtifacts={relatedArtifacts}
      />
    </div>
  );
  if (embedded) {
    return actions;
  }
  return (
    <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS}>
      <div className="hidden @[900px]:block" />
      {actions}
    </div>
  );
}
