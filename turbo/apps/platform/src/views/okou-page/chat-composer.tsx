import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import {
  useComposerConnectorActions,
  type ComposerConnectorActions,
} from "./composer-connector-actions.ts";
import {
  useComposerActions,
  type ComposerActions,
} from "./composer-actions.ts";
import {
  ComposerCreateControls,
  ComposerCreatePicker,
  ComposerCreateImageModelPicker,
  ComposerCreateVideoModelPicker,
  ComposerSelectedTask,
} from "./composer-create.tsx";
import type { ComposerVoiceInputStatus } from "../../signals/okou-page/composer-voice-input.ts";
// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLoadableState,
  useLastLoadable,
  useLastResolved,
  useResolved,
  type Loadable,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { useLoadableSet } from "ccstate-react/experimental";
import { i18n } from "../../i18n/index.ts";
import { introVideoTemplateOptions } from "@okouai/core/intro-video-template";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { IntroVideoPicker } from "./intro-video-picker.tsx";
import {
  avatarSelectionLabel,
  styleSelectionLabel,
  voiceSelectionLabel,
} from "./intro-video-selection-labels.ts";
import {
  importPresentationTemplateDeck$,
  PRESENTATION_TEMPLATE_IMPORT_ACCEPT,
} from "../../signals/okou-page/presentation-template-import.ts";
import type {
  ImportedPresentationTemplateImageBuffers,
  ImportedPresentationTemplateImageSignals,
  ImportedPresentationTemplateImageSlot,
  ImportedPresentationTemplateImageState,
  ImportedPresentationTemplateLoadedImage,
  ImportedPresentationTemplatePickerItem,
  PresentationTemplateDetail,
  PresentationTemplateSummary,
} from "../../signals/okou-page/presentation-template-library.ts";
import { CHAT_UPLOAD_MAX_FILE_SIZE } from "../../lib/chat-upload.ts";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Bolt,
  Check,
  Download,
  Globe,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Lock,
  Mic,
  Monitor,
  Paperclip,
  Palette,
  Play,
  Plug,
  Plus,
  Presentation,
  Route,
  Search,
  SlidersHorizontal,
  Terminal,
  Square,
  SwatchBook,
  Trash2,
  User,
  UserCheck,
  Users,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Button } from "@okouai/ui/components/ui/button";
import { Card, CardContent } from "@okouai/ui/components/ui/card";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { cn } from "@okouai/ui/lib/utils";
import {
  surfaceVariants,
  ElapsedTime,
  getShortcutLabel,
  processShortcut,
  type KeyboardEventLike,
} from "@okouai/ui";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  tapError,
} from "../../signals/utils.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";
import type { TemplatePreviewRuntime } from "../../signals/okou-page/template-preview-runtime.ts";
import { agents$ } from "../../signals/agent.ts";
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { RestorableAttachment } from "../../signals/okou-page/chat-draft.ts";
import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import { AttachmentChips } from "./attachment-chips.tsx";
import { ImageAnnotationEditor } from "./image-annotation-editor.tsx";
import { TiptapWorkflowComposer } from "./tiptap-workflow-composer.tsx";
import { VoiceLevelWaveform } from "./voice-level-waveform.tsx";
import { computerUseIllustrationImg } from "./platform-assets.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";
import {
  COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS,
  COMPOSER_VOICE_INPUT_SHORTCUT,
} from "../../lib/composer-voice-input-shortcut.ts";
import {
  contrastRatio,
  previewPresentationHtml,
  previewTextColorOn,
  safePreviewGround,
  type PresentationPreviewDraft,
} from "./presentation-html-preview.ts";
import {
  type IllustrationTemplateItem,
  ILLUSTRATION_TEMPLATE_ITEMS,
} from "@okouai/core/illustration-template-items";
import {
  type PresentationTemplateItem,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "@okouai/core/presentation-template-items";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import {
  type VideoTemplateItem,
  VIDEO_TEMPLATE_ITEMS,
  findVideoTemplateItem,
} from "@okouai/core/video-template-items";
import {
  type WebsiteTemplateItem,
  WEBSITE_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import {
  WORKFLOW_TEMPLATE_CATEGORIES,
  WORKFLOW_TEMPLATE_ITEMS,
  findWorkflowTemplateItem,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import {
  defaultPresentationTemplateThemeId,
  presentationTemplateColorSystemId,
  toIllustrationGenerationTemplate,
  toPresentationGenerationTemplate,
  toVideoGenerationTemplate,
  toWebsiteGenerationTemplate,
} from "./composer-template-catalog.ts";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  isIntegrationManagedCustomConnector,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { getModelDisplayName } from "@okouai/core/model-display-name";
import {
  ImageModelBrandIcon,
  ModelProviderPicker,
  VideoModelBrandIcon,
  type MediaModelPanelCategory,
  type MediaModelPanelState,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ConnectorCard } from "./components/settings/connector-card.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { customConnectorTarget } from "./components/settings/custom-connector-display.ts";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import type { ConnectorConnectHandlers } from "./components/settings/launch-connector-connect.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  defaultBuiltinConnectorAccountOptions,
  defaultCustomConnectorAccountOptions,
  type DefaultConnectorAccountMutationOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { matchesConnectorSearch } from "../../signals/okou-page/settings/connectors.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import { ConnectorDirectoryDialog } from "./connector-directory-dialog.tsx";
import { resetCustomConnectorConnectInput$ } from "../../signals/okou-page/settings/custom-connectors.ts";
import {
  dismissConnectorConnectionProgress$,
  registerConnectorConnectionDialog$,
} from "../../signals/connector-connection-progress.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  sshAgentAccessSnapshot$,
  sshIdentity$,
  updateAgentSshAccess$,
  invalidateSsh$,
  sshSummary$,
} from "../../signals/ssh.ts";
import { SshLoadError } from "./ssh-load-error.tsx";
import { SshConnectorCard } from "./components/settings/ssh-connector-card.tsx";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { orgPlanCapabilities$ } from "../../signals/okou-page/org-plan-capabilities.ts";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { orgModelPolicies$ } from "../../signals/external/org-model-policies.ts";
import {
  updateDefaultImageModel$,
  updateDefaultVideoModel$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../../signals/external/user-model-preference.ts";
import {
  codexFastModeEnabled$,
  modelPickerFlyoutEnabled$,
  modelPickerMenuEnabled$,
  customConnectorMcpEnabled$,
  voiceInputV2Enabled$,
  featureSwitch$,
} from "../../signals/external/feature-switch.ts";
import { preferredChatReasoningEffort } from "../../signals/okou-page/model-reasoning-effort.ts";
import {
  selectedComputerUseHostId,
  visibleComputerUseHosts,
  OKOU_DESKTOP_DOWNLOAD_URL,
  desktopDownloadSupportStatus$,
} from "../../signals/okou-page/computer-use-hosts.ts";
import { computerUseHostsFromWorker$ } from "../../signals/shared-database.ts";
import { computerUseProductName$ } from "../../signals/branding.ts";
import {
  CONNECTOR_ACCOUNT_SEARCH_THRESHOLD,
  connectorAccountTargetKey,
} from "../../signals/okou-page/connector-accounts.ts";
import { applyUserPermissionGrants$ } from "../../signals/permission-allow/permission-allow-signals.ts";
import { activeUserPermissionGrantSnapshot } from "../../signals/user-permission-grants.ts";
import { savePermissionDraftPolicies } from "../../signals/okou-page/settings/permission-grant-save.ts";
import { PermissionsDialog } from "./components/settings/permissions-dialog.tsx";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { TemplateCardHtmlPreviewState } from "../../signals/okou-page/chat-composer.ts";
import type {
  ComposerPendingEvent,
  ComposerPrimaryAction,
  ComposerImageModelSignals,
  ComposerSignals,
  ComposerVideoModelSignals,
} from "../../signals/okou-page/composer-signals.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
  sttRecording$,
  sttStarting$,
  sttTranscribing$,
  sttVoiceLevel$,
} from "../../signals/voice-io/voice-io-stt.ts";
import { readChatMessageFromClipboard } from "../../signals/okou-page/clipboard.ts";
import { shouldUseUserMessage } from "../../signals/okou-page/user-message-document-codec.ts";
import { WebsiteTemplatePreviewDialogSlot } from "./website-template-preview-dialog.tsx";
import { ReplaceComposerDraftDialog } from "./replace-composer-draft-dialog.tsx";
import {
  AvatarTemplatePickerContent,
  AvatarTemplatePickerToolbar,
} from "./avatar-template-picker.tsx";
import { ComposerVideoOptionsChip } from "./composer-video-options.tsx";
import { ComposerPresentationOptions } from "./composer-presentation-options.tsx";
import {
  localizedWorkflowTemplate,
  localizedWorkflowTemplateCategory,
} from "./workflow-template-copy.ts";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  PUBLIC_VIDEO_MODELS,
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import {
  IMAGE_MODEL_PRICE_TIER,
  VIDEO_MODEL_PRICE_TIER,
} from "@okouai/api-contracts/contracts/media-model-price-tiers";
import {
  avatarTemplateSelection,
  toAvatarGenerationTemplate,
} from "../../signals/okou-page/avatar-template-selection.ts";
import { resolveModelFirstUserDefaultSelection } from "../../signals/okou-page/model-default-selection.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { useConnectorAccountLabel } from "./components/settings/use-connector-account-label.ts";

const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function isHappyDomTestEnvironment(): boolean {
  return (
    typeof globalThis.window !== "undefined" && "happyDOM" in globalThis.window
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ChatComposerProps {
  readonly signals: ComposerSignals;
  readonly showPendingItems?: boolean;
}

interface ComposerComputerUseHost {
  id: string;
  hostName: string;
  displayName: string;
  status: "online" | "offline";
}

interface ComposerTemplatePicker {
  readonly onChange: (value: GenerationTemplateRequest | undefined) => void;
}

interface ComposerComputerUse {
  readonly hosts: readonly ComposerComputerUseHost[];
  readonly loading: boolean;
  readonly selectedHostId: string | null;
  readonly onChange: (hostId: string | null) => void;
  readonly cloudBrowserEnabled: boolean;
  readonly cloudBrowserLoading: boolean;
  readonly onCloudBrowserChange: (enabled: boolean) => void;
  readonly downloadUrl: string;
}

interface ComposerSubmitBlocker {
  readonly message: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}

const TEMPLATE_CARD_PREVIEW_SIZE = { width: 480, height: 270 } as const;
const TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE = {
  width: 708,
  height: 398,
} as const;
const TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE = {
  width: 224,
  height: 126,
} as const;
const PRESENTATION_GALLERY_PREVIEW_BASE_URL =
  "https://static.okou.io/web/assets/presentation-gallery/2026-07-04";
const PRESENTATION_GALLERY_SLIDE_COUNT = 15;
const TEMPLATE_PREWARM_IMAGE_COUNT = 15;
const IMPORTED_PRESENTATION_TEMPLATE_EAGER_THUMBNAIL_COUNT = 16;
const ILLUSTRATION_PREWARM_IMAGE_COUNT = 24;
const ILLUSTRATION_EAGER_IMAGE_COUNT = 24;
const ILLUSTRATION_SCROLL_PREWARM_LOOKAHEAD_COUNT = 12;
const ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT = 24;
const ILLUSTRATION_CARD_PREVIEW_SIZE = {
  width: 1024,
  quality: 72,
} as const;
const ILLUSTRATION_VARIANT_THUMB_SIZE = {
  width: 96,
  height: 96,
  fit: "cover",
  quality: 65,
} as const;
const SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE = {
  width: 40,
  height: 40,
  fit: "cover",
} as const;
type TemplatePreviewImageSize = Parameters<typeof r2ImageTransformUrl>[1];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ComposerConnectorItem = PlatformConnectorCatalogStatusItem & {
  readonly authorized: boolean;
};

type ComposerCustomConnectorItem = CustomConnectorResponse & {
  readonly authorized: boolean;
};

// ---------------------------------------------------------------------------
// Queued messages strip — separate card stacked behind the composer with a
// vertical-only stagger. The composer card sits on top (z-10) and covers the
// strip's bottom edge so it reads as one tucked-behind queue layer.
// ---------------------------------------------------------------------------

// The three-bar "queue" mark leads each queued message row.
function ComposerQueueGlyph() {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center gap-[2px]"
      aria-hidden="true"
    >
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800" />
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800/60" />
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800/30" />
    </span>
  );
}

// Queued messages and automation events share a pending-item layout.
function ComposerStripRow({
  kind,
  text,
  onRemove,
  removeAriaLabel,
  cancellationRecoveryPending,
}: {
  kind: "queued" | "automation-event";
  text: string;
  onRemove?: () => void;
  removeAriaLabel: string;
  cancellationRecoveryPending?: boolean;
}) {
  const { t } = useTranslation();
  const isAutomationEvent = kind === "automation-event";
  const itemAriaLabel = isAutomationEvent
    ? t(($) => {
        return $.chat.queue.pendingAutomationEvent;
      })
    : t(($) => {
        return $.chat.queue.queuedMessage;
      });
  const aboutAriaLabel = isAutomationEvent
    ? t(($) => {
        return $.chat.queue.aboutAutomationEvent;
      })
    : t(($) => {
        return $.chat.queue.aboutQueuedMessage;
      });
  const itemTitle = isAutomationEvent
    ? t(($) => {
        return $.chat.queue.automationEvent;
      })
    : t(($) => {
        return $.chat.queue.queuedMessage;
      });
  const itemDescription = cancellationRecoveryPending
    ? t(($) => {
        return $.chat.queue.cancellationRecoveryPending;
      })
    : isAutomationEvent
      ? t(($) => {
          return $.chat.queue.automationEventDescription;
        })
      : t(($) => {
          return $.chat.queue.queuedMessageDescription;
        });
  return (
    <div
      role="listitem"
      aria-label={itemAriaLabel}
      className="group flex items-center gap-2 rounded-md pl-2 pr-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-state-hover"
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-emerald-800 transition-colors hover:bg-state-selected-hover focus-visible:bg-state-selected-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={aboutAriaLabel}
          >
            {isAutomationEvent ? (
              <Bolt size={16} aria-hidden="true" />
            ) : (
              <ComposerQueueGlyph />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-80 rounded-lg p-3"
        >
          <p className="text-xs font-semibold text-foreground">{itemTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {itemDescription}
          </p>
          <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-2 text-sm text-foreground">
            {text}
          </div>
        </PopoverContent>
      </Popover>
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <IconTooltipButton
        type="button"
        className="shrink-0 rounded-lg p-1.5 text-muted-foreground/45 transition-colors hover:bg-state-selected-hover hover:text-sidebar-foreground focus-visible:bg-state-selected-hover focus-visible:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onRemove?.();
        }}
        aria-label={removeAriaLabel}
      >
        <X size={16} />
      </IconTooltipButton>
    </div>
  );
}

function PendingItemsStripHeader({
  label,
  cancellationRecoveryPending,
}: {
  label: string | null;
  cancellationRecoveryPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="px-5 pt-3 pb-2">
      {label ? <p className="text-sm text-muted-foreground">{label}</p> : null}
      {cancellationRecoveryPending ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-1 text-xs text-muted-foreground"
        >
          {t(($) => {
            return $.chat.queue.cancellationRecoveryPending;
          })}
        </p>
      ) : null}
    </div>
  );
}

function PendingItemsStrip({ signals }: { signals: ComposerSignals }) {
  const { t } = useTranslation();
  const pendingEvents =
    useLastResolved(signals.queue.pendingEvents$) ??
    ([] satisfies readonly ComposerPendingEvent[]);
  const cancellationRecoveryPending =
    useLastResolved(signals.queue.cancellationRecoveryPending$) ?? false;
  const removeQueuedMessage = useSet(signals.queue.removeQueuedMessage$);
  const removeAutomationEvent = useSet(signals.queue.removeAutomationEvent$);
  const pageSignal = useGet(pageSignal$);
  const queued = pendingEvents.filter((event) => {
    return event.kind === "message";
  });
  const events = pendingEvents.filter((event) => {
    return event.kind === "automation";
  });
  const count = queued.length + events.length;
  const messageLabel = t(
    ($) => {
      return $.chat.queue.message;
    },
    {
      count: queued.length,
    },
  );
  const eventLabel = t(
    ($) => {
      return $.chat.queue.event;
    },
    {
      count: events.length,
    },
  );
  const label =
    queued.length > 0 && events.length > 0
      ? t(
          ($) => {
            return $.chat.queue.itemsWaitingTogether;
          },
          {
            messages: messageLabel,
            events: eventLabel,
          },
        )
      : t(
          ($) => {
            return $.chat.queue.itemsWaiting;
          },
          {
            items: queued.length > 0 ? messageLabel : eventLabel,
          },
        );
  if (count === 0) {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <div className="relative z-0 mx-5 -mb-6 overflow-hidden rounded-xl bg-gray-50 dark:bg-gray-100">
      <PendingItemsStripHeader
        label={label}
        cancellationRecoveryPending={cancellationRecoveryPending}
      />
      <div className="max-h-[200px] overflow-y-auto px-2 pb-7 pt-1" role="list">
        {queued.map((item) => {
          return (
            <ComposerStripRow
              key={item.id}
              kind="queued"
              text={item.text}
              onRemove={() => {
                detach(
                  removeQueuedMessage(item.id, pageSignal),
                  Reason.DomCallback,
                );
              }}
              removeAriaLabel={t(($) => {
                return $.chat.queue.removeQueuedMessage;
              })}
              cancellationRecoveryPending={cancellationRecoveryPending}
            />
          );
        })}
        {events.map((event) => {
          return (
            <ComposerStripRow
              key={event.id}
              kind="automation-event"
              text={
                event.text ||
                t(($) => {
                  return $.chat.queue.automationEvent;
                })
              }
              onRemove={() => {
                detach(
                  removeAutomationEvent(event.id, pageSignal),
                  Reason.DomCallback,
                );
              }}
              removeAriaLabel={t(($) => {
                return $.chat.queue.skipAutomationEvent;
              })}
              cancellationRecoveryPending={cancellationRecoveryPending}
            />
          );
        })}
      </div>
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Connector sub-components
// ---------------------------------------------------------------------------

function isSelectedPresentationTemplate(
  item: PresentationTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "presentation" &&
    value.selection.templateId === item.templateId
  );
}

function toImportedPresentationGenerationTemplate(
  template: PresentationTemplateSummary,
): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      templateId: formatUserPresentationTemplateId(template.id),
      ...(template.coverUrl === null ? {} : { previewUrl: template.coverUrl }),
    },
  };
}

function selectedImportedPresentationTemplate(
  value: GenerationTemplateRequest | undefined,
  importedTemplates: readonly PresentationTemplateSummary[],
): PresentationTemplateSummary | undefined {
  if (value?.type !== "presentation") {
    return undefined;
  }
  return importedTemplates.find((template) => {
    return (
      value.selection.templateId ===
      formatUserPresentationTemplateId(template.id)
    );
  });
}

function selectedPresentationTemplateItem(
  value: GenerationTemplateRequest | undefined,
): PresentationTemplateItem | undefined {
  if (value?.type !== "presentation") {
    return undefined;
  }
  return PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return isSelectedPresentationTemplate(item, value);
  });
}

function isSelectedIllustrationTemplate(
  item: IllustrationTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "illustration" &&
    value.selection.illustrationStyleId === item.illustrationStyleId
  );
}

function selectedIllustrationTemplateItem(
  value: GenerationTemplateRequest | undefined,
): IllustrationTemplateItem | undefined {
  if (value?.type !== "illustration") {
    return undefined;
  }
  return ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
    return isSelectedIllustrationTemplate(item, value);
  });
}

function isSelectedVideoTemplate(
  item: VideoTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "video" &&
    findVideoTemplateItem(value.selection.stylePresetId)?.id === item.id
  );
}

/**
 * A template names the look, and nothing else. Every text-to-video parameter,
 * the model included, now belongs to the run: the model comes from the thread
 * pin and the member default, and the rest from the composer's own settings
 * chip, so nothing about a run is frozen into the message that started it.
 */
function selectedVideoTemplateItem(
  value: GenerationTemplateRequest | undefined,
): VideoTemplateItem | undefined {
  if (value?.type !== "video") {
    return undefined;
  }
  return findVideoTemplateItem(value.selection.stylePresetId);
}

function isSelectedWorkflowTemplate(
  item: WorkflowTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "workflow" && value.selection.workflowTemplateId === item.id
  );
}

function toWorkflowGenerationTemplate(
  item: WorkflowTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "workflow",
    selection: { workflowTemplateId: item.id },
  };
}

function selectedWorkflowTemplateItem(
  value: GenerationTemplateRequest | undefined,
): WorkflowTemplateItem | undefined {
  if (value?.type !== "workflow") {
    return undefined;
  }
  return findWorkflowTemplateItem(value.selection.workflowTemplateId);
}

function workflowTemplateMatchesSearch(
  item: WorkflowTemplateItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  // Both wordings are searchable: the reader types in their own language, and
  // connector names stay English in every locale.
  const copy = localizedWorkflowTemplate(item);
  const searchable = [
    item.title,
    item.id,
    item.description,
    copy.title,
    copy.description,
    item.connectorSlugs.join(" "),
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function isSelectedWebsiteTemplate(
  item: WebsiteTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "website" &&
    findWebsiteTemplateItem(value.selection.websiteTemplateId)?.id === item.id
  );
}

function selectedWebsiteTemplateItem(
  value: GenerationTemplateRequest | undefined,
): WebsiteTemplateItem | undefined {
  if (value?.type !== "website") {
    return undefined;
  }
  return findWebsiteTemplateItem(value.selection.websiteTemplateId);
}

function websiteTemplateCardImageUrl(item: WebsiteTemplateItem): string {
  return r2ImageTransformUrl(item.previewImageUrl, TEMPLATE_CARD_PREVIEW_SIZE);
}

function playVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  detach(video.play(), Reason.DomCallback);
}

function markVideoTemplatePreviewPlaying(
  video: HTMLVideoElement | null,
  playing: boolean,
): void {
  if (!video) {
    return;
  }
  video.dataset.previewPlaying = playing ? "true" : "false";
}

function resetVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.pause();
  video.currentTime = 0;
  markVideoTemplatePreviewPlaying(video, false);
}

function toggleVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video || (!video.paused && !video.ended)) {
    return;
  }
  playVideoTemplatePreview(video);
}

function videoTemplatePosterImage(item: VideoTemplateItem): string {
  if (item.cardPreviewImage !== undefined) {
    return r2ImageTransformUrl(
      item.cardPreviewImage,
      TEMPLATE_CARD_PREVIEW_SIZE,
    );
  }
  return r2ImageTransformUrl(item.previewImage, TEMPLATE_CARD_PREVIEW_SIZE);
}

function VideoTemplatePreview({ item }: { item: VideoTemplateItem }) {
  const { t } = useTranslation();
  const posterImage = videoTemplatePosterImage(item);
  return (
    <div
      data-video-template-preview=""
      className="group/video-template-preview relative h-full w-full overflow-hidden bg-muted"
      onMouseEnter={(event) => {
        toggleVideoTemplatePreview(event.currentTarget.querySelector("video"));
      }}
      onMouseLeave={(event) => {
        resetVideoTemplatePreview(event.currentTarget.querySelector("video"));
      }}
    >
      <video
        poster={posterImage}
        className="peer h-full w-full object-cover"
        preload="none"
        playsInline
        muted
        loop
        onPlaying={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, true);
        }}
        onPause={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, false);
        }}
        onEnded={(event) => {
          resetVideoTemplatePreview(event.currentTarget);
        }}
        onError={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, false);
        }}
      >
        <source src={item.previewWebm} type="video/webm; codecs=vp9" />
        <source src={item.previewVideo} type="video/mp4" />
      </video>
      <img
        src={posterImage}
        alt=""
        aria-hidden="true"
        data-video-template-poster=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200 peer-data-[preview-playing=true]:opacity-0"
      />
      <IconTooltipButton
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.playVideo;
          },
          {
            title: item.title,
          },
        )}
        className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white opacity-100 transition-colors duration-200 hover:bg-black/25 focus-visible:bg-black/25 focus-visible:outline-none peer-data-[preview-playing=true]:pointer-events-none peer-data-[preview-playing=true]:!opacity-0"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleVideoTemplatePreview(
            event.currentTarget.parentElement?.querySelector("video") ?? null,
          );
        }}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-template-preview:scale-105">
          <Play size={20} />
        </span>
      </IconTooltipButton>
    </div>
  );
}

/**
 * Soft, cool-tinted card shadow matching the home chat composer
 * (`--okou-card-shadow`). The token is scoped to `.okou-app`, but the template
 * picker renders through a Base UI portal on `document.body` — outside that
 * scope — so the value is inlined here instead of referencing the CSS var.
 * Replaces Tailwind `shadow-sm`, whose hard black tint reads muddy on white.
 */
const TEMPLATE_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";

/**
 * Gallery tile. Hover feedback comes from the scrim and the Use pill alone —
 * the card already carries a hairline border, so a hover ring only doubled it.
 * The ring is reserved for the selected state, offset so it is drawn outside
 * the card and keeps a gap from the artwork.
 */
const TEMPLATE_TILE_WRAPPER = "group/tile relative cursor-pointer";
const TEMPLATE_TILE_RING =
  "rounded-xl ring-offset-1 ring-offset-card transition-shadow duration-150";
const TEMPLATE_TILE_RING_SELECTED = "ring-1 ring-primary";
const TEMPLATE_TILE_MEDIA =
  "relative overflow-hidden border border-border bg-muted";
const TEMPLATE_TILE_SCRIM =
  "pointer-events-none absolute inset-x-0 bottom-0 z-[15] h-14 bg-gradient-to-t from-black/45 to-transparent opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100";
const TEMPLATE_TILE_USE =
  "absolute bottom-2 right-2 z-20 h-[30px] rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-100 transition-opacity duration-150 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:group-hover/tile:opacity-100";
// Caption metrics track the illustration card: same text size, and enough
// breathing room under the artwork that the title never crowds it.
const TEMPLATE_TILE_CAPTION = "flex items-baseline gap-2 px-2 pb-2 pt-2";
const TEMPLATE_TILE_NAME =
  "min-w-0 truncate text-sm font-medium leading-5 text-foreground";

function VideoTemplateCard({
  item,
  selected,
  requiresPro,
  onSelect,
}: {
  item: VideoTemplateItem;
  selected: boolean;
  requiresPro: boolean;
  onSelect: (item: VideoTemplateItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={TEMPLATE_TILE_WRAPPER}>
      <div
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          "aspect-[16/9]",
          selected && TEMPLATE_TILE_RING_SELECTED,
        )}
      >
        <VideoTemplatePreview item={item} />
        {selected ? (
          <span className="pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check size={14} />
          </span>
        ) : null}
        <button
          type="button"
          aria-label={
            requiresPro
              ? t(
                  ($) => {
                    return $.artifacts.templates.viewVideoPlans;
                  },
                  {
                    title: item.title,
                  },
                )
              : t(
                  ($) => {
                    return $.artifacts.templates.selectVideo;
                  },
                  {
                    title: item.title,
                  },
                )
          }
          aria-pressed={requiresPro ? undefined : selected}
          onClick={() => {
            onSelect(item);
          }}
          className={cn(
            TEMPLATE_TILE_USE,
            requiresPro && "inline-flex items-center gap-1 !opacity-100",
          )}
        >
          {requiresPro ? <Lock size={12} aria-hidden="true" /> : null}
          {requiresPro
            ? t(($) => {
                return $.artifacts.templates.needPro;
              })
            : t(($) => {
                return $.artifacts.templates.use;
              })}
        </button>
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <p className={TEMPLATE_TILE_NAME}>{item.title}</p>
      </div>
    </div>
  );
}

function VideoTemplateGrid({
  items,
  value,
  videoGenerationAllowed,
  onSelect,
}: {
  items: readonly VideoTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  videoGenerationAllowed: boolean;
  onSelect: (item: VideoTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <VideoTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedVideoTemplate(item, value)}
            requiresPro={!videoGenerationAllowed}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function WebsiteTemplateCard({
  item,
  selected,
  onSelect,
  onPreview,
}: {
  item: WebsiteTemplateItem;
  selected: boolean;
  onSelect: (item: WebsiteTemplateItem) => void;
  onPreview: (item: WebsiteTemplateItem) => void;
}) {
  const { t } = useTranslation();
  const previewImageUrl = websiteTemplateCardImageUrl(item);
  const preview = () => {
    onPreview(item);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.templates.previewWebsite;
        },
        {
          title: item.title,
        },
      )}
      onClick={preview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          preview();
        }
      }}
      className={cn(
        TEMPLATE_TILE_WRAPPER,
        "cursor-zoom-in focus-visible:outline-none",
      )}
    >
      <div
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          "aspect-[16/9] group-focus-visible/tile:ring-1 group-focus-visible/tile:ring-ring",
          selected && TEMPLATE_TILE_RING_SELECTED,
        )}
      >
        <img
          alt={t(
            ($) => {
              return $.artifacts.templates.websitePreview;
            },
            {
              title: item.title,
            },
          )}
          title={t(
            ($) => {
              return $.artifacts.templates.websitePreview;
            },
            {
              title: item.title,
            },
          )}
          src={previewImageUrl}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          draggable={false}
          className="pointer-events-none h-full w-full bg-background object-cover"
        />
        <div className={TEMPLATE_TILE_SCRIM} />
        {selected ? (
          <span className="pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check size={14} />
          </span>
        ) : null}
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectWebsite;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
          }}
          className={cn(TEMPLATE_TILE_USE, "cursor-pointer")}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <p className={TEMPLATE_TILE_NAME}>{item.title}</p>
      </div>
    </div>
  );
}

function WebsiteTemplateGrid({
  items,
  value,
  onSelect,
  onPreview,
}: {
  items: readonly WebsiteTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: WebsiteTemplateItem) => void;
  onPreview: (item: WebsiteTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <WebsiteTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedWebsiteTemplate(item, value)}
            onSelect={onSelect}
            onPreview={onPreview}
          />
        );
      })}
    </div>
  );
}

function WorkflowTemplateConnectorIcons({
  connectorSlugs,
  compact = false,
  limit = compact ? 3 : 5,
  withDivider = false,
}: {
  connectorSlugs: readonly ConnectorSlug[];
  compact?: boolean;
  limit?: number;
  withDivider?: boolean;
}) {
  const catalogConnectors = useLastResolved(
    connectorCatalogStatus$,
  )?.connectors;
  const visibleConnectors = connectorSlugs.flatMap((connectorSlug) => {
    const connector = catalogConnectors?.find((candidate) => {
      return candidate.slug === connectorSlug;
    });
    return connector ? [connector] : [];
  });
  if (visibleConnectors.length === 0) {
    return null;
  }

  const displayedConnectors = visibleConnectors.slice(0, limit);
  const remainingCount = visibleConnectors.length - displayedConnectors.length;
  return (
    <>
      {withDivider ? (
        <span className="h-3.5 w-px shrink-0 bg-divider/70" />
      ) : null}
      <span
        className={cn(
          "flex min-w-0 items-center",
          compact ? "gap-1" : "gap-1.5",
        )}
      >
        {displayedConnectors.map((connector) => {
          return (
            <span
              key={connector.slug}
              className={cn(
                "flex shrink-0 items-center justify-center border border-border/60 bg-background",
                compact ? "h-5 w-5 rounded" : "h-7 w-7 rounded-md",
              )}
            >
              <ConnectorIcon icon={connector.icon} size={compact ? 12 : 14} />
            </span>
          );
        })}
        {remainingCount > 0 ? (
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded border border-border/60 bg-background text-[10px] font-medium text-muted-foreground",
              compact ? "h-5 min-w-5 px-1" : "h-7 min-w-7 px-1.5",
            )}
          >
            +{remainingCount}
          </span>
        ) : null}
      </span>
    </>
  );
}

