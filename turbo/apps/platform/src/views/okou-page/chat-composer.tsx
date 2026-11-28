import { ChatConnectorAccountDialogs } from "./chat-connector-account-dialogs.tsx";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { remoteDevicesEnabled$ } from "../../signals/remote-devices.ts";
import { ComposerRemoteDevicesMenu } from "./composer-remote-devices.tsx";
import { findDocumentTemplateItem } from "@okouai/core/document-template-items";

import { ChatConnectorMenu } from "./chat-connector-menu.tsx";
import {
  PhoneUseConnectorMenuSection,
  PhoneUseSetupDialog,
} from "./phone-use-connector-menu.tsx";

import { ConnectorPermissionsDialog } from "./components/settings/connector-permissions-dialog.tsx";
import { DocumentTemplatePreviewPage } from "./document-template-preview-page.tsx";

import { ScrollArea } from "@base-ui/react/scroll-area";
import {
  composerVoiceMessagesEnabled$,
  composerVoiceQuota$,
  type ComposerVoiceInputStatus,
} from "../../signals/okou-page/composer-voice-input.ts";
import {
  startComposerSubmission,
  useComposerActions,
  useComposerPrimaryAction,
  type ComposerActions,
} from "./composer-actions.ts";
import {
  ComposerAddMenu,
  type ComposerAddMenuGroup,
} from "./composer-add-menu.tsx";
import {
  useComposerConnectorActions,
  type ComposerConnectorActions,
} from "./composer-connector-actions.ts";
import { ComposerTaskControls } from "./composer-create.tsx";
import { ComposerTools } from "./composer-tools.tsx";
import { useComposerCapabilities } from "./composer-capabilities.ts";
import {
  ComposerProjectControl,
  useComposerProjectMenuItem,
} from "../projects/composer-project.tsx";
import { useCustomTemplateRecommendations } from "./use-custom-template-recommendations.ts";
import { ComposerTemplateSuggestion } from "./composer-template-suggestion.tsx";
// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { PublicConnectorCatalogDiscoveryResponse } from "@okouai/api-contracts/contracts/connector-catalog";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { UserTemplateKind } from "@okouai/api-contracts/contracts/user-templates";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import { ElapsedTime, getShortcutLabel, ScrollBar } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { Card, CardContent } from "@okouai/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { cn } from "@okouai/ui/lib/utils";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
  useLoadableState,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertTriangle,
  ArrowUp,
  AudioLines,
  Bolt,
  Check,
  Download,
  Globe,
  Image as ImageIcon,
  Loader2,
  Mic,
  Monitor,
  Paperclip,
  Plug,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { MAX_ATTACHMENT_UPLOAD_BYTES } from "@okouai/core/upload-limits";