function WorkflowTemplateCard({
  item,
  selected,
  onSelect,
}: {
  item: WorkflowTemplateItem;
  selected: boolean;
  onSelect: (item: WorkflowTemplateItem) => void;
}) {
  const { t } = useTranslation();
  const copy = localizedWorkflowTemplate(item);
  return (
    <div
      className={cn(
        "group/tile flex flex-col border border-border bg-card p-4",
        TEMPLATE_CARD_SHADOW,
        TEMPLATE_TILE_RING,
        selected && TEMPLATE_TILE_RING_SELECTED,
      )}
    >
      <p className="text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {copy.description}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-3.5">
        <WorkflowTemplateConnectorIcons
          connectorSlugs={item.connectorSlugs}
          limit={4}
        />
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectWorkflow;
            },
            {
              title: copy.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item);
          }}
          className={cn(
            "ml-auto h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-brand-text"
              : "border-border bg-background text-foreground hover:bg-state-hover",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

// Resolves the workflow template tab's data in one place: the persona pills
// present in the catalog, the active pill (falling back to "all"), and the
// items after both the pill and the search filter. Kept out of
// TemplatePickerDialog so that component stays under its complexity budget.
function resolveWorkflowCatalog({
  categoryFilter,
  search,
}: {
  categoryFilter: string;
  search: string;
}): ResolvedWorkflowTemplateCatalog {
  const pills = WORKFLOW_TEMPLATE_CATEGORIES.filter((categoryName) => {
    return WORKFLOW_TEMPLATE_ITEMS.some((item) => {
      return item.category === categoryName;
    });
  });
  const active = pills.includes(categoryFilter) ? categoryFilter : "all";
  const items = WORKFLOW_TEMPLATE_ITEMS.filter((item) => {
    const matchesCategory = active === "all" || item.category === active;
    return matchesCategory && workflowTemplateMatchesSearch(item, search);
  });
  return { pills, active, items };
}

interface ResolvedWorkflowTemplateCatalog {
  pills: readonly string[];
  active: string;
  items: readonly WorkflowTemplateItem[];
}

// Persona pill filter for the workflow template tab, styled like the in-app
// Ideas & Use Cases gallery: an "All" pill plus one pill per persona.
function WorkflowTemplatePillRow({
  pills,
  active,
  onSelect,
}: {
  pills: readonly string[];
  active: string;
  onSelect: (category: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-6">
      {["all", ...pills].map((pill) => {
        const isActive = active === pill;
        return (
          <button
            key={pill}
            type="button"
            aria-pressed={isActive}
            className={cn(
              "h-7 shrink-0 rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors cursor-pointer",
              isActive
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
            onClick={() => {
              onSelect(pill);
            }}
          >
            {pill === "all"
              ? t(($) => {
                  return $.artifacts.templates.all;
                })
              : localizedWorkflowTemplateCategory(pill)}
          </button>
        );
      })}
    </div>
  );
}

// Renders the (already search + pill filtered) templates as a flat grid.
// Categorization is handled by the persona pill row above, so there are no
// per-persona section headers — items stay in catalog order (General first)
// so related cards still cluster.
function WorkflowTemplateGrid({
  items,
  value,
  onSelect,
}: {
  items: readonly WorkflowTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: WorkflowTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <WorkflowTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedWorkflowTemplate(item, value)}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function TemplateEmptyPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <div className="flex max-w-xl flex-col items-center">
        <Search className="mb-4 h-8 w-8" />
        <p className="text-sm font-semibold text-muted-foreground">
          {t(($) => {
            return $.artifacts.templates.noMatches;
          })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground/80">
          {t(($) => {
            return $.artifacts.templates.tryDifferentSearch;
          })}
        </p>
      </div>
    </div>
  );
}

function presentationTemplateSlideCount(
  item: PresentationTemplateItem,
): number {
  return Math.max(item.slideCount ?? item.previewImages.length, 1);
}

function presentationTemplateThemedCardPreviewSource(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption | undefined,
): string | undefined {
  if (theme === undefined) {
    return item.cardPreviewImage;
  }
  return item.cardPreviewImagesByTheme?.[theme.id] ?? item.cardPreviewImage;
}

function presentationTemplateCardSlideImage(
  item: PresentationTemplateItem,
  index: number,
  theme?: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  const cardPreviewSource =
    index === 0
      ? presentationTemplateThemedCardPreviewSource(item, theme)
      : undefined;
  if (cardPreviewSource !== undefined) {
    return r2ImageTransformUrl(cardPreviewSource, size);
  }
  return presentationTemplateGallerySlideImage(item, index, size);
}

function presentationTemplateGallerySlideImage(
  item: PresentationTemplateItem,
  index: number,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  return r2ImageTransformUrl(
    presentationTemplateGallerySlideUrl(item, index),
    size,
  );
}

function presentationTemplateGallerySlideUrl(
  item: PresentationTemplateItem,
  index: number,
): string {
  const safeIndex = Math.max(
    0,
    Math.min(index, PRESENTATION_GALLERY_SLIDE_COUNT - 1),
  );
  const slideNumber = String(safeIndex + 1).padStart(3, "0");
  return `${PRESENTATION_GALLERY_PREVIEW_BASE_URL}/${item.slug}/slide-${slideNumber}.webp`;
}

function presentationTemplateHighResolutionSlideImage(
  item: PresentationTemplateItem,
  index: number,
  theme: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE,
): string {
  if (index === 0) {
    return presentationTemplateCardSlideImage(item, index, theme, size);
  }
  return presentationTemplateGallerySlideImage(item, index, size);
}

function presentationTemplateDetailSlideImageSource(
  item: PresentationTemplateItem,
  index: number,
  theme: PresentationTemplateThemeOption,
  htmlPreviewFailed: boolean,
): string {
  if (index === 0) {
    return (
      presentationTemplateThemedCardPreviewSource(item, theme) ??
      presentationTemplateGallerySlideUrl(item, index)
    );
  }
  if (htmlPreviewFailed) {
    return presentationTemplateGallerySlideUrl(item, index);
  }
  return (
    item.previewImages[index] ??
    presentationTemplateGallerySlideUrl(item, index)
  );
}

function prewarmTemplatePreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): void {
  if (typeof Image === "undefined") {
    return;
  }

  const cachedImage = runtime.imagePreloads.get(url);
  if (cachedImage !== undefined) {
    return;
  }

  const image = new Image();
  image.decoding = "async";
  image.loading = "eager";
  image.fetchPriority = "high";
  image.src = url;
  runtime.imagePreloads.set(url, image);
  if (image.decode !== undefined) {
    detach(bestEffort(image.decode()), Reason.DomCallback);
  }
}

function prewarmTemplatePreviewImages(
  runtime: TemplatePreviewRuntime,
  imageUrls: readonly string[],
  count = TEMPLATE_PREWARM_IMAGE_COUNT,
): void {
  for (const imageUrl of [...new Set(imageUrls)].slice(0, count)) {
    prewarmTemplatePreviewImage(runtime, imageUrl);
  }
}

function presentationPreviewImageUrlsForItems(
  items: readonly PresentationTemplateItem[],
  themeIdBySlug: Readonly<Record<string, string>> = {},
): string[] {
  return items.map((item) => {
    const theme = findPresentationTemplateTheme(
      themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
    );
    return presentationTemplateCardSlideImage(item, 0, theme);
  });
}

function illustrationPreviewImageUrlsForItems({
  items,
  variantIndexBySlug,
}: {
  items: readonly IllustrationTemplateItem[];
  variantIndexBySlug: Readonly<Record<string, number>>;
}): string[] {
  return items.map((item) => {
    const images = item.previewImages;
    const activeIndex = Math.max(
      0,
      Math.min(variantIndexBySlug[item.slug] ?? 0, images.length - 1),
    );
    return illustrationHeroImageUrl(images[activeIndex] ?? item.previewImage);
  });
}

function videoPreviewImageUrlsForItems(
  items: readonly VideoTemplateItem[],
): string[] {
  return items.map((item) => {
    return videoTemplatePosterImage(item);
  });
}

function websitePreviewImageUrlsForItems(
  items: readonly WebsiteTemplateItem[],
): string[] {
  return items.map((item) => {
    return websiteTemplateCardImageUrl(item);
  });
}

function initialTemplatePreviewImageUrlsForCategory({
  category,
  presentationThemeIdBySlug,
}: {
  category: string;
  presentationThemeIdBySlug?: Readonly<Record<string, string>>;
}): string[] {
  if (category === "slides") {
    return presentationPreviewImageUrlsForItems(
      PRESENTATION_TEMPLATE_PICKER_ITEMS,
      presentationThemeIdBySlug,
    );
  }
  if (category === "illustration") {
    return illustrationPreviewImageUrlsForItems({
      items: ILLUSTRATION_TEMPLATE_ITEMS,
      variantIndexBySlug: {},
    });
  }
  if (category === "video") {
    return videoPreviewImageUrlsForItems(VIDEO_TEMPLATE_ITEMS);
  }
  if (category === "website") {
    return websitePreviewImageUrlsForItems(WEBSITE_TEMPLATE_ITEMS);
  }
  return [];
}

function templatePreviewPrewarmImageCountForCategory(category: string): number {
  if (category === "illustration") {
    return ILLUSTRATION_PREWARM_IMAGE_COUNT;
  }
  return TEMPLATE_PREWARM_IMAGE_COUNT;
}

function prewarmIllustrationPreviewImagesNearScroll({
  items,
  runtime,
  scrollContainer,
  variantIndexBySlug,
}: {
  items: readonly IllustrationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  scrollContainer: HTMLElement;
  variantIndexBySlug: Readonly<Record<string, number>>;
}): void {
  const scrollableHeight =
    scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (items.length === 0 || scrollableHeight <= 0) {
    return;
  }

  const progress = Math.min(
    1,
    Math.max(0, scrollContainer.scrollTop / scrollableHeight),
  );
  const lookaheadIndex =
    Math.floor(progress * items.length) +
    ILLUSTRATION_SCROLL_PREWARM_LOOKAHEAD_COUNT;
  const bucket = Math.floor(
    lookaheadIndex / ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
  );
  const startIndex = Math.min(
    items.length,
    Math.max(
      ILLUSTRATION_PREWARM_IMAGE_COUNT,
      bucket * ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
    ),
  );
  const firstPrewarmItem = items[startIndex];
  const key = [
    String(items.length),
    String(bucket),
    firstPrewarmItem?.slug ?? "",
  ].join(":");
  if (scrollContainer.dataset.illustrationPreviewPrewarmBucket === key) {
    return;
  }
  scrollContainer.dataset.illustrationPreviewPrewarmBucket = key;

  prewarmTemplatePreviewImages(
    runtime,
    illustrationPreviewImageUrlsForItems({
      items: items.slice(
        startIndex,
        startIndex + ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
      ),
      variantIndexBySlug,
    }),
    ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
  );
}

interface PresentationTemplateThemeOption {
  readonly id: string;
  readonly group: "multi-accent" | "single-accent";
  readonly colors: readonly [
    bg: string,
    surface: string,
    ink: string,
    inkSoft: string,
    accent: string,
    support1: string,
    support2: string,
    support3: string,
    placeholder: string,
  ];
}

const PRESENTATION_TEMPLATE_THEME_OPTIONS = [
  {
    id: "prism",
    group: "multi-accent",
    colors: [
      "#FFFFFF",
      "#F7F7FA",
      "#1A1726",
      "#5C5870",
      "#7257E6",
      "#FF6B4A",
      "#AEE63E",
      "#3FA9F5",
      "#ECECF2",
    ],
  },
  {
    id: "carnival",
    group: "multi-accent",
    colors: [
      "#FFFDF7",
      "#FFFFFF",
      "#221C14",
      "#5E564A",
      "#FF7A1A",
      "#E5388E",
      "#F5B73E",
      "#1FB6A6",
      "#EFEADF",
    ],
  },
  {
    id: "pop-art",
    group: "multi-accent",
    colors: [
      "#111016",
      "#1B1A22",
      "#F4F2FA",
      "#A09CB0",
      "#3D7BFF",
      "#FF3D9A",
      "#C6FF4A",
      "#FF7A1A",
      "#26242E",
    ],
  },
  {
    id: "warm-sand",
    group: "single-accent",
    colors: [
      "#FFFDF8",
      "#FFFFFF",
      "#262626",
      "#5A5A5A",
      "#F19B3A",
      "#8DACE5",
      "#DDB8D9",
      "#516049",
      "#ECECEC",
    ],
  },
  {
    id: "bauhaus-primary",
    group: "single-accent",
    colors: [
      "#F5F1E6",
      "#FFFFFF",
      "#1A1A1A",
      "#4A4A4A",
      "#E63327",
      "#2C5BD6",
      "#F2B705",
      "#1A1A1A",
      "#E2DDD0",
    ],
  },
  {
    id: "nordic-frost",
    group: "single-accent",
    colors: [
      "#FBFCFD",
      "#FFFFFF",
      "#1F2933",
      "#5B6B7B",
      "#3E8EDE",
      "#7BC6C9",
      "#B8C4D0",
      "#1F2933",
      "#E8EDF1",
    ],
  },
  {
    id: "forest-editorial",
    group: "single-accent",
    colors: [
      "#F7F6F1",
      "#FFFFFF",
      "#1E2B22",
      "#4F5C52",
      "#5B7553",
      "#C97B4A",
      "#E4DFD0",
      "#1E2B22",
      "#E6E8E1",
    ],
  },
  {
    id: "coral-studio",
    group: "single-accent",
    colors: [
      "#FFF9F6",
      "#FFFFFF",
      "#3A2A26",
      "#6E5B55",
      "#FF6F5E",
      "#FFB199",
      "#2BB3A3",
      "#3A2A26",
      "#F0E7E2",
    ],
  },
  {
    id: "slate-corporate",
    group: "single-accent",
    colors: [
      "#FFFFFF",
      "#F6F8FB",
      "#16243B",
      "#5A6678",
      "#2F5BD0",
      "#6E8BB8",
      "#F0A03A",
      "#16243B",
      "#E9EDF3",
    ],
  },
  {
    id: "terracotta-clay",
    group: "single-accent",
    colors: [
      "#FBF4EC",
      "#FFFFFF",
      "#3B2A20",
      "#6B5546",
      "#C36A3F",
      "#D9A441",
      "#7A7A52",
      "#EAD9C6",
      "#ECE0D2",
    ],
  },
  {
    id: "berry-pop",
    group: "single-accent",
    colors: [
      "#FFFAFC",
      "#FFFFFF",
      "#2E1A2C",
      "#6A5566",
      "#D63A8E",
      "#8E5BD0",
      "#F4B8D4",
      "#2E1A2C",
      "#F0E6EC",
    ],
  },
  {
    id: "citrus-fresh",
    group: "single-accent",
    colors: [
      "#FFFFFB",
      "#FFFFFF",
      "#232318",
      "#5C5C4E",
      "#FF8A1E",
      "#FFD23E",
      "#8FB339",
      "#4FA3A3",
      "#EDEDE3",
    ],
  },
  {
    id: "mauve-dusk",
    group: "single-accent",
    colors: [
      "#FAF7FB",
      "#FFFFFF",
      "#2B2533",
      "#635B70",
      "#9C7BB8",
      "#8AA0C9",
      "#E0B6C9",
      "#2B2533",
      "#ECE7F0",
    ],
  },
  {
    id: "mono-ink",
    group: "single-accent",
    colors: [
      "#FFFFFF",
      "#FAFAFA",
      "#0A0A0A",
      "#6B6B6B",
      "#E5392E",
      "#0A0A0A",
      "#BFBFBF",
      "#0A0A0A",
      "#EEEEEE",
    ],
  },
  {
    id: "sunset-maroon",
    group: "single-accent",
    colors: [
      "#FFF7F2",
      "#FFFFFF",
      "#3A1F22",
      "#6E4A4C",
      "#F26B3A",
      "#E0457B",
      "#F2A93B",
      "#3A1F22",
      "#F0E2DA",
    ],
  },
  {
    id: "mint-tech",
    group: "single-accent",
    colors: [
      "#FBFFFD",
      "#FFFFFF",
      "#1B2A26",
      "#56655F",
      "#16B981",
      "#4FA3E0",
      "#9AE6C8",
      "#3A4A45",
      "#E6F0EB",
    ],
  },
  {
    id: "midnight-mono",
    group: "single-accent",
    colors: [
      "#121316",
      "#1C1E22",
      "#F2F2F0",
      "#A0A3A8",
      "#C6FF4A",
      "#6B7280",
      "#3A3D44",
      "#C6FF4A",
      "#2A2C31",
    ],
  },
  {
    id: "ocean-deep",
    group: "single-accent",
    colors: [
      "#0E2A33",
      "#143840",
      "#EAF6F4",
      "#9DB8B8",
      "#38C7B4",
      "#5A93A8",
      "#1F4A52",
      "#38C7B4",
      "#1B454E",
    ],
  },
  {
    id: "gold-luxe",
    group: "single-accent",
    colors: [
      "#16140F",
      "#211E16",
      "#F3EEE2",
      "#ADA48E",
      "#C9A24B",
      "#8A6E3A",
      "#3A352A",
      "#C9A24B",
      "#2A271E",
    ],
  },
] as const satisfies readonly PresentationTemplateThemeOption[];

type PresentationTemplateTheme =
  (typeof PRESENTATION_TEMPLATE_THEME_OPTIONS)[number];

const PRESENTATION_TEMPLATE_THEME_NAMES = {
  "bauhaus-primary": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.bauhausPrimary;
    });
  },
  "berry-pop": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.berryPop;
    });
  },
  carnival: () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.carnival;
    });
  },
  "citrus-fresh": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.citrusFresh;
    });
  },
  "coral-studio": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.coralStudio;
    });
  },
  "forest-editorial": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.forestEditorial;
    });
  },
  "gold-luxe": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.goldLuxe;
    });
  },
  "mauve-dusk": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.mauveDusk;
    });
  },
  "midnight-mono": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.midnightMono;
    });
  },
  "mint-tech": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.mintTech;
    });
  },
  "mono-ink": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.monoInk;
    });
  },
  "nordic-frost": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.nordicFrost;
    });
  },
  "ocean-deep": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.oceanDeep;
    });
  },
  "pop-art": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.popArt;
    });
  },
  prism: () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.prism;
    });
  },
  "slate-corporate": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.slateCorporate;
    });
  },
  "sunset-maroon": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.sunsetMaroon;
    });
  },
  "terracotta-clay": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.terracottaClay;
    });
  },
  "warm-sand": () => {
    return i18n.t(($) => {
      return $.artifacts.templates.themeNames.warmSand;
    });
  },
} satisfies Record<PresentationTemplateTheme["id"], () => string>;

function presentationTemplateThemeName(
  theme: PresentationTemplateTheme,
): string {
  return PRESENTATION_TEMPLATE_THEME_NAMES[theme.id]();
}

function findPresentationTemplateTheme(
  themeId: string,
): PresentationTemplateTheme {
  return (
    PRESENTATION_TEMPLATE_THEME_OPTIONS.find((theme) => {
      return theme.id === themeId;
    }) ?? PRESENTATION_TEMPLATE_THEME_OPTIONS[0]!
  );
}

function presentationTemplateThemePreviewSwatches(
  theme: PresentationTemplateThemeOption,
): readonly { readonly color: string; readonly id: string }[] {
  const background = theme.colors[0];
  const accents = theme.colors.slice(4, 8);
  return [
    { id: "background", color: background },
    ...accents.slice(0, 3).map((accent, accentIndex) => {
      return { id: `accent-${accentIndex + 1}`, color: accent };
    }),
  ];
}

function isPresentationTemplateSupport2SwatchSlug(slug: string): boolean {
  return (
    slug === "playful-launch-presentation" ||
    slug === "crayon-learning-deck" ||
    slug === "mosaic-geometric-pitch"
  );
}

function presentationTemplateAccentSwatchColor(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption,
): { readonly color: string; readonly id: string } {
  if (item.slug === "landing-consulting-deck") {
    return { id: "support-1", color: theme.colors[5] };
  }
  if (isPresentationTemplateSupport2SwatchSlug(item.slug)) {
    return { id: "support-2", color: theme.colors[6] };
  }
  return { id: "accent", color: theme.colors[4] };
}

function presentationTemplateThemeAccentSwatches(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption,
): readonly { readonly color: string; readonly id: string }[] {
  return [
    { id: "background", color: theme.colors[0] },
    presentationTemplateAccentSwatchColor(item, theme),
  ];
}

function presentationTemplateThemeCss(
  theme: PresentationTemplateThemeOption,
): string {
  const [bg, surface, ink, soft, accent, s1, s2, s3, ph] = theme.colors;
  const accents = [accent, s1, s2, s3] as const;
  const accentVariables = accents
    .map((accent, index) => {
      const [ground, text] = safePreviewGround(accent);
      return `--g${index}:${ground};--t${index}:${text};`;
    })
    .join("");
  return `
    :root {
      --bg:${bg};
      --surface:${surface};
      --ink:${ink};
      --soft:${soft};
      --ph:${ph};
      --accent:${accent};
      --s1:${s1};
      --s2:${s2};
      --s3:${s3};
      --oa:${previewTextColorOn(accent)};
      --o1:${previewTextColorOn(s1)};
      --o2:${previewTextColorOn(s2)};
      --o3:${previewTextColorOn(s3)};
      --ka:${contrastRatio(accent, bg) >= 4.5 ? accent : ink};
      --kad:${contrastRatio(accent, ink) >= 4.5 ? accent : bg};
      --k1:${contrastRatio(s1, bg) >= 4.5 ? s1 : ink};
      --k2:${contrastRatio(s2, bg) >= 4.5 ? s2 : ink};
      --k3:${contrastRatio(s3, bg) >= 4.5 ? s3 : ink};
      ${accentVariables}
    }
    #sw {
      display: none !important;
    }
  `;
}

function themedPreviewPresentationHtml(params: {
  readonly activeSlideId: string;
  readonly draft: PresentationPreviewDraft;
  readonly theme: PresentationTemplateThemeOption;
}): string {
  return previewPresentationHtml({
    activeSlideId: params.activeSlideId,
    additionalHeadStyle: presentationTemplateThemeCss(params.theme),
    html: params.draft.html,
  });
}

function schedulePresentationTemplateCardSlideIndex(params: {
  readonly apply: (index: number) => void;
  readonly embedUrl: string;
  readonly index: number;
  readonly runtime: TemplatePreviewRuntime;
}): void {
  const cache = params.runtime.presentation;
  cache.pendingSlideIndexes.set(params.embedUrl, params.index);
  if (cache.pendingSlideAnimationFrames.has(params.embedUrl)) {
    return;
  }

  const frameId = window.requestAnimationFrame(() => {
    const nextIndex = cache.pendingSlideIndexes.get(params.embedUrl);
    cache.pendingSlideAnimationFrames.delete(params.embedUrl);
    cache.pendingSlideIndexes.delete(params.embedUrl);
    if (nextIndex === undefined) {
      return;
    }
    cache.activeIndexes.set(params.embedUrl, nextIndex);
    params.apply(nextIndex);
  });
  cache.pendingSlideAnimationFrames.set(params.embedUrl, frameId);
}

function cancelPresentationTemplateCardSlideIndex(
  runtime: TemplatePreviewRuntime,
  embedUrl: string,
): void {
  const cache = runtime.presentation;
  const frameId = cache.pendingSlideAnimationFrames.get(embedUrl);
  if (frameId !== undefined) {
    window.cancelAnimationFrame(frameId);
  }
  cache.pendingSlideAnimationFrames.delete(embedUrl);
  cache.pendingSlideIndexes.delete(embedUrl);
}

function revokePresentationTemplateHtmlPreviewUrl(url: string | null): void {
  if (url !== null) {
    URL.revokeObjectURL(url);
  }
}

type PresentationTemplateThemeVariables = CSSProperties &
  Record<`--${string}`, string>;

function presentationTemplateThemeVariables(
  theme: PresentationTemplateThemeOption,
): PresentationTemplateThemeVariables {
  const [bg, surface, ink, soft, accent, s1, s2, s3, ph] = theme.colors;
  const [g0, t0] = safePreviewGround(accent);
  const [g1, t1] = safePreviewGround(s1);
  const [g2, t2] = safePreviewGround(s2);
  const [g3, t3] = safePreviewGround(s3);
  return {
    "--bg": bg,
    "--surface": surface,
    "--ink": ink,
    "--soft": soft,
    "--ph": ph,
    "--accent": accent,
    "--s1": s1,
    "--s2": s2,
    "--s3": s3,
    "--oa": previewTextColorOn(accent),
    "--o1": previewTextColorOn(s1),
    "--o2": previewTextColorOn(s2),
    "--o3": previewTextColorOn(s3),
    "--ka": contrastRatio(accent, bg) >= 4.5 ? accent : ink,
    "--kad": contrastRatio(accent, ink) >= 4.5 ? accent : bg,
    "--k1": contrastRatio(s1, bg) >= 4.5 ? s1 : ink,
    "--k2": contrastRatio(s2, bg) >= 4.5 ? s2 : ink,
    "--k3": contrastRatio(s3, bg) >= 4.5 ? s3 : ink,
    "--g0": g0,
    "--t0": t0,
    "--g1": g1,
    "--t1": t1,
    "--g2": g2,
    "--t2": t2,
    "--g3": g3,
    "--t3": t3,
  };
}

function applyPresentationTemplateThumbnailTheme(
  host: HTMLDivElement,
  themeVariables: PresentationTemplateThemeVariables,
): void {
  const root = host.shadowRoot?.querySelector<HTMLElement>(
    ".presentation-template-shadow-preview-root",
  );
  if (root === undefined || root === null) {
    return;
  }

  for (const [name, value] of Object.entries(themeVariables)) {
    if (name.startsWith("--")) {
      root.style.setProperty(name, value);
    }
  }
}

function renderPresentationTemplateShadowThumbnail(
  runtime: TemplatePreviewRuntime,
  host: HTMLDivElement,
  html: string,
  themeVariables: PresentationTemplateThemeVariables,
): void {
  const htmlByHost = runtime.presentation.thumbnailHtmlByHost;
  if (htmlByHost.get(host) === html) {
    applyPresentationTemplateThumbnailTheme(host, themeVariables);
    return;
  }
  htmlByHost.set(host, html);

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const doc = new DOMParser().parseFromString(html, "text/html");
  shadow.replaceChildren();

  const resetStyle = document.createElement("style");
  resetStyle.textContent = `
    :host {
      all: initial;
      contain: strict;
      display: block;
      height: 100%;
      overflow: hidden;
      position: relative;
      width: 100%;
    }
    .presentation-template-shadow-preview-root {
      background: #fff;
      height: 100%;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      position: absolute;
      user-select: none;
      width: 100%;
    }
    .presentation-template-shadow-preview-root *,
    .presentation-template-shadow-preview-root *:hover,
    .presentation-template-shadow-preview-root *:focus,
    .presentation-template-shadow-preview-root *:focus-visible {
      caret-color: transparent !important;
      outline: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }
  `;
  shadow.append(resetStyle);
  for (const node of Array.from(doc.head.childNodes)) {
    const clone = node.cloneNode(true);
    if (clone instanceof HTMLStyleElement && clone.textContent !== null) {
      clone.textContent = clone.textContent.replaceAll(
        ":root",
        ":host, .presentation-template-shadow-preview-root",
      );
    }
    shadow.append(clone);
  }
  const root = document.createElement("div");
  root.className = "presentation-template-shadow-preview-root";
  root.append(
    ...Array.from(doc.body.childNodes).map((node) => {
      return node.cloneNode(true);
    }),
  );
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    element.removeAttribute("contenteditable");
    element.removeAttribute("tabindex");
  }
  shadow.append(root);
  applyPresentationTemplateThumbnailTheme(host, themeVariables);
}

function PresentationTemplateShadowThumbnail({
  draft,
  imageUrl,
  runtime,
  slideId,
  themeVariables,
  title,
}: {
  readonly draft: PresentationPreviewDraft | undefined;
  readonly imageUrl: string;
  readonly runtime: TemplatePreviewRuntime;
  readonly slideId: string | null;
  readonly themeVariables: PresentationTemplateThemeVariables;
  readonly title: string;
}) {
  const hasHtmlThumbnail = draft !== undefined && slideId !== null;
  return (
    <>
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {hasHtmlThumbnail ? (
        <div
          ref={(node) => {
            if (node !== null) {
              renderPresentationTemplateShadowThumbnail(
                runtime,
                node,
                previewPresentationHtml({
                  activeSlideId: slideId,
                  html: draft.html,
                }),
                themeVariables,
              );
            }
          }}
          aria-label={title}
          className="pointer-events-none absolute inset-0"
          style={themeVariables}
        />
      ) : null}
    </>
  );
}

function createPresentationTemplateHtmlPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly previousFrameUrl: string | null;
  readonly theme: PresentationTemplateThemeOption;
}): TemplateCardHtmlPreviewState | null {
  const slide =
    params.draft.slides[Math.min(params.index, params.draft.slides.length - 1)];
  if (slide === undefined) {
    return null;
  }

  revokePresentationTemplateHtmlPreviewUrl(params.previousFrameUrl);
  const frameUrl = URL.createObjectURL(
    new Blob(
      [
        themedPreviewPresentationHtml({
          activeSlideId: slide.id,
          draft: params.draft,
          theme: params.theme,
        }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );

  return {
    slug: params.item.slug,
    embedUrl: params.item.embedUrl,
    themeId: params.theme.id,
    loading: false,
    frameUrl,
    slideCount: params.draft.slides.length,
  };
}

function createPresentationTemplateCardHtmlPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly previousFrameUrl: string | null;
  readonly theme: PresentationTemplateThemeOption;
}): TemplateCardHtmlPreviewState | null {
  if (params.index === 0) {
    revokePresentationTemplateHtmlPreviewUrl(params.previousFrameUrl);
    return null;
  }
  return createPresentationTemplateHtmlPreviewState(params);
}

function presentationTemplateCardFrameUrls(params: {
  readonly currentFrameUrl: string | null;
  readonly loadedFrameUrl: string | null;
}): {
  readonly overlayFrameUrl: string | null;
  readonly primaryFrameUrl: string | null;
} {
  if (
    params.currentFrameUrl === null ||
    params.loadedFrameUrl === null ||
    params.loadedFrameUrl === params.currentFrameUrl
  ) {
    return {
      overlayFrameUrl: null,
      primaryFrameUrl: params.currentFrameUrl,
    };
  }

  return {
    overlayFrameUrl: params.currentFrameUrl,
    primaryFrameUrl: params.loadedFrameUrl,
  };
}

function revokeLoadedTemplateCardFrameAfterReplacement(params: {
  readonly frameUrl: string;
  readonly previousLoadedFrameUrl: string | null;
}): void {
  if (
    params.previousLoadedFrameUrl === null ||
    params.previousLoadedFrameUrl === params.frameUrl
  ) {
    return;
  }
  revokePresentationTemplateHtmlPreviewUrl(params.previousLoadedFrameUrl);
}

function presentationTemplateCardActiveFrameUrlForImmediateRevocation(params: {
  readonly activeFrameUrl: string | null;
  readonly loadedFrameUrl: string | null;
}): string | null {
  if (
    params.activeFrameUrl === null ||
    params.activeFrameUrl === params.loadedFrameUrl
  ) {
    return null;
  }
  return params.activeFrameUrl;
}

function revealTemplatePreviewFrameAfterPaint(params: {
  readonly frame: HTMLIFrameElement;
  readonly frameUrl: string;
  readonly onFrameLoad: (frameUrl: string) => void;
}): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!params.frame.isConnected) {
        return;
      }
      params.onFrameLoad(params.frameUrl);
    });
  });
}

function startProgressiveTemplatePreviewImageLoad(
  lowResolutionImage: HTMLImageElement,
): void {
  const highResolutionImage =
    lowResolutionImage.parentElement?.querySelector<HTMLImageElement>(
      '[data-template-preview-image="high"]',
    );
  if (highResolutionImage === null || highResolutionImage === undefined) {
    return;
  }

  const highResolutionUrl = highResolutionImage.dataset.src;
  if (
    highResolutionUrl === undefined ||
    highResolutionImage.getAttribute("src") === highResolutionUrl
  ) {
    return;
  }
  delete highResolutionImage.dataset.loaded;
  highResolutionImage.src = highResolutionUrl;
}

function ProgressiveTemplatePreviewImage({
  alt,
  className,
  dataTestId,
  fetchPriority,
  highResolutionUrl,
  loading,
  lowResolutionUrl,
}: {
  readonly alt: string;
  readonly className: string;
  readonly dataTestId?: string;
  readonly fetchPriority?: "high" | "low" | "auto";
  readonly highResolutionUrl: string;
  readonly loading?: "eager" | "lazy";
  readonly lowResolutionUrl: string;
}) {
  const hasHighResolutionImage = lowResolutionUrl !== highResolutionUrl;

  return (
    <>
      <img
        src={lowResolutionUrl}
        alt={alt}
        aria-hidden={alt === "" ? "true" : undefined}
        data-template-preview-image="low"
        data-testid={dataTestId}
        className={className}
        loading={loading}
        decoding="async"
        fetchPriority={fetchPriority}
        onLoad={(event) => {
          if (hasHighResolutionImage) {
            startProgressiveTemplatePreviewImageLoad(event.currentTarget);
          }
        }}
        onError={(event) => {
          if (hasHighResolutionImage) {
            startProgressiveTemplatePreviewImageLoad(event.currentTarget);
          }
        }}
      />
      {hasHighResolutionImage ? (
        <img
          src={undefined}
          data-template-preview-image="high"
          data-src={highResolutionUrl}
          alt={alt}
          aria-hidden={alt === "" ? "true" : undefined}
          className={cn(
            className,
            "opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100",
          )}
          loading={loading}
          decoding="async"
          fetchPriority={fetchPriority}
          onLoad={(event) => {
            const highResolutionImage = event.currentTarget;
            highResolutionImage.dataset.loaded = "true";
          }}
        />
      ) : null}
    </>
  );
}

function TemplatePreviewFrames({
  highResolutionImageUrl,
  loadedFrameUrl,
  loading,
  lowResolutionImageUrl,
  onFrameLoad,
  overlayFrameUrl,
  primaryFrameUrl,
  title,
}: {
  readonly highResolutionImageUrl: string;
  readonly loadedFrameUrl: string | null;
  readonly loading: boolean;
  readonly lowResolutionImageUrl: string;
  readonly onFrameLoad: (frameUrl: string) => void;
  readonly overlayFrameUrl: string | null;
  readonly primaryFrameUrl: string | null;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const frameUrls: readonly string[] =
    primaryFrameUrl === null
      ? []
      : [
          primaryFrameUrl,
          ...(overlayFrameUrl === null ? [] : [overlayFrameUrl]),
        ];

  return (
    <>
      <ProgressiveTemplatePreviewImage
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        dataTestId={`${title} card image preview`}
        fetchPriority="high"
        highResolutionUrl={highResolutionImageUrl}
        loading="eager"
        lowResolutionUrl={lowResolutionImageUrl}
      />
      {frameUrls.map((frameUrl) => {
        return (
          <iframe
            key={frameUrl}
            title={
              frameUrl === overlayFrameUrl
                ? t(
                    ($) => {
                      return $.artifacts.templates.activeHtmlPreview;
                    },
                    { title },
                  )
                : t(
                    ($) => {
                      return $.artifacts.templates.htmlPreview;
                    },
                    { title },
                  )
            }
            data-testid={
              frameUrl === overlayFrameUrl || overlayFrameUrl === null
                ? `${title} card HTML preview`
                : undefined
            }
            data-loaded={frameUrl === loadedFrameUrl ? "true" : undefined}
            src={frameUrl}
            sandbox="allow-same-origin"
            tabIndex={-1}
            className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-background opacity-0 data-[loaded=true]:opacity-100"
            onLoad={(event) => {
              revealTemplatePreviewFrameAfterPaint({
                frame: event.currentTarget,
                frameUrl,
                onFrameLoad,
              });
            }}
          />
        );
      })}
      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
    </>
  );
}

function TemplatePreview({
  item,
  onPreview,
  runtime,
  signals,
  theme,
}: {
  item: PresentationTemplateItem;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  runtime: TemplatePreviewRuntime;
  signals: ComposerSignals;
  theme?: PresentationTemplateThemeOption;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const hover = useGet(signals.template.templateCardHover$);
  const setHover = useSet(signals.template.setTemplateCardHover$);
  const htmlPreview = useGet(signals.template.templateCardHtmlPreview$);
  const setHtmlPreview = useSet(signals.template.setTemplateCardHtmlPreview$);
  const loadedHtmlFrameUrls = useGet(
    signals.template.templateCardLoadedHtmlFrameUrls$,
  );
  const setLoadedHtmlFrameUrl = useSet(
    signals.template.setTemplateCardLoadedHtmlFrameUrl$,
  );
  const slideCount = presentationTemplateSlideCount(item);
  const hoverSlideIndex = Math.max(
    0,
    Math.min(hover?.slug === item.slug ? hover.index : 0, slideCount - 1),
  );
  const previewTheme =
    theme ??
    findPresentationTemplateTheme(defaultPresentationTemplateThemeId(item));
  const lowResolutionImageUrl = presentationTemplateCardSlideImage(
    item,
    hoverSlideIndex,
    previewTheme,
  );
  const highResolutionImageUrl = presentationTemplateHighResolutionSlideImage(
    item,
    hoverSlideIndex,
    previewTheme,
    TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE,
  );
  const activeHtmlPreview =
    htmlPreview?.slug === item.slug &&
    htmlPreview.embedUrl === item.embedUrl &&
    htmlPreview.themeId === previewTheme.id
      ? htmlPreview
      : null;
  const loadedHtmlFrameKey = `card:${item.embedUrl}:${previewTheme.id}:loaded`;
  const loadedFrameUrl = loadedHtmlFrameUrls[loadedHtmlFrameKey] ?? null;
  const previousActiveFrameUrlForImmediateRevocation =
    presentationTemplateCardActiveFrameUrlForImmediateRevocation({
      activeFrameUrl: activeHtmlPreview?.frameUrl ?? null,
      loadedFrameUrl,
    });
  const scrubSlideCount = activeHtmlPreview?.slideCount ?? slideCount;
  const currentPreviewSlideIndex = () => {
    const cache = runtime.presentation;
    const index =
      cache.pendingSlideIndexes.get(item.embedUrl) ??
      cache.activeIndexes.get(item.embedUrl) ??
      hoverSlideIndex;
    return Math.max(0, Math.min(index, scrubSlideCount - 1));
  };
  const currentFrameUrl =
    currentPreviewSlideIndex() === 0
      ? null
      : (activeHtmlPreview?.frameUrl ?? null);
  const { overlayFrameUrl, primaryFrameUrl } =
    presentationTemplateCardFrameUrls({
      currentFrameUrl,
      loadedFrameUrl,
    });
  const openPreview = () => {
    onPreview(item, currentPreviewSlideIndex());
  };
  const handleFrameLoad = (frameUrl: string) => {
    revokeLoadedTemplateCardFrameAfterReplacement({
      frameUrl,
      previousLoadedFrameUrl: loadedFrameUrl,
    });
    setLoadedHtmlFrameUrl(loadedHtmlFrameKey, frameUrl);
  };

  const startHtmlPreviewLoad = () => {
    const cache = runtime.presentation;
    const activeIndex = cache.activeIndexes.get(item.embedUrl) ?? 0;
    const cachedDraft = cache.drafts.get(item.embedUrl);
    if (cachedDraft !== undefined) {
      const previewState = createPresentationTemplateCardHtmlPreviewState({
        draft: cachedDraft,
        index: activeIndex,
        item,
        previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
        theme: previewTheme,
      });
      setHtmlPreview(previewState);
      return;
    }

    if (cache.failed.has(item.embedUrl)) {
      setHtmlPreview({
        slug: item.slug,
        embedUrl: item.embedUrl,
        themeId: previewTheme.id,
        loading: false,
        frameUrl: null,
        slideCount,
      });
      return;
    }

    let pendingLoad = cache.pendingLoads.get(item.embedUrl);
    if (pendingLoad === undefined) {
      pendingLoad = signals.template.loadPresentationTemplateHtmlPreview(
        {
          item,
        },
        pageSignal,
      );
      cache.pendingLoads.set(item.embedUrl, pendingLoad);
    }

    const activeToken = Symbol(item.embedUrl);
    cache.activeTokens.set(item.embedUrl, activeToken);
    setHtmlPreview({
      slug: item.slug,
      embedUrl: item.embedUrl,
      themeId: previewTheme.id,
      loading: true,
      frameUrl: null,
      slideCount,
    });
    detach(
      (async () => {
        const result = await tapError(
          pendingLoad.finally(() => {
            if (cache.pendingLoads.get(item.embedUrl) === pendingLoad) {
              cache.pendingLoads.delete(item.embedUrl);
            }
          }),
        );

        if (result === undefined || result === null) {
          cache.failed.add(item.embedUrl);
          if (cache.activeTokens.get(item.embedUrl) === activeToken) {
            setHtmlPreview({
              slug: item.slug,
              embedUrl: item.embedUrl,
              themeId: previewTheme.id,
              loading: false,
              frameUrl: null,
              slideCount,
            });
          }
          return;
        }

        cache.drafts.set(item.embedUrl, result);
        if (cache.activeTokens.get(item.embedUrl) === activeToken) {
          setHtmlPreview(
            createPresentationTemplateCardHtmlPreviewState({
              draft: result,
              index: cache.activeIndexes.get(item.embedUrl) ?? 0,
              item,
              previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
              theme: previewTheme,
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  const applySlideIndex = (index: number) => {
    const cachedDraft = runtime.presentation.drafts.get(item.embedUrl);
    setHover({ slug: item.slug, index });
    if (cachedDraft !== undefined) {
      setHtmlPreview(
        createPresentationTemplateCardHtmlPreviewState({
          draft: cachedDraft,
          index,
          item,
          previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
          theme: previewTheme,
        }),
      );
    }
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const cache = runtime.presentation;
    if (!cache.drafts.has(item.embedUrl)) {
      return;
    }
    if (scrubSlideCount < 2) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const offsetX = Math.min(
      rect.width - 1,
      Math.max(0, event.clientX - rect.left),
    );
    const nextIndex = Math.min(
      scrubSlideCount - 1,
      Math.round((offsetX / rect.width) * (scrubSlideCount - 1)),
    );
    const currentIndex =
      cache.pendingSlideIndexes.get(item.embedUrl) ??
      currentPreviewSlideIndex();
    if (nextIndex === currentIndex) {
      return;
    }
    schedulePresentationTemplateCardSlideIndex({
      apply: applySlideIndex,
      embedUrl: item.embedUrl,
      index: nextIndex,
      runtime,
    });
    event.currentTarget.dataset.targetSlideIndex = String(nextIndex);
  };

  return (
    <div
      className="relative aspect-[16/9] shrink-0 overflow-hidden bg-muted"
      onMouseEnter={() => {
        cancelPresentationTemplateCardSlideIndex(runtime, item.embedUrl);
        runtime.presentation.activeIndexes.set(item.embedUrl, 0);
        setHover({ slug: item.slug, index: 0 });
        startHtmlPreviewLoad();
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={(event) => {
        delete event.currentTarget.dataset.targetSlideIndex;
        const cache = runtime.presentation;
        cancelPresentationTemplateCardSlideIndex(runtime, item.embedUrl);
        cache.activeIndexes.delete(item.embedUrl);
        cache.activeTokens.delete(item.embedUrl);
        setHover(null);
        revokePresentationTemplateHtmlPreviewUrl(
          previousActiveFrameUrlForImmediateRevocation,
        );
        setHtmlPreview(null);
      }}
    >
      <TemplatePreviewFrames
        highResolutionImageUrl={highResolutionImageUrl}
        loadedFrameUrl={loadedFrameUrl}
        loading={activeHtmlPreview?.loading === true}
        lowResolutionImageUrl={lowResolutionImageUrl}
        onFrameLoad={handleFrameLoad}
        overlayFrameUrl={overlayFrameUrl}
        primaryFrameUrl={primaryFrameUrl}
        title={item.title}
      />
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewCurrentSlide;
          },
          {
            title: item.title,
          },
        )}
        className="absolute inset-0 z-10 cursor-zoom-in bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={openPreview}
      />
    </div>
  );
}

const TEMPLATE_DETAIL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"]):not([role="group"])',
].join(",");

function templateDetailFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(TEMPLATE_DETAIL_FOCUSABLE_SELECTOR),
  ).filter((element) => {
    return (
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      !element.closest("[inert]")
    );
  });
}

function handleTemplateDetailTabKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  if (event.key !== "Tab") {
    return;
  }

  const candidates = templateDetailFocusableElements(event.currentTarget);
  if (candidates.length === 0) {
    return;
  }

  const target =
    event.target instanceof HTMLElement ? event.target : document.activeElement;
  const currentIndex = candidates.findIndex((candidate) => {
    return target instanceof Node && candidate.contains(target);
  });
  const direction = event.shiftKey ? -1 : 1;
  const nextIndex =
    currentIndex === -1
      ? event.shiftKey
        ? candidates.length - 1
        : 0
      : (currentIndex + direction + candidates.length) % candidates.length;

  event.preventDefault();
  candidates[nextIndex]?.focus();
}

function TemplateDetailPreviewFrame({
  frameLoaded,
  frameUrl,
  onFrameLoad,
  previousFrameSlideIndex,
  previousFrameUrl,
  slideIndex,
  title,
}: {
  readonly frameLoaded: boolean;
  readonly frameUrl: string | null;
  readonly onFrameLoad: (frameUrl: string) => void;
  readonly previousFrameSlideIndex: number | null;
  readonly previousFrameUrl: string | null;
  readonly slideIndex: number;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const frames: readonly {
    readonly active: boolean;
    readonly slideIndex: number;
    readonly url: string;
  }[] = [
    ...(previousFrameUrl === null || previousFrameUrl === frameUrl
      ? []
      : [
          {
            active: false,
            slideIndex: previousFrameSlideIndex ?? slideIndex,
            url: previousFrameUrl,
          },
        ]),
    ...(frameUrl === null ? [] : [{ active: true, slideIndex, url: frameUrl }]),
  ];

  return frames.map((candidateFrame) => {
    const previousFrameShowsActiveSlide =
      !candidateFrame.active && candidateFrame.slideIndex === slideIndex;
    return (
      <iframe
        key={candidateFrame.url}
        title={
          candidateFrame.active
            ? t(
                ($) => {
                  return $.artifacts.templates.htmlPreview;
                },
                { title },
              )
            : t(
                ($) => {
                  return $.artifacts.templates.previousHtmlPreview;
                },
                { title },
              )
        }
        data-template-detail-frame={
          candidateFrame.active ? "active" : "previous"
        }
        data-loaded={!candidateFrame.active || frameLoaded ? "true" : undefined}
        data-testid={
          candidateFrame.active ? `${title} detail HTML preview` : undefined
        }
        src={candidateFrame.url}
        sandbox="allow-same-origin"
        tabIndex={-1}
        className={cn(
          "pointer-events-none absolute inset-0 h-full w-full border-0 bg-background opacity-0 data-[loaded=true]:opacity-100",
          candidateFrame.active
            ? "z-40"
            : previousFrameShowsActiveSlide
              ? "z-30"
              : "z-10",
        )}
        onLoad={(event) => {
          if (!candidateFrame.active) {
            return;
          }
          revealTemplatePreviewFrameAfterPaint({
            frame: event.currentTarget,
            frameUrl: candidateFrame.url,
            onFrameLoad,
          });
        }}
      />
    );
  });
}

function templateDetailPreviewMatchesItem(
  preview: {
    readonly embedUrl: string;
    readonly slug: string;
  } | null,
  item: PresentationTemplateItem,
): boolean {
  return preview?.slug === item.slug && preview.embedUrl === item.embedUrl;
}

function TemplatePreviewPage({
  item,
  onBack,
  onSelect,
  runtime,
  signals,
}: {
  item: PresentationTemplateItem;
  onBack: () => void;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  runtime: TemplatePreviewRuntime;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const detailPreview = useGet(signals.template.templateDetailHtmlPreview$);
  const setCardThemeId = useSet(signals.template.setTemplateCardThemeId$);
  const selectDetailPreview = useSet(
    signals.template.selectPresentationTemplateDetailPreview$,
  );
  const settleDetailPreviewFrame = useSet(
    signals.template.settlePresentationTemplateDetailPreviewFrame$,
  );
  const visibleDetailPreview = templateDetailPreviewMatchesItem(
    detailPreview,
    item,
  )
    ? detailPreview
    : null;
  const selectedThemeId =
    visibleDetailPreview?.themeId ?? defaultPresentationTemplateThemeId(item);
  const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
  const activeSlideIndex = visibleDetailPreview?.index ?? 0;
  const defaultSlideCount = presentationTemplateSlideCount(item);
  const detailSlideCount =
    visibleDetailPreview?.slideCount ?? defaultSlideCount;
  const cachedDetailDraft = runtime.presentation.drafts.get(item.embedUrl);
  const htmlPreviewFailed = runtime.presentation.failed.has(item.embedUrl);
  const thumbnailThemeVariables =
    presentationTemplateThemeVariables(selectedTheme);
  const detailImageSource = presentationTemplateDetailSlideImageSource(
    item,
    activeSlideIndex,
    selectedTheme,
    htmlPreviewFailed,
  );
  const detailLowResolutionImage = r2ImageTransformUrl(
    detailImageSource,
    TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE,
  );
  const detailHighResolutionImage = detailImageSource;
  const selectDetailSlide = (index: number) => {
    selectDetailPreview({
      item,
      runtime,
      index: Math.max(0, Math.min(detailSlideCount - 1, index)),
      themeCss: presentationTemplateThemeCss(selectedTheme),
      themeId: selectedTheme.id,
    });
  };

  const selectDetailTheme = (theme: PresentationTemplateThemeOption) => {
    selectDetailPreview({
      item,
      runtime,
      index: activeSlideIndex,
      themeCss: presentationTemplateThemeCss(theme),
      themeId: theme.id,
    });
  };
  const handleDetailSlideKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "ArrowLeft" && activeSlideIndex > 0) {
      event.preventDefault();
      selectDetailSlide(activeSlideIndex - 1);
    }
    if (event.key === "ArrowRight" && activeSlideIndex < detailSlideCount - 1) {
      event.preventDefault();
      selectDetailSlide(activeSlideIndex + 1);
    }
  };
  const multiAccentThemes = PRESENTATION_TEMPLATE_THEME_OPTIONS.filter(
    (theme) => {
      return theme.group === "multi-accent";
    },
  );
  const singleAccentThemes = PRESENTATION_TEMPLATE_THEME_OPTIONS.filter(
    (theme) => {
      return theme.group === "single-accent";
    },
  );

  return (
    <>
      <DialogHeader
        data-presentation-template-detail-header=""
        className="flex h-[68px] shrink-0 justify-center border-b border-border px-6 pr-14 text-left duration-200 motion-reduce:animate-none"
      >
        <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
          <button
            type="button"
            className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onBack}
          >
            {t(($) => {
              return $.artifacts.templates.template;
            })}
          </button>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="block min-w-0 truncate leading-none">
            {item.title}
          </span>
        </DialogTitle>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto bg-muted/20 p-3 duration-200 motion-reduce:animate-none sm:gap-4 sm:p-5 lg:max-h-[72vh] lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
        <div className="rounded-lg border border-border bg-background p-2.5 sm:p-3">
          <div
            role="group"
            aria-label={t(
              ($) => {
                return $.artifacts.templates.slidePreview;
              },
              {
                title: item.title,
              },
            )}
            tabIndex={0}
            onKeyDown={handleDetailSlideKeyDown}
            className="relative aspect-[16/9] overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProgressiveTemplatePreviewImage
              alt=""
              className="pointer-events-none absolute inset-0 z-20 h-full w-full object-cover"
              dataTestId={`${item.title} detail image preview`}
              fetchPriority="high"
              highResolutionUrl={detailHighResolutionImage}
              loading="eager"
              lowResolutionUrl={detailLowResolutionImage}
            />
            <TemplateDetailPreviewFrame
              frameLoaded={visibleDetailPreview?.frameLoaded ?? false}
              frameUrl={visibleDetailPreview?.frameUrl ?? null}
              onFrameLoad={(frameUrl) => {
                settleDetailPreviewFrame(frameUrl);
              }}
              previousFrameSlideIndex={
                visibleDetailPreview?.previousFrameSlideIndex ?? null
              }
              previousFrameUrl={visibleDetailPreview?.previousFrameUrl ?? null}
              slideIndex={activeSlideIndex}
              title={item.title}
            />
            <button
              type="button"
              aria-label={t(($) => {
                return $.artifacts.templates.previousSlide;
              })}
              disabled={activeSlideIndex === 0}
              tabIndex={-1}
              onClick={() => {
                selectDetailSlide(activeSlideIndex - 1);
              }}
              className="absolute inset-y-0 left-0 w-1/2 cursor-w-resize bg-transparent focus:outline-none disabled:cursor-default"
            />
            <button
              type="button"
              aria-label={t(($) => {
                return $.artifacts.templates.nextSlide;
              })}
              disabled={activeSlideIndex >= detailSlideCount - 1}
              tabIndex={-1}
              onClick={() => {
                selectDetailSlide(activeSlideIndex + 1);
              }}
              className="absolute inset-y-0 right-0 w-1/2 cursor-e-resize bg-transparent focus:outline-none disabled:cursor-default"
            />
            {visibleDetailPreview?.loading ||
            !visibleDetailPreview?.frameUrl ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
                <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
              </div>
            ) : null}
          </div>
          <div
            className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-1.5 lg:grid-cols-8"
            onKeyDown={handleDetailSlideKeyDown}
          >
            {Array.from(
              { length: Math.min(detailSlideCount, 15) },
              (_, index) => {
                return index + 1;
              },
            ).map((slideNumber) => {
              const slideIndex = slideNumber - 1;
              const active = slideIndex === activeSlideIndex;
              const thumbnailImage = r2ImageTransformUrl(
                presentationTemplateDetailSlideImageSource(
                  item,
                  slideIndex,
                  selectedTheme,
                  htmlPreviewFailed,
                ),
                TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE,
              );
              const thumbnailSlide =
                cachedDetailDraft?.slides[slideIndex] ?? null;
              return (
                <button
                  key={slideNumber}
                  type="button"
                  aria-label={t(
                    ($) => {
                      return $.artifacts.templates.previewSlide;
                    },
                    {
                      slideNumber,
                    },
                  )}
                  aria-pressed={active}
                  onClick={() => {
                    selectDetailSlide(slideIndex);
                  }}
                  className={cn(
                    "relative aspect-[16/9] overflow-hidden rounded-md border bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-ring ring-1 ring-ring"
                      : "border-border hover:border-muted-foreground/50",
                  )}
                >
                  <PresentationTemplateShadowThumbnail
                    draft={cachedDetailDraft}
                    imageUrl={thumbnailImage}
                    runtime={runtime}
                    slideId={thumbnailSlide?.id ?? null}
                    themeVariables={thumbnailThemeVariables}
                    title={t(
                      ($) => {
                        return $.artifacts.templates.slideThumbnail;
                      },
                      {
                        title: item.title,
                        slideNumber,
                      },
                    )}
                  />
                  <span className="absolute bottom-1 right-1 rounded border border-border bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow-sm backdrop-blur">
                    {slideNumber}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col lg:sticky lg:top-0">
          <div className="rounded-lg border border-border bg-background p-4 shadow-sm">
            <h3 className="text-xl font-semibold text-foreground">
              {item.title}
            </h3>
            <div className="my-5 border-t border-border" />
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Palette size={14} />
              <span>
                {t(($) => {
                  return $.artifacts.templates.theme;
                })}
              </span>
            </p>
            <div className="mt-3 space-y-4">
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.artifacts.templates.multiAccent;
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {multiAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={t(
                          ($) => {
                            return $.artifacts.templates.selectStyle;
                          },
                          { style: presentationTemplateThemeName(theme) },
                        )}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-7 w-14 overflow-hidden rounded-lg border bg-background transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-ring ring-1 ring-ring"
                            : "border-border hover:border-muted-foreground/60",
                        )}
                      >
                        <span className="flex h-full overflow-hidden rounded-md">
                          {presentationTemplateThemePreviewSwatches(theme).map(
                            (swatch) => {
                              return (
                                <span
                                  key={`${theme.id}-${swatch.id}`}
                                  className="flex-1"
                                  style={{ backgroundColor: swatch.color }}
                                />
                              );
                            },
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.artifacts.templates.singleAccent;
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {singleAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    const swatches = presentationTemplateThemeAccentSwatches(
                      item,
                      theme,
                    );
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={t(
                          ($) => {
                            return $.artifacts.templates.selectStyle;
                          },
                          { style: presentationTemplateThemeName(theme) },
                        )}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-7 w-7 overflow-hidden rounded-md border transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-ring ring-1 ring-ring"
                            : "border-border hover:border-muted-foreground/60",
                        )}
                      >
                        <span className="flex h-full">
                          {swatches.map((swatch) => {
                            return (
                              <span
                                key={`${theme.id}-${swatch.id}`}
                                className="flex-1"
                                style={{ backgroundColor: swatch.color }}
                              />
                            );
                          })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <Button
              type="button"
              aria-label={t(
                ($) => {
                  return $.artifacts.templates.selectTemplate;
                },
                {
                  title: item.title,
                },
              )}
              className="mt-4 h-12 w-full font-semibold shadow-sm"
              onClick={() => {
                setCardThemeId(item.slug, selectedTheme.id);
                onSelect(
                  item,
                  presentationTemplateColorSystemId(selectedTheme.id),
                );
              }}
            >
              {t(($) => {
                return $.artifacts.templates.useThisTemplate;
              })}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function PptCard({
  item,
  selected,
  onSelect,
  onPreview,
  runtime,
  signals,
}: {
  item: PresentationTemplateItem;
  selected: boolean;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  runtime: TemplatePreviewRuntime;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const themeIdBySlug = useGet(signals.template.templateCardThemeIdBySlug$);
  const selectedTheme = findPresentationTemplateTheme(
    themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
  );

  return (
    <div className={TEMPLATE_TILE_WRAPPER}>
      <div
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          selected && TEMPLATE_TILE_RING_SELECTED,
        )}
      >
        <TemplatePreview
          item={item}
          onPreview={onPreview}
          runtime={runtime}
          signals={signals}
          theme={selectedTheme}
        />
        <div className={TEMPLATE_TILE_SCRIM} />
        {selected ? (
          <span className="pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check size={14} />
          </span>
        ) : null}
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item, presentationTemplateColorSystemId(selectedTheme.id));
          }}
          className={TEMPLATE_TILE_USE}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <p className={cn(TEMPLATE_TILE_NAME, "cursor-default")}>
                {item.title}
              </p>
            </TooltipTrigger>
            <TooltipContent side="bottom">{item.title}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {presentationTemplateThemeAccentSwatches(item, selectedTheme).map(
            (swatch) => {
              return (
                <span
                  key={swatch.id}
                  aria-hidden
                  className="h-3 w-3 rounded-full ring-1 ring-inset ring-black/10"
                  style={{ backgroundColor: swatch.color }}
                />
              );
            },
          )}
        </span>
      </div>
    </div>
  );
}

function IllustrationTemplateHero({
  item,
  images,
  activeIndex,
  priority = false,
  source,
  onVariantChange,
  runtime,
}: {
  item: IllustrationTemplateItem;
  images: readonly string[];
  activeIndex: number;
  priority?: boolean;
  source: string;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const heroImage = illustrationHeroImageUrl(source);
  const navigable = images.length > 1;
  const variantAt = (direction: -1 | 1): number => {
    return (activeIndex + direction + images.length) % images.length;
  };
  const preloadNeighbors = (): void => {
    preloadIllustrationVariant(runtime, images, variantAt(1));
    preloadIllustrationVariant(runtime, images, variantAt(-1));
  };

  return (
    <div
      className="relative w-full overflow-hidden bg-muted"
      style={{ aspectRatio: `${String(item.width)} / ${String(item.height)}` }}
    >
      <img
        key={source}
        src={heroImage}
        alt={t(
          ($) => {
            return $.artifacts.templates.illustrationPreview;
          },
          {
            title: item.title,
          },
        )}
        className={cn(
          "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100",
          // Same affordance the detail preview uses for slide paging: the
          // cursor points at the half that will be navigated to.
          navigable &&
            "data-[half=left]:cursor-w-resize data-[half=right]:cursor-e-resize",
        )}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "low"}
        onMouseEnter={navigable ? preloadNeighbors : undefined}
        onMouseMove={
          navigable
            ? (event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dataset.half =
                  event.clientX - rect.left < rect.width / 2 ? "left" : "right";
              }
            : undefined
        }
        onMouseLeave={
          navigable
            ? (event) => {
                delete event.currentTarget.dataset.half;
              }
            : undefined
        }
        onClick={
          navigable
            ? (event) => {
                // Navigate by clicking the image halves instead of overlay
                // buttons, so the native context menu (copy image) stays usable.
                const rect = event.currentTarget.getBoundingClientRect();
                const direction =
                  event.clientX - rect.left < rect.width / 2 ? -1 : 1;
                selectIllustrationVariant({
                  card: event.currentTarget.closest<HTMLElement>(
                    "[data-illustration-template-card]",
                  ),
                  index: variantAt(direction),
                  item,
                  onVariantChange,
                  runtime,
                });
              }
            : undefined
        }
        onLoad={(event) => {
          const image = event.currentTarget;
          detach(
            markIllustrationPreviewImageLoaded(runtime, heroImage, image),
            Reason.DomCallback,
          );
        }}
        onError={(event) => {
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>("[data-illustration-preview-error]")
            ?.removeAttribute("hidden");
        }}
      />
      <div
        data-illustration-preview-error=""
        hidden
        className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground"
      >
        <LayoutTemplate size={28} />
      </div>
    </div>
  );
}

function illustrationHeroImageUrl(source: string): string {
  return r2ImageTransformUrl(source, ILLUSTRATION_CARD_PREVIEW_SIZE);
}

function preloadIllustrationPreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): HTMLImageElement | undefined {
  if (typeof Image === "undefined") {
    return undefined;
  }

  const cache = runtime.illustration;
  const cachedImage = cache.preloads.get(url);
  if (cachedImage !== undefined) {
    return cachedImage;
  }

  const image = new Image();
  image.decoding = "async";
  image.loading = "eager";
  image.fetchPriority = "high";
  image.src = url;
  cache.preloads.set(url, image);
  return image;
}

async function decodeIllustrationPreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): Promise<void> {
  const cache = runtime.illustration;
  if (cache.decoded.has(url)) {
    return;
  }

  if (isHappyDomTestEnvironment()) {
    cache.decoded.add(url);
    return;
  }

  const pendingDecode = cache.pendingDecodes.get(url);
  if (pendingDecode !== undefined) {
    await pendingDecode;
    return;
  }

  const image = preloadIllustrationPreviewImage(runtime, url);
  if (image === undefined) {
    return;
  }

  if (image.decode === undefined) {
    if (image.complete && image.naturalWidth > 0) {
      cache.decoded.add(url);
    }
    return;
  }

  const decode = markIllustrationPreviewImageDecoded(runtime, url, image);
  cache.pendingDecodes.set(url, decode);
  await decode;
}

async function markIllustrationPreviewImageDecoded(
  runtime: TemplatePreviewRuntime,
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = runtime.illustration;
  await tapError(image.decode(), () => {});
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  cache.pendingDecodes.delete(url);
}

async function markIllustrationPreviewImageLoaded(
  runtime: TemplatePreviewRuntime,
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = runtime.illustration;
  if (image.decode !== undefined) {
    await tapError(image.decode(), () => {});
  }
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  image.dataset.loaded = "true";
  image.parentElement
    ?.querySelector<HTMLElement>("[data-illustration-preview-error]")
    ?.setAttribute("hidden", "");
}

function illustrationPreviewImageDecoded(
  runtime: TemplatePreviewRuntime,
  url: string,
): boolean {
  return runtime.illustration.decoded.has(url);
}

async function selectDecodedIllustrationVariant({
  card,
  imageUrl,
  index,
  item,
  onVariantChange,
  runtime,
}: {
  card: HTMLElement;
  imageUrl: string;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}): Promise<void> {
  await decodeIllustrationPreviewImage(runtime, imageUrl);
  if (
    card.dataset.targetVariantIndex === String(index) &&
    illustrationPreviewImageDecoded(runtime, imageUrl)
  ) {
    onVariantChange(item.slug, index);
  }
}

function selectIllustrationVariant({
  card,
  index,
  item,
  onVariantChange,
  runtime,
}: {
  card: HTMLElement | null;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}): void {
  const image = item.previewImages[index];
  if (image === undefined) {
    return;
  }

  const imageUrl = illustrationHeroImageUrl(image);
  // Swap immediately only when the target hero is already decoded; otherwise
  // decode it off-screen first so the hero never flashes a blank/loading frame.
  if (card === null || illustrationPreviewImageDecoded(runtime, imageUrl)) {
    onVariantChange(item.slug, index);
    return;
  }

  card.dataset.targetVariantIndex = String(index);
  detach(
    selectDecodedIllustrationVariant({
      card,
      imageUrl,
      index,
      item,
      onVariantChange,
      runtime,
    }),
    Reason.DomCallback,
  );
}

function preloadIllustrationVariant(
  runtime: TemplatePreviewRuntime,
  images: readonly string[],
  index: number,
): void {
  const image = images[index];
  if (image === undefined) {
    return;
  }

  detach(
    decodeIllustrationPreviewImage(runtime, illustrationHeroImageUrl(image)),
    Reason.DomCallback,
  );
}

type IllustrationThumbnailScrollDirection = -1 | 1;

const ILLUSTRATION_THUMBNAIL_REVEAL_COUNT = 2;
const ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX = 1;

type IllustrationThumbnailScrollTarget = {
  element: HTMLElement;
  targetIsBoundary: boolean;
};

function illustrationThumbnailScrollTarget(
  node: HTMLElement,
  direction: IllustrationThumbnailScrollDirection,
): IllustrationThumbnailScrollTarget {
  let target = node;
  for (let i = 0; i < ILLUSTRATION_THUMBNAIL_REVEAL_COUNT; i += 1) {
    const sibling =
      direction > 0 ? target.nextElementSibling : target.previousElementSibling;
    if (!(sibling instanceof HTMLElement)) {
      return {
        element: target,
        targetIsBoundary: true,
      };
    }
    target = sibling;
  }
  const boundarySibling =
    direction > 0 ? target.nextElementSibling : target.previousElementSibling;
  return {
    element: target,
    targetIsBoundary: !(boundarySibling instanceof HTMLElement),
  };
}

function maxIllustrationThumbnailScrollLeft(
  thumbnailStrip: HTMLElement,
): number {
  return Math.max(0, thumbnailStrip.scrollWidth - thumbnailStrip.clientWidth);
}

function scrollIllustrationThumbnailIntoView(
  node: HTMLButtonElement | null,
  direction: IllustrationThumbnailScrollDirection,
): void {
  if (node === null) {
    return;
  }

  const thumbnailStrip = node.closest<HTMLElement>(
    "[data-illustration-variant-strip]",
  );
  if (thumbnailStrip === null) {
    return;
  }

  const { element: target, targetIsBoundary } =
    illustrationThumbnailScrollTarget(node, direction);

  if (direction < 0) {
    if (targetIsBoundary) {
      if (thumbnailStrip.scrollLeft > 0) {
        thumbnailStrip.scrollTo({
          left: 0,
        });
      }
      return;
    }

    const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const leftOverflow = thumbnailStripRect.left - targetRect.left;
    if (leftOverflow > 0) {
      thumbnailStrip.scrollTo({
        left: Math.max(0, thumbnailStrip.scrollLeft - leftOverflow),
      });
    }
    return;
  }

  if (targetIsBoundary) {
    const maxScrollLeft = maxIllustrationThumbnailScrollLeft(thumbnailStrip);
    if (thumbnailStrip.scrollLeft < maxScrollLeft) {
      thumbnailStrip.scrollTo({
        left: maxScrollLeft,
      });
    }
    return;
  }

  const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const rightOverflow = targetRect.right - thumbnailStripRect.right;
  if (rightOverflow > 0) {
    thumbnailStrip.scrollTo({
      left: Math.max(0, thumbnailStrip.scrollLeft + rightOverflow),
    });
  }
}

function activeIllustrationThumbnailScrollDirection(
  node: HTMLButtonElement,
): IllustrationThumbnailScrollDirection | null {
  const thumbnailStrip = node.closest<HTMLElement>(
    "[data-illustration-variant-strip]",
  );
  if (thumbnailStrip === null) {
    return null;
  }

  const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
  const thumbnailRect = node.getBoundingClientRect();
  const maxScrollLeft = maxIllustrationThumbnailScrollLeft(thumbnailStrip);

  if (
    thumbnailRect.right >=
      thumbnailStripRect.right - ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX &&
    (node.nextElementSibling instanceof HTMLElement ||
      thumbnailStrip.scrollLeft < maxScrollLeft)
  ) {
    return 1;
  }

  if (
    thumbnailRect.left <=
      thumbnailStripRect.left + ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX &&
    (node.previousElementSibling instanceof HTMLElement ||
      thumbnailStrip.scrollLeft > 0)
  ) {
    return -1;
  }

  return null;
}

function IllustrationTemplateCard({
  item,
  selected,
  activeIndex,
  priority = false,
  onSelect,
  onVariantChange,
  runtime,
}: {
  item: IllustrationTemplateItem;
  selected: boolean;
  activeIndex: number;
  priority?: boolean;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const images = item.previewImages;
  const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1));
  const heroSource = images[safeIndex] ?? item.previewImage;
  const hasMultipleVariants = images.length > 1;

  return (
    <div
      data-illustration-template-card=""
      className={cn(
        "group/tile mb-4 break-inside-avoid overflow-hidden border border-border bg-card",
        TEMPLATE_CARD_SHADOW,
        TEMPLATE_TILE_RING,
        selected && TEMPLATE_TILE_RING_SELECTED,
      )}
    >
      <IllustrationTemplateHero
        item={item}
        images={images}
        activeIndex={safeIndex}
        priority={priority}
        source={heroSource}
        onVariantChange={onVariantChange}
        runtime={runtime}
      />
      {hasMultipleVariants && (
        <div
          data-illustration-variant-strip=""
          className="flex items-center gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, index) => {
            const active = index === safeIndex;
            const thumbnailImage = r2ImageTransformUrl(
              image,
              ILLUSTRATION_VARIANT_THUMB_SIZE,
            );
            return (
              <button
                key={image}
                type="button"
                aria-label={t(
                  ($) => {
                    return $.artifacts.templates.showVariant;
                  },
                  {
                    variantNumber: index + 1,
                  },
                )}
                aria-pressed={active}
                className={cn(
                  "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary" : "border-border",
                )}
                onFocus={() => {
                  preloadIllustrationPreviewImage(
                    runtime,
                    illustrationHeroImageUrl(image),
                  );
                }}
                onMouseEnter={() => {
                  preloadIllustrationPreviewImage(
                    runtime,
                    illustrationHeroImageUrl(image),
                  );
                }}
                onClick={(event) => {
                  selectIllustrationVariant({
                    card: event.currentTarget.closest<HTMLElement>(
                      "[data-illustration-template-card]",
                    ),
                    index,
                    item,
                    onVariantChange,
                    runtime,
                  });
                  const scrollDirection = active
                    ? activeIllustrationThumbnailScrollDirection(
                        event.currentTarget,
                      )
                    : index > safeIndex
                      ? 1
                      : -1;
                  if (scrollDirection !== null) {
                    scrollIllustrationThumbnailIntoView(
                      event.currentTarget,
                      scrollDirection,
                    );
                  }
                }}
              >
                <img
                  src={thumbnailImage}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {item.title}
        </p>
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item);
          }}
          className={cn(
            "h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-brand-text"
              : "border-border bg-background text-foreground hover:bg-state-hover",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

function resolveTemplatePickerCategory(
  category: string,
  introVideoEnabled: boolean,
): string {
  switch (category) {
    case "intro-video": {
      return introVideoEnabled ? category : "video";
    }
    case "slides":
    case "website":
    case "illustration":
    case "video":
    case "avatar":
    case "workflow": {
      return category;
    }
    default: {
      return "slides";
    }
  }
}

function TemplatePickerCategoryNav({
  selectedCategory,
  introVideoEnabled,
  onChange,
}: {
  selectedCategory: string;
  introVideoEnabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const categoryOptions: {
    value: string;
    label: string;
    Icon: LucideIcon;
  }[] = [
    {
      value: "slides",
      label: t(($) => {
        return $.artifacts.kinds.presentation;
      }),
      Icon: Presentation,
    },
    {
      value: "website",
      label: t(($) => {
        return $.artifacts.templates.website;
      }),
      Icon: Globe,
    },
    {
      value: "illustration",
      label: t(($) => {
        return $.artifacts.templates.illustration;
      }),
      Icon: ImageIcon,
    },
    {
      value: "video",
      label: t(($) => {
        return introVideoEnabled
          ? $.artifacts.templates.creativeVideo
          : $.artifacts.kinds.video;
      }),
      Icon: Video,
    },
    ...(introVideoEnabled
      ? [
          {
            value: "intro-video",
            label: t(($) => {
              return $.artifacts.templates.introVideo;
            }),
            Icon: Presentation,
          },
        ]
      : []),
    {
      value: "avatar",
      label: t(($) => {
        return $.artifacts.templates.avatar;
      }),
      Icon: User,
    },
    {
      value: "workflow",
      label: t(($) => {
        return $.artifacts.templates.workflow;
      }),
      Icon: Route,
    },
  ];

  return (
    <>
      <div className="shrink-0 border-b border-border bg-gray-50 px-4 pb-4 pr-14 pt-4 sm:hidden">
        <Select value={selectedCategory} onValueChange={onChange}>
          <SelectTrigger
            aria-label={t(($) => {
              return $.artifacts.templates.category;
            })}
            className="h-9 w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryOptions.map(({ value, label, Icon }) => {
              return (
                <SelectItem key={value} value={value}>
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" />
                    {label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="hidden shrink-0 sm:flex">
        <div className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <TemplatePickerHeader />
          <nav
            role="tablist"
            aria-label={t(($) => {
              return $.artifacts.templates.categories;
            })}
            aria-orientation="vertical"
            data-template-picker-sidebar=""
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-3"
          >
            {categoryOptions.map(({ value, label, Icon }, categoryIndex) => {
              const selected = value === selectedCategory;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    onChange(value);
                  }}
                  onKeyDown={(event) => {
                    let nextIndex: number | null = null;
                    if (event.key === "ArrowDown") {
                      nextIndex = (categoryIndex + 1) % categoryOptions.length;
                    } else if (event.key === "ArrowUp") {
                      nextIndex =
                        (categoryIndex - 1 + categoryOptions.length) %
                        categoryOptions.length;
                    } else if (event.key === "Home") {
                      nextIndex = 0;
                    } else if (event.key === "End") {
                      nextIndex = categoryOptions.length - 1;
                    }
                    if (nextIndex === null) {
                      return;
                    }
                    event.preventDefault();
                    const nextTab = event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLElement>("[role=tab]")
                      .item(nextIndex);
                    nextTab?.focus();
                    onChange(categoryOptions[nextIndex]?.value ?? value);
                  }}
                  className={cn(
                    "group flex h-9 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected
                      ? "bg-gray-50 font-medium text-foreground"
                      : "text-gray-800 hover:bg-state-hover hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      selected
                        ? "text-foreground"
                        : "text-gray-700 group-hover:text-gray-800",
                    )}
                  />
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </>
  );
}

function TemplatePickerHeader() {
  const { t } = useTranslation();
  return (
    <header className="flex h-[68px] shrink-0 items-center px-5">
      <h2 className="text-lg font-semibold leading-6 tracking-tight text-foreground">
        {t(($) => {
          return $.artifacts.templates.template;
        })}
      </h2>
    </header>
  );
}

function TemplatePickerWorkflowSearch({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative w-56 shrink-0">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={t(($) => {
            return $.artifacts.templates.searchConnectors;
          })}
          className="h-9 pl-9 text-sm"
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
          placeholder={t(($) => {
            return $.artifacts.templates.searchConnector;
          })}
        />
      </div>
    </div>
  );
}

function IllustrationTemplateGrid({
  items,
  runtime,
  value,
  variantIndexBySlug,
  onSelect,
  onVariantChange,
}: {
  items: readonly IllustrationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  value: GenerationTemplateRequest | undefined;
  variantIndexBySlug: Readonly<Record<string, number>>;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
}) {
  // CSS multi-column masonry mirrors www.okou.ai/illustration: each tile renders
  // the full illustration at its native aspect ratio (no cropping, letterbox,
  // or fixed height), and the column count adapts to the dialog width.
  return (
    <div className="columns-[244px] gap-4">
      {items.map((item, index) => {
        return (
          <IllustrationTemplateCard
            key={item.illustrationStyleId}
            item={item}
            selected={isSelectedIllustrationTemplate(item, value)}
            activeIndex={variantIndexBySlug[item.slug] ?? 0}
            priority={index < ILLUSTRATION_EAGER_IMAGE_COUNT}
            onSelect={onSelect}
            onVariantChange={onVariantChange}
            runtime={runtime}
          />
        );
      })}
    </div>
  );
}

/**
 * Hands the chosen deck to the composer, which attaches it, sends it, and
 * navigates into the new thread. Importing is the ordinary chat path with the
 * message written for the user, not a separate upload flow.
 *
 * The import owns the root signal, like the ordinary send and upload controls:
 * from the new-thread composer it outlives the page it started on. A page
 * signal is aborted by the very navigation this send performs, which would kill
 * the in-flight thread create and the run that follows it, leaving a thread the
 * user can see but the server never recorded.
 */
function PptImportCard({
  signals,
  onImported,
  compact = false,
}: {
  signals: ComposerSignals;
  onImported: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const importDeck = useSet(importPresentationTemplateDeck$);
  const label = t(($) => {
    return $.artifacts.templates.importDeck;
  });
  return (
    <label
      data-presentation-template-import=""
      className={TEMPLATE_TILE_WRAPPER}
    >
      <span
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          "block aspect-video bg-muted/40 transition-colors duration-150 group-hover/tile:bg-muted/60 group-active/tile:bg-muted/80 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
          compact && "bg-gray-50 group-hover/tile:bg-state-hover",
        )}
      >
        <Plus
          className="absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 text-muted-foreground transition-colors duration-150 group-hover/tile:text-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
        <input
          type="file"
          className="sr-only"
          accept={PRESENTATION_TEMPLATE_IMPORT_ACCEPT}
          aria-label={label}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Clear the input so choosing the same deck again still fires.
            event.currentTarget.value = "";
            if (!file) {
              return;
            }
            onImported();
            detach(
              importDeck({ signals, file }, rootSignal),
              Reason.DomCallback,
            );
          }}
        />
      </span>
      <span
        className={cn(
          TEMPLATE_TILE_CAPTION,
          compact && "flex-col items-stretch gap-0.5",
        )}
      >
        <span className={TEMPLATE_TILE_NAME}>{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {t(($) => {
            return $.artifacts.templates.importDeckHint;
          })}
        </span>
      </span>
    </label>
  );
}

function importedPresentationTemplateSlideIndex(
  event: ReactMouseEvent<HTMLDivElement>,
  slideCount: number,
): number | null {
  if (slideCount < 2) {
    return null;
  }
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) {
    return null;
  }
  const offsetX = Math.min(
    rect.width - 1,
    Math.max(0, event.clientX - rect.left),
  );
  return Math.min(
    slideCount - 1,
    Math.round((offsetX / rect.width) * (slideCount - 1)),
  );
}

function ImportedPptCardMediaControls({
  template,
  selected,
  loading,
  onPreview,
  onSelect,
}: {
  template: PresentationTemplateSummary;
  selected: boolean;
  loading: boolean;
  onPreview: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewCurrentSlide;
          },
          { title: template.title },
        )}
        className="absolute inset-0 z-10 cursor-zoom-in bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onPreview}
      />
      <div className={TEMPLATE_TILE_SCRIM} />
      {selected ? (
        <span className="pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check size={14} />
        </span>
      ) : null}
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.selectTemplate;
          },
          { title: template.title },
        )}
        aria-pressed={selected}
        className={TEMPLATE_TILE_USE}
        onClick={onSelect}
      >
        {t(($) => {
          return $.artifacts.templates.use;
        })}
      </button>
      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
    </>
  );
}