import {
  COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS,
  COMPOSER_VOICE_INPUT_SHORTCUT,
} from "../../lib/composer-voice-input-shortcut.ts";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { withConnectorCompletion } from "../../signals/external/connectors.ts";
import { modelCatalog$ } from "../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../signals/external/run-models.ts";
import {
  updateUserModelPreference$,
  userModelPreference$,
} from "../../signals/external/user-model-preference.ts";
import type { RestorableAttachment } from "../../signals/okou-page/chat-draft.ts";
import { readChatMessageFromClipboard } from "../../signals/okou-page/clipboard.ts";
import type {
  ComposerPendingEvent,
  ComposerPrimaryAction,
  ComposerSignals,
} from "../../signals/okou-page/composer-signals.ts";
import {
  OKOU_DESKTOP_DOWNLOAD_URL,
  selectedComputerUseHostId,
  visibleComputerUseHosts,
} from "../../signals/okou-page/computer-use-hosts.ts";
import { resolveDefaultModelSelection } from "../../signals/okou-page/model-default-selection.ts";
import { preferredChatReasoningEffort } from "../../signals/okou-page/model-reasoning-effort.ts";
import {
  DOCUMENT_TEMPLATE_IMPORT_ACCEPT,
  PRESENTATION_TEMPLATE_IMPORT_ACCEPT,
  IMAGE_TEMPLATE_IMPORT_ACCEPT,
  importPresentationTemplateDeck$,
} from "../../signals/okou-page/presentation-template-import.ts";
import {
  defaultBuiltinConnectorAccountOptions,
  defaultCustomConnectorAccountOptions,
  type DefaultConnectorAccountMutationOptions,
  type CustomConnectorAccountMutationOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";

import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";
import { shouldUseUserMessage } from "../../signals/okou-page/user-message-document-codec.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { pastedTextFile$ } from "../../signals/pasted-text.ts";
import { locale$ } from "../../signals/locale.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { openSkillImportDialog$ } from "../../signals/skill-import/skill-import-dialog.ts";
import { Reason, detach, onDomEventFn } from "../../signals/utils.ts";
import { audioInputAvailable$ } from "../../signals/voice-io/voice-io-stt.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import {
  SubscriptionLinkingComposerMenu,
  useSubscriptionLinkingAvailable,
} from "./subscription-linking.tsx";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { AttachmentChips } from "./attachment-chips.tsx";
import { ComposerModelPanel } from "./components/composer-model-panel.tsx";
import {
  selectedModelDisplayName,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";

import type { ConnectorConnectHandlers } from "./components/settings/launch-connector-connect.ts";

import type { ComposerPasteEvent } from "./composer-input-types.ts";
import { ComposerNoticeTray } from "./composer-notice-tray.tsx";
import { ComposerRail } from "./composer-rail.tsx";
import { ComposerPresentationFormatSetup } from "./composer-presentation-format-setup.tsx";
import {
  TEMPLATE_CARD,
  TemplateCard,
  TemplateCardFace,
} from "./template-card.tsx";
import {
  defaultPresentationTemplateThemeId,
  presentationTemplateColorSystemId,
  toDocumentGenerationTemplate,
  toPresentationGenerationTemplate,
} from "./composer-template-catalog.ts";
import { ConnectorDirectoryDialog } from "./connector-directory-dialog.tsx";
import { CustomTemplatePreviewSlot } from "./custom-template-preview-slot.tsx";
import { ImageAnnotationEditor } from "./image-annotation-editor.tsx";
import { ComposerPaidToolNotice } from "./paid-tool-notice.tsx";
import { ComputerUseDownloadDialog } from "./computer-use-download-dialog.tsx";
import {
  contrastRatio,
  previewTextColorOn,
  safePreviewGround,
} from "./presentation-html-preview.ts";
import {
  ThreadRemoteAccessDialog,
  ThreadRemoteAccessSection,
} from "./remote-access-controls.tsx";
import { SCROLL_FADE_Y_WHEN_OVERFLOWING } from "./scroll-fade.ts";
import {
  TEMPLATE_DETAIL_BODY,
  TEMPLATE_DETAIL_FOOTER,
  TEMPLATE_DETAIL_GRID,
  TEMPLATE_DETAIL_STAGE,
  TemplateDetailFilmstrip,
  TemplateDetailSideColumn,
  TemplateDetailStageControls,
} from "./template-detail-layout.tsx";
import { TiptapWorkflowComposer } from "./tiptap-workflow-composer.tsx";
import { VoiceLevelWaveform } from "./voice-level-waveform.tsx";
import { WebsiteTemplatePreviewDialogSlot } from "./website-template-preview-dialog.tsx";

const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * `home` keeps the start page's two-line field wherever the composer sits.
 * `card` embeds the composer in a card row: the caret starts on the quote's left
 * edge, and a quote reserves one line for its note instead of a 96px field.
 */
export type ComposerLayout = "default" | "home" | "card";

interface ChatComposerProps {
  readonly signals: ComposerSignals;
  readonly showPendingItems?: boolean;
  readonly layout?: ComposerLayout;
  readonly discovery?: ReactNode;
}

interface ComposerComputerUseHost {
  id: string;
  hostName: string;
  displayName: string;
  status: "online" | "offline";
}

interface ComposerTemplateSelection {
  readonly onChange: (value: GenerationTemplateRequest) => void;
}

interface ComposerComputerUse {
  readonly hosts: readonly ComposerComputerUseHost[];
  readonly loading: boolean;
  readonly failed: boolean;
  readonly cloudBrowserAvailable: boolean;
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
const TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE = {
  width: 224,
  height: 126,
} as const;
const PRESENTATION_GALLERY_PREVIEW_BASE_URL =
  "https://static.okou.io/web/assets/presentation-gallery/2026-07-04";
const PRESENTATION_GALLERY_SLIDE_COUNT = 15;
const SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE = {
  width: 40,
  height: 40,
  fit: "cover",
} as const;
type TemplatePreviewImageSize = Parameters<typeof r2ImageTransformUrl>[1];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        <PopoverTrigger
          render={
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
          }
        />
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
    return null;
  }
  return (
    <div className="relative z-0 mx-5 -mb-6 overflow-hidden rounded-xl bg-gray-50 dark:bg-gray-100">
      <PendingItemsStripHeader
        label={label}
        cancellationRecoveryPending={cancellationRecoveryPending}
      />
      <div className="max-h-[200px] overflow-y-auto px-2 pb-7 pt-1" role="list">
        {pendingEvents.map((item) => {
          return item.kind === "message" ? (
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
          ) : (
            <ComposerStripRow
              key={item.id}
              kind="automation-event"
              text={
                item.text ||
                t(($) => {
                  return $.chat.queue.automationEvent;
                })
              }
              onRemove={() => {
                detach(
                  removeAutomationEvent(item.id, pageSignal),
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connector sub-components
// ---------------------------------------------------------------------------

function presentationTemplateSlideCount(
  item: PresentationTemplateItem,
): number {
  return Math.max(item.slideCount, 1);
}

function presentationTemplateThemedCardPreviewSource(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption | undefined,
): string {
  if (theme === undefined) {
    return item.cardPreviewImage;
  }
  return item.cardPreviewImagesByTheme[theme.id] ?? item.cardPreviewImage;
}

function presentationTemplateCoverImage(
  item: PresentationTemplateItem,
  theme?: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  return r2ImageTransformUrl(
    presentationTemplateThemedCardPreviewSource(item, theme),
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

function presentationTemplateDetailSlideImageSource(
  item: PresentationTemplateItem,
  index: number,
  theme: PresentationTemplateThemeOption,
  htmlPreviewFailed: boolean,
): string {
  if (index === 0) {
    return presentationTemplateThemedCardPreviewSource(item, theme);
  }
  if (htmlPreviewFailed) {
    return presentationTemplateGallerySlideUrl(item, index);
  }
  return (
    item.previewImages[index] ??
    presentationTemplateGallerySlideUrl(item, index)
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

function PresentationTemplateHtmlFrame({
  html,
  title,
  dataTestId,
  className,
  loading,
  frameRef,
}: {
  readonly html: string | null;
  readonly title: string;
  readonly dataTestId?: string;
  readonly className?: string;
  readonly loading?: "eager" | "lazy";
  readonly frameRef?: RefCallback<HTMLIFrameElement>;
}) {
  if (html === null) {
    return null;
  }
  return (
    <iframe
      key={html}
      ref={frameRef}
      title={title}
      data-testid={dataTestId}
      srcDoc={html}
      sandbox="allow-same-origin"
      tabIndex={-1}
      loading={loading}
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full border-0 bg-background opacity-0 data-[loaded=true]:opacity-100",
        className,
      )}
      onLoad={(event) => {
        event.currentTarget.dataset.loaded = "true";
      }}
    />
  );
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
  onSelect,
  signals,
}: {
  item: PresentationTemplateItem;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const focusPreview = useSet(signals.template.focusTemplatePreviewRef$);
  const detailPreview = useGet(signals.template.openedTemplateSelection$);
  const template = useLoadable(signals.template.openedTemplate$);
  const slideDocuments = useLoadable(
    signals.template.openedTemplateSlideDocuments$,
  );
  const setThemedFrameRef = useSet(signals.template.setOpenedTemplateFrameRef$);
  const setTheme = useSet(signals.template.setPresentationTemplateTheme$);
  const selectDetailPreview = useSet(signals.template.selectOpenedTemplate$);
  const visibleDetailPreview = templateDetailPreviewMatchesItem(
    detailPreview,
    item,
  )
    ? detailPreview
    : null;
  const selectedThemeId =
    visibleDetailPreview?.themeId ?? defaultPresentationTemplateThemeId(item);
  const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
  const loadedTemplate =
    template.state === "hasData" && template.data?.item.slug === item.slug
      ? template.data
      : null;
  const detailSlideCount =
    loadedTemplate?.draft.slides.length ?? presentationTemplateSlideCount(item);
  const activeSlideIndex = Math.min(
    visibleDetailPreview?.index ?? 0,
    detailSlideCount - 1,
  );
  const htmlPreviewFailed =
    template.state === "hasError" || slideDocuments.state === "hasError";
  const documents =
    slideDocuments.state === "hasData" ? slideDocuments.data : null;
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
      index: Math.max(0, Math.min(detailSlideCount - 1, index)),
      themeCss: presentationTemplateThemeCss(selectedTheme),
      themeId: selectedTheme.id,
    });
  };

  const selectDetailTheme = (theme: PresentationTemplateThemeOption) => {
    selectDetailPreview({
      item,
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

  return (
    <>
      <DialogHeader
        data-presentation-template-detail-header=""
        className="flex h-[68px] shrink-0 justify-center px-6 pr-14 text-left duration-200 motion-reduce:animate-none"
      >
        <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
          <span className="shrink-0 text-muted-foreground">
            {t(($) => {
              return $.artifacts.templates.template;
            })}
          </span>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="block min-w-0 truncate leading-none">
            {item.title}
          </span>
        </DialogTitle>
      </DialogHeader>
      <div className={TEMPLATE_DETAIL_BODY}>
        <div className={TEMPLATE_DETAIL_GRID}>
          <TemplateDetailStage
            title={item.title}
            focusRef={focusPreview}
            frameRef={setThemedFrameRef}
            activeSlideIndex={activeSlideIndex}
            slideCount={detailSlideCount}
            lowResolutionImage={detailLowResolutionImage}
            highResolutionImage={detailHighResolutionImage}
            documents={documents}
            onChange={selectDetailSlide}
            onKeyDown={handleDetailSlideKeyDown}
          />
          <TemplateDetailFilmstrip
            slideCount={Math.min(detailSlideCount, 15)}
            activeSlideIndex={activeSlideIndex}
            onChange={selectDetailSlide}
            onKeyDown={handleDetailSlideKeyDown}
            renderThumbnail={(slideIndex) => {
              return (
                <>
                  <img
                    src={r2ImageTransformUrl(
                      presentationTemplateDetailSlideImageSource(
                        item,
                        slideIndex,
                        selectedTheme,
                        htmlPreviewFailed,
                      ),
                      TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE,
                    )}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                  <PresentationTemplateHtmlFrame
                    html={documents?.[slideIndex]?.html ?? null}
                    frameRef={setThemedFrameRef}
                    loading="lazy"
                    title={t(
                      ($) => {
                        return $.artifacts.templates.slideThumbnail;
                      },
                      { title: item.title, slideNumber: slideIndex + 1 },
                    )}
                  />
                </>
              );
            }}
          />
          <TemplateDetailSideColumn>
            <TemplateDetailThemeList
              item={item}
              selectedTheme={selectedTheme}
              onSelect={selectDetailTheme}
            />
          </TemplateDetailSideColumn>
        </div>
      </div>
      <div className={TEMPLATE_DETAIL_FOOTER}>
        <Button
          type="button"
          size="lg"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            {
              title: item.title,
            },
          )}
          onClick={() => {
            setTheme(item.slug, selectedTheme.id);
            onSelect(item, presentationTemplateColorSystemId(selectedTheme.id));
          }}
        >
          {t(($) => {
            return $.artifacts.templates.useThisTemplate;
          })}
        </Button>
      </div>
    </>
  );
}

function TemplateDetailStage({
  title,
  focusRef,
  frameRef,
  activeSlideIndex,
  slideCount,
  lowResolutionImage,
  highResolutionImage,
  documents,
  onChange,
  onKeyDown,
}: {
  readonly title: string;
  readonly focusRef: RefCallback<HTMLDivElement>;
  readonly frameRef: RefCallback<HTMLIFrameElement>;
  readonly activeSlideIndex: number;
  readonly slideCount: number;
  readonly lowResolutionImage: string;
  readonly highResolutionImage: string;
  readonly documents:
    readonly { readonly id: string; readonly html: string }[] | null;
  readonly onChange: (index: number) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={focusRef}
      role="group"
      aria-label={t(
        ($) => {
          return $.artifacts.templates.slidePreview;
        },
        { title },
      )}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={TEMPLATE_DETAIL_STAGE}
    >
      <ProgressiveTemplatePreviewImage
        alt=""
        className="pointer-events-none absolute inset-0 z-20 h-full w-full object-cover"
        dataTestId={`${title} detail image preview`}
        fetchPriority="high"
        highResolutionUrl={highResolutionImage}
        loading="eager"
        lowResolutionUrl={lowResolutionImage}
      />
      {/* Every slide stays loaded on the stage and only the active one shows,
          so stepping through slides swaps frames that are already painted
          rather than loading a new one over the default-theme image. */}
      {documents?.map((slideDocument, slideIndex) => {
        const active = slideIndex === activeSlideIndex;
        return (
          <PresentationTemplateHtmlFrame
            key={slideDocument.id}
            html={slideDocument.html}
            frameRef={frameRef}
            title={
              active
                ? t(
                    ($) => {
                      return $.artifacts.templates.htmlPreview;
                    },
                    { title },
                  )
                : t(
                    ($) => {
                      return $.artifacts.templates.slideThumbnail;
                    },
                    { title, slideNumber: slideIndex + 1 },
                  )
            }
            dataTestId={active ? `${title} detail HTML preview` : undefined}
            className={cn("z-40", !active && "invisible")}
          />
        );
      })}
      <TemplateDetailStageControls
        activeSlideIndex={activeSlideIndex}
        slideCount={slideCount}
        onChange={onChange}
      />
    </div>
  );
}

// A theme reads as a small page: its ground, one line of its ink, and its
// accent dots. Light and dark grounds separate at a glance, which a split
// square of ground and accent could not show when 13 of 16 grounds are white.
function PresentationTemplateThemeSwatch({
  item,
  theme,
}: {
  readonly item: PresentationTemplateItem;
  readonly theme: PresentationTemplateThemeOption;
}) {
  const accents =
    theme.group === "multi-accent"
      ? presentationTemplateThemePreviewSwatches(theme).slice(1)
      : [presentationTemplateAccentSwatchColor(item, theme)];
  return (
    <span
      aria-hidden
      className="flex h-5 w-8 shrink-0 flex-col justify-between rounded p-1 ring-1 ring-inset ring-black/10"
      style={{ backgroundColor: theme.colors[0] }}
    >
      <span
        className="block h-0.5 w-1/2 rounded-full"
        style={{ backgroundColor: theme.colors[2] }}
      />
      <span className="flex gap-0.5">
        {accents.map((accent) => {
          return (
            <span
              key={accent.id}
              className="size-1.5 rounded-full"
              style={{ backgroundColor: accent.color }}
            />
          );
        })}
      </span>
    </span>
  );
}

function TemplateDetailThemeOptions({
  item,
  label,
  themes,
  selectedTheme,
  onSelect,
}: {
  readonly item: PresentationTemplateItem;
  readonly label: string;
  readonly themes: readonly PresentationTemplateTheme[];
  readonly selectedTheme: PresentationTemplateTheme;
  readonly onSelect: (theme: PresentationTemplateThemeOption) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="px-2 pb-1 pt-1 text-xs text-muted-foreground">{label}</p>
      <div className="grid grid-cols-2 gap-x-1 lg:grid-cols-1">
        {themes.map((theme) => {
          const active = theme.id === selectedTheme.id;
          const name = presentationTemplateThemeName(theme);
          return (
            <button
              key={theme.id}
              type="button"
              aria-label={t(
                ($) => {
                  return $.artifacts.templates.selectStyle;
                },
                { style: name },
              )}
              aria-pressed={active}
              onClick={() => {
                onSelect(theme);
              }}
              className={cn(
                "flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active
                  ? "bg-state-selected hover:bg-state-selected-hover"
                  : "hover:bg-state-hover",
              )}
            >
              <PresentationTemplateThemeSwatch item={item} theme={theme} />
              <span className="min-w-0 truncate">{name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TemplateDetailThemeList({
  item,
  selectedTheme,
  onSelect,
}: {
  readonly item: PresentationTemplateItem;
  readonly selectedTheme: PresentationTemplateTheme;
  readonly onSelect: (theme: PresentationTemplateThemeOption) => void;
}) {
  const { t } = useTranslation();
  const groups = [
    {
      group: "multi-accent",
      label: t(($) => {
        return $.artifacts.templates.multiAccent;
      }),
    },
    {
      group: "single-accent",
      label: t(($) => {
        return $.artifacts.templates.singleAccent;
      }),
    },
  ] as const;
  return (
    <>
      <p className="px-2 text-sm font-medium text-foreground">
        {t(($) => {
          return $.artifacts.templates.theme;
        })}
      </p>
      <ScrollArea.Root className="group relative mt-2 min-h-0 flex-1">
        <ScrollArea.Viewport
          data-slot="scroll-area-viewport"
          className={cn(
            "h-full focus-visible:outline-none",
            SCROLL_FADE_Y_WHEN_OVERFLOWING,
          )}
        >
          <ScrollArea.Content className="flex flex-col gap-2 pb-1">
            {groups.map(({ group, label }) => {
              return (
                <TemplateDetailThemeOptions
                  key={group}
                  item={item}
                  label={label}
                  themes={PRESENTATION_TEMPLATE_THEME_OPTIONS.filter(
                    (theme) => {
                      return theme.group === group;
                    },
                  )}
                  selectedTheme={selectedTheme}
                  onSelect={onSelect}
                />
              );
            })}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollBar />
      </ScrollArea.Root>
    </>
  );
}

/**
 * Hands the chosen file to the composer, which attaches it, sends it, and
 * navigates into the new thread. Importing is the ordinary chat path with the
 * message written for the user, not a separate upload flow.
 *
 * The import owns the root signal, like the ordinary send and upload controls:
 * from the new-thread composer it outlives the page it started on. A page
 * signal is aborted by the very navigation this send performs, which would kill
 * the in-flight thread create and the run that follows it, leaving a thread the
 * user can see but the server never recorded.
 */
export function TemplateImportCard({
  signals,
  onImported,
  kind = "presentation",
}: {
  signals: ComposerSignals;
  onImported: () => void;
  kind?: UserTemplateKind;
}) {
  const { t } = useTranslation();
  const rootSignal = useGet(rootSignal$);
  const importTemplate = useSet(importPresentationTemplateDeck$);
  const labels = {
    presentation: t(($) => {
      return $.artifacts.templates.importDeck;
    }),
    document: t(($) => {
      return $.artifacts.templates.importDocument;
    }),
    illustration: t(($) => {
      return $.artifacts.templates.importImage;
    }),
  };
  const hints = {
    presentation: t(($) => {
      return $.artifacts.templates.importDeckHint;
    }),
    document: t(($) => {
      return $.artifacts.templates.importDocumentHint;
    }),
    illustration: t(($) => {
      return $.artifacts.templates.importImageHint;
    }),
  };
  const accepts = {
    presentation: PRESENTATION_TEMPLATE_IMPORT_ACCEPT,
    document: DOCUMENT_TEMPLATE_IMPORT_ACCEPT,
    illustration: IMAGE_TEMPLATE_IMPORT_ACCEPT,
  };
  const label = labels[kind];
  const ratio =
    kind === "illustration"
      ? "aspect-[4/5]"
      : kind === "document"
        ? "aspect-[4/3]"
        : "aspect-video";
  const input = (
    <input
      type="file"
      className="sr-only"
      accept={accepts[kind]}
      aria-label={label}
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        // Clear the input so choosing the same file again still fires.
        event.currentTarget.value = "";
        if (!file) {
          return;
        }
        onImported();
        detach(
          importTemplate({ signals, file }, rootSignal),
          Reason.DomCallback,
        );
      }}
    />
  );
  return (
    <label
      data-presentation-template-import={
        kind === "presentation" ? "" : undefined
      }
      className={cn(
        TEMPLATE_CARD,
        "ring-offset-background has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
      )}
    >
      <TemplateCardFace title={label} ratio={ratio} className="bg-muted/40">
        <span className="flex flex-col items-center justify-center gap-1.5 px-2 text-muted-foreground transition-colors duration-150 group-hover/tile:text-foreground">
          <Plus className="size-8" strokeWidth={1.5} aria-hidden />
          <span className="max-w-full truncate text-xs">{hints[kind]}</span>
        </span>
      </TemplateCardFace>
      {input}
    </label>
  );
}

function ComposerPresentationSuggestion({
  title,
  children,
  onSelect,
  onPreview,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly onPreview: () => void;
}) {
  return (
    <ComposerTemplateSuggestion title={title} onPreview={onPreview}>
      <TemplateCard title={title} ratio="aspect-video" onSelect={onSelect}>
        {children}
      </TemplateCard>
    </ComposerTemplateSuggestion>
  );
}

export function ComposerPresentationRecommendations({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selection = useComposerTemplateSelection(signals);
  const custom = useCustomTemplateRecommendations(signals, "presentation");
  const builtIn = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  const previewRecommendation = useSet(signals.template.previewRecommendation$);
  const presentationSelection =
    usePresentationTemplatePreviewSelection(signals);
  const setMode = useSet(signals.create.setMode$);
  const label = t(($) => {
    return $.chat.taskChips.presentationTemplates;
  });
  // The import tile leads the rail so members can start with their own deck.
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <ComposerRail
        rail="templates:presentation"
        itemWidth={200}
        items={[
          <TemplateImportCard
            key="import"
            signals={signals}
            onImported={() => {
              setMode(null);
            }}
          />,
          ...custom.map((template) => {
            return (
              <ComposerPresentationSuggestion
                key={template.id}
                title={template.title}
                onPreview={() => {
                  previewRecommendation({
                    type: "custom",
                    templateId: template.id,
                    kind: "presentation",
                  });
                }}
                onSelect={() => {
                  selection.onChange({
                    type: "custom",
                    selection: { userTemplateId: template.id },
                  });
                }}
              >
                {template.coverUrl ? (
                  <img
                    src={template.coverUrl}
                    alt=""
                    loading="lazy"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <ImageIcon size={24} aria-hidden />
                  </span>
                )}
              </ComposerPresentationSuggestion>
            );
          }),
          ...builtIn.map((item) => {
            return (
              <ComposerPresentationSuggestion
                key={item.slug}
                title={item.title}
                onPreview={() => {
                  previewRecommendation({
                    type: "presentation",
                    selection: presentationSelection(item),
                  });
                }}
                onSelect={() => {
                  selection.onChange(toPresentationGenerationTemplate(item));
                }}
              >
                <img
                  src={presentationTemplateCoverImage(item)}
                  alt=""
                  loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              </ComposerPresentationSuggestion>
            );
          }),
        ]}
      />
    </div>
  );
}

function BuiltInTemplatePreviewDialog({
  signals,
  onChange,
}: {
  readonly signals: ComposerSignals;
  readonly onChange: (value: GenerationTemplateRequest) => void;
}) {
  const { t } = useTranslation();
  const open = useGet(signals.template.templatePreviewOpen$);
  const close = useSet(signals.template.closeTemplatePreview$);
  const completeClose = useSet(signals.template.completeTemplatePreviewClose$);
  const finalFocus = useSet(signals.template.templatePreviewFinalFocus$);
  const previewSlug = useGet(signals.template.openedTemplateId$);
  const previewItem = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return item.slug === previewSlug;
  });
  const documentPreview = useGet(signals.template.documentPreview$);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          completeClose();
        }
      }}
    >
      <DialogContent
        finalFocus={finalFocus}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth="6xl"
        height={760}
        contentClassName="flex flex-col gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        {documentPreview ? (
          <DocumentTemplatePreviewPage
            signals={signals}
            item={documentPreview}
            onBack={close}
            onSelect={(item) => {
              onChange(toDocumentGenerationTemplate(item));
            }}
          />
        ) : previewItem ? (
          <TemplatePreviewPage
            item={previewItem}
            onSelect={(item, colorSystemId) => {
              onChange(toPresentationGenerationTemplate(item, colorSystemId));
            }}
            signals={signals}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function usePresentationTemplatePreviewSelection(signals: ComposerSignals) {
  const themeIdBySlug = useGet(
    signals.template.presentationTemplateThemeIdBySlug$,
  );
  return (item: PresentationTemplateItem, slideIndex = 0) => {
    const selectedTheme = findPresentationTemplateTheme(
      themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
    );
    return {
      index: Math.max(0, Math.floor(slideIndex)),
      item,
      themeCss: presentationTemplateThemeCss(selectedTheme),
      themeId: selectedTheme.id,
    };
  };
}

function selectedComposerTemplateAttachment(
  value: GenerationTemplateRequest | undefined,
): ComposerTemplateAttachment | undefined {
  if (value?.type === "document") {
    const item = findDocumentTemplateItem(value.selection.documentTemplateId);
    return item
      ? { type: "document", title: item.title, category: "document" }
      : undefined;
  }
  const presentationItem =
    value?.type === "presentation"
      ? PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
          return item.templateId === value.selection.templateId;
        })
      : undefined;
  if (presentationItem && value?.type === "presentation") {
    const selectedTheme = findPresentationTemplateTheme(
      value.selection.colorSystemId?.replace("color-system:", "") ??
        defaultPresentationTemplateThemeId(presentationItem),
    );
    return {
      type: "presentation",
      title: presentationItem.title,
      category: "slides",
      previewImageUrl: presentationTemplateCoverImage(
        presentationItem,
        selectedTheme,
        SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
      ),
    };
  }
  return undefined;
}

/** Only the selected detail mounts; it owns focus and its exit completion. */
function ComposerTemplatePreviewSlot({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const mounted = useGet(signals.template.templatePreviewMounted$);
  const kind = useGet(signals.template.templatePreviewKind$);
  const close = useSet(signals.template.closeTemplatePreview$);
  const setFinalFocus = useSet(signals.template.setTemplatePreviewFinalFocus$);
  const selection = useComposerTemplateSelection(signals);
  const select = (value: GenerationTemplateRequest) => {
    // The dialog restores focus after its exit animation, later than insertion.
    setFinalFocus(signals.editor.editor.view.dom);
    selection.onChange(value);
    close();
  };
  if (!mounted) {
    return null;
  }
  if (kind === "custom") {
    return (
      <CustomTemplatePreviewSlot
        signals={signals}
        onSelect={(template) => {
          select({
            type: "custom",
            selection: { userTemplateId: template.id },
          });
        }}
      />
    );
  }
  if (kind === "website") {
    return <WebsiteTemplatePreviewDialogSlot signals={signals} />;
  }
  return <BuiltInTemplatePreviewDialog signals={signals} onChange={select} />;
}

function ComposerCloudBrowserToggle({
  computerUse,
}: {
  readonly computerUse: ComposerComputerUse;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover">
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
      <span className="flex shrink-0 items-center">
        <LoadingSwitch
          checked={computerUse.cloudBrowserEnabled}
          disabled={!computerUse.cloudBrowserAvailable}
          onCheckedChange={onDomEventFn((enabled) => {
            computerUse.onCloudBrowserChange(enabled);
          })}
          loading={computerUse.cloudBrowserLoading}
          size="sm"
        />
      </span>
    </label>
  );
}

function ComputerUseConnectorMenuSection({
  computerUse,
  onOpenDownloadDialog,
  remoteAccess,
}: {
  computerUse: ComposerComputerUse;
  onOpenDownloadDialog: () => void;
  remoteAccess?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-t border-border/50 bg-gray-50 p-1 dark:bg-gray-100">
      <ComposerCloudBrowserToggle computerUse={computerUse} />
      {remoteAccess}
      <div className="mx-2 my-1 border-t border-border/50" />
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.computerUse.yourComputer;
        })}
      </div>
      {computerUse.failed ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 p-2 text-sm text-destructive"
        >
          <span>
            {t(($) => {
              return $.chat.remoteAccess.loadFailed;
            })}
          </span>
        </div>
      ) : computerUse.loading ? (
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
              <label
                key={host.id}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover"
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
                <span className="flex shrink-0 items-center">
                  <LoadingSwitch
                    checked={checked}
                    onCheckedChange={onDomEventFn((nextChecked) => {
                      computerUse.onChange(nextChecked ? host.id : null);
                    })}
                    loading={false}
                    size="sm"
                  />
                </span>
              </label>
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
      <PopoverClose
        render={
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
        }
      />
    </div>
  );
}

function ComposerRemoteAccessMenu({
  signals,
  computerUse,
  onOpenDownloadDialog,
}: {
  signals: ComposerSignals;
  computerUse: ComposerComputerUse | undefined;
  onOpenDownloadDialog: () => void;
}) {
  const openRemoteAccessDialog = useSet(
    signals.connector.openRemoteAccessDialog$,
  );
  const remoteAccess = (
    <ThreadRemoteAccessSection
      threadId={signals.threadId}
      remoteAccess$={signals.remoteAccess$}
      defaults$={signals.connector.resources.remoteHostDefaults$}
      pendingRemoteAccess={signals.pendingRemoteAccess}
      onOpen={openRemoteAccessDialog}
    />
  );
  return (
    <>
      {computerUse ? (
        <ComputerUseConnectorMenuSection
          computerUse={computerUse}
          onOpenDownloadDialog={onOpenDownloadDialog}
          remoteAccess={remoteAccess}
        />
      ) : (
        remoteAccess
      )}
      <PhoneUseConnectorMenuSection signals={signals.connector} />
    </>
  );
}

/**
 * The composer's connector entry. The trigger is a static mark so the composer
 * waits until the popover is open to load the Chat's connector access.
 */
function ConnectorsPopoverButton({
  signals,
  onOpenAddDialog,
}: {
  signals: ComposerSignals;
  onOpenAddDialog: () => void;
}) {
  const { t } = useTranslation();
  const deviceMode = useLastResolved(remoteDevicesEnabled$) === true;
  const session = useGet(authenticatedSessionKey$);
  const popoverOpen = useGet(signals.connector.popoverOpen$);
  const setPopoverOpen = useSet(signals.connector.setPopoverOpen$);
  const setTriggerRef = useSet(signals.connector.setTriggerRef$);
  const phoneUseSetupOpen = useGet(signals.connector.phoneUseSetupOpen$);
  const downloadDialogOpen = useGet(
    signals.computer.computerUseDownloadDialogOpen$,
  );
  const setDownloadDialogOpen = useSet(
    signals.computer.setComputerUseDownloadDialogOpen$,
  );
  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <TooltipProvider delay={300}>
        <Tooltip>
          <PopoverTrigger
            ref={setTriggerRef}
            render={
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="quiet"
                    size="icon-sm"
                    iconSize="md"
                    className="shrink-0"
                    aria-label={t(($) => {
                      return $.chat.connectors.title;
                    })}
                  >
                    <Plug size={18} />
                  </Button>
                }
              />
            }
          />
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
        positionerClassName={
          deviceMode
            ? "max-sm:inset-x-2! max-sm:top-auto! max-sm:bottom-[max(.5rem,var(--okou-safe-b,0px),var(--okou-keyboard-scroll-reserve,0px))]! max-sm:transform-none!"
            : undefined
        }
        className={cn(
          "flex max-h-[var(--available-height)] w-72 flex-col overflow-hidden p-0",
          deviceMode &&
            "h-96 w-80 max-w-[var(--available-width)] max-sm:max-h-[calc(100dvh-.5rem-max(.5rem,var(--okou-safe-b,0px),var(--okou-keyboard-scroll-reserve,0px)))] max-sm:w-full max-sm:max-w-none",
        )}
      >
        {popoverOpen && (
          <ChatConnectorsPopoverBody
            key={session}
            deviceMode={deviceMode}
            signals={signals}
            onOpenAddDialog={onOpenAddDialog}
            onOpenDownloadDialog={() => {
              setDownloadDialogOpen(true);
            }}
          />
        )}
      </PopoverContent>
      {downloadDialogOpen && (
        <ComputerUseDownloadDialog
          downloadUrl={OKOU_DESKTOP_DOWNLOAD_URL}
          open={downloadDialogOpen}
          onOpenChange={setDownloadDialogOpen}
        />
      )}
      {phoneUseSetupOpen && <PhoneUseSetupDialog signals={signals.connector} />}
    </Popover>
  );
}

function ChatConnectorsPopoverBody({
  signals,
  deviceMode,
  onOpenAddDialog,
  onOpenDownloadDialog,
}: {
  signals: ComposerSignals;
  deviceMode: boolean;
  onOpenAddDialog: () => void;
  onOpenDownloadDialog: () => void;
}) {
  const computerUse = useComposerComputerUse(signals);
  if (deviceMode) {
    return (
      <ComposerRemoteDevicesMenu
        signals={signals}
        cloudBrowser={
          computerUse && (
            <ComposerCloudBrowserToggle computerUse={computerUse} />
          )
        }
        onOpenAddDialog={onOpenAddDialog}
      />
    );
  }
  return (
    <ChatConnectorMenu
      signals={signals}
      onOpenAddDialog={onOpenAddDialog}
      footer={
        <ComposerRemoteAccessMenu
          signals={signals}
          computerUse={computerUse}
          onOpenDownloadDialog={onOpenDownloadDialog}
        />
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Voice input mic button
// ---------------------------------------------------------------------------

interface MicButtonStatus {
  readonly starting: boolean;
  readonly quotaLoading: boolean;
}

function micButtonAriaLabel(status: MicButtonStatus): string {
  if (status.starting) {
    return i18n.t(($) => {
      return $.chat.voice.starting;
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
  if (status.starting) {
    return i18n.t(($) => {
      return $.chat.voice.openingMicrophone;
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

function MicButton({ signals }: { signals: ComposerSignals }) {
  const available = useGet(audioInputAvailable$);
  const quotaState = useLoadableState(composerVoiceQuota$);
  const quotaResolved = useLastResolved(composerVoiceQuota$) !== undefined;
  // The last resolved status keeps this control stable while a composer
  // target reads its stored draft; run$ awaits that read before acting.
  const voiceDraftStatus = useLastResolved(signals.voice.state$)?.status;
  const [operation, runVoice] = useLoadableSet(signals.voice.run$);
  const starting = operation.state === "loading";

  const signal = useGet(pageSignal$);
  const draftLoading = voiceDraftStatus === undefined;
  const actionDisabled = starting || !quotaResolved;
  const status = {
    starting,
    quotaLoading: quotaState === "loading" && !quotaResolved,
  };

  if (!available) {
    return null;
  }

  const handleClick = () => {
    detach(runVoice("toggle", signal), Reason.DomCallback);
  };

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
              className={cn("relative shrink-0", {
                // Background draft checks should not dim the mic on thread switches.
                "disabled:opacity-100": draftLoading && !actionDisabled,
                "bg-[#2E9E9F] text-white hover:bg-[#279394] hover:text-white":
                  starting,
              })}
              data-composer-voice-toggle
              onClick={handleClick}
              disabled={actionDisabled || draftLoading}
              aria-label={micButtonAriaLabel(status)}
              aria-busy={starting}
              aria-keyshortcuts={COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS}
            >
              {starting ? (
                <span
                  className="block size-[17px] rounded-full border-2 border-[rgb(255_255_255_/_0.35)] border-t-[#ffffff] pointer-events-none [transform:rotate(0deg)_translateZ(0)] origin-center [backface-visibility:hidden] [will-change:transform] animate-mic-starting-spin"
                  aria-hidden="true"
                />
              ) : (
                <Mic size={18} />
              )}
            </Button>
          }
        />
        <TooltipContent
          role="tooltip"
          side="top"
          className="flex flex-col items-center gap-1 py-1.5"
        >
          <span>{micButtonTooltip(status)}</span>
          <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
            {getShortcutLabel(COMPOSER_VOICE_INPUT_SHORTCUT)}
          </kbd>
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

function VoiceDraftActionButtons({
  voiceDisabled,
  textDisabled,
  onVoice,
  onText,
}: {
  voiceDisabled: boolean;
  textDisabled: boolean;
  onVoice: () => void;
  onText: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={300}>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 bg-background"
                disabled={voiceDisabled}
                onClick={onVoice}
              >
                <AudioLines size={14} aria-hidden="true" />
                <span>
                  {t(($) => {
                    return $.chat.voice.voiceOption;
                  })}
                </span>
              </Button>
            }
          />
          <TooltipContent role="tooltip" side="top">
            {t(($) => {
              return $.chat.voice.insertVoiceRecording;
            })}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="default"
                size="sm"
                className="shrink-0 gap-1.5"
                data-composer-voice-toggle
                aria-keyshortcuts={COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS}
                disabled={textDisabled}
                onClick={onText}
              >
                <Check size={14} aria-hidden="true" />
                <span>
                  {t(($) => {
                    return $.chat.voice.textOption;
                  })}
                </span>
              </Button>
            }
          />
          <TooltipContent
            role="tooltip"
            side="top"
            className="flex flex-col items-center gap-1 py-1.5"
          >
            <span>
              {t(($) => {
                return $.chat.voice.transcribeToText;
              })}
            </span>
            <kbd className="whitespace-nowrap font-sans text-xs opacity-70">
              {getShortcutLabel(COMPOSER_VOICE_INPUT_SHORTCUT)}
            </kbd>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function VoiceDraftRecordedTray({
  recordingAvailable,
  voiceMessagesEnabled,
  voiceMessage,
  textActionFailed,
  onDiscard,
  onFinishVoice,
  onFinishText,
  onFinishDefault,
}: {
  recordingAvailable: boolean;
  voiceMessagesEnabled: boolean;
  voiceMessage: string | undefined;
  textActionFailed: boolean;
  onDiscard: () => void;
  onFinishVoice: () => void;
  onFinishText: () => void;
  onFinishDefault: () => void;
}) {
  const { t } = useTranslation();
  const textDisabled =
    !recordingAvailable || textActionFailed || voiceMessage !== undefined;
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
                return $.chat.voice.recordingSaved;
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
          onClick={onDiscard}
        >
          <Trash2 size={16} />
        </Button>
      )}
      {voiceMessagesEnabled ? (
        <VoiceDraftActionButtons
          voiceDisabled={!recordingAvailable}
          textDisabled={textDisabled}
          onVoice={onFinishVoice}
          onText={onFinishText}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-w-14 shrink-0 bg-background"
          data-composer-voice-toggle
          disabled={textDisabled}
          onClick={onFinishDefault}
        >
          {t(($) => {
            return $.chat.voice.useRecording;
          })}
        </Button>
      )}
    </div>
  );
}

function VoiceDraftProcessingTray({
  isDiscarding,
  isUploading,
}: {
  isDiscarding: boolean;
  isUploading: boolean;
}) {
  const { t } = useTranslation();
  const statusText = isDiscarding
    ? t(($) => {
        return $.chat.voice.discarding;
      })
    : isUploading
      ? t(($) => {
          return $.chat.voice.uploadingRecording;
        })
      : t(($) => {
          return $.chat.voice.transcribing;
        });
  const outcomeText =
    isDiscarding || isUploading
      ? null
      : t(($) => {
          return $.chat.voice.textTakingShape;
        });
  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 text-sm",
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
      {outcomeText ? (
        <span className="min-w-0 shrink-0 truncate text-right text-xs text-muted-foreground">
          {outcomeText}
        </span>
      ) : null}
    </div>
  );
}

function VoiceDraftFooter({
  signals,
  status: draftStatus,
  recordingAvailable,
  voiceMessage,
  children,
}: {
  signals: ComposerSignals;
  status: ComposerVoiceInputStatus | undefined;
  recordingAvailable: boolean;
  voiceMessage: string | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.voice.capture$);
  const pendingAction = useGet(signals.voice.pendingAction$);
  const voiceMessagesEnabled =
    useLastResolved(composerVoiceMessagesEnabled$) ?? false;
  const recording = capture !== null;
  const [operation, runVoice] = useLoadableSet(signals.voice.run$);
  const status = operation.state === "loading" ? "transcribing" : draftStatus;
  const recordingStartedAt = capture?.startedAt ?? null;

  const voiceLevelSamples = useGet(signals.voice.voiceLevelSamples$);
  const signal = useGet(pageSignal$);

  if (status === undefined || status === "idle") {
    return children;
  }
  if (status === "recorded" || status === "failed") {
    return (
      <VoiceDraftRecordedTray
        recordingAvailable={recordingAvailable}
        voiceMessagesEnabled={voiceMessagesEnabled}
        voiceMessage={voiceMessage}
        textActionFailed={
          operation.state === "hasError" && pendingAction === "transcribing"
        }
        onDiscard={() => {
          detach(runVoice("discard", signal), Reason.DomCallback);
        }}
        onFinishVoice={() => {
          detach(runVoice("finish-voice", signal), Reason.DomCallback);
        }}
        onFinishText={() => {
          detach(runVoice("finish-text", signal), Reason.DomCallback);
        }}
        onFinishDefault={() => {
          detach(runVoice("finish", signal), Reason.DomCallback);
        }}
      />
    );
  }

  if (status !== "recording") {
    return (
      <VoiceDraftProcessingTray
        isDiscarding={status === "discarding" || pendingAction === "discarding"}
        isUploading={pendingAction === "uploading"}
      />
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
      {voiceMessagesEnabled ? (
        <VoiceDraftActionButtons
          voiceDisabled={!recording}
          textDisabled={!recording}
          onVoice={() => {
            detach(runVoice("finish-voice", signal), Reason.DomCallback);
          }}
          onText={() => {
            detach(runVoice("finish-text", signal), Reason.DomCallback);
          }}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto min-w-14 shrink-0 bg-background"
          aria-label={stopRecordingLabel}
          data-composer-voice-toggle
          aria-keyshortcuts={COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS}
          disabled={!recording}
          onClick={() => {
            detach(runVoice("toggle", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.voice.confirmRecording;
          })}
        </Button>
      )}
    </div>
  );
}

/** Attachments, home capabilities and skill imports share the add menu. */
function useComposerAddMenuGroups(
  signals: ComposerSignals,
): readonly ComposerAddMenuGroup[] {
  const { t } = useTranslation();
  const fileInput = useGet(signals.draft.composerFileInput$);
  const openSkillImportDialog = useSet(openSkillImportDialog$);
  const project = useComposerProjectMenuItem(signals);
  const capabilities = useComposerCapabilities(signals);
  const capabilityItem = (capability: (typeof capabilities)[number]) => {
    return {
      ...capability,
      onSelect: () => {
        capability.run();
        // The capability panel keeps the draft's caret, not the menu trigger.
        return false as const;
      },
    };
  };
  return [
    [
      {
        id: "attach",
        Icon: Paperclip,
        label: t(($) => {
          return $.chat.attachments.attach;
        }),
        onSelect: () => {
          fileInput?.showPicker();
        },
      },
      ...(project ? [project] : []),
    ],
    [
      capabilityItem(capabilities[0]),
      ...capabilities.slice(1).map(capabilityItem),
    ],
    [
      {
        id: "import-skills",
        Icon: Download,
        label: t(($) => {
          return $.workflows.skillImport.action;
        }),
        onSelect: () => {
          openSkillImportDialog();
        },
      },
    ],
  ];
}

function ComposerAddMenuSlot({ signals }: { signals: ComposerSignals }) {
  const groups = useComposerAddMenuGroups(signals);
  return (
    <>
      <ComposerAddMenu signals={signals.addMenu} groups={groups} />
      {/* Menu.Item owns keyboard activation through showPicker(). Keep its
          input outside the popup so selection survives the menu closing. */}
      <ComposerFileInput signals={signals} />
    </>
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
    // Restoration owns persistence once availability and annotated copies have
    // settled. Do not race it with a save of the temporary placeholders.
    restoreAttachments(persistedAttachments);
  } else {
    onDraftChange?.();
  }
  return true;
}

function useComposerDraftChange(signals: ComposerSignals): () => void {
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return () => {
    detach(saveDraft(pageSignal), Reason.DomCallback);
  };
}

function useComposerTemplateSelection(
  signals: ComposerSignals,
): ComposerTemplateSelection {
  const selectTemplateAndSave = useSet(signals.template.selectTemplateAndSave$);
  const pageSignal = useGet(pageSignal$);
  return {
    onChange(value) {
      // Chip presentation is pure; catalog resolution, insertion, task
      // selection and persistence are one page-owned business action.
      detach(
        selectTemplateAndSave(
          value,
          selectedComposerTemplateAttachment(value),
          pageSignal,
        ),
        Reason.DomCallback,
      );
    },
  };
}

function useComposerFileUpload(
  signals: ComposerSignals,
): (file: File) => boolean {
  const uploadAttachment = useSet(signals.draft.uploadAttachment$);
  const rootSignal = useGet(rootSignal$);
  const { t } = useTranslation();
  return (file) => {
    if (file.size > MAX_ATTACHMENT_UPLOAD_BYTES) {
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
  { singleLineOnMobile, forwardComposer }: ComposerSignals["editor"],
  hasTemplateAttachment: boolean,
  layout: ComposerLayout,
): ComposerLayoutHeightClassNames {
  // The start page defaults to the compact shell at every width. Most first
  // messages are a line or two, and a field several lines deep reads as a
  // demand for a long message rather than an invitation. The page centres the
  // composer, so every pixel of empty field is also taken from the room the
  // slash and mention menus open into. The input still grows with the draft.
  // The forward dialog shares these signals and is not that page, so it keeps
  // the dialog's shell. The capability home keeps the compact shell for the
  // same reason, including when it fronts an empty chat, whose thread signals
  // would otherwise take the conversation's responsive shell.
  const home = layout === "home";
  const responsive = !home && singleLineOnMobile;
  const startPage = home || (!responsive && !forwardComposer);
  if (hasTemplateAttachment) {
    return responsive
      ? {
          input: "min-h-[86px] composer-wide:min-h-[114px]",
          shell: "min-h-[158px] composer-wide:min-h-[186px]",
        }
      : startPage
        ? {
            input: "min-h-[86px]",
            shell: "min-h-[158px]",
          }
        : {
            input: "min-h-[114px]",
            shell: "min-h-[186px]",
          };
  }
  return responsive
    ? {
        input: "min-h-12 composer-wide:min-h-[76px]",
        shell: "min-h-[120px] composer-wide:min-h-[148px]",
      }
    : startPage
      ? {
          input: "min-h-12",
          shell: "min-h-[120px]",
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
  const notifyDraftChanged = useComposerDraftChange(signals);
  const restoreAttachments = useSet(signals.draft.restorePastedAttachments$);
  const pageSignal = useGet(pageSignal$);
  const focusEditor = useSet(signals.editor.focus$);
  const insertPromptMarkdown = useSet(signals.editor.insertPromptMarkdown$);
  const insertUserMessage = useSet(signals.editor.insertUserMessage$);
  const pastedTextFile = useSet(pastedTextFile$);
  const uploadFile = useComposerFileUpload(signals);
  const handlePaste = (event: ComposerPasteEvent) => {
    if (
      restoreChatClipboardPayload({
        event,
        insertPromptMarkdown,
        insertUserMessage,
        restoreAttachments: (attachments) => {
          detach(
            restoreAttachments(attachments, pageSignal),
            Reason.DomCallback,
          );
        },
        onDraftChange: notifyDraftChanged,
      })
    ) {
      return;
    }
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      return;
    }
    const items = Array.from(clipboardData.items);
    const plainText =
      clipboardData.getData("text/plain") || clipboardData.getData("text");
    const textFile = pastedTextFile(
      plainText,
      items.some((item) => {
        return item.kind === "file";
      }) || clipboardData.files.length > 0,
    );
    if (textFile && uploadFile(textFile)) {
      // The attachment owns this paste; leave the editor and its selection intact.
      event.preventDefault();
      notifyDraftChanged();
      return;
    }
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

  return (
    <div
      className={cn("min-h-0 flex-1", minimumHeightClassName)}
      data-slot="chat-composer-input"
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
        actions={actions}
        onPaste={handlePaste}
      />
    </div>
  );
}

// Stop while an empty composer is mid-run; otherwise Send.
function ComposerSendButton({
  action,
  onActivate,
  sendRef,
}: {
  action: ComposerPrimaryAction;
  onActivate: () => void;
  sendRef: RefCallback<HTMLButtonElement>;
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
      ref={sendRef}
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
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex">{button}</span>}
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
  const setSendAnchor = useSet(
    signals.submission.presentationFormatSetup.setAnchor$,
  );
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
  return (
    <>
      <ComposerSendButton
        action={action}
        onActivate={activate}
        sendRef={setSendAnchor}
      />
      <ComposerPresentationFormatSetup
        signals={signals.submission.presentationFormatSetup}
      />
    </>
  );
}

function ModelConfigurationWarning({
  blocker,
}: {
  blocker: ComposerSubmitBlocker;
}) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={blocker.onAction}
              aria-label={`${blocker.actionLabel}: ${blocker.message}`}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
            >
              <AlertTriangle size={15} />
              <span className="hidden composer-wide:inline">
                {blocker.actionLabel}
              </span>
            </button>
          }
        />
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

// One quiet trigger for the model. It carries no fill of its own -- the
// composer's control row is a row of quiet controls.
function composerModelPickerTriggerClassName(): string {
  return cn(
    "h-8 w-8 max-w-none justify-center gap-0 overflow-hidden border-transparent bg-transparent px-0 text-sm text-muted-foreground transition-colors composer-wide:w-auto composer-wide:max-w-[14rem] composer-wide:justify-start composer-wide:gap-1 composer-wide:px-2",
    "[&>[data-slot=select-value]]:flex [&>[data-slot=select-value]]:items-center [&>[data-slot=select-value]]:justify-center composer-wide:[&>[data-slot=select-value]]:justify-start",
    "[&>[data-slot=select-icon]]:hidden composer-wide:[&>[data-slot=select-icon]]:block",
    "hover:bg-state-hover hover:text-foreground data-popup-open:bg-state-hover data-popup-open:text-foreground",
    COMPOSER_CONTROL_FOCUS_CLASS,
  );
}

interface ComposerModelPickerControlsProps {
  signals: ComposerSignals;
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
}

/**
 * The composer chooses only the chat model and how it runs. Images follow the
 * member's settings, so the panel offers no media model. Effort and Fast live
 * in the same panel.
 */
function ComposerModelPickerControls({
  signals,
  value,
  onChange,
}: ComposerModelPickerControlsProps) {
  const { t } = useTranslation();
  const open = useGet(signals.model.modelPickerOpen$);
  const setOpen = useSet(signals.model.setModelPickerOpen$);
  return (
    <>
      <ComposerModelPanel
        value={value}
        onChange={onChange}
        placeholder={t(($) => {
          return $.chat.composer.selectModel;
        })}
        triggerClassName={composerModelPickerTriggerClassName()}
        open={open}
        onOpenChange={setOpen}
      />
      <ComposerModelSlotDivider />
    </>
  );
}

function ComposerModelSlotDivider() {
  return <div className="mx-0 h-5 w-px bg-divider/60 composer-wide:mx-0.5" />;
}

/** The model slot of a member who can only run Auto; see the menu's note. */
function ComposerSubscriptionLinkingSlot() {
  const available = useSubscriptionLinkingAvailable();
  if (!available) {
    return null;
  }
  return (
    <>
      <SubscriptionLinkingComposerMenu />
      <ComposerModelSlotDivider />
    </>
  );
}

function ComposerModelPickerSlot({ signals }: { signals: ComposerSignals }) {
  const modelSelection = useLastLoadable(signals.model.modelSelection$);
  const selectedModelOauthAvailable =
    useLastResolved(signals.model.selectedModelOauthAvailable$) ?? true;
  const setModelSelection = useSet(signals.model.setModelSelection$);
  const pageSignal = useGet(pageSignal$);
  const models = useLastResolved(availableRunModels$);
  const value = modelSelection.state === "hasData" ? modelSelection.data : null;
  const modelPickerLoading = modelSelection.state === "loading";
  const onModelPickerChange = (selection: ModelProviderSelection | null) => {
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };
  // Auto offers a choice only once a personal subscription adds models.
  const autoOnly =
    models === undefined ||
    models.models.every((runModel) => {
      return runModel.model === null;
    });
  if (models !== undefined && autoOnly) {
    return <ComposerSubscriptionLinkingSlot />;
  }
  if (modelPickerLoading || value === null || autoOnly) {
    return null;
  }

  return (
    <>
      <ComposerModelConfigurationWarning
        signals={signals}
        selection={value}
        oauthAvailable={selectedModelOauthAvailable}
      />
      <ComposerModelPickerControls
        signals={signals}
        value={value}
        onChange={onModelPickerChange}
      />
    </>
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
  onUseForFutureChats: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ComposerNoticeTray role="group" label={label}>
      <span className="min-w-0 max-w-full text-muted-foreground">
        <span>
          {t(($) => {
            return $.chat.composer.temporarilySwitchTo;
          })}
        </span>{" "}
        <span>{model}</span>
      </span>
      {onUseForFutureChats && (
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
      )}
    </ComposerNoticeTray>
  );
}

function runServiceTier(
  selection: ModelProviderSelection | null | undefined,
): "priority" | "ultrafast" | null {
  return selection?.codexServiceTier === "fast"
    ? "priority"
    : (selection?.codexServiceTier ?? null);
}

function ComposerTemporaryModelNotice({
  signals,
}: {
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selection = useLastResolved(signals.model.modelSelection$);
  const models = useLastResolved(availableRunModels$);
  const userPreference = useLastResolved(userModelPreference$);
  const catalog = useLastResolved(modelCatalog$);
  const [updateLoadable, updatePreference] = useLoadableSet(
    updateUserModelPreference$,
  );
  const pageSignal = useGet(pageSignal$);
  const defaultSelection = resolveDefaultModelSelection({
    userPreference,
    models,
    catalog,
  });
  const selectionServiceTier = runServiceTier(selection);
  const defaultServiceTier = runServiceTier(defaultSelection);
  const modelChanged =
    selection?.selectedModel !== defaultSelection?.selectedModel;
  const serviceTierChanged = selectionServiceTier !== defaultServiceTier;
  const effort = preferredChatReasoningEffort(selection, catalog);
  const defaultEffort = preferredChatReasoningEffort(defaultSelection, catalog);
  const effortChanged = effort !== defaultEffort;
  // Compare only against a resolved default; until both sources load the
  // fixed Auto fallback would misreport the member's saved preference.
  if (
    !selection ||
    !defaultSelection ||
    userPreference === undefined ||
    models === undefined ||
    (!modelChanged && !serviceTierChanged && !effortChanged)
  ) {
    return null;
  }
  const updating = updateLoadable.state === "loading";
  const modelName = selectedModelDisplayName(catalog, selection.selectedModel);
  const runSpeedLabel = t(($) => {
    if (selectionServiceTier === "ultrafast") {
      return $.settings.models.picker.ultrafast;
    }
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
    if (updating || selectionServiceTier === "ultrafast") {
      return;
    }
    const { selectedModel } = selection;
    detach(
      updatePreference(
        {
          selectedModel,
          serviceTier: selectionServiceTier,
          ...(effort === undefined || selectedModel === null
            ? {}
            : {
                modelSettingsPatch: {
                  model: selectedModel,
                  effort,
                },
              }),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <ComposerModelScopeCard
      label={t(($) => {
        return $.chat.composer.modelForThisChat;
      })}
      model={scopedModelLabel}
      updating={updating}
      onUseForFutureChats={
        selectionServiceTier === "ultrafast" ? undefined : useForFutureChats
      }
    />
  );
}

function ComposerTemporaryModelNoticeSlot({
  signals,
}: {
  signals: ComposerSignals;
}) {
  if (!signals.model.temporaryModelNoticeEnabled) {
    return null;
  }
  return <ComposerTemporaryModelNotice signals={signals} />;
}

/** The one tray above the card, and the notice that currently owns it. */
function ComposerNoticeSlot({ signals }: { signals: ComposerSignals }) {
  const paidToolHints = useGet(signals.paidToolHints$);
  const imageMode = useGet(signals.create.mode$) === "image";
  const clearTask = useSet(signals.taskChips.selectTask$);
  const onDiscardImage = imageMode
    ? () => {
        clearTask(null);
      }
    : undefined;
  return (
    <ComposerPaidToolNotice
      tools={paidToolHints}
      onDiscardImage={onDiscardImage}
      fallback={<ComposerTemporaryModelNoticeSlot signals={signals} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

function ComposerFileInput({ signals }: { signals: ComposerSignals }) {
  const { t } = useTranslation();
  const setFileInput = useSet(signals.draft.setComposerFileInput$);
  const uploadFile = useComposerFileUpload(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);

  return (
    <input
      ref={setFileInput}
      type="file"
      className="hidden"
      aria-label={t(($) => {
        return $.chat.attachments.attach;
      })}
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
    return null;
  }
  return (
    <AttachmentChips
      attachments={attachments}
      previewHost={signals}
      onRemove={(attachment) => {
        removeAttachment(attachment);
        notifyDraftChanged();
      }}
    />
  );
}

function ComposerConnectorConnectDialogs({
  selectedConnector,
  selectedConnectorAccountOptions,
  selectedCustomConnector,
  selectedCustomConnectorAccountOptions,
  connectHostKey,
  onBuiltinClose,
}: {
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | undefined;
  readonly selectedConnectorAccountOptions: DefaultConnectorAccountMutationOptions | null;
  readonly selectedCustomConnector: CustomConnectorResponse | undefined;
  readonly selectedCustomConnectorAccountOptions: CustomConnectorAccountMutationOptions | null;
  /** The composer's registration as the origin of its connections. */
  readonly connectHostKey: string;
  readonly onBuiltinClose: () => void;
}) {
  return (
    <>
      {selectedConnector && selectedConnectorAccountOptions ? (
        <ConnectModal
          item={selectedConnector}
          accountOptions={selectedConnectorAccountOptions}
          onClose={onBuiltinClose}
          origin={{ kind: "composer", hostKey: connectHostKey }}
        />
      ) : null}
      {selectedCustomConnector && selectedCustomConnectorAccountOptions ? (
        <CustomConnectorConnectDialog
          connector={selectedCustomConnector}
          accountOptions={selectedCustomConnectorAccountOptions}
          origin={{ kind: "composer", hostKey: connectHostKey }}
        />
      ) : null}
    </>
  );
}

function useComposerComputerUse(signals: ComposerSignals): ComposerComputerUse {
  const locale = useGet(locale$);
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
      : lastCloudBrowserEnabled;
  const setComputerUseHostId = useSet(signals.computer.setComputerUseHostId$);
  const setCloudBrowserEnabled = useSet(
    signals.computer.setCloudBrowserEnabled$,
  );
  const computerUseHostsState = useLoadable(
    signals.connector.resources.remotes$,
  );
  const computerUseHosts =
    computerUseHostsState.state === "hasData"
      ? computerUseHostsState.data.computerUseHosts
      : [];
  const resolvedComputerUseHostId = selectedComputerUseHostId(
    computerUseHosts,
    storedComputerUseHostId,
  );
  const composerPageSignal = useGet(pageSignal$);
  return {
    hosts: visibleComputerUseHosts(
      computerUseHosts,
      resolvedComputerUseHostId,
      locale,
    ),
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
    failed: computerUseHostsState.state === "hasError",
    cloudBrowserAvailable:
      computerUseHostsState.state === "hasData" &&
      computerUseHostsState.data.cloudBrowserAvailable,
    cloudBrowserEnabled:
      cloudBrowserEnabled ??
      (computerUseHostsState.state === "hasData" &&
        computerUseHostsState.data.cloudBrowserEnabledByDefault),
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

function composerDirectoryBrowseData(
  browse: PublicConnectorCatalogDiscoveryResponse | null | undefined,
  items: readonly PlatformConnectorCatalogStatusItem[],
) {
  return {
    categoryCounts: browse?.categoryConnectorCounts,
    chipCatalog: browse?.connectors.map(withConnectorCompletion) ?? items,
  };
}

function ComposerConnectorsSlot({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
}) {
  const dialogsOpen = useGet(signals.connector.dialogsOpen$);
  const triggerElement = useGet(signals.connector.triggerElement$);
  const permissions = useGet(signals.connector.chatAccess.permissions$);
  const permissionSignals = useGet(
    signals.connector.chatAccess.permissionSignals$,
  );
  const openAddConnectorsDialog = useSet(
    signals.connector.openAddConnectorsDialog$,
  );
  return (
    <>
      <ConnectorsPopoverButton
        signals={signals}
        onOpenAddDialog={openAddConnectorsDialog}
      />
      <ChatConnectorAccountDialogs signals={signals} />
      {permissions && permissionSignals && (
        <ConnectorPermissionsDialog
          finalFocus={triggerElement}
          entry={permissions}
          signals={permissionSignals}
        />
      )}
      {dialogsOpen && (
        <ComposerConnectorDialogsSlot signals={signals} actions={actions} />
      )}
    </>
  );
}

/**
 * The add, directory and connect dialogs. Mounted only while one is open,
 * because they need the connector catalog.
 */
function ComposerConnectorDialogsSlot({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
}) {
  const addDialogCatalog = useLastResolved(signals.connector.addDialogCatalog$);
  const addDialogBrowseCatalog = useLastResolved(
    signals.connector.addDialogBrowseCatalog$,
  );
  const addDialogCatalogItems =
    useLastResolved(signals.connector.addDialogCatalogItems$) ?? [];
  const addDialogCustomConnectors =
    useLastResolved(signals.connector.addDialogCustomConnectors$) ?? [];
  const customConnectorState = useLoadable(
    signals.connector.addDialogCustomConnectors$,
  ).state;
  const directoryBrowse = composerDirectoryBrowseData(
    addDialogBrowseCatalog,
    addDialogCatalogItems,
  );
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const openConnectorPermissions = useSet(
    signals.connector.openConnectorPermissions$,
  );
  const directoryFinalFocus = useSet(signals.connector.directoryFinalFocus$);

  const pageSignal = useGet(pageSignal$);
  const selectedCustomConnectorId = connectorUi.selectedCustomConnectorId;
  const selectedCustomConnector = addDialogCustomConnectors.find(
    (connector) => {
      return connector.id === selectedCustomConnectorId;
    },
  );

  const selectedConnector = connectorUi.selectedConnector ?? undefined;
  const selectedConnectorAccountOptions =
    defaultBuiltinConnectorAccountOptions(selectedConnector);
  const selectedCustomConnectorAccountOptions =
    defaultCustomConnectorAccountOptions(selectedCustomConnector);

  const connectorConnectHandlers = (
    connector: PlatformConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    const connectorSlug = connector.slug;
    const accountOptions = defaultBuiltinConnectorAccountOptions(connector);
    const origin = {
      kind: "composer",
      hostKey: signals.connectorCompletion.connectHostKey,
    } as const;
    return {
      openModal: () => {
        updateConnectorUi({
          showAddDialog: false,
          selectedConnectorSlug: connectorSlug,
          selectedConnector: connector,
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
              ...accountOptions,
            },
            origin,
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
            origin,
            options: {
              connectorLabel: connector.label,
              ...accountOptions,
            },
          },
          pageSignal,
        );
      },
    };
  };

  return (
    <>
      <ComposerConnectorConnectDialogs
        selectedConnector={selectedConnector}
        selectedConnectorAccountOptions={selectedConnectorAccountOptions}
        selectedCustomConnector={selectedCustomConnector}
        selectedCustomConnectorAccountOptions={
          selectedCustomConnectorAccountOptions
        }
        connectHostKey={signals.connectorCompletion.connectHostKey}
        onBuiltinClose={() => {
          updateConnectorUi({
            selectedConnectorSlug: null,
            selectedConnector: null,
          });
        }}
      />
      {connectorUi.showAddDialog && (
        <ConnectorDirectoryDialog
          finalFocus={directoryFinalFocus}
          state={connectorUi}
          onUpdateState={updateConnectorUi}
          categoryCounts={directoryBrowse.categoryCounts}
          loading={addDialogCatalog === undefined || addDialogCatalog === null}
          chipCatalog={directoryBrowse.chipCatalog}
          connectors={addDialogCatalogItems}
          customConnectors={addDialogCustomConnectors}
          customConnectorState={customConnectorState}
          connecting={actions.connecting}
          isConnectorConnecting={actions.isConnectorConnecting}
          connectHandlers={connectorConnectHandlers}
          onConnectCustom={(connector) => {
            updateConnectorUi({
              showAddDialog: false,
              selectedCustomConnectorId: connector.id,
            });
          }}
          onConfigurePermissions={(connectorSlug) => {
            const connector = addDialogCatalogItems.find((item) => {
              return item.slug === connectorSlug;
            });
            if (!connector) {
              return;
            }
            openConnectorPermissions({
              slug: connector.slug,
              label: connector.label,
              icon: connector.icon,
              hasPermissions: connector.permissionSummary.hasPermissions,
            });
          }}
          onClose={() => {
            return updateConnectorUi({
              showAddDialog: false,
            });
          }}
        />
      )}
    </>
  );
}

function ComposerIdleControls({
  signals,
  actions,
  connectorActions,
}: {
  signals: ComposerSignals;
  actions: ComposerActions;
  connectorActions: ComposerConnectorActions;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1 text-muted-foreground composer-wide:gap-1.5">
        <ComposerAddMenuSlot signals={signals} />
        <ComposerTemplatePreviewSlot signals={signals} />
        <ComposerConnectorsSlot signals={signals} actions={connectorActions} />
        <ComposerProjectControl signals={signals} />
        <ComposerTaskControls signals={signals} />
        <ComposerTools signals={signals} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 composer-wide:gap-2">
        <ComposerModelPickerSlot signals={signals} />
        <MicButton signals={signals} />
        <ComposerSendControl signals={signals} actions={actions} />
      </div>
    </>
  );
}

function ComposerFooter({
  signals,
  children,
}: {
  signals: ComposerSignals;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const voiceDraftLoadable = useLastLoadable(signals.voice.state$);
  const voiceDraft =
    voiceDraftLoadable.state === "hasData"
      ? voiceDraftLoadable.data
      : undefined;
  const capture = useGet(signals.voice.capture$);
  const status = capture
    ? "recording"
    : voiceDraftLoadable.state === "hasError"
      ? "failed"
      : voiceDraft?.status === "recording"
        ? "recorded"
        : voiceDraft?.status;
  const activeVoiceDraftStatus: Exclude<
    ComposerVoiceInputStatus,
    "idle"
  > | null = status !== undefined && status !== "idle" ? status : null;
  return (
    <div
      className={cn(
        // One row that wraps. A control that does not fit takes the next line
        // instead of pressing on the one beside it, so the footer has no width
        // at which it has to be told to squeeze its gaps and padding shut.
        "flex shrink-0 flex-wrap items-center gap-1 composer-wide:gap-2",
        activeVoiceDraftStatus ? "px-2 pb-3 pt-3" : "px-4 pb-4 pt-1",
      )}
    >
      <VoiceDraftFooter
        signals={signals}
        status={status}
        recordingAvailable={Boolean(voiceDraft?.recording)}
        voiceMessage={
          voiceDraftLoadable.state === "hasError"
            ? t(($) => {
                return $.chat.voice.storageFailed;
              })
            : voiceDraft?.message
        }
      >
        {children}
      </VoiceDraftFooter>
    </div>
  );
}

function containsFiles(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes("Files") ||
    Array.from(dataTransfer.items).some((item) => {
      return item.kind === "file";
    })
  );
}

function ComposerCard({
  signals,
  layout,
}: {
  signals: ComposerSignals;
  layout: ComposerLayout;
}) {
  const actions = useComposerActions(signals);
  const connectorActions = useComposerConnectorActions();
  const hasTemplateAttachment = useGet(signals.template.hasTemplateAttachment$);
  const dragOver = useGet(signals.draft.dragOver$);
  const setDragOver = useSet(signals.draft.setDragOver$);
  const uploadFile = useComposerFileUpload(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);
  const layoutHeightClassNames = composerLayoutHeightClassNames(
    signals.editor,
    hasTemplateAttachment,
    layout,
  );

  return (
    <Card
      data-slot="chat-composer-card"
      surface="composer"
      className={cn(
        "z-10",
        "[@media(display-mode:standalone)]:[[data-chat-composer]_&]:scroll-mb-4",
        layout === "card" &&
          "[&_.ProseMirror_p]:pl-0 [&_[data-feedback-item]]:min-h-0",
        dragOver && "outline outline-2 outline-blue-400/60",
      )}
      onDrop={(event) => {
        if (!containsFiles(event.dataTransfer)) {
          return;
        }
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
        if (!containsFiles(event.dataTransfer)) {
          return;
        }
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
          <ComposerAttachments signals={signals} />
          <ComposerInputSlot
            signals={signals}
            actions={actions}
            minimumHeightClassName={layoutHeightClassNames.input}
          />
          {/* Voice states share 8px/12px outer tray spacing and 12px/8px
              inner padding so their surfaces stay aligned through handoff. */}
          <ComposerFooter key={signals.voice.key} signals={signals}>
            <ComposerIdleControls
              signals={signals}
              actions={actions}
              connectorActions={connectorActions}
            />
          </ComposerFooter>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChatComposer({
  signals,
  showPendingItems = true,
  layout = "default",
  discovery,
}: ChatComposerProps) {
  const setLifecycleRef = useSet(signals.setLifecycleRef$);
  return (
    <>
      {(!signals.threadId || signals.editor.forwardComposer) && (
        <ThreadRemoteAccessDialog signals={signals} />
      )}
      {/* The composer group's width, named once. The card is not the container
          itself: the model-scope notice and the pending-items strip are its
          siblings at exactly this width, and a control that reads a width it is
          not inside reads the window instead. */}
      <div
        ref={setLifecycleRef}
        className="@container/composer relative flex w-full min-w-0 flex-col"
      >
        <ComposerNoticeSlot signals={signals} />
        {showPendingItems ? <PendingItemsStrip signals={signals} /> : null}
        {discovery}
        <ComposerCard signals={signals} layout={layout} />
        <ImageAnnotationEditor signals={signals.imageAnnotation} />
      </div>
    </>
  );
}