function importedPptImageVariant(
  imageUrl: string | null,
  size: TemplatePreviewImageSize,
): string | null {
  return imageUrl === null ? null : r2ImageTransformUrl(imageUrl, size);
}

const IMPORTED_PPT_IMAGE_SLOTS = ["a", "b"] as const;

function importedPptImageLoadMatches(
  image: ImportedPresentationTemplateLoadedImage | null,
  desiredUrl: string,
  sourceUrl: string,
): boolean {
  return image?.desiredUrl === desiredUrl && image.sourceUrl === sourceUrl;
}

function importedPptImageLoadFailed(
  failedImages: readonly ImportedPresentationTemplateLoadedImage[],
  desiredUrl: string,
  sourceUrl: string,
): boolean {
  return failedImages.some((image) => {
    return importedPptImageLoadMatches(image, desiredUrl, sourceUrl);
  });
}

function importedPptImageCandidateSource(
  state: ImportedPresentationTemplateImageState,
  desiredUrl: string | null,
  desiredSourceUrl: string | null,
  previewSourceUrl: string | null,
): string | null {
  if (
    desiredUrl === null ||
    desiredSourceUrl === null ||
    importedPptImageLoadMatches(state.active, desiredUrl, desiredSourceUrl)
  ) {
    return null;
  }
  const resolvedPreviewSourceUrl = previewSourceUrl ?? desiredSourceUrl;
  if (
    state.active === null &&
    resolvedPreviewSourceUrl !== desiredSourceUrl &&
    !importedPptImageLoadFailed(
      state.failed,
      desiredUrl,
      resolvedPreviewSourceUrl,
    )
  ) {
    return resolvedPreviewSourceUrl;
  }
  return importedPptImageLoadFailed(state.failed, desiredUrl, desiredSourceUrl)
    ? null
    : desiredSourceUrl;
}

function importedPptImageForSlot({
  active,
  candidateSourceUrl,
  candidateSlot,
  desiredUrl,
  slot,
}: {
  readonly active: ImportedPresentationTemplateLoadedImage | null;
  readonly candidateSourceUrl: string | null;
  readonly candidateSlot: ImportedPresentationTemplateImageSlot;
  readonly desiredUrl: string | null;
  readonly slot: ImportedPresentationTemplateImageSlot;
}): ImportedPresentationTemplateLoadedImage | null {
  if (active?.slot === slot) {
    return active;
  }
  if (
    candidateSourceUrl === null ||
    desiredUrl === null ||
    candidateSlot !== slot
  ) {
    return null;
  }
  return { desiredUrl, sourceUrl: candidateSourceUrl, slot };
}

function ImportedPptImage({
  className,
  fetchPriority,
  imageSignals,
  label,
  loading,
  placeholder,
  previewSize,
  size,
}: {
  readonly className: string;
  readonly fetchPriority: "auto" | "high" | "low";
  readonly imageSignals: ImportedPresentationTemplateImageSignals;
  readonly label: string;
  readonly loading: "eager" | "lazy";
  readonly placeholder?: ReactNode;
  readonly previewSize?: TemplatePreviewImageSize;
  readonly size: TemplatePreviewImageSize;
}) {
  const desiredUrl = useLastResolved(imageSignals.desiredUrl$) ?? null;
  const pageSignal = useGet(pageSignal$);
  const state = useGet(imageSignals.state$);
  const commitLoadedImage = useSet(imageSignals.commitLoadedImage$);
  const failImageLoad = useSet(imageSignals.failImageLoad$);
  const desiredSourceUrl = importedPptImageVariant(desiredUrl, size);
  const previewSourceUrl = importedPptImageVariant(
    desiredUrl,
    previewSize ?? size,
  );
  const active = desiredUrl === null ? null : state.active;
  const candidateSourceUrl = importedPptImageCandidateSource(
    state,
    desiredUrl,
    desiredSourceUrl,
    previewSourceUrl,
  );
  const candidateSlot = active?.slot === "a" ? "b" : "a";
  const placeholderState =
    active !== null
      ? "hidden"
      : desiredUrl === null || candidateSourceUrl === null
        ? "error"
        : "loading";
  return (
    <>
      {IMPORTED_PPT_IMAGE_SLOTS.map((slot) => {
        const image = importedPptImageForSlot({
          active,
          candidateSourceUrl,
          candidateSlot,
          desiredUrl,
          slot,
        });
        const isActive = active?.slot === slot;
        const isInitialCandidate = active === null && image !== null;
        return (
          <img
            key={`${slot}:${image?.desiredUrl ?? "empty"}:${image?.sourceUrl ?? "empty"}`}
            src={image?.sourceUrl}
            alt={isActive || isInitialCandidate ? label : ""}
            aria-hidden={isActive || isInitialCandidate ? undefined : "true"}
            title={isActive || isInitialCandidate ? label : undefined}
            data-imported-presentation-template-image={slot}
            data-active={isActive ? "true" : "false"}
            data-loaded-image-url={isActive ? active.sourceUrl : undefined}
            loading={loading}
            decoding="async"
            fetchPriority={fetchPriority}
            draggable={false}
            className={cn(
              className,
              "opacity-0 data-[active=true]:opacity-100",
            )}
            onLoad={(event) => {
              if (image !== null && event.currentTarget.isConnected) {
                detach(
                  commitLoadedImage(image, pageSignal),
                  Reason.DomCallback,
                );
              }
            }}
            onError={(event) => {
              if (image !== null && event.currentTarget.isConnected) {
                detach(failImageLoad(image, pageSignal), Reason.DomCallback);
              }
            }}
          />
        );
      })}
      {placeholder === undefined ? null : (
        <div
          hidden={placeholderState === "hidden"}
          data-imported-presentation-template-image-placeholder=""
          data-state={placeholderState}
          className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-muted/60 text-muted-foreground data-[state=loading]:animate-pulse"
        >
          {placeholder}
        </div>
      )}
    </>
  );
}

function ImportedPptCardMedia({
  template,
  selected,
  activeSlideIndex,
  slideCount,
  imageSignals,
  loading,
  label,
  onRequestDetail,
  onHover,
  onPreview,
  onSelect,
}: {
  template: PresentationTemplateSummary;
  selected: boolean;
  activeSlideIndex: number;
  slideCount: number;
  imageSignals: ImportedPresentationTemplateImageSignals;
  loading: boolean;
  label: string;
  onRequestDetail: () => void;
  onHover: (index: number | null) => void;
  onPreview: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      data-imported-presentation-template-media=""
      className={cn(
        TEMPLATE_TILE_MEDIA,
        TEMPLATE_TILE_RING,
        "aspect-[16/9]",
        selected && TEMPLATE_TILE_RING_SELECTED,
      )}
      onMouseEnter={() => {
        onRequestDetail();
        onHover(0);
      }}
      onMouseMove={(event) => {
        const nextIndex = importedPresentationTemplateSlideIndex(
          event,
          slideCount,
        );
        if (nextIndex !== null && nextIndex !== activeSlideIndex) {
          onHover(nextIndex);
        }
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
    >
      <ImportedPptImage
        imageSignals={imageSignals}
        label={label}
        loading="eager"
        fetchPriority="high"
        size={TEMPLATE_CARD_PREVIEW_SIZE}
        placeholder={<ImageIcon size={24} aria-hidden="true" />}
        className="pointer-events-none absolute inset-0 h-full w-full bg-background object-cover"
      />
      <ImportedPptCardMediaControls
        template={template}
        selected={selected}
        loading={loading}
        onPreview={onPreview}
        onSelect={onSelect}
      />
    </div>
  );
}

function ImportedPptCardCaption({
  template,
}: {
  template: PresentationTemplateSummary;
}) {
  return (
    <div className={TEMPLATE_TILE_CAPTION}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <p className={cn(TEMPLATE_TILE_NAME, "cursor-default")}>
              {template.title}
            </p>
          </TooltipTrigger>
          <TooltipContent side="bottom">{template.title}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function ImportedPptCard({
  imageSignals,
  template,
  selected,
  onSelect,
  onPreview,
  signals,
}: {
  imageSignals: ImportedPresentationTemplateImageSignals;
  template: PresentationTemplateSummary;
  selected: boolean;
  onSelect: (template: PresentationTemplateSummary) => void;
  onPreview: (templateId: string, slideIndex: number) => void;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const detailLoadable = useLoadable(
    signals.template.importedPresentationTemplateDetail$,
  );
  const requestedTemplateId = useGet(
    signals.template.importedPresentationTemplateRequestedId$,
  );
  const hover = useGet(signals.template.importedPresentationTemplateCardHover$);
  const requestDetail = useSet(
    signals.template.requestImportedPresentationTemplateDetail$,
  );
  const setHover = useSet(
    signals.template.setImportedPresentationTemplateCardHover$,
  );
  const detail =
    detailLoadable.state === "hasData" &&
    detailLoadable.data?.id === template.id
      ? detailLoadable.data
      : null;
  const slideCount = Math.max(1, detail?.pageUrls.length ?? template.pageCount);
  const activeSlideIndex = Math.max(
    0,
    Math.min(
      hover?.templateId === template.id ? hover.index : 0,
      slideCount - 1,
    ),
  );
  const loading =
    requestedTemplateId === template.id && detailLoadable.state === "loading";
  const label = t(
    ($) => {
      return $.artifacts.templates.slidePreview;
    },
    {
      title: template.title,
    },
  );
  const setCardHover = (index: number | null) => {
    setHover(index === null ? null : { templateId: template.id, index });
  };
  return (
    <div
      className={TEMPLATE_TILE_WRAPPER}
      data-imported-presentation-template={template.id}
    >
      <ImportedPptCardMedia
        template={template}
        selected={selected}
        activeSlideIndex={activeSlideIndex}
        slideCount={slideCount}
        imageSignals={imageSignals}
        loading={loading}
        label={label}
        onRequestDetail={() => {
          requestDetail(template.id);
        }}
        onHover={setCardHover}
        onPreview={() => {
          onPreview(template.id, activeSlideIndex);
        }}
        onSelect={() => {
          onSelect(template);
        }}
      />
      <ImportedPptCardCaption template={template} />
    </div>
  );
}

/** A name wraps across lines on screen but is stored as one. */
function normalizeImportedTemplateTitle(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * A template name is one line of meaning but not one line of layout: the panel
 * is 320px wide, so anything past a dozen or so characters has to go somewhere.
 * An `<input>` answers that by scrolling the overflow out of view without even
 * an ellipsis, which is how a name ends up cut mid-glyph. A textarea wraps
 * instead, and the mirrored `::after` grows the grid row to the wrapped text so
 * the field gains lines rather than a scrollbar. Enter still submits and
 * whitespace folds on the way out, so the value stays the single line it models.
 *
 * The check then keeps its column at every height but not its ink. Lit from
 * the moment the panel opens it reads as a state badge rather than an action,
 * so it waits for a reason to exist: pointing at the control, entering it, or
 * a draft that differs from the saved name. Hover and focus have to count
 * because the check is now the only thing that says the name is editable —
 * a hairline border alone reads as decoration. A dirty draft pins it on, so
 * the way back to the check is never to go find the field again.
 */
function ImportedPresentationTemplateRenameControl({
  title,
  updating,
  onRename,
}: {
  title: string;
  updating: boolean;
  onRename: (title: string) => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.renameImportedTemplate;
  });
  return (
    <form
      className="group flex min-w-0 items-start gap-1.5"
      data-rename-dirty="false"
      onSubmit={(event) => {
        event.preventDefault();
        const nextTitle = new FormData(event.currentTarget).get("title");
        if (typeof nextTitle !== "string") {
          return;
        }
        const normalized = normalizeImportedTemplateTitle(nextTitle);
        if (normalized.length > 0 && normalized !== title) {
          // Confirming ends this edit. Keeping the submit control focused pins
          // the check visible through the form's focus-within affordance.
          event.currentTarget.querySelector<HTMLElement>(":focus")?.blur();
          onRename(normalized);
        }
      }}
    >
      <div
        className="grid min-h-10 min-w-0 flex-1 rounded-lg border border-transparent px-1 py-[5px] text-xl font-semibold leading-7 text-foreground transition-colors after:col-start-1 after:row-start-1 after:invisible after:whitespace-pre-wrap after:break-words after:content-[attr(data-value)_'_'] hover:border-[hsl(var(--gray-400))] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-primary/10"
        data-value={title}
      >
        <textarea
          name="title"
          aria-label={label}
          defaultValue={title}
          required
          rows={1}
          maxLength={255}
          className="col-start-1 row-start-1 resize-none overflow-hidden break-words bg-transparent p-0 outline-none"
          onChange={(event) => {
            const field = event.currentTarget;
            const mirror = field.parentElement;
            const form = field.form;
            if (!mirror || !form) {
              return;
            }
            const normalized = normalizeImportedTemplateTitle(field.value);
            mirror.dataset.value = field.value;
            form.dataset.renameDirty = String(
              normalized.length > 0 && normalized !== title,
            );
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
      </div>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              variant="quiet"
              size="icon-sm"
              disabled={updating}
              aria-label={label}
              className="invisible mt-1 shrink-0 group-focus-within:visible group-hover:visible group-data-[rename-dirty=true]:visible"
            >
              {updating ? <Loader2 className="animate-spin" /> : <Check />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </form>
  );
}

const IMPORTED_TEMPLATE_VISIBILITY_OPTIONS = [
  { value: "private", Icon: Lock },
  { value: "public", Icon: Users },
] as const;

/**
 * Visibility for an imported deck, stated as its consequence rather than as a
 * setting: a template is only ever "mine" or "everyone's here", so the two
 * words that name those states carry less than the one sentence that says what
 * they do. The sentence stays on screen and the picker moves behind `Change`,
 * because reading the current state is the common act and switching it is not.
 */
function ImportedPresentationTemplateVisibilityControl({
  visibility,
  updating,
  onChange,
}: {
  visibility: PresentationTemplateSummary["visibility"];
  updating: boolean;
  onChange: (visibility: PresentationTemplateSummary["visibility"]) => void;
}) {
  const { t } = useTranslation();
  const optionLabel = (value: PresentationTemplateSummary["visibility"]) => {
    return value === "private"
      ? t(($) => {
          return $.workflows.common.private;
        })
      : t(($) => {
          return $.settings.dialog.groups.workspace;
        });
  };
  const optionState = (value: PresentationTemplateSummary["visibility"]) => {
    return value === "private"
      ? t(($) => {
          return $.artifacts.templates.visibility.privateState;
        })
      : t(($) => {
          return $.artifacts.templates.visibility.workspaceState;
        });
  };
  const CurrentIcon = visibility === "private" ? Lock : Users;
  return (
    <Popover>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <CurrentIcon size={14} className="shrink-0" aria-hidden="true" />
        <span>{optionState(visibility)}</span>
        <span aria-hidden="true">·</span>
        <PopoverTrigger
          disabled={updating}
          className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground disabled:opacity-50"
          aria-label={t(($) => {
            return $.artifacts.templates.visibility.changeLabel;
          })}
        >
          {t(($) => {
            return $.artifacts.templates.visibility.change;
          })}
        </PopoverTrigger>
      </p>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[19rem] p-1.5"
      >
        <div
          role="radiogroup"
          aria-label={t(($) => {
            return $.workflows.detail.metadata.visibility;
          })}
        >
          {IMPORTED_TEMPLATE_VISIBILITY_OPTIONS.map(({ value, Icon }) => {
            const selected = value === visibility;
            return (
              <PopoverClose asChild key={value}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-state-hover",
                    selected && "bg-state-selected",
                  )}
                  onClick={() => {
                    if (!selected) {
                      onChange(value);
                    }
                  }}
                >
                  <Icon
                    size={16}
                    className="mt-0.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">
                      {optionLabel(value)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {optionState(value)}
                    </span>
                  </span>
                  {/* The check column is reserved on both rows: letting it
                      appear only on the selected one narrows that row's text
                      box, so the description reflows every time the selection
                      moves. */}
                  <span className="mt-0.5 w-4 shrink-0">
                    {selected ? (
                      <Check
                        size={16}
                        className="text-foreground"
                        aria-hidden="true"
                      />
                    ) : null}
                  </span>
                </button>
              </PopoverClose>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ImportedPresentationTemplateUseButton({
  template,
  onSelect,
}: {
  template: PresentationTemplateSummary;
  onSelect: (template: PresentationTemplateSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      aria-label={t(
        ($) => {
          return $.artifacts.templates.selectTemplate;
        },
        { title: template.title },
      )}
      className="mt-5 h-12 w-full font-semibold shadow-sm"
      onClick={() => {
        onSelect(template);
      }}
    >
      {t(($) => {
        return $.artifacts.templates.useThisTemplate;
      })}
    </Button>
  );
}

function ImportedPresentationTemplateDeleteControl({
  summary,
  signals,
}: {
  summary: PresentationTemplateSummary;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [deleteLoadable, deleteTemplate] = useLoadableSet(
    signals.template.deleteImportedPresentationTemplate$,
  );
  const deleting = deleteLoadable.state === "loading";
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      disabled={deleting}
      className="mt-2 w-full text-destructive hover:text-destructive"
      onClick={() => {
        detach(deleteTemplate(summary.id, pageSignal), Reason.DomCallback);
      }}
    >
      {deleting ? <Loader2 className="animate-spin" /> : null}
      {t(($) => {
        return $.chat.actions.delete;
      })}
    </Button>
  );
}

function ImportedPresentationTemplateSidebar({
  summary,
  detail,
  title,
  slideCount,
  onSelect,
  signals,
}: {
  summary: PresentationTemplateSummary;
  detail: PresentationTemplateDetail | null;
  title: string;
  slideCount: number;
  onSelect: (template: PresentationTemplateSummary) => void;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateTemplate] = useLoadableSet(
    signals.template.updateImportedPresentationTemplate$,
  );
  const activeTemplate = detail === null ? summary : detail;
  const updating = updateLoadable.state === "loading";
  const update = (
    body: { title: string } | { visibility: "private" | "public" },
  ) => {
    detach(updateTemplate(summary.id, body, pageSignal), Reason.DomCallback);
  };
  return (
    <div className="flex flex-col lg:sticky lg:top-0">
      <div className="rounded-lg border border-border bg-background p-4 shadow-sm">
        {activeTemplate.canManage ? (
          <ImportedPresentationTemplateRenameControl
            key={title}
            title={title}
            updating={updating}
            onRename={(nextTitle) => {
              update({ title: nextTitle });
            }}
          />
        ) : (
          <h3 className="text-xl font-semibold text-foreground">{title}</h3>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.artifacts.templates.importedSlides;
            },
            { count: slideCount },
          )}
        </p>
        {activeTemplate.canManage ? (
          <>
            <div className="my-5 border-t border-border" />
            <ImportedPresentationTemplateVisibilityControl
              visibility={activeTemplate.visibility}
              updating={updating}
              onChange={(nextVisibility) => {
                update({ visibility: nextVisibility });
              }}
            />
          </>
        ) : null}
        <ImportedPresentationTemplateUseButton
          template={activeTemplate}
          onSelect={onSelect}
        />
        {activeTemplate.canManage ? (
          <ImportedPresentationTemplateDeleteControl
            summary={summary}
            signals={signals}
          />
        ) : null}
      </div>
    </div>
  );
}

function ImportedPresentationTemplatePreviewHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogHeader className="flex h-[68px] shrink-0 justify-center border-b border-border px-6 pr-14 text-left duration-200 motion-reduce:animate-none">
      <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
        <button
          type="button"
          className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onBack}
        >
          {t(($) => {
            return $.artifacts.templates.template;
          })}
        </button>
        <span className="shrink-0 text-muted-foreground">/</span>
        <span className="block min-w-0 truncate leading-none">{title}</span>
      </DialogTitle>
    </DialogHeader>
  );
}

function ImportedPresentationTemplateMainPreview({
  title,
  activeSlideIndex,
  imageSignals,
  slideCount,
  loading,
  onChange,
  onKeyDown,
}: {
  title: string;
  activeSlideIndex: number;
  imageSignals: ImportedPresentationTemplateImageSignals;
  slideCount: number;
  loading: boolean;
  onChange: (index: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  const previewLabel = t(
    ($) => {
      return $.artifacts.templates.slidePreview;
    },
    { title },
  );
  return (
    <div
      role="group"
      aria-label={previewLabel}
      data-testid={`${title} imported detail image preview`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative aspect-[16/9] overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ImportedPptImage
        imageSignals={imageSignals}
        label={previewLabel}
        loading="eager"
        fetchPriority="high"
        size={TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE}
        previewSize={TEMPLATE_CARD_PREVIEW_SIZE}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      />
      <button
        type="button"
        aria-label={t(($) => {
          return $.artifacts.templates.previousSlide;
        })}
        disabled={activeSlideIndex === 0}
        tabIndex={-1}
        onClick={() => {
          onChange(activeSlideIndex - 1);
        }}
        className="absolute inset-y-0 left-0 w-1/2 cursor-w-resize bg-transparent focus:outline-none disabled:cursor-default"
      />
      <button
        type="button"
        aria-label={t(($) => {
          return $.artifacts.templates.nextSlide;
        })}
        disabled={activeSlideIndex >= slideCount - 1}
        tabIndex={-1}
        onClick={() => {
          onChange(activeSlideIndex + 1);
        }}
        className="absolute inset-y-0 right-0 w-1/2 cursor-e-resize bg-transparent focus:outline-none disabled:cursor-default"
      />
      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
    </div>
  );
}

function ImportedPresentationTemplateThumbnails({
  pageUrls,
  activeSlideIndex,
  imageSignals,
  onChange,
  onKeyDown,
}: {
  pageUrls: readonly string[];
  activeSlideIndex: number;
  imageSignals: readonly ImportedPresentationTemplateImageSignals[];
  onChange: (index: number) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-1.5 lg:grid-cols-8"
      onKeyDown={onKeyDown}
    >
      {pageUrls.map((_pageUrl, index) => {
        const slideNumber = index + 1;
        const active = index === activeSlideIndex;
        const eagerlyLoad =
          index < IMPORTED_PRESENTATION_TEMPLATE_EAGER_THUMBNAIL_COUNT;
        const previewLabel = t(
          ($) => {
            return $.artifacts.templates.previewSlide;
          },
          { slideNumber },
        );
        const thumbnailImageSignals = imageSignals[index];
        if (thumbnailImageSignals === undefined) {
          throw new Error(
            `Imported presentation thumbnail image state is missing: ${slideNumber.toString()}`,
          );
        }
        return (
          <button
            key={slideNumber}
            type="button"
            aria-label={previewLabel}
            aria-pressed={active}
            onClick={() => {
              onChange(index);
            }}
            className={cn(
              "relative aspect-[16/9] overflow-hidden rounded-md border bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "border-ring ring-1 ring-ring"
                : "border-border hover:border-muted-foreground/50",
            )}
          >
            <ImportedPptImage
              imageSignals={thumbnailImageSignals}
              label={previewLabel}
              loading={eagerlyLoad ? "eager" : "lazy"}
              fetchPriority={active ? "high" : eagerlyLoad ? "auto" : "low"}
              size={TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            />
            <span className="absolute bottom-1 right-1 rounded border border-border bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow-sm backdrop-blur">
              {slideNumber}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ImportedPresentationTemplatePreviewPage({
  imageBuffers,
  summary,
  onBack,
  onSelect,
  signals,
}: {
  imageBuffers: ImportedPresentationTemplateImageBuffers;
  summary: PresentationTemplateSummary;
  onBack: () => void;
  onSelect: (template: PresentationTemplateSummary) => void;
  signals: ComposerSignals;
}) {
  const detailLoadable = useLoadable(
    signals.template.importedPresentationTemplateDetail$,
  );
  const lastResolvedDetail = useLastResolved(
    signals.template.importedPresentationTemplateDetail$,
  );
  const activeSlideIndexRaw = useGet(
    signals.template.importedPresentationTemplatePreviewSlideIndex$,
  );
  const selectSlide = useSet(
    signals.template.selectImportedPresentationTemplatePreviewSlide$,
  );
  const currentDetail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const loadedDetail =
    currentDetail?.id === summary.id
      ? currentDetail
      : lastResolvedDetail?.id === summary.id
        ? lastResolvedDetail
        : null;
  const detail =
    loadedDetail?.id === summary.id ? { ...loadedDetail, ...summary } : null;
  const activeTemplate = detail === null ? summary : detail;
  const title = activeTemplate.title;
  const pageUrls =
    detail === null
      ? summary.coverUrl === null
        ? []
        : [summary.coverUrl]
      : detail.pageUrls;
  const slideCount = Math.max(1, activeTemplate.pageCount);
  const activeSlideIndex = Math.max(
    0,
    Math.min(activeSlideIndexRaw, slideCount - 1),
  );
  const changeSlide = (index: number) => {
    selectSlide(Math.max(0, Math.min(slideCount - 1, index)));
  };
  const handleSlideKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "ArrowLeft" && activeSlideIndex > 0) {
      event.preventDefault();
      changeSlide(activeSlideIndex - 1);
    }
    if (event.key === "ArrowRight" && activeSlideIndex < slideCount - 1) {
      event.preventDefault();
      changeSlide(activeSlideIndex + 1);
    }
  };

  return (
    <>
      <ImportedPresentationTemplatePreviewHeader
        title={title}
        onBack={onBack}
      />
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto bg-muted/20 p-3 duration-200 motion-reduce:animate-none sm:gap-4 sm:p-5 lg:max-h-[72vh] lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
        <div className="rounded-lg border border-border bg-background p-2.5 sm:p-3 lg:overflow-y-auto">
          <ImportedPresentationTemplateMainPreview
            title={title}
            activeSlideIndex={activeSlideIndex}
            imageSignals={imageBuffers.detail}
            slideCount={slideCount}
            loading={detailLoadable.state === "loading"}
            onChange={changeSlide}
            onKeyDown={handleSlideKeyDown}
          />
          <ImportedPresentationTemplateThumbnails
            pageUrls={pageUrls}
            activeSlideIndex={activeSlideIndex}
            imageSignals={imageBuffers.thumbnails}
            onChange={changeSlide}
            onKeyDown={handleSlideKeyDown}
          />
        </div>
        <ImportedPresentationTemplateSidebar
          summary={summary}
          detail={detail}
          title={title}
          slideCount={slideCount}
          onSelect={onSelect}
          signals={signals}
        />
      </div>
    </>
  );
}

function useImportedPresentationTemplatePickerItems(
  signals: ComposerSignals,
): readonly ImportedPresentationTemplatePickerItem[] {
  const items =
    useLastResolved(
      signals.template.importedPresentationTemplatePickerItems$,
    ) ?? [];
  const deletedTemplateIds = useGet(
    signals.template.importedPresentationTemplateDeletedIds$,
  );
  return deletedTemplateIds.size === 0
    ? items
    : items.filter((item) => {
        return !deletedTemplateIds.has(item.template.id);
      });
}

function useImportedPresentationTemplates(
  signals: ComposerSignals,
): readonly PresentationTemplateSummary[] {
  return useImportedPresentationTemplatePickerItems(signals).map((item) => {
    return item.template;
  });
}

function ComposerPresentationSuggestion({
  title,
  children,
  onSelect,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="quiet"
      className="group/tile block h-auto min-w-0 rounded-xl p-0 text-left font-normal hover:bg-gray-50"
      onClick={onSelect}
    >
      <span
        className={cn(
          TEMPLATE_TILE_MEDIA,
          TEMPLATE_TILE_RING,
          "block aspect-video group-hover/tile:opacity-90",
        )}
      >
        {children}
      </span>
      <span className={cn(TEMPLATE_TILE_CAPTION, "block")}>
        <span className={cn(TEMPLATE_TILE_NAME, "block")} title={title}>
          {title}
        </span>
      </span>
    </Button>
  );
}

export function ComposerPresentationRecommendations({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const picker = useComposerTemplatePicker(signals);
  const imported = useImportedPresentationTemplatePickerItems(signals).slice(
    0,
    3,
  );
  const builtIn = PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(
    0,
    3 - imported.length,
  );
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const setMode = useSet(signals.create.setMode$);
  return (
    <div
      className="flex flex-col gap-2"
      role="group"
      aria-label={t(($) => {
        return $.chat.taskChips.presentationTemplates;
      })}
    >
      <div className="flex justify-end">
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="font-normal hover:bg-gray-50"
          onClick={() => {
            openTemplates({ kind: "insert", category: "slides" });
          }}
        >
          {t(($) => {
            return $.chat.taskChips.moreTemplates;
          })}
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-2 items-start gap-4 sm:grid-cols-4">
        <PptImportCard
          signals={signals}
          compact
          onImported={() => {
            setMode(null);
          }}
        />
        {imported.map(({ imageBuffers, template }) => {
          return (
            <ComposerPresentationSuggestion
              key={template.id}
              title={template.title}
              onSelect={() => {
                picker.onChange(
                  toImportedPresentationGenerationTemplate(template),
                );
              }}
            >
              <ImportedPptImage
                imageSignals={imageBuffers.card}
                label=""
                loading="eager"
                fetchPriority="high"
                size={TEMPLATE_CARD_PREVIEW_SIZE}
                placeholder={<ImageIcon size={24} aria-hidden />}
                className="pointer-events-none absolute inset-0 h-full w-full bg-background object-cover"
              />
            </ComposerPresentationSuggestion>
          );
        })}
        {builtIn.map((item) => {
          return (
            <ComposerPresentationSuggestion
              key={item.slug}
              title={item.title}
              onSelect={() => {
                picker.onChange(toPresentationGenerationTemplate(item));
              }}
            >
              <img
                src={presentationTemplateCardSlideImage(item, 0)}
                alt=""
                loading="lazy"
                className="absolute inset-0 h-full w-full object-cover"
              />
            </ComposerPresentationSuggestion>
          );
        })}
      </div>
    </div>
  );
}

function PptTemplateGrid({
  items,
  importedItems,
  runtime,
  value,
  onSelect,
  onSelectImported,
  onPreview,
  onPreviewImported,
  onImported,
  signals,
}: {
  items: readonly PresentationTemplateItem[];
  importedItems: readonly ImportedPresentationTemplatePickerItem[];
  runtime: TemplatePreviewRuntime;
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  onSelectImported: (template: PresentationTemplateSummary) => void;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  onPreviewImported: (templateId: string, slideIndex: number) => void;
  onImported: () => void;
  signals: ComposerSignals;
}) {
  // Import tile, then accessible uploaded decks (owned decks are sorted first),
  // then the built-in templates.
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <PptImportCard signals={signals} onImported={onImported} />
      {importedItems.map(({ imageBuffers, template }) => {
        return (
          <ImportedPptCard
            key={template.id}
            imageSignals={imageBuffers.card}
            template={template}
            selected={
              value?.type === "presentation" &&
              value.selection.templateId ===
                formatUserPresentationTemplateId(template.id)
            }
            onSelect={onSelectImported}
            onPreview={onPreviewImported}
            signals={signals}
          />
        );
      })}
      {items.map((item) => {
        return (
          <PptCard
            key={item.slug}
            item={item}
            selected={isSelectedPresentationTemplate(item, value)}
            onSelect={onSelect}
            onPreview={onPreview}
            runtime={runtime}
            signals={signals}
          />
        );
      })}
    </div>
  );
}

function TemplatePickerDialog({
  value,
  onChange,
  onClose,
  onCloseComplete,
  open,
  presentationItems,
  runtime,
  signals,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  onCloseComplete: () => void;
  open: boolean;
  presentationItems: readonly PresentationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const planCapabilities = useLastResolved(orgPlanCapabilities$);
  const videoGenerationAllowed =
    planCapabilities?.videoGenerationAllowed ?? true;
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const category = useGet(signals.template.templatePickerCategory$);
  const setCategory = useSet(signals.template.setTemplatePickerCategory$);
  const search = useGet(signals.template.templatePickerSearch$);
  const setSearch = useSet(signals.template.setTemplatePickerSearch$);
  const previewSlug = useGet(signals.template.templatePickerPreviewSlug$);
  const importedPreviewId = useGet(
    signals.template.importedPresentationTemplatePreviewId$,
  );
  const importedPreviewSlideIndex = useGet(
    signals.template.importedPresentationTemplatePreviewSlideIndex$,
  );
  const importedDetailLoadable = useLoadable(
    signals.template.importedPresentationTemplateDetail$,
  );
  const openImportedPreview = useSet(
    signals.template.openImportedPresentationTemplatePreview$,
  );
  const closeImportedPreview = useSet(
    signals.template.closeImportedPresentationTemplatePreview$,
  );
  const selectImportedPreviewSlide = useSet(
    signals.template.selectImportedPresentationTemplatePreviewSlide$,
  );
  const resetImportedTemplatePicker = useSet(
    signals.template.resetImportedPresentationTemplatePicker$,
  );
  const restorePresentationGridScroll = useSet(
    signals.template.restoreTemplatePickerPresentationScroll$,
  );
  const setPresentationGridScrollTop = useSet(
    signals.template.setTemplatePickerPresentationScrollTop$,
  );
  const detailPreview = useGet(signals.template.templateDetailHtmlPreview$);
  const ownPreviewResources = useSet(
    signals.template.ownTemplatePickerPreviewResources$,
  );
  const releasePreviewResources = useSet(
    signals.template.releaseTemplatePickerPreviewResources$,
  );
  const openDetailPreview = useSet(
    signals.template.openPresentationTemplateDetailPreview$,
  );
  const selectDetailPreview = useSet(
    signals.template.selectPresentationTemplateDetailPreview$,
  );
  const closeDetailPreview = useSet(
    signals.template.closePresentationTemplateDetailPreview$,
  );
  const openWebsiteTemplatePreview = useSet(
    signals.template.openWebsiteTemplatePreview$,
  );
  const cardThemeIdBySlug = useGet(signals.template.templateCardThemeIdBySlug$);
  const illustrationVariantIndex = useGet(
    signals.template.illustrationVariantIndex$,
  );
  const setIllustrationVariantIndex = useSet(
    signals.template.setIllustrationVariantIndex$,
  );
  const clearAvatarVoiceSelection = useSet(
    signals.template.clearAvatarTemplateVoiceSelection$,
  );
  const previewItem =
    presentationItems.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const importedTemplateItems =
    useImportedPresentationTemplatePickerItems(signals);
  const importedPreviewItem =
    importedTemplateItems.find((item) => {
      return item.template.id === importedPreviewId;
    }) ?? null;
  const importedPreviewDetail =
    importedDetailLoadable.state === "hasData" &&
    importedDetailLoadable.data?.id === importedPreviewId
      ? importedDetailLoadable.data
      : null;
  const isPreviewing = Boolean(previewItem ?? importedPreviewItem);
  const dialogContentClassName = cn(
    "gap-0 overflow-hidden p-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0",
    "flex flex-col",
  );
  // A persona pill filters the grid, ideation-gallery style.
  // resolveWorkflowCatalog() keeps that logic out of this component to stay
  // under the complexity budget.
  const workflowCategoryFilter = useGet(
    signals.template.templatePickerWorkflowCategory$,
  );
  const setWorkflowCategoryFilter = useSet(
    signals.template.setTemplatePickerWorkflowCategory$,
  );
  const workflowCatalog = resolveWorkflowCatalog({
    categoryFilter: workflowCategoryFilter,
    search,
  });

  const features = useGet(featureSwitch$);
  const introVideoEnabled = features[FeatureSwitchKey.IntroVideo] === true;
  const selectedCategory = resolveTemplatePickerCategory(
    category,
    introVideoEnabled,
  );
  const showTemplatePickerSearch = selectedCategory === "workflow";
  const showAvatarPickerToolbar = selectedCategory === "avatar";

  const previewImageUrlsForCategory = (targetCategory: string) => {
    if (targetCategory === "slides") {
      return presentationPreviewImageUrlsForItems(
        presentationItems,
        cardThemeIdBySlug,
      );
    }
    if (targetCategory === "illustration") {
      return illustrationPreviewImageUrlsForItems({
        items: ILLUSTRATION_TEMPLATE_ITEMS,
        variantIndexBySlug: illustrationVariantIndex,
      });
    }
    if (targetCategory === "video") {
      return videoPreviewImageUrlsForItems(VIDEO_TEMPLATE_ITEMS);
    }
    if (targetCategory === "website") {
      return websitePreviewImageUrlsForItems(WEBSITE_TEMPLATE_ITEMS);
    }
    return [];
  };

  const prewarmTemplatePreviewsForCategory = (targetCategory: string) => {
    prewarmTemplatePreviewImages(
      runtime,
      previewImageUrlsForCategory(targetCategory),
      templatePreviewPrewarmImageCountForCategory(targetCategory),
    );
  };

  const closeTemplatePicker = () => {
    onClose();
  };

  const completeTemplatePickerClose = () => {
    releasePreviewResources(runtime);
    resetImportedTemplatePicker();
    clearAvatarVoiceSelection();
    setPresentationGridScrollTop(0);
    onCloseComplete();
  };

  const handleSelectPresentation = (
    item: PresentationTemplateItem,
    colorSystemId?: string,
  ) => {
    onChange(toPresentationGenerationTemplate(item, colorSystemId));
    closeTemplatePicker();
  };

  const handleSelectImportedPresentation = (
    template: PresentationTemplateSummary,
  ) => {
    onChange(toImportedPresentationGenerationTemplate(template));
    closeTemplatePicker();
  };

  const handleSelectVideo = (item: VideoTemplateItem) => {
    if (!videoGenerationAllowed) {
      closeTemplatePicker();
      openBillingPlans();
      detach(openSettings(true, pageSignal), Reason.DomCallback);
      return;
    }
    onChange(toVideoGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handleSelectAvatar = (
    avatar: AvatarVideoAvatar,
    voice: AvatarVideoVoice,
    aspectRatio: "portrait" | "landscape",
  ) => {
    onChange(toAvatarGenerationTemplate(avatar, voice, aspectRatio));
    closeTemplatePicker();
  };

  const handleSelectWorkflow = (item: WorkflowTemplateItem) => {
    onChange(toWorkflowGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handleSelectWebsite = (item: WebsiteTemplateItem) => {
    onChange(toWebsiteGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handlePreviewWebsite = (item: WebsiteTemplateItem) => {
    openWebsiteTemplatePreview(item.id);
  };

  const handleSelectIllustration = (item: IllustrationTemplateItem) => {
    onChange(toIllustrationGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handlePreview = (item: PresentationTemplateItem, slideIndex = 0) => {
    const selectedTheme = findPresentationTemplateTheme(
      cardThemeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
    );
    const selectedSlideIndex = Math.max(0, Math.floor(slideIndex));
    detach(
      openDetailPreview(
        {
          index: selectedSlideIndex,
          item,
          runtime,
          themeCss: presentationTemplateThemeCss(selectedTheme),
          themeId: selectedTheme.id,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handlePreviewImported = (templateId: string, slideIndex: number) => {
    openImportedPreview(templateId, Math.max(0, Math.floor(slideIndex)));
  };

  const previewDetailNavigationState = () => {
    if (previewItem === null) {
      return null;
    }
    const activeDetailPreview =
      detailPreview?.slug === previewItem.slug &&
      detailPreview.embedUrl === previewItem.embedUrl
        ? detailPreview
        : null;
    const selectedThemeId =
      activeDetailPreview?.themeId ??
      cardThemeIdBySlug[previewItem.slug] ??
      defaultPresentationTemplateThemeId(previewItem);
    const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
    const detailSlideCount =
      activeDetailPreview?.slideCount ??
      presentationTemplateSlideCount(previewItem);
    return {
      activeSlideIndex: activeDetailPreview?.index ?? 0,
      detailSlideCount,
      selectedTheme,
    };
  };

  const selectPreviewDetailSlide = (index: number) => {
    if (previewItem === null) {
      return;
    }
    const navigationState = previewDetailNavigationState();
    if (navigationState === null) {
      return;
    }
    selectDetailPreview({
      item: previewItem,
      runtime,
      index: Math.max(0, Math.min(navigationState.detailSlideCount - 1, index)),
      themeCss: presentationTemplateThemeCss(navigationState.selectedTheme),
      themeId: navigationState.selectedTheme.id,
    });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isPreviewing || event.defaultPrevented) {
      return;
    }
    if (importedPreviewItem !== null) {
      const slideCount = Math.max(
        1,
        importedPreviewDetail?.pageCount ??
          importedPreviewItem.template.pageCount,
      );
      if (event.key === "ArrowLeft" && importedPreviewSlideIndex > 0) {
        event.preventDefault();
        selectImportedPreviewSlide(importedPreviewSlideIndex - 1);
      }
      if (
        event.key === "ArrowRight" &&
        importedPreviewSlideIndex < slideCount - 1
      ) {
        event.preventDefault();
        selectImportedPreviewSlide(importedPreviewSlideIndex + 1);
      }
      return;
    }
    const navigationState = previewDetailNavigationState();
    if (navigationState === null) {
      return;
    }
    if (event.key === "ArrowLeft") {
      if (navigationState.activeSlideIndex > 0) {
        event.preventDefault();
        selectPreviewDetailSlide(navigationState.activeSlideIndex - 1);
      }
    }
    if (event.key === "ArrowRight") {
      if (
        navigationState.activeSlideIndex <
        navigationState.detailSlideCount - 1
      ) {
        event.preventDefault();
        selectPreviewDetailSlide(navigationState.activeSlideIndex + 1);
      }
    }
  };

  const handleCategoryChange = (nextCategory: string) => {
    if (nextCategory !== "avatar") {
      clearAvatarVoiceSelection();
    }
    setCategory(nextCategory);
    if (!isPreviewing) {
      prewarmTemplatePreviewsForCategory(nextCategory);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (!isPreviewing) {
      prewarmTemplatePreviewsForCategory(selectedCategory);
    }
  };

  const restorePresentationGridScrollNode = (node: HTMLDivElement | null) => {
    if (node === null) {
      return;
    }
    restorePresentationGridScroll(node);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (importedPreviewItem !== null) {
            closeImportedPreview();
            return;
          }
          if (previewItem !== null) {
            closeDetailPreview(runtime);
            return;
          }
          closeTemplatePicker();
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeTemplatePickerClose();
          return;
        }
        ownPreviewResources(runtime, pageSignal);
        if (!isPreviewing) {
          prewarmTemplatePreviewsForCategory(selectedCategory);
        }
      }}
    >
      <DialogContent
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth="6xl"
        height={760}
        contentClassName={dialogContentClassName}
        aria-describedby={undefined}
        onKeyDown={handleDialogKeyDown}
        onKeyDownCapture={
          isPreviewing ? handleTemplateDetailTabKeyDown : undefined
        }
        initialFocus={false}
      >
        {!isPreviewing ? (
          <div className="min-h-0 flex flex-1 flex-col">
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4 sm:hidden">
              <DialogTitle>
                {t(($) => {
                  return $.artifacts.templates.template;
                })}
              </DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <TemplatePickerCategoryNav
                selectedCategory={selectedCategory}
                introVideoEnabled={introVideoEnabled}
                onChange={handleCategoryChange}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                {selectedCategory === "intro-video" ? (
                  <IntroVideoPicker
                    signals={signals.template.introVideo}
                    onCancel={closeTemplatePicker}
                    onSelect={(template) => {
                      onChange(template);
                      closeTemplatePicker();
                    }}
                  />
                ) : (
                  <>
                    <div
                      className={cn(
                        "relative h-[68px] shrink-0 items-center px-6 pr-14",
                        showTemplatePickerSearch || showAvatarPickerToolbar
                          ? "flex"
                          : "hidden sm:flex",
                      )}
                    >
                      {showTemplatePickerSearch ? (
                        <TemplatePickerWorkflowSearch
                          search={search}
                          onSearchChange={handleSearchChange}
                        />
                      ) : null}
                      {showAvatarPickerToolbar ? (
                        <AvatarTemplatePickerToolbar signals={signals} />
                      ) : null}
                    </div>
                    <TemplatePickerCategoryContent
                      signals={signals}
                      selectedCategory={selectedCategory}
                      pptItems={presentationItems}
                      importedPptItems={importedTemplateItems}
                      websiteItems={WEBSITE_TEMPLATE_ITEMS}
                      illustrationItems={ILLUSTRATION_TEMPLATE_ITEMS}
                      videoItems={VIDEO_TEMPLATE_ITEMS}
                      videoGenerationAllowed={videoGenerationAllowed}
                      workflowCatalog={workflowCatalog}
                      value={value}
                      illustrationVariantIndex={illustrationVariantIndex}
                      onPresentationScroll={setPresentationGridScrollTop}
                      onRestorePresentationScroll={
                        restorePresentationGridScrollNode
                      }
                      onSelectPresentation={handleSelectPresentation}
                      onSelectImportedPresentation={
                        handleSelectImportedPresentation
                      }
                      onPreviewPresentation={handlePreview}
                      onPreviewImportedPresentation={handlePreviewImported}
                      onImportedPresentation={closeTemplatePicker}
                      onSelectWebsite={handleSelectWebsite}
                      onPreviewWebsite={handlePreviewWebsite}
                      onSelectIllustration={handleSelectIllustration}
                      onIllustrationVariantChange={setIllustrationVariantIndex}
                      onSelectVideo={handleSelectVideo}
                      onSelectAvatar={handleSelectAvatar}
                      onWorkflowCategoryChange={setWorkflowCategoryFilter}
                      onSelectWorkflow={handleSelectWorkflow}
                      runtime={runtime}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        ) : null}
        {previewItem ? (
          <TemplatePreviewPage
            item={previewItem}
            onBack={() => {
              closeDetailPreview(runtime);
            }}
            onSelect={handleSelectPresentation}
            runtime={runtime}
            signals={signals}
          />
        ) : importedPreviewItem ? (
          <ImportedPresentationTemplatePreviewPage
            imageBuffers={importedPreviewItem.imageBuffers}
            summary={importedPreviewItem.template}
            onBack={closeImportedPreview}
            onSelect={handleSelectImportedPresentation}
            signals={signals}
          />
        ) : null}
        <WebsiteTemplatePreviewDialogSlot signals={signals} />
      </DialogContent>
    </Dialog>
  );
}

function TemplatePickerCategoryContent({
  signals,
  selectedCategory,
  pptItems,
  importedPptItems,
  websiteItems,
  illustrationItems,
  videoItems,
  videoGenerationAllowed,
  workflowCatalog,
  value,
  illustrationVariantIndex,
  onPresentationScroll,
  onRestorePresentationScroll,
  onSelectPresentation,
  onSelectImportedPresentation,
  onPreviewPresentation,
  onPreviewImportedPresentation,
  onImportedPresentation,
  onSelectWebsite,
  onPreviewWebsite,
  onSelectIllustration,
  onIllustrationVariantChange,
  onSelectVideo,
  onSelectAvatar,
  onWorkflowCategoryChange,
  onSelectWorkflow,
  runtime,
}: {
  signals: ComposerSignals;
  selectedCategory: string;
  pptItems: readonly PresentationTemplateItem[];
  importedPptItems: readonly ImportedPresentationTemplatePickerItem[];
  websiteItems: readonly WebsiteTemplateItem[];
  illustrationItems: readonly IllustrationTemplateItem[];
  videoItems: readonly VideoTemplateItem[];
  videoGenerationAllowed: boolean;
  workflowCatalog: ResolvedWorkflowTemplateCatalog;
  value: GenerationTemplateRequest | undefined;
  illustrationVariantIndex: Readonly<Record<string, number>>;
  onPresentationScroll: (value: number) => void;
  onRestorePresentationScroll: (node: HTMLDivElement | null) => void;
  onSelectPresentation: (
    item: PresentationTemplateItem,
    colorSystemId?: string,
  ) => void;
  onSelectImportedPresentation: (template: PresentationTemplateSummary) => void;
  onPreviewPresentation: (
    item: PresentationTemplateItem,
    slideIndex?: number,
  ) => void;
  onPreviewImportedPresentation: (
    templateId: string,
    slideIndex: number,
  ) => void;
  onImportedPresentation: () => void;
  onSelectWebsite: (item: WebsiteTemplateItem) => void;
  onPreviewWebsite: (item: WebsiteTemplateItem) => void;
  onSelectIllustration: (item: IllustrationTemplateItem) => void;
  onIllustrationVariantChange: (slug: string, index: number) => void;
  onSelectVideo: (item: VideoTemplateItem) => void;
  onSelectAvatar: (
    avatar: AvatarVideoAvatar,
    voice: AvatarVideoVoice,
    aspectRatio: "portrait" | "landscape",
  ) => void;
  onWorkflowCategoryChange: (category: string) => void;
  onSelectWorkflow: (item: WorkflowTemplateItem) => void;
  runtime: TemplatePreviewRuntime;
}) {
  if (selectedCategory === "slides") {
    return (
      <div
        data-presentation-template-grid-scroll=""
        ref={onRestorePresentationScroll}
        className="relative flex min-h-0 flex-1 transform-gpu flex-col overflow-y-auto px-6 pb-6 pt-0.5"
        onScroll={(event) => {
          onPresentationScroll(event.currentTarget.scrollTop);
        }}
      >
        <PptTemplateGrid
          items={pptItems}
          importedItems={importedPptItems}
          value={value}
          onSelect={onSelectPresentation}
          onSelectImported={onSelectImportedPresentation}
          onPreview={onPreviewPresentation}
          onPreviewImported={onPreviewImportedPresentation}
          onImported={onImportedPresentation}
          runtime={runtime}
          signals={signals}
        />
      </div>
    );
  }

  if (selectedCategory === "website") {
    return (
      <div
        data-website-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-0.5"
      >
        <WebsiteTemplateGrid
          items={websiteItems}
          value={value}
          onSelect={onSelectWebsite}
          onPreview={onPreviewWebsite}
        />
      </div>
    );
  }

  if (selectedCategory === "illustration") {
    return (
      <div
        data-illustration-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-0.5"
        onScroll={(event) => {
          prewarmIllustrationPreviewImagesNearScroll({
            items: illustrationItems,
            runtime,
            scrollContainer: event.currentTarget,
            variantIndexBySlug: illustrationVariantIndex,
          });
        }}
      >
        <IllustrationTemplateGrid
          items={illustrationItems}
          value={value}
          variantIndexBySlug={illustrationVariantIndex}
          onSelect={onSelectIllustration}
          onVariantChange={onIllustrationVariantChange}
          runtime={runtime}
        />
      </div>
    );
  }

  if (selectedCategory === "video") {
    return (
      <div
        data-video-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-0.5"
      >
        <VideoTemplateGrid
          items={videoItems}
          value={value}
          videoGenerationAllowed={videoGenerationAllowed}
          onSelect={onSelectVideo}
        />
      </div>
    );
  }

  if (selectedCategory === "avatar") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-6">
        <AvatarTemplatePickerContent
          signals={signals}
          value={value}
          onSelect={onSelectAvatar}
        />
      </div>
    );
  }

  if (selectedCategory === "workflow") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {workflowCatalog.pills.length > 1 && (
          <WorkflowTemplatePillRow
            pills={workflowCatalog.pills}
            active={workflowCatalog.active}
            onSelect={onWorkflowCategoryChange}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            data-workflow-template-grid-scroll=""
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-4"
          >
            {workflowCatalog.items.length > 0 ? (
              <WorkflowTemplateGrid
                items={workflowCatalog.items}
                value={value}
                onSelect={onSelectWorkflow}
              />
            ) : (
              <TemplateEmptyPanel />
            )}
          </div>
          {/* Soften the hard clip where cards scroll up under the pill row,
              mirroring the chat-to-composer top fade. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-card to-transparent" />
        </div>
      </div>
    );
  }

  return null;
}

function selectedComposerTemplateAttachment(
  value: GenerationTemplateRequest | undefined,
  importedTemplates: readonly PresentationTemplateSummary[] = [],
): ComposerTemplateAttachment | undefined {
  const introVideo = introVideoTemplateOptions(value);
  if (introVideo) {
    return {
      type: "video",
      category: "intro-video",
      title: [
        i18n.t(($) => {
          return $.artifacts.templates.introVideo;
        }),
        styleSelectionLabel(i18n.t, introVideo.style),
        avatarSelectionLabel(i18n.t, introVideo.avatar),
        voiceSelectionLabel(i18n.t, introVideo.voice, introVideo.avatar),
      ].join(" · "),
      previewImageUrl:
        introVideo.style.kind === "catalog"
          ? introVideo.style.style.thumbnailUrl
          : undefined,
    };
  }
  const avatar = avatarTemplateSelection(value);
  if (avatar) {
    return {
      type: "avatar",
      title: avatar.title,
      category: "avatar",
      previewImageUrl: avatar.previewUrl,
    };
  }
  const presentationItem = selectedPresentationTemplateItem(value);
  if (presentationItem && value?.type === "presentation") {
    const selectedTheme = findPresentationTemplateTheme(
      value.selection.colorSystemId?.replace("color-system:", "") ??
        defaultPresentationTemplateThemeId(presentationItem),
    );
    return {
      type: "presentation",
      title: presentationItem.title,
      category: "slides",
      previewImageUrl: presentationTemplateCardSlideImage(
        presentationItem,
        0,
        selectedTheme,
        SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
      ),
    };
  }
  const importedPresentationTemplate = selectedImportedPresentationTemplate(
    value,
    importedTemplates,
  );
  if (importedPresentationTemplate) {
    return {
      type: "presentation",
      title: importedPresentationTemplate.title,
      category: "slides",
      ...(importedPresentationTemplate.coverUrl === null
        ? {}
        : { previewImageUrl: importedPresentationTemplate.coverUrl }),
    };
  }
  const illustrationItem = selectedIllustrationTemplateItem(value);
  if (illustrationItem) {
    return {
      type: "illustration",
      title: illustrationItem.title,
      category: "illustration",
      previewImageUrl: r2ImageTransformUrl(
        illustrationItem.previewImage,
        SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
      ),
    };
  }
  const videoItem = selectedVideoTemplateItem(value);
  if (videoItem) {
    return { type: "video", title: videoItem.title, category: "video" };
  }
  const workflowItem = selectedWorkflowTemplateItem(value);
  if (workflowItem) {
    return {
      type: "workflow",
      title: localizedWorkflowTemplate(workflowItem).title,
      category: "workflow",
    };
  }
  const websiteItem = selectedWebsiteTemplateItem(value);
  return websiteItem
    ? { type: "website", title: websiteItem.title, category: "website" }
    : undefined;
}

function ComposerImportedTemplateUrlRefreshLifecycle({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const setImportedTemplateUrlRefreshLifecycleRef = useSet(
    signals.template.importedPresentationTemplateUrlRefreshLifecycleRef$,
  );
  return (
    <span
      ref={setImportedTemplateUrlRefreshLifecycleRef}
      aria-hidden="true"
      className="pointer-events-none absolute size-px overflow-hidden opacity-0"
    />
  );
}

function TemplatePickerButton({
  picker,
  presentationItems,
  runtime,
  signals,
}: {
  picker: ComposerTemplatePicker;
  presentationItems: readonly PresentationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const mounted = useGet(signals.template.templatePickerMounted$);
  const open = useGet(signals.template.templatePickerOpen$);
  const category = useGet(signals.template.templatePickerCategory$);
  const introVideoEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.IntroVideo] === true;
  const referenceValue = useGet(signals.template.templatePickerReferenceValue$);
  const createMode = useGet(signals.create.mode$);
  const templateMode = createMode === "image" ? "illustration" : createMode;
  const templateLabel =
    templateMode === "illustration"
      ? t(($) => {
          return $.chat.composer.create.addStyle;
        })
      : templateMode
        ? t(($) => {
            return $.chat.composer.create.addTemplate;
          })
        : t(($) => {
            return $.artifacts.templates.template;
          });
  const setOpen = useSet(signals.template.setTemplatePickerOpen$);
  const completeClose = useSet(signals.template.completeTemplatePickerClose$);
  const setReferenceValue = useSet(
    signals.template.setTemplatePickerReferenceValue$,
  );
  const openTemplatePicker = useSet(signals.template.openTemplatePicker$);
  const cardThemeIdBySlug = useGet(signals.template.templateCardThemeIdBySlug$);
  const selectedCategory =
    templateMode === "presentation"
      ? "slides"
      : (templateMode ??
        resolveTemplatePickerCategory(category, introVideoEnabled));
  const prewarmPicker = () => {
    prewarmTemplatePreviewImages(
      runtime,
      initialTemplatePreviewImageUrlsForCategory({
        category: selectedCategory,
        presentationThemeIdBySlug: cardThemeIdBySlug,
      }),
      templatePreviewPrewarmImageCountForCategory(selectedCategory),
    );
  };

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="quiet"
              size={templateMode ? "sm" : "icon-sm"}
              iconSize="md"
              className={
                templateMode
                  ? "min-w-0 max-w-[13rem] gap-1 font-normal"
                  : "shrink-0"
              }
              aria-label={templateLabel}
              aria-pressed={false}
              onPointerEnter={prewarmPicker}
              onFocus={prewarmPicker}
              onPointerDown={prewarmPicker}
              onClick={() => {
                prewarmPicker();
                openTemplatePicker({
                  kind: "insert",
                  category: selectedCategory,
                });
              }}
            >
              {templateMode ? (
                <>
                  <Plus size={16} className="shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{templateLabel}</span>
                </>
              ) : (
                <SwatchBook size={18} aria-hidden="true" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {templateLabel}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {mounted && (
        <TemplatePickerDialog
          value={referenceValue ?? undefined}
          onChange={picker.onChange}
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          onCloseComplete={() => {
            setReferenceValue(null);
            completeClose();
          }}
          presentationItems={presentationItems}
          runtime={runtime}
          signals={signals}
        />
      )}
    </>
  );
}

function ComposerTemplatePickerSlot({ signals }: { signals: ComposerSignals }) {
  const picker = useComposerTemplatePicker(signals);
  return (
    <TemplatePickerButton
      picker={picker}
      presentationItems={PRESENTATION_TEMPLATE_PICKER_ITEMS}
      runtime={signals.template.templatePreview}
      signals={signals}
    />
  );
}

function CreateWorkflowPromptButton({
  onCreateWorkflowPrompt,
}: {
  onCreateWorkflowPrompt: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="shrink-0"
            aria-label={t(($) => {
              return $.chat.composer.createWorkflow;
            })}
            onClick={onCreateWorkflowPrompt}
          >
            <Route size={18} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t(($) => {
            return $.chat.composer.createWorkflow;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerWorkflowPromptSlot({ signals }: { signals: ComposerSignals }) {
  const createWorkflowPrompt = useSet(signals.workflow.createWorkflowPrompt$);
  const pageSignal = useGet(pageSignal$);
  return (
    <CreateWorkflowPromptButton
      onCreateWorkflowPrompt={() => {
        detach(createWorkflowPrompt(pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function ConnectorTriggerIcons({
  connectors,
  customConnectors,
  hasComputerUse,
  hasCloudBrowser,
  hasSsh,
}: {
  connectors: ComposerConnectorItem[];
  customConnectors: ComposerCustomConnectorItem[];
  hasComputerUse: boolean;
  hasCloudBrowser: boolean;
  hasSsh: boolean;
}) {
  const { t } = useTranslation();
  const enabledConnectors = connectors.filter((connector) => {
    return connector.authorized;
  });
  const enabledCustomConnectors = customConnectors.filter((connector) => {
    return connector.authorized;
  });
  const connectorIconLimit =
    3 - Number(hasComputerUse) - Number(hasCloudBrowser);
  const enabled = [
    ...enabledConnectors.map((connector) => {
      return { kind: "builtin" as const, connector };
    }),
    ...(hasSsh ? [{ kind: "ssh" as const }] : []),
    ...enabledCustomConnectors.map((connector) => {
      return { kind: "custom" as const, connector };
    }),
  ].slice(0, connectorIconLimit);
  const hasComputerAccess = hasComputerUse || hasCloudBrowser;
  if (enabled.length === 0 && !hasComputerAccess) {
    return <Plug size={18} />;
  }
  return (
    <span className="flex items-center sm:-space-x-1.5">
      {enabled.map((item, index) => {
        const key =
          item.kind === "ssh"
            ? "ssh"
            : item.kind === "builtin"
              ? item.connector.slug
              : item.connector.id;
        return (
          <span
            key={key}
            className={cn(
              "relative shrink-0",
              (index > 0 || hasComputerAccess) && "hidden sm:block",
            )}
          >
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-gray-400 bg-background sm:h-7 sm:w-7",
                item.kind === "ssh" && "text-brand-text",
              )}
            >
              {item.kind === "ssh" ? (
                <Terminal
                  size={16}
                  role="img"
                  aria-label={t(($) => {
                    return $.ssh.label;
                  })}
                />
              ) : item.kind === "builtin" ? (
                <ConnectorIcon icon={item.connector.icon} size={16} />
              ) : (
                <CustomConnectorIcon
                  id={item.connector.id}
                  displayName={item.connector.displayName}
                  size={16}
                />
              )}
            </span>
          </span>
        );
      })}
      {hasComputerUse && (
        <span className="relative shrink-0">
          <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-gray-400 bg-background text-brand-text sm:h-7 sm:w-7">
            <Monitor size={16} />
          </span>
        </span>
      )}
      {hasCloudBrowser && (
        <span className="relative shrink-0">
          <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-gray-400 bg-background text-brand-text sm:h-7 sm:w-7">
            <Globe size={16} />
          </span>
        </span>
      )}
    </span>
  );
}

function matchesCustomConnectorSearch(
  search: string,
  connector: CustomConnectorResponse,
): boolean {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) {
    return true;
  }
  return [
    connector.displayName,
    connector.slug,
    customConnectorTarget(connector),
  ].some((value) => {
    return value.toLowerCase().includes(normalizedSearch);
  });
}

function CustomConnectorCatalogCard({
  connector,
  onConnect,
}: {
  connector: CustomConnectorResponse;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      data-slot="connector-card"
      type="button"
      aria-label={t(
        ($) => {
          return $.connectors.card.connectAria;
        },
        { connector: connector.displayName },
      )}
      className={surfaceVariants({
        interactive: true,
        className: "overflow-hidden text-left",
      })}
      onClick={onConnect}
    >
      <span className="flex items-center gap-2.5 px-5 pb-1 pt-4">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <CustomConnectorIcon
            id={connector.id}
            displayName={connector.displayName}
            size={20}
          />
        </span>
        <span
          data-testid="connector-card-label"
          className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
        >
          {connector.displayName}
        </span>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
          aria-hidden="true"
        >
          <Plus size={14} />
        </span>
      </span>
      <span className="block px-5 pb-4 pt-1">
        <span
          data-testid="connector-help-text"
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
        >
          <span className="shrink-0">
            {connector.kind === "mcp"
              ? t(($) => {
                  return $.connectors.custom.mcpType;
                })
              : t(($) => {
                  return $.connectors.custom.create.httpType;
                })}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono text-muted-foreground/60">
            {customConnectorTarget(connector)}
          </span>
        </span>
      </span>
    </button>
  );
}

function AddConnectorsDialog({
  signals,
  unconnected,
  unconnectedCustom,
  connecting,
  connectHandlers,
  onConnectCustom,
  onClose,
}: {
  signals: ComposerSignals;
  unconnected: PlatformConnectorCatalogStatusItem[];
  unconnectedCustom: CustomConnectorResponse[];
  connecting: boolean;
  connectHandlers: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => ConnectorConnectHandlers;
  onConnectCustom: (connector: CustomConnectorResponse) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const resetCustomConnectorConnectInput = useSet(
    resetCustomConnectorConnectInput$,
  );
  const registerConnectionDialog = useSet(registerConnectorConnectionDialog$);
  const dismissProgress = useSet(dismissConnectorConnectionProgress$);
  const search = connectorUi.addDialogSearch;
  const filtered = unconnected.filter((item) => {
    return matchesConnectorSearch(search, item);
  });
  const filteredCustom = unconnectedCustom.filter((item) => {
    return matchesCustomConnectorSearch(search, item);
  });
  const sshSummary = useLoadable(sshSummary$);
  const showSsh =
    sshSummary.state === "hasData" &&
    sshSummary.data?.configuredCount === 0 &&
    "ssh".includes(search.trim().toLowerCase());
  const visibleConnectorCount =
    filtered.length + filteredCustom.length + Number(showSsh);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          dismissProgress();
          onClose();
        }
      }}
    >
      <DialogContent
        ref={registerConnectionDialog}
        maxWidth="2xl"
        contentClassName="okou-app flex flex-col"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t(
              ($) => {
                return $.chat.connectors.available;
              },
              { count: visibleConnectorCount },
            )}
          </DialogTitle>
          {connecting && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              {t(($) => {
                return $.connectors.actions.connecting;
              })}
            </p>
          )}
        </DialogHeader>
        <div className="shrink-0">
          <Input
            type="text"
            placeholder={t(($) => {
              return $.chat.connectors.find;
            })}
            value={search}
            onChange={(e) => {
              return updateConnectorUi({ addDialogSearch: e.target.value });
            }}
            autoFocus
          />
        </div>
        <div className="overflow-y-auto -mx-6 px-6">
          <div className="grid grid-cols-2 gap-3">
            {showSsh && sshSummary.state === "hasData" && sshSummary.data && (
              <SshConnectorCard
                configuredCount={sshSummary.data.configuredCount}
              />
            )}
            {filtered.map((item) => {
              return (
                <ConnectorCard
                  key={item.slug}
                  variant="catalog"
                  connector={item}
                  busy={connecting}
                  connect={connectHandlers(item)}
                />
              );
            })}
            {filteredCustom.map((item) => {
              return (
                <CustomConnectorCatalogCard
                  key={item.id}
                  connector={item}
                  onConnect={() => {
                    resetCustomConnectorConnectInput();
                    onConnectCustom(item);
                  }}
                />
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComputerUseConnectorMenuSection({
  computerUse,
  onOpenDownloadDialog,
}: {
  computerUse: ComposerComputerUse;
  onOpenDownloadDialog: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-t border-border/50 bg-gray-50 p-1 dark:bg-gray-100">
      <div
        onClick={() => {
          computerUse.onCloudBrowserChange(!computerUse.cloudBrowserEnabled);
        }}
        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Globe size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {t(($) => {
              return $.chat.computerUse.cloudBrowser;
            })}
          </span>
        </span>
        <span
          className="flex shrink-0 items-center"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <LoadingSwitch
            checked={computerUse.cloudBrowserEnabled}
            onCheckedChange={onDomEventFn((enabled) => {
              computerUse.onCloudBrowserChange(enabled);
            })}
            loading={computerUse.cloudBrowserLoading}
            ariaLabel={
              computerUse.cloudBrowserEnabled
                ? t(($) => {
                    return $.chat.computerUse.disableCloudBrowser;
                  })
                : t(($) => {
                    return $.chat.computerUse.enableCloudBrowser;
                  })
            }
            size="sm"
          />
        </span>
      </div>
      <div className="mx-2 my-1 border-t border-border/50" />
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.computerUse.yourComputer;
        })}
      </div>
      {computerUse.loading ? (
        <div className="flex flex-col animate-pulse">
          {Array.from({ length: 2 }, (_, i) => {
            return (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                <span className="h-3.5 w-24 rounded bg-muted/50 flex-1" />
                <span className="h-3 w-6 rounded-full bg-muted/50" />
              </div>
            );
          })}
        </div>
      ) : computerUse.hosts.length > 0 ? (
        <div
          className="flex max-h-[96px] flex-col overflow-y-auto"
          role="group"
          aria-label={t(($) => {
            return $.chat.computerUse.hosts;
          })}
        >
          {computerUse.hosts.map((host) => {
            const checked = computerUse.selectedHostId === host.id;
            return (
              <div
                key={host.id}
                onClick={() => {
                  computerUse.onChange(checked ? null : host.id);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  <Monitor size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    <span>{host.displayName}</span>
                  </span>
                  {host.status === "offline" && (
                    <span className="block text-[11px] leading-3 text-muted-foreground">
                      {t(($) => {
                        return $.chat.computerUse.offline;
                      })}
                    </span>
                  )}
                </span>
                <span
                  className="flex shrink-0 items-center"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <LoadingSwitch
                    checked={checked}
                    onCheckedChange={onDomEventFn((nextChecked) => {
                      computerUse.onChange(nextChecked ? host.id : null);
                    })}
                    loading={false}
                    ariaLabel={
                      checked
                        ? t(
                            ($) => {
                              return $.chat.computerUse.disconnectHost;
                            },
                            {
                              hostName: host.displayName,
                            },
                          )
                        : t(
                            ($) => {
                              return $.chat.computerUse.connectHost;
                            },
                            {
                              hostName: host.displayName,
                            },
                          )
                    }
                    size="sm"
                  />
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground">
          <Monitor size={16} className="shrink-0" />
          {t(($) => {
            return $.chat.computerUse.noOnlineComputers;
          })}
        </div>
      )}
      <PopoverClose asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-state-hover"
          onClick={onOpenDownloadDialog}
        >
          <Plug size={16} className="shrink-0" />
          {t(($) => {
            return $.chat.computerUse.connectMyComputer;
          })}
        </button>
      </PopoverClose>
    </div>
  );
}

function ComposerConnectorPermissionDialog({
  signals,
  agentId,
  agentDisplayName,
  connector,
  onClose,
}: {
  signals: ComposerSignals;
  agentId: string;
  agentDisplayName: string;
  connector: ComposerConnectorItem;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const grantsLoadable = useLastLoadable(
    signals.connector.connectorPermissionGrants$,
  );
  const pageSignal = useGet(pageSignal$);
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);

  const grants =
    grantsLoadable.state === "hasData" ? grantsLoadable.data : undefined;

  if (grants === undefined) {
    return null;
  }

  const activeSnapshot = activeUserPermissionGrantSnapshot(grants);
  const initialPolicies = activeSnapshot.policies ?? {};

  return (
    <PermissionsDialog
      agentId={agentId}
      connectorSlug={connector.slug}
      connectorLabel={connector.label}
      metadata$={signals.connector.connectorPermissionMetadata$}
      displayName={agentDisplayName}
      initialPolicies={initialPolicies}
      initialGrants={activeSnapshot.grants}
      readOnly={false}
      onApply={async (intent, { metadata: appliedMetadata }) => {
        await savePermissionDraftPolicies(
          {
            scope: { agentId },
            connectorSlug: connector.slug,
            metadata: appliedMetadata,
            initialPolicies,
            initialGrants: activeSnapshot.grants,
            intent,
            applyGrantPolicies,
          },
          pageSignal,
        );
        toast.success(
          t(($) => {
            return $.chat.permissions.updated;
          }),
        );
      }}
      onClose={onClose}
    />
  );
}

type ComposerPopoverConnectorItem =
  | {
      readonly kind: "ssh";
      readonly connector: {
        readonly id: "ssh";
        readonly label: string;
        readonly authorized: boolean;
      };
    }
  | {
      readonly kind: "builtin";
      readonly connector: ComposerConnectorItem;
    }
  | {
      readonly kind: "custom";
      readonly connector: ComposerCustomConnectorItem;
    };

function composerPopoverConnectorId(
  item: ComposerPopoverConnectorItem,
): string {
  return item.kind === "builtin" ? item.connector.slug : item.connector.id;
}

function composerPopoverConnectorTarget(
  item: Exclude<ComposerPopoverConnectorItem, { kind: "ssh" }>,
): ConnectorAccountTarget {
  return item.kind === "builtin"
    ? { kind: "builtin", connectorSlug: item.connector.slug }
    : { kind: "custom", customConnectorId: item.connector.id };
}

function matchesComposerPopoverConnectorSearch(
  search: string,
  item: ComposerPopoverConnectorItem,
): boolean {
  if (item.kind === "ssh") {
    return item.connector.label
      .toLowerCase()
      .includes(search.trim().toLowerCase());
  }
  return item.kind === "builtin"
    ? matchesConnectorSearch(search, item.connector)
    : matchesCustomConnectorSearch(search, item.connector);
}

function ComposerConnectorAccessRow({
  icon,
  connectorLabel,
  actions,
  checked,
  loading,
  onCheckedChange,
  ariaLabel,
}: {
  readonly icon: ReactNode;
  readonly connectorLabel: string;
  readonly actions?: ReactNode;
  readonly checked: boolean;
  readonly loading: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly ariaLabel: string;
}) {
  return (
    <div
      role="listitem"
      className="flex h-10 shrink-0 items-center gap-2 px-3 py-2 hover:bg-state-hover transition-colors"
    >
      {actions ? (
        <span className="order-2 flex shrink-0 items-center gap-2 empty:hidden">
          {actions}
        </span>
      ) : null}
      <label className="contents">
        <span className="order-1 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center">
          {icon}
        </span>
        <span className="order-1 min-w-0 flex-1 cursor-pointer truncate text-sm text-foreground">
          {connectorLabel}
        </span>
        <span className="order-3 shrink-0">
          <LoadingSwitch
            checked={checked}
            onCheckedChange={onCheckedChange}
            loading={loading}
            ariaLabel={ariaLabel}
            size="sm"
          />
        </span>
      </label>
    </div>
  );
}

function ComposerConnectorAccountMenu({
  signals,
  actions,
  target,
  connectorLabel,
  selectedConnection,
  defaultConnection,
  explicit,
}: {
  readonly signals: ComposerSignals;
  readonly actions: ComposerConnectorActions;
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
  readonly selectedConnection: ConnectorAccountConnection | undefined;
  readonly defaultConnection: ConnectorAccountConnection | null;
  readonly explicit: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const menuTarget = useGet(signals.connector.accounts.menuTarget$);
  const menuOpen = useGet(signals.connector.accounts.menuOpen$);
  const openTarget = useSet(signals.connector.accounts.openTarget$);
  const closeMenu = useSet(signals.connector.accounts.closeMenu$);
  const open = Boolean(
    menuOpen &&
    menuTarget &&
    connectorAccountTargetKey(menuTarget) === connectorAccountTargetKey(target),
  );
  const effectiveConnection = explicit ? selectedConnection : defaultConnection;
  const resolveAccountLabel = useConnectorAccountLabel();
  const accountLabel = effectiveConnection
    ? resolveAccountLabel(effectiveConnection)
    : t(($) => {
        return $.chat.connectors.noUsableAccount;
      });
  const accessibleLabel = explicit
    ? t(
        ($) => {
          return $.chat.connectors.selectedAccountFor;
        },
        { connector: connectorLabel, account: accountLabel },
      )
    : t(
        ($) => {
          return $.chat.connectors.defaultAccountFor;
        },
        { connector: connectorLabel, account: accountLabel },
      );
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          openTarget(target, signal);
        } else {
          closeMenu();
        }
      }}
    >
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="quiet"
              size="icon-2xs"
              className="shrink-0"
              aria-label={accessibleLabel}
            >
              {explicit ? <UserCheck size={14} /> : <User size={14} />}
            </Button>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="top" className="text-xs">
          {accessibleLabel}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="start"
        className="flex max-h-[min(25rem,var(--available-height))] w-72 flex-col overflow-hidden p-0"
        aria-label={t(($) => {
          return $.chat.connectors.accountForThread;
        })}
      >
        <ComposerConnectorAccountMenuContent
          signals={signals}
          actions={actions}
          target={target}
          connectorLabel={connectorLabel}
        />
      </PopoverContent>
    </Popover>
  );
}

function handleConnectorAccountRadioKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
): void {
  const buttons = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="radio"]:not(:disabled)',
    ),
  ];
  if (buttons.length === 0 || !(event.target instanceof HTMLButtonElement)) {
    return;
  }
  const currentIndex = buttons.indexOf(event.target);
  if (currentIndex === -1) {
    return;
  }
  let nextIndex: number;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = (currentIndex + 1) % buttons.length;
  } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = buttons.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  buttons[nextIndex]?.focus();
  buttons[nextIndex]?.click();
}

function ComposerConnectorAccountChoices({
  connectorLabel,
  connections,
  selection,
  defaultConnection,
  saving,
  loading,
  unavailable,
  noResults,
  loadingAccountCount,
  onSelect,
  onUseDefault,
}: {
  readonly connectorLabel: string;
  readonly connections: readonly ConnectorAccountConnection[];
  readonly selection: ConnectorAccountSelection | undefined;
  readonly defaultConnection: ConnectorAccountConnection | null;
  readonly saving: boolean;
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly noResults: boolean;
  readonly loadingAccountCount: number;
  readonly onSelect: (connection: ConnectorAccountConnection) => void;
  readonly onUseDefault: () => void;
}) {
  const { t } = useTranslation();
  const choiceClassName = cn(
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    saving && "cursor-default opacity-50",
  );
  const accountLabel = useConnectorAccountLabel();
  const defaultLabel = defaultConnection
    ? accountLabel(defaultConnection)
    : t(($) => {
        return $.chat.connectors.noUsableAccount;
      });
  const hasCheckedConnection = connections.some((connection) => {
    return selection?.connectionId === connection.id;
  });
  const accountStatus = (connection: ConnectorAccountConnection): string => {
    if (connection.connectionStatus === "connected") {
      return t(($) => {
        return $.connectors.accounts.connected;
      });
    }
    if (selection?.connectionId !== connection.id) {
      return t(($) => {
        return $.connectors.accounts.reconnectRequired;
      });
    }
    if (
      defaultConnection?.connectionStatus === "connected" &&
      defaultConnection.id !== connection.id
    ) {
      return t(
        ($) => {
          return $.chat.connectors.fallsBackTo;
        },
        { account: defaultLabel },
      );
    }
    return t(($) => {
      return $.chat.connectors.noUsableAccount;
    });
  };

  return (
    <div
      className="flex max-h-64 min-h-0 flex-1 flex-col overflow-y-auto p-1"
      role="radiogroup"
      aria-label={connectorLabel}
      onKeyDown={handleConnectorAccountRadioKeyDown}
    >
      <button
        type="button"
        role="radio"
        aria-checked={!selection}
        tabIndex={!selection || !hasCheckedConnection ? 0 : -1}
        disabled={saving}
        className={choiceClassName}
        onClick={onUseDefault}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-brand-text">
          {!selection ? <Check size={15} strokeWidth={2.5} /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {t(($) => {
              return $.chat.connectors.useDefault;
            })}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {defaultLabel}
            {defaultConnection?.connectionStatus === "reconnect-required"
              ? ` · ${t(($) => {
                  return $.connectors.accounts.reconnectRequired;
                })}`
              : ""}
          </span>
        </span>
      </button>
      {loading ? (
        <>
          <div className="flex flex-col" aria-hidden="true">
            {Array.from(
              {
                length: Math.max(1, Math.min(loadingAccountCount, 4)),
              },
              (_, index) => {
                return (
                  <div
                    key={index}
                    className="flex h-[52px] shrink-0 animate-pulse items-center gap-2 px-2 py-2"
                  >
                    <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <span className="h-3.5 w-28 rounded bg-muted/50" />
                      <span className="h-3 w-16 rounded bg-muted/50" />
                    </span>
                  </div>
                );
              },
            )}
          </div>
          <span className="sr-only" role="status">
            {t(($) => {
              return $.connectors.accounts.loading;
            })}
          </span>
        </>
      ) : null}
      {unavailable ? (
        <div className="px-2 py-3 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.accountsUnavailable;
          })}
        </div>
      ) : null}
      {connections.map((connection) => {
        const checked = selection?.connectionId === connection.id;
        return (
          <button
            key={connection.id}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={saving}
            className={choiceClassName}
            onClick={() => {
              onSelect(connection);
            }}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-brand-text">
              {checked ? <Check size={15} strokeWidth={2.5} /> : null}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {accountLabel(connection)}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {accountStatus(connection)}
              </span>
            </span>
          </button>
        );
      })}
      {noResults ? (
        <div className="px-2 py-3 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.noAccountsFound;
          })}
        </div>
      ) : null}
    </div>
  );
}

function ComposerConnectorAccountMenuContent({
  signals,
  actions,
  target,
  connectorLabel,
}: {
  readonly signals: ComposerSignals;
  readonly actions: ComposerConnectorActions;
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
}) {
  const { t } = useTranslation();
  const preferenceLoadable = useLastLoadable(
    signals.connector.accounts.preferenceState$,
  );
  const summariesLoadable = useLastLoadable(
    signals.connector.accounts.summaryByTarget$,
  );
  const accountsLoadable = useLastLoadable(
    signals.connector.accounts.accounts$,
  );
  const search = useGet(signals.connector.accounts.search$);
  const closeMenu = useSet(signals.connector.accounts.closeMenu$);
  const setSearch = useSet(signals.connector.accounts.setSearch$);
  const selectAccount = actions.selectAccount;
  const clearAccountSelection = actions.useDefaultAccount;
  const [loadMoreLoadable, loadMore] = useLoadableSet(
    signals.connector.accounts.loadMore$,
  );
  const signal = useGet(pageSignal$);
  const targetKey = connectorAccountTargetKey(target);
  const preference =
    preferenceLoadable.state === "hasData"
      ? preferenceLoadable.data
      : { selections: [], selectedConnections: [] };
  const selection = preference.selections.find((candidate) => {
    return connectorAccountTargetKey(candidate.target) === targetKey;
  });
  const selectedConnection = selection
    ? preference.selectedConnections.find((connection) => {
        return connection.id === selection.connectionId;
      })
    : undefined;
  const summary =
    summariesLoadable.state === "hasData"
      ? summariesLoadable.data.get(targetKey)
      : undefined;
  const defaultConnection = summary?.defaultConnection ?? null;
  const accountList =
    accountsLoadable.state === "hasData"
      ? accountsLoadable.data
      : { connections: [], nextCursor: null, available: true };
  const connections = selectedConnection
    ? [
        selectedConnection,
        ...accountList.connections.filter((connection) => {
          return connection.id !== selectedConnection.id;
        }),
      ]
    : accountList.connections;
  const showSearch =
    search.length > 0 ||
    (summary?.accountCount ?? 0) > CONNECTOR_ACCOUNT_SEARCH_THRESHOLD ||
    accountList.nextCursor !== null;
  const saving = actions.savingAccount;
  const selectAndClose = (connection: ConnectorAccountConnection): void => {
    detach(
      (async () => {
        await selectAccount(connection, signal);
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  };
  const selectDefaultAndClose = (): void => {
    detach(
      (async () => {
        await clearAccountSelection(target, signal);
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <div
      className={cn(
        "flex max-h-[min(25rem,var(--available-height))] min-h-0 flex-col overflow-hidden",
        showSearch && "h-[min(25rem,var(--available-height))]",
      )}
    >
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-border/60 pl-1.5 pr-2 text-sm font-medium text-foreground">
        <Button
          type="button"
          variant="quiet"
          size="icon-xs"
          aria-label={t(($) => {
            return $.chat.connectors.back;
          })}
          onClick={closeMenu}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.chat.connectors.accountForThread;
          })}
        </span>
      </div>
      {showSearch ? (
        <div className="shrink-0 border-b border-border/50 px-3 py-2">
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value, signal);
            }}
            placeholder={t(($) => {
              return $.connectors.accounts.find;
            })}
            className="h-8"
          />
        </div>
      ) : null}
      <ComposerConnectorAccountChoices
        connectorLabel={connectorLabel}
        connections={connections}
        selection={selection}
        defaultConnection={defaultConnection}
        saving={saving}
        loading={accountsLoadable.state === "loading"}
        unavailable={
          accountsLoadable.state === "hasError" || !accountList.available
        }
        noResults={connectorAccountSearchHasNoResults({
          state: accountsLoadable.state,
          available: accountList.available,
          resultCount: accountList.connections.length,
          search,
        })}
        loadingAccountCount={summary?.accountCount ?? 0}
        onSelect={(connection) => {
          selectAndClose(connection);
        }}
        onUseDefault={() => {
          selectDefaultAndClose();
        }}
      />
      {accountList.nextCursor ? (
        <div className="shrink-0 border-t border-border/50 p-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={loadMoreLoadable.state === "loading"}
            onClick={() => {
              return detach(loadMore(signal), Reason.DomCallback);
            }}
          >
            {loadMoreLoadable.state === "loading"
              ? t(($) => {
                  return $.connectors.accounts.loadingMore;
                })
              : t(($) => {
                  return $.connectors.accounts.loadMore;
                })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function connectorAccountSearchHasNoResults(args: {
  readonly state: Loadable<unknown>["state"];
  readonly available: boolean;
  readonly resultCount: number;
  readonly search: string;
}): boolean {
  return (
    args.state === "hasData" &&
    args.available &&
    args.resultCount === 0 &&
    Boolean(args.search.trim())
  );
}

function deriveComposerConnectorPopoverState(args: {
  readonly connectorItems: readonly ComposerPopoverConnectorItem[];
  readonly sortOrder: readonly string[] | null;
  readonly search: string;
  readonly showSearch: boolean;
  readonly permissionConnectorSlug: ConnectorSlug | null;
  readonly agentConnectors: readonly ComposerConnectorItem[];
}) {
  const sorted = args.sortOrder
    ? [...args.connectorItems].sort((a, b) => {
        const order = { builtin: 0, ssh: 1, custom: 2 };
        const kindOrder = order[a.kind] - order[b.kind];
        if (kindOrder !== 0) {
          return kindOrder;
        }
        const ai = args.sortOrder?.indexOf(composerPopoverConnectorId(a)) ?? -1;
        const bi = args.sortOrder?.indexOf(composerPopoverConnectorId(b)) ?? -1;
        if (ai === -1 && bi === -1) {
          return 0;
        }
        if (ai === -1) {
          return 1;
        }
        if (bi === -1) {
          return -1;
        }
        return ai - bi;
      })
    : args.connectorItems;
  const visibleConnectors =
    args.showSearch && args.search.trim()
      ? sorted.filter((item) => {
          return matchesComposerPopoverConnectorSearch(args.search, item);
        })
      : sorted;
  const permissionConnector = args.permissionConnectorSlug
    ? args.agentConnectors.find((connector) => {
        return connector.slug === args.permissionConnectorSlug;
      })
    : undefined;
  return { visibleConnectors, permissionConnector };
}

function ComposerConnectorAccountAction({
  signals,
  actions,
  item,
}: {
  readonly signals: ComposerSignals;
  readonly actions: ComposerConnectorActions;
  readonly item: Exclude<ComposerPopoverConnectorItem, { kind: "ssh" }>;
}) {
  const preference = useLastResolved(
    signals.connector.accounts.preferenceState$,
  );
  const summaries = useLastResolved(
    signals.connector.accounts.summaryByTarget$,
  );
  const target = composerPopoverConnectorTarget(item);
  const targetKey = connectorAccountTargetKey(target);
  const summary = summaries?.get(targetKey);
  if (
    !item.connector.authorized ||
    (item.kind === "custom" &&
      isIntegrationManagedCustomConnector(item.connector)) ||
    !summary ||
    summary.accountCount <= 1
  ) {
    return null;
  }
  const selection = preference?.selections.find((candidate) => {
    return connectorAccountTargetKey(candidate.target) === targetKey;
  });
  return (
    <ComposerConnectorAccountMenu
      signals={signals}
      actions={actions}
      target={target}
      connectorLabel={
        item.kind === "builtin"
          ? item.connector.label
          : item.connector.displayName
      }
      explicit={selection !== undefined}
      selectedConnection={preference?.selectedConnections.find((connection) => {
        return connection.id === selection?.connectionId;
      })}
      defaultConnection={summary.defaultConnection}
    />
  );
}

function useComposerSshAccess(agentId: string | null) {
  const identity = useLoadable(sshIdentity$);
  const rows = useLoadable(sshAgentAccessSnapshot$);
  const retained = useLastLoadable(sshAgentAccessSnapshot$);
  const access =
    identity.state === "hasData" &&
    identity.data !== null &&
    retained.state === "hasData" &&
    retained.data.identity === identity.data
      ? retained.data.rows?.find((row) => {
          return row.agent.agentId === agentId;
        })
      : undefined;
  return { rows, access };
}

function ConnectorsPopoverButton({
  signals,
  agentId,
  agentDisplayName,
  agentConnectors,
  agentCustomConnectors,
  connectorsLoading,
  actions,
  computerUse,
  onOpenAddDialog,
  onToggle,
  onToggleCustom,
}: {
  signals: ComposerSignals;
  agentId: string | null;
  agentDisplayName: string;
  agentConnectors: ComposerConnectorItem[];
  agentCustomConnectors: ComposerCustomConnectorItem[];
  connectorsLoading: boolean;
  actions: ComposerConnectorActions;
  computerUse: ComposerComputerUse | undefined;
  onOpenAddDialog: () => void;
  onToggle: (
    connectorSlug: ConnectorSlug,
    checked: boolean,
  ) => void | Promise<void>;
  onToggleCustom: (
    connectorId: string,
    checked: boolean,
  ) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const accountMenuOpen = useGet(signals.connector.accounts.menuOpen$);
  const closeAccountMenu = useSet(signals.connector.accounts.closeMenu$);
  const openAccountsPopover = useSet(signals.connector.accounts.openPopover$);
  const search = connectorUi.popoverSearch;
  const sortOrder = connectorUi.popoverSortOrder;
  const downloadDialogOpen = useGet(
    signals.computer.computerUseDownloadDialogOpen$,
  );
  const setDownloadDialogOpen = useSet(
    signals.computer.setComputerUseDownloadDialogOpen$,
  );
  const permissionConnectorSlug = connectorUi.permissionConnectorSlug;
  const { rows: sshRows, access: sshAccess } = useComposerSshAccess(agentId);
  const [sshSaving, updateSshAccess] = useLoadableSet(updateAgentSshAccess$);
  const pageSignal = useGet(pageSignal$);
  const reloadSsh = useSet(invalidateSsh$);
  const waitingForConnectors = connectorsLoading && !sshAccess;
  const connectorItems: ComposerPopoverConnectorItem[] = [
    ...agentConnectors.map((connector) => {
      return { kind: "builtin" as const, connector };
    }),
    ...(sshAccess
      ? [
          {
            kind: "ssh" as const,
            connector: {
              id: "ssh" as const,
              label: t(($) => {
                return $.ssh.label;
              }),
              authorized: sshAccess.enabled,
            },
          },
        ]
      : []),
    ...agentCustomConnectors.map((connector) => {
      return { kind: "custom" as const, connector };
    }),
  ];
  const showSearch = connectorItems.length > 20;
  const { visibleConnectors, permissionConnector } =
    deriveComposerConnectorPopoverState({
      connectorItems,
      sortOrder,
      search,
      showSearch,
      permissionConnectorSlug,
      agentConnectors,
    });
  const handleOpenChange = (open: boolean) => {
    if (open) {
      // Snapshot the sort order when popover opens
      const freshSort = connectorItems.map(composerPopoverConnectorId);
      updateConnectorUi({ popoverSortOrder: freshSort });
      openAccountsPopover();
      reloadSsh();
    } else {
      updateConnectorUi({ popoverSortOrder: null, popoverSearch: "" });
      closeAccountMenu();
    }
  };

  return (
    <Popover
      onOpenChange={(open, eventDetails) => {
        if (
          !open &&
          accountMenuOpen &&
          eventDetails.reason === "outside-press"
        ) {
          eventDetails.cancel();
          closeAccountMenu();
          return;
        }
        handleOpenChange(open);
      }}
    >
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-1 transition-colors hover:bg-state-hover sm:min-w-9 sm:px-1.5",
                  COMPOSER_CONTROL_FOCUS_CLASS,
                )}
                aria-label={t(($) => {
                  return $.chat.connectors.title;
                })}
              >
                {!waitingForConnectors && (
                  <ConnectorTriggerIcons
                    connectors={agentConnectors}
                    customConnectors={agentCustomConnectors}
                    hasComputerUse={Boolean(computerUse?.selectedHostId)}
                    hasCloudBrowser={Boolean(computerUse?.cloudBrowserEnabled)}
                    hasSsh={sshAccess?.enabled ?? false}
                  />
                )}
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            {t(($) => {
              return $.chat.connectors.title;
            })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        side="top"
        align="start"
        aria-label={t(($) => {
          return $.chat.connectors.title;
        })}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        className="flex max-h-[var(--available-height)] w-72 flex-col overflow-hidden p-0"
        // Keep the search field and actions stationary as results change.
        style={{ height: showSearch ? "25rem" : undefined }}
      >
        {(connectorItems.length > 0 || connectorsLoading) && (
          <div className="flex min-h-0 flex-1 flex-col py-1">
            {showSearch && (
              <div className="shrink-0 px-3 py-1 border-b border-border/50">
                <input
                  type="text"
                  placeholder={t(($) => {
                    return $.chat.connectors.find;
                  })}
                  value={search}
                  onChange={(e) => {
                    return updateConnectorUi({
                      popoverSearch: e.target.value,
                    });
                  }}
                  className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                />
              </div>
            )}
            {waitingForConnectors ? (
              <div className="flex flex-col animate-pulse">
                {Array.from({ length: 3 }, (_, i) => {
                  return (
                    <div key={i} className="flex items-center gap-2 px-3 py-2">
                      <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                      <span className="h-3.5 w-20 rounded bg-muted/50 flex-1" />
                      <span className="h-3 w-6 rounded-full bg-muted/50" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div
                role="list"
                aria-label={t(($) => {
                  return $.chat.connectors.title;
                })}
                className="flex max-h-64 min-h-0 flex-1 flex-col overflow-y-auto"
              >
                {visibleConnectors.map((item) => {
                  if (item.kind === "ssh") {
                    return (
                      <ComposerConnectorAccessRow
                        key={item.connector.id}
                        icon={<Terminal size={16} />}
                        connectorLabel={item.connector.label}
                        checked={item.connector.authorized}
                        loading={
                          sshSaving.state === "loading" ||
                          sshRows.state === "loading"
                        }
                        onCheckedChange={onDomEventFn(async (checked) => {
                          if (agentId) {
                            await updateSshAccess(agentId, checked, pageSignal);
                          }
                        })}
                        ariaLabel={
                          item.connector.authorized
                            ? t(
                                ($) => {
                                  return $.chat.connectors.remove;
                                },
                                {
                                  connectorName: item.connector.label,
                                },
                              )
                            : t(
                                ($) => {
                                  return $.chat.connectors.add;
                                },
                                {
                                  connectorName: item.connector.label,
                                },
                              )
                        }
                      />
                    );
                  }
                  if (item.kind === "custom") {
                    const connector = item.connector;
                    return (
                      <ComposerConnectorAccessRow
                        key={connector.id}
                        icon={
                          <CustomConnectorIcon
                            id={connector.id}
                            displayName={connector.displayName}
                            size={16}
                          />
                        }
                        connectorLabel={connector.displayName}
                        actions={
                          <ComposerConnectorAccountAction
                            signals={signals}
                            actions={actions}
                            item={item}
                          />
                        }
                        checked={connector.authorized}
                        onCheckedChange={onDomEventFn(async (checked) => {
                          await onToggleCustom(connector.id, checked);
                        })}
                        loading={actions.savingAuthorization}
                        ariaLabel={
                          connector.authorized
                            ? t(
                                ($) => {
                                  return $.chat.connectors.remove;
                                },
                                {
                                  connectorName: connector.displayName,
                                },
                              )
                            : t(
                                ($) => {
                                  return $.chat.connectors.add;
                                },
                                {
                                  connectorName: connector.displayName,
                                },
                              )
                        }
                      />
                    );
                  }
                  const connector = item.connector;
                  const accountAction = connector.authorized ? (
                    <ComposerConnectorAccountAction
                      signals={signals}
                      actions={actions}
                      item={item}
                    />
                  ) : null;
                  const showPermissionAction =
                    Boolean(agentId) &&
                    connector.authorized &&
                    connector.permissionSummary.hasPermissions;
                  return (
                    <ComposerConnectorAccessRow
                      key={connector.slug}
                      icon={<ConnectorIcon icon={connector.icon} size={16} />}
                      connectorLabel={connector.label}
                      actions={
                        showPermissionAction || accountAction ? (
                          <>
                            {accountAction}
                            {showPermissionAction ? (
                              <PopoverClose asChild>
                                <Button
                                  showTooltip
                                  type="button"
                                  onClick={() => {
                                    updateConnectorUi({
                                      permissionConnectorSlug: connector.slug,
                                    });
                                  }}
                                  aria-label={t(
                                    ($) => {
                                      return $.chat.connectors
                                        .configurePermissions;
                                    },
                                    { connectorName: connector.label },
                                  )}
                                  variant="quiet"
                                  size="icon-2xs"
                                  className="shrink-0"
                                >
                                  <SlidersHorizontal size={15} />
                                </Button>
                              </PopoverClose>
                            ) : null}
                          </>
                        ) : null
                      }
                      checked={connector.authorized}
                      onCheckedChange={onDomEventFn(async (checked) => {
                        await onToggle(connector.slug, checked);
                      })}
                      loading={actions.savingAuthorization}
                      ariaLabel={
                        connector.authorized
                          ? t(
                              ($) => {
                                return $.chat.connectors.remove;
                              },
                              {
                                connectorName: connector.label,
                              },
                            )
                          : t(
                              ($) => {
                                return $.chat.connectors.add;
                              },
                              {
                                connectorName: connector.label,
                              },
                            )
                      }
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
        {sshRows.state === "hasError" && (
          <div className="px-3 py-2">
            <SshLoadError />
          </div>
        )}
        <div className="flex shrink-0 flex-col p-1">
          {(connectorItems.length > 0 || connectorsLoading) && (
            <div className="mx-2 mb-1 border-t border-border/50" />
          )}
          <PopoverClose asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-state-hover transition-colors"
              onClick={() => {
                return onOpenAddDialog();
              }}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
                <Plus size={13} />
              </span>
              {t(($) => {
                return $.chat.connectors.addConnectors;
              })}
            </button>
          </PopoverClose>
        </div>
        {computerUse && (
          <ComputerUseConnectorMenuSection
            computerUse={computerUse}
            onOpenDownloadDialog={() => {
              setDownloadDialogOpen(true);
            }}
          />
        )}
      </PopoverContent>
      {computerUse && (
        <ComputerUseDownloadDialog
          open={downloadDialogOpen}
          onOpenChange={setDownloadDialogOpen}
          downloadUrl={computerUse.downloadUrl}
        />
      )}
      {agentId && permissionConnector && (
        <ComposerConnectorPermissionDialog
          signals={signals}
          agentId={agentId}
          agentDisplayName={agentDisplayName}
          connector={permissionConnector}
          onClose={() => {
            updateConnectorUi({ permissionConnectorSlug: null });
          }}
        />
      )}
    </Popover>
  );
}

function ComputerUseDownloadDialog({
  open,
  onOpenChange,
  downloadUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downloadUrl: string;
}) {
  const { t } = useTranslation();
  const computerUseProductName = useGet(computerUseProductName$);
  const downloadSupportLoadable = useLoadable(desktopDownloadSupportStatus$);
  const downloadSupportStatus =
    downloadSupportLoadable.state === "hasData"
      ? downloadSupportLoadable.data
      : "checking";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth="md" contentClassName="gap-0 overflow-hidden p-0">
        <div className="flex h-44 items-center justify-center border-b border-border bg-gray-50">
          <img
            src={computerUseIllustrationImg}
            alt=""
            className="h-40 w-40 object-contain"
          />
        </div>
        <DialogHeader className="space-y-2 px-6 pt-5 text-left">
          <DialogTitle className="text-xl leading-7">
            {t(
              ($) => {
                return $.chat.computerUse.dialogTitle;
              },
              { desktopProductName: computerUseProductName },
            )}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {t(
              ($) => {
                return $.chat.computerUse.dialogDescription;
              },
              { desktopProductName: computerUseProductName },
            )}
          </DialogDescription>
          <p className="text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.computerUse.macosRequirement;
            })}
          </p>
        </DialogHeader>
        <div className="px-6 pb-6 pt-4">
          {downloadSupportStatus === "unsupported-intel-mac" ? (
            <Button type="button" size="lg" className="w-full" disabled>
              <AlertTriangle size={16} />
              {t(($) => {
                return $.chat.computerUse.unsupportedIntelMac;
              })}
            </Button>
          ) : downloadSupportStatus === "checking" ? (
            <Button type="button" size="lg" className="w-full" disabled>
              {t(($) => {
                return $.chat.computerUse.checkingCompatibility;
              })}
            </Button>
          ) : (
            <Button asChild size="lg" className="w-full">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                <Download size={16} />
                {t(($) => {
                  return $.chat.computerUse.downloadMacos;
                })}
              </a>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Voice input mic button
// ---------------------------------------------------------------------------

interface MicButtonStatus {
  readonly recording: boolean;
  readonly starting: boolean;
  readonly transcribing: boolean;
  readonly quotaLoading: boolean;
}

function micButtonAriaLabel(status: MicButtonStatus): string {
  if (status.recording) {
    return i18n.t(($) => {
      return $.chat.voice.stopRecording;
    });
  }
  if (status.starting) {
    return i18n.t(($) => {
      return $.chat.voice.starting;
    });
  }
  if (status.transcribing) {
    return i18n.t(($) => {
      return $.chat.voice.transcribing;
    });
  }
  if (status.quotaLoading) {
    return i18n.t(($) => {
      return $.chat.voice.checkingLimit;
    });
  }
  return i18n.t(($) => {
    return $.chat.voice.input;
  });
}

function micButtonTooltip(status: MicButtonStatus): string {
  if (status.recording) {
    return i18n.t(($) => {
      return $.chat.voice.stopRecording;
    });
  }
  if (status.starting) {
    return i18n.t(($) => {
      return $.chat.voice.openingMicrophone;
    });
  }
  if (status.transcribing) {
    return i18n.t(($) => {
      return $.chat.voice.transcribingProgress;
    });
  }
  if (status.quotaLoading) {
    return i18n.t(($) => {
      return $.chat.voice.checkingLimit;
    });
  }
  return i18n.t(($) => {
    return $.chat.voice.input;
  });
}

function voiceDraftMicButtonStatus(
  recording: boolean,
  action: ComposerActions["voiceAction"],
) {
  return {
    recording: recording && action !== "start",
    starting: action === "start",
    transcribing: action === "finish" || action === "retry",
  };
}

function MicButton({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
}) {
  const available = useGet(audioInputAvailable$);
  const quotaState = useLoadableState(audioInputQuota$);
  const quotaResolved = useLastResolved(audioInputQuota$) !== undefined;
  const voiceInputV2Enabled = useGet(voiceInputV2Enabled$);
  // The last resolved status keeps this control stable while a composer
  // target reads its stored draft; run$ awaits that read before acting.
  const voiceDraftStatus = useLastResolved(signals.voice.state$)?.status;
  const sttRecording = useGet(sttRecording$);
  const sttStarting = useGet(sttStarting$);
  const sttTranscribing = useGet(sttTranscribing$);
  const capture = useGet(signals.voice.capture$);
  const { recording, starting, transcribing } = voiceInputV2Enabled
    ? voiceDraftMicButtonStatus(capture !== null, actions.voiceAction)
    : {
        recording: sttRecording,
        starting: sttStarting,
        transcribing: sttTranscribing,
      };
  const voiceLevel = useGet(sttVoiceLevel$);
  const voiceLevelFill = `${Math.round((voiceLevel / 3) * 100)}%`;

  const signal = useGet(pageSignal$);
  const draftLoading = voiceInputV2Enabled && voiceDraftStatus === undefined;
  const actionDisabled =
    starting || transcribing || (!recording && !quotaResolved);
  const status = {
    recording,
    starting,
    transcribing,
    quotaLoading: quotaState === "loading" && !quotaResolved,
  };

  if (!available) {
    return null;
  }

  const handleClick = () => {
    detach(actions.voice("toggle", signal), Reason.DomCallback);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn("relative shrink-0", {
              // Background draft checks should not dim the mic on thread switches.
              "disabled:opacity-100": draftLoading && !actionDisabled,
              "bg-[#2E9E9F] text-white hover:bg-[#279394] hover:text-white":
                recording || starting || transcribing,
            })}
            data-composer-voice-toggle
            onClick={handleClick}
            disabled={actionDisabled || draftLoading}
            aria-label={micButtonAriaLabel(status)}
            aria-busy={starting || transcribing}
            aria-keyshortcuts={
              voiceInputV2Enabled
                ? COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS
                : undefined
            }
          >
            {starting || transcribing ? (
              <span
                className="block size-[17px] rounded-full border-2 border-[rgb(255_255_255_/_0.35)] border-t-[#ffffff] pointer-events-none [transform:rotate(0deg)_translateZ(0)] origin-center [backface-visibility:hidden] [will-change:transform] animate-mic-starting-spin"
                aria-hidden="true"
              />
            ) : recording ? (
              <>
                <span
                  className="absolute bottom-4 left-1/2 h-2 w-[5px] rounded-full bg-[rgb(255_255_255_/_0.18)] overflow-hidden pointer-events-none [transform:translateX(-50%)] after:absolute after:right-0 after:bottom-0 after:left-0 after:h-[var(--mic-volume-fill,0%)] after:rounded-[inherit] after:bg-[linear-gradient(to_top,#bdf9ff,#ffffff)] after:content-[''] after:transition-[height] after:duration-[0.12s] after:ease-[cubic-bezier(0.25,0.1,0.25,1)]"
                  aria-hidden="true"
                  style={
                    {
                      "--mic-volume-fill": voiceLevelFill,
                    } as CSSProperties
                  }
                />
                <Mic size={17} className="relative" />
              </>
            ) : (
              <Mic size={18} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent
          role="tooltip"
          side="top"
          className="flex flex-col items-center gap-1 py-1.5"
        >
          <span>{micButtonTooltip(status)}</span>
          {voiceInputV2Enabled && (
            <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
              {getShortcutLabel(COMPOSER_VOICE_INPUT_SHORTCUT)}
            </kbd>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function formatVoiceRecordingDuration(elapsedTime: number): string {
  const totalSeconds = Math.floor(elapsedTime / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const VOICE_DRAFT_TRAY_CLASS =
  "min-h-12 rounded-xl bg-neutral-50 px-3 py-2 dark:bg-neutral-900";

function VoiceDraftFooter({
  signals,
  actions,
  status,
  recordingAvailable,
  voiceMessage,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
  status: Exclude<ComposerVoiceInputStatus, "idle">;
  recordingAvailable: boolean;
  voiceMessage: string | undefined;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.voice.capture$);
  const recording = capture !== null;
  const starting = actions.voiceAction === "start";
  const recordingStartedAt = capture?.startedAt ?? null;

  const voiceLevelSamples = useGet(signals.voice.voiceLevelSamples$);
  const signal = useGet(pageSignal$);

  if (status === "failed") {
    return (
      <div
        className={cn("flex w-full items-center gap-3", VOICE_DRAFT_TRAY_CLASS)}
        data-composer-voice-tray
      >
        <span
          role="status"
          className="min-w-0 flex-1 text-sm text-muted-foreground"
        >
          {voiceMessage ??
            (recordingAvailable
              ? t(($) => {
                  return $.chat.voice.retryReady;
                })
              : t(($) => {
                  return $.chat.voice.restoreFailed;
                }))}
        </span>
        {recordingAvailable && (
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.chat.voice.removeDraft;
            })}
            onClick={() => {
              detach(actions.voice("discard", signal), Reason.DomCallback);
            }}
          >
            <Trash2 size={16} />
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-14 shrink-0 bg-background"
          data-composer-voice-toggle
          onClick={() => {
            detach(actions.voice("retry", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.voice.retry;
          })}
        </Button>
      </div>
    );
  }

  if (status !== "recording") {
    const statusText =
      status === "discarding"
        ? t(($) => {
            return $.chat.voice.discarding;
          })
        : t(($) => {
            return $.chat.voice.transcribing;
          });
    const outcomeText =
      status === "discarding"
        ? t(($) => {
            return $.chat.voice.returningToComposer;
          })
        : actions.voiceAction === "retry"
          ? t(($) => {
              return $.chat.voice.retryingSavedAudio;
            })
          : t(($) => {
              return $.chat.voice.textTakingShape;
            });
    return (
      <div
        className={cn(
          "grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 text-sm",
          VOICE_DRAFT_TRAY_CLASS,
        )}
        role="status"
        data-composer-voice-tray
      >
        <span className="flex min-w-0 items-center gap-2.5 font-medium text-foreground">
          <Loader2
            size={16}
            className="shrink-0 animate-spin text-[#2E9E9F] motion-reduce:animate-none"
          />
          <span className="truncate">{statusText}</span>
        </span>
        <span className="min-w-0 max-w-full justify-self-end truncate text-right text-xs text-muted-foreground">
          {outcomeText}
        </span>
      </div>
    );
  }

  const stopRecordingLabel = t(($) => {
    return $.chat.voice.stopRecording;
  });
  return (
    <div
      className={cn("flex w-full items-center gap-2", VOICE_DRAFT_TRAY_CLASS)}
      data-composer-voice-tray
    >
      <span
        className="size-2 shrink-0 rounded-full bg-destructive"
        aria-hidden="true"
      />
      {recordingStartedAt === null ? (
        <time className="w-11 shrink-0 text-sm tabular-nums text-foreground">
          00:00
        </time>
      ) : (
        <ElapsedTime
          startTime={recordingStartedAt}
          className="w-11 shrink-0 text-sm tabular-nums text-foreground"
        >
          {formatVoiceRecordingDuration}
        </ElapsedTime>
      )}
      <VoiceLevelWaveform samples={voiceLevelSamples} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto min-w-14 shrink-0 bg-background"
        aria-label={stopRecordingLabel}
        data-composer-voice-toggle
        aria-keyshortcuts={COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS}
        disabled={starting || !recording}
        onClick={() => {
          detach(actions.voice("toggle", signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.chat.voice.confirmRecording;
        })}
      </Button>
    </div>
  );
}

function ComposerAttachButton({ signals }: { signals: ComposerSignals }) {
  const { t } = useTranslation();
  const fileInput = useGet(signals.draft.composerFileInput$);
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="shrink-0"
            aria-label={t(($) => {
              return $.chat.attachments.attach;
            })}
            onClick={() => {
              fileInput?.click();
            }}
          >
            <Paperclip size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t(($) => {
            return $.chat.attachments.attach;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function toRestorableAttachments(
  attachments: readonly {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[],
  userMessage: UserMessageDocument | undefined,
): RestorableAttachment[] {
  const filePartById = new Map(
    (userMessage?.parts ?? []).flatMap((part) => {
      return part.type === "file" ? [[part.fileId, part] as const] : [];
    }),
  );
  return attachments
    .filter(
      (
        attachment,
      ): attachment is typeof attachment & { readonly id: string } => {
        return attachment.id !== null;
      },
    )
    .map((attachment) => {
      const part = filePartById.get(attachment.id);
      return {
        id: attachment.id,
        url: attachment.url,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
        ...(part?.annotatedFileId
          ? { annotatedFileId: part.annotatedFileId }
          : {}),
        ...(part?.annotations ? { annotations: part.annotations } : {}),
      };
    });
}

function restoreChatClipboardPayload({
  event,
  insertPromptMarkdown,
  insertUserMessage,
  restoreAttachments,
  onDraftChange,
}: {
  event: ComposerPasteEvent;
  insertPromptMarkdown: (value: string) => void;
  insertUserMessage: (value: UserMessageDocument) => void;
  restoreAttachments: (attachments: RestorableAttachment[]) => void;
  onDraftChange: (() => void) | undefined;
}): boolean {
  if (!event.clipboardData) {
    return false;
  }
  const payload = readChatMessageFromClipboard(event.clipboardData);
  if (!payload) {
    return false;
  }
  const userMessage = shouldUseUserMessage(payload.userMessage)
    ? payload.userMessage
    : undefined;
  const persistedAttachments = toRestorableAttachments(
    payload.attachments,
    userMessage,
  );
  if (!userMessage && persistedAttachments.length === 0) {
    return false;
  }

  event.preventDefault();
  const hasInsertableUserMessagePart = userMessage?.parts.some((part) => {
    return (
      part.type === "text" ||
      part.type === "chat_thread" ||
      part.type === "agent" ||
      part.type === "feedback" ||
      part.type === "template"
    );
  });
  if (userMessage && hasInsertableUserMessagePart) {
    insertUserMessage(userMessage);
  } else if (payload.text) {
    insertPromptMarkdown(payload.text);
  }
  if (persistedAttachments.length > 0) {
    restoreAttachments(persistedAttachments);
  }
  onDraftChange?.();
  return true;
}

function useComposerDraftChange(signals: ComposerSignals): () => void {
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return () => {
    detach(saveDraft(pageSignal), Reason.DomCallback);
  };
}

function useComposerTemplatePicker(
  signals: ComposerSignals,
): ComposerTemplatePicker {
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const importedTemplates = useImportedPresentationTemplates(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);
  return {
    onChange(value) {
      if (!value) {
        return;
      }
      const attachment = selectedComposerTemplateAttachment(
        value,
        importedTemplates,
      );
      if (!attachment) {
        return;
      }
      insertTemplate(value, attachment);
      notifyDraftChanged();
    },
  };
}

function useComposerPrimaryAction(
  signals: ComposerSignals,
  actions: ComposerActions,
): ComposerPrimaryAction {
  const action = useResolved(signals.submission.primaryAction$) ?? "disabled";
  const selectedModelOauthAvailable =
    useLastResolved(signals.model.selectedModelOauthAvailable$) ?? true;
  return selectedModelOauthAvailable &&
    (!actions.submitting || action === "stop") &&
    actions.voiceAction === null
    ? action
    : "disabled";
}

function startComposerSubmission(
  {
    action,
    activate,
    ensurePushSubscription,
  }: {
    action: ComposerPrimaryAction;
    activate: (signal: AbortSignal) => Promise<boolean>;
    ensurePushSubscription: (signal: AbortSignal) => Promise<void>;
  },
  signal: AbortSignal,
): void {
  if (action === "disabled" || action === "stop") {
    return;
  }
  if (action === "send") {
    detach(ensurePushSubscription(signal), Reason.DomCallback);
  }
  detach(activate(signal), Reason.DomCallback);
}

function useComposerFileUpload(
  signals: ComposerSignals,
): (file: File) => boolean {
  const uploadAttachment = useSet(signals.draft.uploadAttachment$);
  const rootSignal = useGet(rootSignal$);
  const { t } = useTranslation();
  return (file) => {
    if (file.size > CHAT_UPLOAD_MAX_FILE_SIZE) {
      toast.error(
        t(
          ($) => {
            return $.chat.attachments.fileTooLarge;
          },
          { filename: file.name },
        ),
      );
      return false;
    }
    detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
    return true;
  };
}

interface ComposerLayoutHeightClassNames {
  readonly input: string;
  readonly shell: string;
}

// The idle footer is 52px tall and an active voice footer is 72px tall. Keep
// the shell stable and let its flexible input region absorb that 20px change.
// A template chip reserves the same additional 38px in both footer modes.
function composerLayoutHeightClassNames(
  singleLineOnMobile: boolean,
  hasTemplateAttachment: boolean,
): ComposerLayoutHeightClassNames {
  if (hasTemplateAttachment) {
    return singleLineOnMobile
      ? {
          input: "min-h-[86px] md:min-h-[114px]",
          shell: "min-h-[158px] md:min-h-[186px]",
        }
      : {
          input: "min-h-[114px]",
          shell: "min-h-[186px]",
        };
  }
  return singleLineOnMobile
    ? {
        input: "min-h-12 md:min-h-[76px]",
        shell: "min-h-[120px] md:min-h-[148px]",
      }
    : {
        input: "min-h-[76px]",
        shell: "min-h-[148px]",
      };
}

function ComposerInputSlot({
  signals,
  actions,
  minimumHeightClassName,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
  minimumHeightClassName: string;
}) {
  const createPickerOpen = useGet(signals.create.pickerOpen$);
  const sending = useLastResolved(signals.submission.sending$) ?? false;
  const notifyDraftChanged = useComposerDraftChange(signals);
  const restoreAttachments = useSet(signals.draft.restoreAttachments$);
  const pageSignal = useGet(pageSignal$);
  const focusEditor = useSet(signals.editor.focus$);
  const insertPromptMarkdown = useSet(signals.editor.insertPromptMarkdown$);
  const insertUserMessage = useSet(signals.editor.insertUserMessage$);
  const uploadFile = useComposerFileUpload(signals);
  const primaryAction = useComposerPrimaryAction(signals, actions);

  const ensurePushSubscription = useSet(ensurePushSubscription$);
  const rootSignal = useGet(rootSignal$);
  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";
  const handlePaste = (event: ComposerPasteEvent) => {
    if (
      restoreChatClipboardPayload({
        event,
        insertPromptMarkdown,
        insertUserMessage,
        restoreAttachments: (attachments) => {
          detach(
            (async () => {
              const removedUnavailableAttachments = await restoreAttachments(
                attachments,
                pageSignal,
              );
              if (removedUnavailableAttachments) {
                notifyDraftChanged();
              }
            })(),
            Reason.DomCallback,
          );
        },
        onDraftChange: notifyDraftChanged,
      })
    ) {
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    const plainText = event.clipboardData?.getData("text/plain") ?? "";
    let pastedPlainText = false;
    let uploaded = false;
    const applyPlainText = () => {
      if (pastedPlainText || !plainText) {
        return;
      }
      insertPromptMarkdown(plainText);
      pastedPlainText = true;
    };
    for (const item of items) {
      if (item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      event.preventDefault();
      applyPlainText();
      uploaded = uploadFile(file) || uploaded;
    }
    if (uploaded || pastedPlainText) {
      notifyDraftChanged();
    }
  };

  const submit = () => {
    startComposerSubmission(
      {
        action: primaryAction,
        activate: (signal) => {
          return actions.submit(primaryAction, signal);
        },
        ensurePushSubscription,
      },
      rootSignal,
    );
  };

  const handleKeyDown = (event: KeyboardEventLike) => {
    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
    if (isMobileTextInputDevice()) {
      processShortcut({ "mod+enter": submit }, event);
      return;
    }
    processShortcut(
      {
        ...(sendMode === "enter" ? { enter: submit } : { "mod+enter": submit }),
        ...(isTouchDevice && sendMode === "enter"
          ? { "mod+enter": submit }
          : {}),
        escape: () => {
          (event.target as HTMLElement).blur();
        },
      },
      event,
    );
  };

  return (
    <div
      className={cn(
        "grid flex-1 grid-cols-1 grid-rows-1",
        minimumHeightClassName,
      )}
    >
      <div
        className="col-start-1 row-start-1 min-h-0"
        data-slot="chat-composer-input"
        hidden={createPickerOpen}
        onClick={(event) => {
          const target = event.target;
          if (
            target instanceof Node &&
            !signals.editor.editor.view.dom.contains(target)
          ) {
            focusEditor();
          }
        }}
      >
        <TiptapWorkflowComposer
          signals={signals}
          onDraftChange={notifyDraftChanged}
          sending={sending}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
      <ComposerCreatePicker signals={signals} />
    </div>
  );
}

// Stop while an empty composer is mid-run; otherwise Send.
function ComposerSendButton({
  action,
  onActivate,
}: {
  action: ComposerPrimaryAction;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";
  if (action === "stop") {
    return (
      <Button
        showTooltip
        size="icon-sm"
        variant="interrupt"
        className="shrink-0"
        onClick={onActivate}
        aria-label={t(($) => {
          return $.chat.actions.stop;
        })}
      >
        <Square />
      </Button>
    );
  }
  const sendLabel = t(($) => {
    return $.chat.actions.send;
  });
  const button = (
    <Button
      size="icon-sm"
      className="shrink-0"
      onClick={onActivate}
      disabled={action === "disabled"}
      aria-label={sendLabel}
    >
      <ArrowUp size={18} />
    </Button>
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            action === "disabled" ? (
              <span className="inline-flex">{button}</span>
            ) : (
              button
            )
          }
        />
        <TooltipContent
          role="tooltip"
          side="top"
          className="flex flex-col items-center gap-1 py-1.5"
        >
          <span>{sendLabel}</span>
          <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
            {getShortcutLabel(sendMode === "enter" ? "enter" : "mod+enter")}
          </kbd>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerSendControl({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
}) {
  const action = useComposerPrimaryAction(signals, actions);
  const activatePrimaryAction = actions.submit;
  const ensurePushSubscription = useSet(ensurePushSubscription$);
  const rootSignal = useGet(rootSignal$);
  const activate = () => {
    if (action === "stop") {
      detach(activatePrimaryAction(action, rootSignal), Reason.DomCallback);
      return;
    }
    startComposerSubmission(
      {
        action,
        activate: (signal) => {
          return activatePrimaryAction(action, signal);
        },
        ensurePushSubscription,
      },
      rootSignal,
    );
  };
  return <ComposerSendButton action={action} onActivate={activate} />;
}

function ModelConfigurationWarning({
  blocker,
}: {
  blocker: ComposerSubmitBlocker;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={blocker.onAction}
            aria-label={`${blocker.actionLabel}: ${blocker.message}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
          >
            <AlertTriangle size={15} />
            <span className="hidden sm:inline">{blocker.actionLabel}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          {blocker.message}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerModelConfigurationWarning({
  signals,
  selection,
  oauthAvailable,
}: {
  signals: ComposerSignals;
  selection: ModelProviderSelection | null;
  oauthAvailable: boolean;
}) {
  const { t } = useTranslation();
  const configureSelectedModel = useSet(signals.model.configureSelectedModel$);
  const pageSignal = useGet(pageSignal$);
  if (selection === null || oauthAvailable) {
    return null;
  }
  return (
    <ModelConfigurationWarning
      blocker={{
        message: t(($) => {
          return $.chat.composer.selectedModelUnavailable;
        }),
        actionLabel: t(($) => {
          return $.chat.composer.configureModel;
        }),
        onAction: () => {
          detach(configureSelectedModel(pageSignal), Reason.DomCallback);
        },
      }}
    />
  );
}

interface ComposerMediaModelPickerState<Model extends string> {
  readonly value: Model | null;
  readonly onChange: (next: Model | null) => void;
}

interface ComposerResolvedMediaModelPickerState<
  Model extends string,
> extends ComposerMediaModelPickerState<Model> {
  readonly selectedModel: Model;
}

type ComposerImageModelPickerState = ComposerMediaModelPickerState<ImageModel>;
type ComposerResolvedImageModelPickerState =
  ComposerResolvedMediaModelPickerState<ImageModel>;
type ComposerVideoModelPickerState = ComposerMediaModelPickerState<VideoModel>;
type ComposerResolvedVideoModelPickerState =
  ComposerResolvedMediaModelPickerState<VideoModel>;

// One quiet trigger for every model category. It carries no fill of its own --
// the composer's control row is a row of quiet controls, and a filled track
// holding three of them read as the heaviest thing in the composer.
function composerModelPickerTriggerClassName(): string {
  return cn(
    "h-8 w-8 max-w-none gap-0 overflow-hidden border-transparent bg-transparent px-0 text-sm text-muted-foreground transition-colors sm:w-auto sm:max-w-[14rem] sm:gap-1 sm:px-3",
    "[&>[data-slot=select-value]]:flex [&>[data-slot=select-value]]:items-center [&>[data-slot=select-value]]:justify-center sm:[&>[data-slot=select-value]]:justify-start",
    "[&>[data-slot=select-icon]]:hidden sm:[&>[data-slot=select-icon]]:block",
    "hover:bg-state-hover hover:text-foreground data-popup-open:bg-state-hover data-popup-open:text-foreground",
    COMPOSER_CONTROL_FOCUS_CLASS,
  );
}

function ComposerRunModelPickerControl({
  signals,
  value,
  onChange,
  codexFastModeEnabled,
  desktopLayout,
  mediaModelPanel,
}: {
  signals: ComposerSignals;
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
  codexFastModeEnabled: boolean;
  desktopLayout: boolean;
  mediaModelPanel: MediaModelPanelState | undefined;
}) {
  const { t } = useTranslation();
  const modelMenuEnabled = useGet(modelPickerMenuEnabled$);
  // The flyout needs the room a phone does not have; narrow viewports keep the
  // menu's pages until the sheet layout lands.
  const modelFlyoutEnabled = useGet(modelPickerFlyoutEnabled$) && desktopLayout;
  const modelPickerOpen = useGet(signals.model.modelPickerOpen$);
  const setModelPickerOpen = useSet(signals.model.setModelPickerOpen$);
  const setLifecycleRef = useSet(signals.model.desktopModelPickerLifecycleRef$);
  return (
    <div ref={setLifecycleRef} className="contents sm:relative sm:flex">
      <ModelProviderPicker
        value={value}
        onChange={onChange}
        placeholder={t(($) => {
          return $.chat.composer.selectModel;
        })}
        triggerClassName={composerModelPickerTriggerClassName()}
        menuSignals={
          modelMenuEnabled || modelFlyoutEnabled
            ? signals.model.menu
            : undefined
        }
        flyoutLayout={modelFlyoutEnabled}
        onSelected={() => {
          setModelPickerOpen(false);
        }}
        compactTrigger
        mobileIconTrigger
        open={modelPickerOpen}
        modal={mediaModelPanel ? !desktopLayout : undefined}
        onOpenChange={(open) => {
          setModelPickerOpen(open);
        }}
        codexFastModeEnabled={codexFastModeEnabled}
        {...(mediaModelPanel ? { mediaModelPanel } : {})}
      />
    </div>
  );
}

function composerImageModelPanelCategory({
  selectedModel,
  onChange,
  label,
  tabLabel,
}: {
  selectedModel: ImageModel;
  onChange: (next: ImageModel | null) => void;
  label: string;
  tabLabel: string;
}): MediaModelPanelCategory {
  return {
    id: "image",
    label,
    tabLabel,
    options: PUBLIC_IMAGE_MODELS.map((candidate) => {
      return {
        key: candidate,
        label: IMAGE_MODEL_CONFIGS[candidate].label,
        icon: <ImageModelBrandIcon model={candidate} />,
        priceTier: IMAGE_MODEL_PRICE_TIER[candidate],
        selected: selectedModel === candidate,
        onSelect: () => {
          onChange(candidate);
        },
      };
    }),
  };
}

function composerVideoModelPanelCategory({
  selectedModel,
  onChange,
  label,
  tabLabel,
}: {
  selectedModel: VideoModel;
  onChange: (next: VideoModel | null) => void;
  label: string;
  tabLabel: string;
}): MediaModelPanelCategory {
  return {
    id: "video",
    label,
    tabLabel,
    options: PUBLIC_VIDEO_MODELS.map((candidate) => {
      return {
        key: candidate,
        label: VIDEO_MODEL_CONFIGS[candidate].label,
        icon: <VideoModelBrandIcon model={candidate} />,
        priceTier: VIDEO_MODEL_PRICE_TIER[candidate],
        selected: selectedModel === candidate,
        onSelect: () => {
          onChange(candidate);
        },
      };
    }),
  };
}

function ComposerModelPickerControls({
  signals,
  value,
  onChange,
  codexFastModeEnabled,
  imageModel,
  videoModel,
}: {
  signals: ComposerSignals;
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
  codexFastModeEnabled: boolean;
  imageModel: ComposerResolvedImageModelPickerState | undefined;
  videoModel: ComposerResolvedVideoModelPickerState | undefined;
}) {
  const { t } = useTranslation();
  const desktopLayout = useGet(signals.model.desktopModelPickerLayout$);
  const category = useGet(signals.model.mediaModelCategory$);
  const setCategory = useSet(signals.model.setMediaModelCategory$);
  const categories: MediaModelPanelCategory[] = [];
  if (imageModel) {
    categories.push(
      composerImageModelPanelCategory({
        selectedModel: imageModel.selectedModel,
        onChange: imageModel.onChange,
        label: t(($) => {
          return $.settings.models.picker.imageModels;
        }),
        tabLabel: t(($) => {
          return $.settings.models.picker.categoryImage;
        }),
      }),
    );
  }
  if (videoModel) {
    categories.push(
      composerVideoModelPanelCategory({
        selectedModel: videoModel.selectedModel,
        onChange: videoModel.onChange,
        label: t(($) => {
          return $.settings.models.picker.videoModels;
        }),
        tabLabel: t(($) => {
          return $.settings.models.picker.categoryVideo;
        }),
      }),
    );
  }
  const activeCategory = categories.some((candidate) => {
    return candidate.id === category;
  })
    ? category
    : null;
  const mediaModelPanel: MediaModelPanelState | undefined =
    categories.length > 0
      ? {
          activeCategory,
          categories,
          onActiveCategoryChange: setCategory,
        }
      : undefined;
  return (
    <>
      <ComposerRunModelPickerControl
        signals={signals}
        value={value}
        onChange={onChange}
        codexFastModeEnabled={codexFastModeEnabled}
        desktopLayout={desktopLayout}
        mediaModelPanel={mediaModelPanel}
      />
      <div className="mx-0 h-5 w-px bg-divider/60 sm:mx-0.5" />
    </>
  );
}

function ComposerMediaModelPickerControls({
  signals,
  value,
  onChange,
  codexFastModeEnabled,
  imageModel,
  videoModel,
}: {
  signals: ComposerSignals;
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
  codexFastModeEnabled: boolean;
  imageModel: ComposerImageModelPickerState | undefined;
  videoModel: ComposerVideoModelPickerState | undefined;
}) {
  const userPreference = useLastResolved(userModelPreference$);
  const resolvedImageModel = imageModel
    ? {
        ...imageModel,
        selectedModel:
          imageModel.value ??
          userPreference?.selectedImageModel ??
          DEFAULT_IMAGE_MODEL,
      }
    : undefined;
  const resolvedVideoModel = videoModel
    ? {
        ...videoModel,
        selectedModel:
          videoModel.value ??
          userPreference?.selectedVideoModel ??
          DEFAULT_VIDEO_MODEL,
      }
    : undefined;
  return (
    <ComposerModelPickerControls
      signals={signals}
      value={value}
      onChange={onChange}
      codexFastModeEnabled={codexFastModeEnabled}
      imageModel={resolvedImageModel}
      videoModel={resolvedVideoModel}
    />
  );
}

function ComposerModelPickerSlotBase({
  signals,
  imageModel,
  videoModel,
}: {
  signals: ComposerSignals;
  imageModel: ComposerImageModelPickerState | undefined;
  videoModel: ComposerVideoModelPickerState | undefined;
}) {
  const codexFastModeEnabled = useGet(codexFastModeEnabled$);
  const modelSelection = useLastLoadable(signals.model.modelSelection$);
  const selectedModelOauthAvailable =
    useLastResolved(signals.model.selectedModelOauthAvailable$) ?? true;
  const setModelSelection = useSet(signals.model.setModelSelection$);
  const pageSignal = useGet(pageSignal$);
  const value = modelSelection.state === "hasData" ? modelSelection.data : null;
  const modelPickerLoading = modelSelection.state === "loading";
  const onModelPickerChange = (selection: ModelProviderSelection | null) => {
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };
  if (modelPickerLoading || value === null) {
    return null;
  }

  return (
    <>
      <ComposerModelConfigurationWarning
        signals={signals}
        selection={value}
        oauthAvailable={selectedModelOauthAvailable}
      />
      {imageModel || videoModel ? (
        <ComposerMediaModelPickerControls
          signals={signals}
          value={value}
          onChange={onModelPickerChange}
          codexFastModeEnabled={codexFastModeEnabled}
          imageModel={imageModel}
          videoModel={videoModel}
        />
      ) : (
        <ComposerModelPickerControls
          signals={signals}
          value={value}
          onChange={onModelPickerChange}
          codexFastModeEnabled={codexFastModeEnabled}
          imageModel={undefined}
          videoModel={undefined}
        />
      )}
    </>
  );
}

/** Choosing a media model writes its pin and closes the shared popover. */
function ComposerVideoModelPickerSlot({
  signals,
  videoModelSignals,
}: {
  signals: ComposerSignals;
  videoModelSignals: ComposerVideoModelSignals;
}) {
  const setModelPickerOpen = useSet(signals.model.setModelPickerOpen$);
  const selectedVideoModel =
    useLastResolved(videoModelSignals.selectedVideoModel$) ?? null;
  const setVideoModel = useSet(videoModelSignals.setVideoModel$);
  const pageSignal = useGet(pageSignal$);
  const videoModel: ComposerVideoModelPickerState = {
    value: selectedVideoModel,
    onChange: (next) => {
      detach(setVideoModel(next, pageSignal), Reason.DomCallback);
      setModelPickerOpen(false);
    },
  };
  return (
    <ComposerModelPickerSlotBase
      signals={signals}
      imageModel={undefined}
      videoModel={videoModel}
    />
  );
}

function ComposerExistingMediaModelPickerSlot({
  signals,
  imageModelSignals,
  videoModelSignals,
}: {
  signals: ComposerSignals;
  imageModelSignals: ComposerImageModelSignals;
  videoModelSignals: ComposerVideoModelSignals;
}) {
  const setModelPickerOpen = useSet(signals.model.setModelPickerOpen$);
  const selectedImageModel =
    useLastResolved(imageModelSignals.selectedImageModel$) ?? null;
  const selectedVideoModel =
    useLastResolved(videoModelSignals.selectedVideoModel$) ?? null;
  const setImageModel = useSet(imageModelSignals.setImageModel$);
  const setVideoModel = useSet(videoModelSignals.setVideoModel$);
  const pageSignal = useGet(pageSignal$);
  const imageModel: ComposerImageModelPickerState = {
    value: selectedImageModel,
    onChange: (next) => {
      detach(setImageModel(next, pageSignal), Reason.DomCallback);
      setModelPickerOpen(false);
    },
  };
  const videoModel: ComposerVideoModelPickerState = {
    value: selectedVideoModel,
    onChange: (next) => {
      detach(setVideoModel(next, pageSignal), Reason.DomCallback);
      setModelPickerOpen(false);
    },
  };
  return (
    <ComposerModelPickerSlotBase
      signals={signals}
      imageModel={imageModel}
      videoModel={videoModel}
    />
  );
}

function ComposerModelPickerSlot({ signals }: { signals: ComposerSignals }) {
  const createMode = useGet(signals.create.mode$);
  if (createMode === "image" && signals.imageModel) {
    return <ComposerCreateImageModelPicker model={signals.imageModel} />;
  }
  if (createMode === "video" && signals.videoModel) {
    return (
      <ComposerCreateVideoModelPicker
        model={signals.videoModel}
        signals={signals}
      />
    );
  }
  const imageModelSignals = signals.imageModel;
  const videoModelSignals = signals.videoModel;
  if (imageModelSignals && videoModelSignals) {
    return (
      <ComposerExistingMediaModelPickerSlot
        signals={signals}
        imageModelSignals={imageModelSignals}
        videoModelSignals={videoModelSignals}
      />
    );
  }
  if (videoModelSignals) {
    return (
      <ComposerVideoModelPickerSlot
        signals={signals}
        videoModelSignals={videoModelSignals}
      />
    );
  }
  return (
    <ComposerModelPickerSlotBase
      signals={signals}
      imageModel={undefined}
      videoModel={undefined}
    />
  );
}

function ComposerModelScopeCard({
  label,
  model,
  updating,
  onUseForFutureChats,
}: {
  label: string;
  model: string;
  updating: boolean;
  onUseForFutureChats: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative z-0 mx-3 sm:ml-auto sm:mr-4 sm:w-fit sm:max-w-[calc(100%_-_2rem)]">
      {/* The surface extends one content-height behind the composer. The
          composer stays above it (z-10), while the controls remain fully
          visible in the half that protrudes below. */}
      <div
        className="pointer-events-none absolute inset-x-0 -top-full bottom-0 rounded-xl bg-gray-50"
        aria-hidden="true"
      />
      <div
        className="relative flex flex-wrap items-center gap-2 p-1 pl-3 text-xs sm:flex-nowrap"
        role="group"
        aria-label={label}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="min-w-0 max-w-full text-muted-foreground">
          <span>
            {t(($) => {
              return $.chat.composer.temporarilySwitchTo;
            })}
          </span>{" "}
          <span>{model}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0 text-xs font-medium text-foreground"
          disabled={updating}
          aria-busy={updating}
          onClick={onUseForFutureChats}
        >
          {updating && <Loader2 className="animate-spin" aria-hidden="true" />}
          {t(($) => {
            return $.chat.composer.useForFutureChats;
          })}
        </Button>
      </div>
    </div>
  );
}

function ComposerTemporaryModelNotice({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selection = useLastResolved(signals.model.modelSelection$);
  const policies = useLastResolved(orgModelPolicies$);
  const userPreference = useLastResolved(userModelPreference$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateUserModelPreference$,
  );
  const codexFastModeEnabled = useGet(codexFastModeEnabled$);
  const featureSwitches = useGet(featureSwitch$);
  const pageSignal = useGet(pageSignal$);
  const defaultSelection = resolveModelFirstUserDefaultSelection({
    userPreference,
    policies,
    codexFastModeEnabled,
  });
  const selectionServiceTier =
    selection?.codexServiceTier === "fast" ? "priority" : null;
  const defaultServiceTier =
    defaultSelection?.codexServiceTier === "fast" ? "priority" : null;
  const modelChanged =
    selection?.selectedModel !== defaultSelection?.selectedModel;
  const serviceTierChanged = selectionServiceTier !== defaultServiceTier;
  const effort = preferredChatReasoningEffort(selection, featureSwitches);
  const defaultEffort = preferredChatReasoningEffort(
    defaultSelection,
    featureSwitches,
  );
  const effortChanged = effort !== defaultEffort;
  if (
    !selection ||
    !defaultSelection ||
    (!modelChanged && !serviceTierChanged && !effortChanged)
  ) {
    return withChatScrollLayout(null);
  }
  const updating = updateLoadable.state === "loading";
  const modelName = getModelDisplayName(selection.selectedModel);
  const runSpeedLabel = t(($) => {
    return selectionServiceTier === "priority"
      ? $.settings.models.picker.fast
      : $.settings.models.picker.standard;
  });
  const scopedModelLabel = [
    modelName,
    serviceTierChanged ? runSpeedLabel : undefined,
    effortChanged && effort
      ? effort.charAt(0).toUpperCase() + effort.slice(1)
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const useForFutureChats = () => {
    if (updating) {
      return;
    }
    detach(
      updatePreference(
        {
          selectedModel: selection.selectedModel,
          serviceTier: selectionServiceTier,
          ...(effort === undefined
            ? {}
            : {
                modelSettingsPatch: {
                  model: selection.selectedModel,
                  effort,
                },
              }),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return withChatScrollLayout(
    <ComposerModelScopeCard
      label={t(($) => {
        return $.chat.composer.modelForThisChat;
      })}
      model={scopedModelLabel}
      updating={updating}
      onUseForFutureChats={useForFutureChats}
    />,
  );
}

function ComposerTemporaryVideoModelNotice({
  videoModelSignals,
}: {
  videoModelSignals: ComposerVideoModelSignals;
}) {
  const { t } = useTranslation();
  // The effective model, not the pin: the card names the model a run would
  // actually use, which is what the member default is being compared against.
  const selection = useLastResolved(videoModelSignals.effectiveVideoModel$);
  const userPreference = useLastResolved(userModelPreference$);
  const [updateLoadable, updateDefaultVideoModel] = useLoadableSet(
    updateDefaultVideoModel$,
  );
  const pageSignal = useGet(pageSignal$);
  if (!userPreference) {
    return withChatScrollLayout(null);
  }
  const defaultVideoModel =
    userPreference.selectedVideoModel ?? DEFAULT_VIDEO_MODEL;
  if (!selection || selection === defaultVideoModel) {
    return withChatScrollLayout(null);
  }
  const updating = updateLoadable.state === "loading";
  const useForFutureChats = () => {
    if (updating) {
      return;
    }
    detach(updateDefaultVideoModel(selection, pageSignal), Reason.DomCallback);
  };
  return withChatScrollLayout(
    <ComposerModelScopeCard
      label={t(($) => {
        return $.chat.composer.videoModelForThisChat;
      })}
      model={getModelDisplayName(selection)}
      updating={updating}
      onUseForFutureChats={useForFutureChats}
    />,
  );
}

function ComposerTemporaryImageModelNotice({
  imageModelSignals,
}: {
  imageModelSignals: ComposerImageModelSignals;
}) {
  const { t } = useTranslation();
  const selection = useLastResolved(imageModelSignals.effectiveImageModel$);
  const userPreference = useLastResolved(userModelPreference$);
  const [updateLoadable, updateDefaultImageModel] = useLoadableSet(
    updateDefaultImageModel$,
  );
  const pageSignal = useGet(pageSignal$);
  if (!userPreference) {
    return withChatScrollLayout(null);
  }
  const defaultImageModel =
    userPreference.selectedImageModel ?? DEFAULT_IMAGE_MODEL;
  if (!selection || selection === defaultImageModel) {
    return withChatScrollLayout(null);
  }
  const updating = updateLoadable.state === "loading";
  const useForFutureChats = () => {
    if (updating) {
      return;
    }
    detach(updateDefaultImageModel(selection, pageSignal), Reason.DomCallback);
  };
  return withChatScrollLayout(
    <ComposerModelScopeCard
      label={t(($) => {
        return $.chat.composer.imageModelForThisChat;
      })}
      model={IMAGE_MODEL_CONFIGS[selection].label}
      updating={updating}
      onUseForFutureChats={useForFutureChats}
    />,
  );
}

function ComposerTemporaryModelNoticeSlot({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const enabled = useGet(signals.model.temporaryModelNoticeEnabled$);
  const mediaModelCategory = useGet(signals.model.mediaModelCategory$);
  const imageModelSignals = signals.imageModel;
  const videoModelSignals = signals.videoModel;
  if (!enabled) {
    return withChatScrollLayout(null);
  }
  // One card at a time: it belongs to whichever model the composer is
  // currently pointed at, matching the pressed state of the two mode chips.
  if (imageModelSignals && mediaModelCategory === "image") {
    return withChatScrollLayout(
      <ComposerTemporaryImageModelNotice
        imageModelSignals={imageModelSignals}
      />,
    );
  }
  if (videoModelSignals && mediaModelCategory === "video") {
    return withChatScrollLayout(
      <ComposerTemporaryVideoModelNotice
        videoModelSignals={videoModelSignals}
      />,
    );
  }
  return withChatScrollLayout(
    <ComposerTemporaryModelNotice signals={signals} />,
  );
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

interface ResolvedComposerConnectorCollections {
  readonly authorizedSet: ReadonlySet<ConnectorSlug>;
  readonly connectorMap: ReadonlyMap<
    ConnectorSlug,
    PlatformConnectorCatalogStatusItem
  >;
  readonly unconnectedConnectors: PlatformConnectorCatalogStatusItem[];
  readonly unconnectedCustomConnectors: CustomConnectorResponse[];
  readonly agentConnectors: ComposerConnectorItem[];
  readonly agentCustomConnectors: ComposerCustomConnectorItem[];
  readonly selectedCustomConnector: CustomConnectorResponse | undefined;
}

function resolveComposerConnectorCollections({
  relatedCatalogItems,
  addDialogCatalogItems,
  customConnectors,
  authorizedConnectorSlugs,
  customConnectorGrants,
  selectedCustomConnectorId,
  mcpEnabled,
}: {
  relatedCatalogItems: readonly PlatformConnectorCatalogStatusItem[];
  addDialogCatalogItems: readonly PlatformConnectorCatalogStatusItem[];
  customConnectors: readonly CustomConnectorResponse[];
  authorizedConnectorSlugs: readonly ConnectorSlug[] | null;
  customConnectorGrants: readonly AgentCustomConnectorGrant[] | null;
  selectedCustomConnectorId: string | null;
  mcpEnabled: boolean;
}): ResolvedComposerConnectorCollections {
  const resolvedRelatedCatalogItems = relatedCatalogItems;
  const resolvedAddDialogCatalogItems = addDialogCatalogItems;
  const authorizedSet = new Set(authorizedConnectorSlugs ?? []);
  const authorizedCustomSet = new Set(
    customConnectorGrants?.map((grant) => {
      return grant.customConnectorId;
    }) ?? [],
  );
  const resolvedCustomConnectors = customConnectors.filter((connector) => {
    return (
      connector.kind === "http" ||
      mcpEnabled ||
      authorizedCustomSet.has(connector.id)
    );
  });
  const connectorMap = new Map(
    [...resolvedRelatedCatalogItems, ...resolvedAddDialogCatalogItems].map(
      (connector) => {
        return [connector.slug, connector];
      },
    ),
  );
  const unconnectedConnectors = resolvedAddDialogCatalogItems.filter(
    (connector) => {
      return !connector.connected;
    },
  );
  const unconnectedCustomConnectors = resolvedCustomConnectors.filter(
    (connector) => {
      return (
        !connector.connected &&
        !isIntegrationManagedCustomConnector(connector) &&
        (connector.kind === "http" || mcpEnabled)
      );
    },
  );
  const agentConnectors = resolvedRelatedCatalogItems
    .filter((connector) => {
      return connector.connected;
    })
    .map((connector) => {
      return {
        ...connector,
        authorized: authorizedSet.has(connector.slug),
      };
    });
  const agentCustomConnectors = resolvedCustomConnectors
    .filter((connector) => {
      return connector.connected;
    })
    .map((connector) => {
      return {
        ...connector,
        authorized: authorizedCustomSet.has(connector.id),
      };
    });
  const selectedCustomConnector = selectedCustomConnectorId
    ? resolvedCustomConnectors.find((connector) => {
        return connector.id === selectedCustomConnectorId;
      })
    : undefined;
  return {
    authorizedSet,
    connectorMap,
    unconnectedConnectors,
    unconnectedCustomConnectors,
    agentConnectors,
    agentCustomConnectors,
    selectedCustomConnector,
  };
}

function ComposerFileInput({ signals }: { signals: ComposerSignals }) {
  const setFileInput = useSet(signals.draft.setComposerFileInput$);
  const uploadFile = useComposerFileUpload(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);

  return (
    <input
      ref={setFileInput}
      type="file"
      className="hidden"
      multiple
      onChange={(event) => {
        const files = event.target.files;
        let uploaded = false;
        if (files) {
          for (const file of files) {
            uploaded = uploadFile(file) || uploaded;
          }
        }
        if (uploaded) {
          notifyDraftChanged();
        }
        event.target.value = "";
      }}
    />
  );
}

function ComposerAttachments({ signals }: { signals: ComposerSignals }) {
  const attachments = useGet(signals.draft.attachments$);
  const removeAttachment = useSet(signals.draft.removeAttachment$);
  const notifyDraftChanged = useComposerDraftChange(signals);

  if (attachments.length === 0) {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <AttachmentChips
      attachments={attachments}
      annotationSignals={signals.imageAnnotation}
      onAnnotationChange={notifyDraftChanged}
      onRemove={(attachment) => {
        removeAttachment(attachment);
        notifyDraftChanged();
      }}
    />,
  );
}

function ComposerConnectorConnectDialogs({
  selectedConnector,
  selectedConnectorAccountOptions,
  selectedCustomConnector,
  selectedCustomConnectorAccountOptions,
  agentId,
  onBuiltinClose,
  onBuiltinSuccess,
  onCustomClose,
}: {
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | undefined;
  readonly selectedConnectorAccountOptions: DefaultConnectorAccountMutationOptions | null;
  readonly selectedCustomConnector: CustomConnectorResponse | undefined;
  readonly selectedCustomConnectorAccountOptions: DefaultConnectorAccountMutationOptions | null;
  readonly agentId: string;
  readonly onBuiltinClose: () => void;
  readonly onBuiltinSuccess: () => Promise<void>;
  readonly onCustomClose: () => void;
}) {
  return (
    <>
      {selectedConnector && selectedConnectorAccountOptions ? (
        <ConnectModal
          item={selectedConnector}
          agentId={agentId}
          accountOptions={selectedConnectorAccountOptions}
          onClose={onBuiltinClose}
          onSuccess={onBuiltinSuccess}
        />
      ) : null}
      {selectedCustomConnector && selectedCustomConnectorAccountOptions ? (
        <CustomConnectorConnectDialog
          connector={selectedCustomConnector}
          agentId={agentId}
          accountOptions={selectedCustomConnectorAccountOptions}
          onClose={onCustomClose}
        />
      ) : null}
    </>
  );
}

function useComposerComputerUse(signals: ComposerSignals): ComposerComputerUse {
  const storedComputerUseHostId = useGet(signals.computer.computerUseHostId$);
  const cloudBrowserState = useLastLoadable(
    signals.computer.cloudBrowserEnabled$,
  );
  const lastCloudBrowserEnabled = useLastResolved(
    signals.computer.cloudBrowserEnabled$,
  );
  const cloudBrowserEnabled =
    cloudBrowserState.state === "hasData"
      ? cloudBrowserState.data
      : (lastCloudBrowserEnabled ?? true);
  const setComputerUseHostId = useSet(signals.computer.setComputerUseHostId$);
  const setCloudBrowserEnabled = useSet(
    signals.computer.setCloudBrowserEnabled$,
  );
  const computerUseHostsState = useLastLoadable(computerUseHostsFromWorker$);
  const lastComputerUseHosts =
    useLastResolved(computerUseHostsFromWorker$) ?? [];
  const computerUseHosts =
    computerUseHostsState.state === "hasData"
      ? computerUseHostsState.data
      : lastComputerUseHosts;
  const resolvedComputerUseHostId = selectedComputerUseHostId(
    computerUseHosts,
    storedComputerUseHostId,
  );
  const composerPageSignal = useGet(pageSignal$);
  return {
    hosts: visibleComputerUseHosts(computerUseHosts, resolvedComputerUseHostId),
    loading:
      computerUseHostsState.state === "loading" &&
      computerUseHosts.length === 0,
    selectedHostId: resolvedComputerUseHostId,
    onChange: (hostId) => {
      detach(
        setComputerUseHostId(hostId, composerPageSignal),
        Reason.DomCallback,
      );
    },
    cloudBrowserEnabled,
    cloudBrowserLoading:
      cloudBrowserState.state === "loading" &&
      lastCloudBrowserEnabled === undefined,
    onCloudBrowserChange: (enabled) => {
      detach(
        setCloudBrowserEnabled(enabled, composerPageSignal),
        Reason.DomCallback,
      );
    },
    downloadUrl: OKOU_DESKTOP_DOWNLOAD_URL,
  };
}

function ComposerConnectorsSlot({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
}) {
  const computerUse = useComposerComputerUse(signals);
  const { t } = useTranslation();
  const mcpEnabled = useGet(customConnectorMcpEnabled$);
  const connectorDirectoryEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ConnectorDirectory] === true;
  const connectorData = useLastResolved(signals.connector.data$);
  const addDialogCatalogItems =
    useLastResolved(signals.connector.addDialogCatalogItems$) ?? [];
  const agents = useLastResolved(agents$) ?? [];
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const openAddConnectorsDialog = useSet(
    signals.connector.openAddConnectorsDialog$,
  );

  const pageSignal = useGet(pageSignal$);
  const selectedConnectorSlug = connectorUi.selectedConnectorSlug;
  const selectedCustomConnectorId = connectorUi.selectedCustomConnectorId;
  const setConnectorAuthorization = actions.setAuthorization;
  const agentRecordId = signals.agentId;
  const displayName =
    agents.find((agent) => {
      return agent.agentId === agentRecordId;
    })?.displayName ?? "";

  const {
    authorizedSet,
    connectorMap,
    unconnectedConnectors,
    unconnectedCustomConnectors,
    agentConnectors,
    agentCustomConnectors,
    selectedCustomConnector,
  } = resolveComposerConnectorCollections({
    relatedCatalogItems: connectorData?.relatedCatalogItems ?? [],
    addDialogCatalogItems,
    customConnectors: connectorData?.customConnectors ?? [],
    authorizedConnectorSlugs:
      connectorData?.authorization.enabledConnectorSlugs ?? null,
    customConnectorGrants:
      connectorData?.authorization.customConnectorGrants ?? null,
    selectedCustomConnectorId,
    mcpEnabled,
  });
  const selectedConnector = selectedConnectorSlug
    ? connectorMap.get(selectedConnectorSlug)
    : undefined;
  const selectedConnectorAccountOptions =
    defaultBuiltinConnectorAccountOptions(selectedConnector);
  const selectedCustomConnectorAccountOptions =
    defaultCustomConnectorAccountOptions(selectedCustomConnector);

  const handleConnectSuccess = async (connectorSlug: ConnectorSlug) => {
    const label = connectorMap.get(connectorSlug)?.label ?? connectorSlug;
    await setConnectorAuthorization(
      { kind: "builtin", connectorSlug },
      true,
      pageSignal,
    );
    toast.success(
      t(
        ($) => {
          return $.chat.connectors.authorized;
        },
        {
          connectorName: label,
          agentName: displayName,
        },
      ),
      {
        id: `connector-connected-${connectorSlug}`,
      },
    );
  };

  const completeConnectorAddition = async (
    connectorSlug: ConnectorSlug,
  ): Promise<void> => {
    if (
      connectorData?.authorization.agentId !== agentRecordId ||
      !authorizedSet.has(connectorSlug)
    ) {
      await handleConnectSuccess(connectorSlug);
    }
    updateConnectorUi({
      showAddDialog: false,
    });
  };

  const connectorConnectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    const connectorSlug = connector.slug;
    const accountOptions = defaultBuiltinConnectorAccountOptions(connector);
    return {
      openModal: () => {
        updateConnectorUi({
          showAddDialog: false,
          selectedConnectorSlug: connectorSlug,
        });
      },
      connectBrowserAuth: async (authMethod) => {
        if (!accountOptions) {
          return;
        }
        await actions.connectBrowserAuth(
          {
            connectorSlug,
            method: authMethod,
            options: {
              connectorLabel: connector.label,
              connectorIcon: connector.icon,
              agentId: agentRecordId,
              ...accountOptions,
            },
            onSuccess: () => {
              return completeConnectorAddition(connectorSlug);
            },
          },
          pageSignal,
        );
      },
      connectNoAuth: async (authMethod) => {
        if (!accountOptions) {
          return;
        }
        await actions.connectNoAuth(
          {
            connectorSlug,
            authMethod,
            onSuccess: () => {
              return completeConnectorAddition(connectorSlug);
            },
            options: {
              connectorLabel: connector.label,
              agentId: agentRecordId,
              ...accountOptions,
            },
          },
          pageSignal,
        );
      },
    };
  };

  const handleToggle = async (
    connectorSlug: ConnectorSlug,
    checked: boolean,
  ) => {
    await setConnectorAuthorization(
      { kind: "builtin", connectorSlug },
      checked,
      pageSignal,
    );
  };

  const handleCustomToggle = async (connectorId: string, checked: boolean) => {
    const connector = agentCustomConnectors.find((candidate) => {
      return candidate.id === connectorId;
    });
    if (checked && connector?.permissionBundleRef) {
      return;
    }
    await setConnectorAuthorization(
      {
        kind: "custom",
        connectorId,
        permissionBundleRef: connector?.permissionBundleRef ?? null,
      },
      checked,
      pageSignal,
    );
  };

  return (
    <>
      <ConnectorsPopoverButton
        signals={signals}
        agentId={agentRecordId}
        agentDisplayName={displayName}
        agentConnectors={agentConnectors}
        agentCustomConnectors={agentCustomConnectors}
        connectorsLoading={connectorData === undefined}
        actions={actions}
        computerUse={computerUse}
        onOpenAddDialog={openAddConnectorsDialog}
        onToggle={handleToggle}
        onToggleCustom={handleCustomToggle}
      />
      <ComposerConnectorConnectDialogs
        selectedConnector={selectedConnector}
        selectedConnectorAccountOptions={selectedConnectorAccountOptions}
        selectedCustomConnector={selectedCustomConnector}
        selectedCustomConnectorAccountOptions={
          selectedCustomConnectorAccountOptions
        }
        agentId={agentRecordId}
        onBuiltinClose={() => {
          updateConnectorUi({ selectedConnectorSlug: null });
        }}
        onBuiltinSuccess={async () => {
          const connectorSlug = selectedConnectorSlug;
          if (connectorSlug) {
            await completeConnectorAddition(connectorSlug);
          }
        }}
        onCustomClose={() => {
          updateConnectorUi({ selectedCustomConnectorId: null });
        }}
      />
      {connectorUi.showAddDialog &&
        (connectorDirectoryEnabled ? (
          <ConnectorDirectoryDialog
            state={connectorUi}
            onUpdateState={updateConnectorUi}
            categoryCounts={connectorData?.categoryConnectorCounts}
            categoryMetadata={connectorData?.categoryMetadata}
            loading={connectorData === undefined}
            chipCatalog={connectorData?.relatedCatalogItems ?? []}
            connected={agentConnectors}
            unconnected={unconnectedConnectors}
            connectedCustom={agentCustomConnectors}
            unconnectedCustom={unconnectedCustomConnectors}
            connecting={actions.connecting}
            connectHandlers={connectorConnectHandlers}
            onConnectCustom={(connector) => {
              updateConnectorUi({
                showAddDialog: false,
                selectedCustomConnectorId: connector.id,
              });
            }}
            onConfigurePermissions={(connectorSlug) => {
              updateConnectorUi({
                showAddDialog: false,
                permissionConnectorSlug: connectorSlug,
              });
            }}
            onClose={() => {
              return updateConnectorUi({
                showAddDialog: false,
              });
            }}
          />
        ) : (
          <AddConnectorsDialog
            signals={signals}
            unconnected={unconnectedConnectors}
            unconnectedCustom={unconnectedCustomConnectors}
            connecting={actions.connecting}
            connectHandlers={connectorConnectHandlers}
            onConnectCustom={(connector) => {
              updateConnectorUi({
                showAddDialog: false,
                selectedCustomConnectorId: connector.id,
              });
            }}
            onClose={() => {
              return updateConnectorUi({
                showAddDialog: false,
              });
            }}
          />
        ))}
    </>
  );
}

function ComposerFooter({
  signals,
  actions,
  connectorActions,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
  connectorActions: ComposerConnectorActions;
}) {
  const createMode = useGet(signals.create.mode$);
  const narrowVideoGap =
    createMode === "video" ? "@max-[344px]/composer:gap-0" : undefined;
  const voiceInputV2Enabled = useGet(voiceInputV2Enabled$);
  const voiceDraft = useResolved(signals.voice.state$);
  const capture = useGet(signals.voice.capture$);
  const status =
    actions.voiceAction === "start"
      ? "idle"
      : actions.voiceAction === "discard"
        ? "discarding"
        : actions.voiceAction === "finish" || actions.voiceAction === "retry"
          ? "transcribing"
          : capture
            ? "recording"
            : voiceDraft?.status;
  const activeVoiceDraftStatus: Exclude<
    ComposerVoiceInputStatus,
    "idle"
  > | null =
    voiceInputV2Enabled &&
    status !== undefined &&
    status !== "idle" &&
    (status !== "recording" || capture !== null)
      ? status
      : null;
  return withChatScrollLayout(
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-1 sm:gap-2",
        activeVoiceDraftStatus ? "px-2 pb-3 pt-3" : "px-4 pb-4 pt-1",
        narrowVideoGap,
        createMode === "video" && "@max-[344px]/composer:px-3",
      )}
    >
      {activeVoiceDraftStatus ? (
        <VoiceDraftFooter
          signals={signals}
          actions={actions}
          status={activeVoiceDraftStatus}
          recordingAvailable={Boolean(voiceDraft?.recording)}
          voiceMessage={voiceDraft?.message}
        />
      ) : (
        <>
          <div
            className={cn(
              "flex min-w-0 items-center gap-1 text-muted-foreground sm:gap-1.5",
              narrowVideoGap,
            )}
          >
            <ComposerAttachButton signals={signals} />
            <ComposerTemplatePickerSlot signals={signals} />
            <ComposerWorkflowPromptSlot signals={signals} />
            <ComposerConnectorsSlot
              signals={signals}
              actions={connectorActions}
            />
            {/* Sits with the other input-scoped controls rather than beside
                the model picker: it configures the message being written,
                not which model the composer points at. */}
            <ComposerVideoOptionsChip signals={signals} />
            <ComposerPresentationOptions signals={signals} />
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center gap-1 sm:gap-2",
              narrowVideoGap,
            )}
          >
            <ComposerModelPickerSlot signals={signals} />
            <MicButton signals={signals} actions={actions} />
            <ComposerSendControl signals={signals} actions={actions} />
          </div>
        </>
      )}
    </div>,
  );
}

function ComposerCard({ signals }: { signals: ComposerSignals }) {
  const actions = useComposerActions(signals);
  const connectorActions = useComposerConnectorActions(signals.connector);
  const hasTemplateAttachment = useGet(signals.template.hasTemplateAttachment$);
  const dragOver = useGet(signals.draft.dragOver$);
  const setDragOver = useSet(signals.draft.setDragOver$);
  const uploadFile = useComposerFileUpload(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);
  const layoutHeightClassNames = composerLayoutHeightClassNames(
    signals.editor.singleLineOnMobile,
    hasTemplateAttachment,
  );

  return (
    <Card
      data-slot="chat-composer-card"
      className={cn(
        // Paint focus on the existing border. A separately promoted border
        // with a negative inset can snap differently from the card and SVGs.
        "@container/composer relative z-10 overflow-visible rounded-3xl border-gray-300 bg-card shadow-[var(--okou-card-shadow)] transition-[border-color] duration-[220ms] ease-[cubic-bezier(0.4,0,0.2,1)] focus-within:border-surface-focus motion-reduce:transition-none",
        "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:opacity-0 after:shadow-[var(--okou-composer-focus-veil)] after:transition-opacity after:duration-[220ms] after:ease-[cubic-bezier(0.4,0,0.2,1)] after:content-[''] focus-within:after:opacity-100 motion-reduce:after:transition-none",
        "[@media(display-mode:standalone)]:[[data-chat-composer]_&]:scroll-mb-4",
        dragOver && "outline outline-2 outline-blue-400/60",
      )}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        let uploaded = false;
        for (const file of event.dataTransfer.files) {
          uploaded = uploadFile(file) || uploaded;
        }
        if (uploaded) {
          notifyDraftChanged();
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
    >
      <CardContent className="overflow-hidden rounded-[inherit] p-0">
        <div
          ref={actions.bind}
          className={cn("flex flex-col", layoutHeightClassNames.shell)}
        >
          <ComposerImportedTemplateUrlRefreshLifecycle signals={signals} />
          <ComposerCreateControls signals={signals} />
          <ComposerAttachments signals={signals} />
          <ComposerSelectedTask signals={signals} />
          <ComposerInputSlot
            signals={signals}
            actions={actions}
            minimumHeightClassName={layoutHeightClassNames.input}
          />
          {/* Voice states share 8px/12px outer tray spacing and 12px/8px
              inner padding so their surfaces stay aligned through handoff. */}
          <ComposerFooter
            signals={signals}
            actions={actions}
            connectorActions={connectorActions}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function ChatComposer({
  signals,
  showPendingItems = true,
}: ChatComposerProps) {
  const setImageAnnotationLifecycleRef = useSet(
    signals.setImageAnnotationLifecycleRef$,
  );
  return (
    <>
      <ComposerFileInput signals={signals} />
      <div
        ref={setImageAnnotationLifecycleRef}
        className="relative flex w-full min-w-0 flex-col"
      >
        {showPendingItems ? <PendingItemsStrip signals={signals} /> : null}
        <ComposerCard signals={signals} />
        <ComposerTemporaryModelNoticeSlot signals={signals} />
        <ReplaceComposerDraftDialog signals={signals} />
        <ImageAnnotationEditor signals={signals.imageAnnotation} />
      </div>
    </>
  );
}
