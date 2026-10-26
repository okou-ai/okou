import { findDocumentTemplateItem } from "@okouai/core/document-template-items";
import { DocumentTemplatePickerPane } from "./document-template-picker-pane.tsx";
import { DocumentTemplatePreviewPage } from "./document-template-preview-page.tsx";
import { Combobox } from "@base-ui/react/combobox";
import { ScrollArea } from "@base-ui/react/scroll-area";
import type { ComposerVoiceInputStatus } from "../../signals/okou-page/composer-voice-input.ts";
import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
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
import { useCustomTemplateRecommendations } from "./use-custom-template-recommendations.ts";
// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  GenerationTemplateRequest,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import type { PublicConnectorCatalogDiscoveryResponse } from "@okouai/api-contracts/contracts/connector-catalog";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type {
  BuiltinConnectorBrief,
  CustomConnectorBrief,
} from "@okouai/api-contracts/contracts/connected-connectors";
import type {
  UserTemplateCatalogEntry,
  UserTemplateKind,
} from "@okouai/api-contracts/contracts/user-templates";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
} from "@okouai/core/illustration-template-items";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import {
  WEBSITE_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import {
  WORKFLOW_TEMPLATE_CATEGORIES,
  WORKFLOW_TEMPLATE_ITEMS,
  findWorkflowTemplateItem,
  type WorkflowTemplateItem,
} from "@okouai/core/workflow-template-items";
import { ElapsedTime, getShortcutLabel, ScrollBar } from "@okouai/ui";
import { Button } from "@okouai/ui/components/ui/button";
import { Card, CardContent } from "@okouai/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
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
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@okouai/ui/components/ui/tabs";
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
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bolt,
  Check,
  Download,
  FileText,
  Globe,
  Image as ImageIcon,
  LayoutTemplate,
  Loader2,
  Mic,
  Monitor,
  Paperclip,
  Plug,
  Plus,
  Presentation,
  Route,
  Search,
  SlidersHorizontal,
  Square,
  SwatchBook,
  Trash2,
  User,
  UserCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { CHAT_UPLOAD_MAX_FILE_SIZE } from "../../lib/chat-upload.ts";
import {
  COMPOSER_VOICE_INPUT_ARIA_KEY_SHORTCUTS,
  COMPOSER_VOICE_INPUT_SHORTCUT,
} from "../../lib/composer-voice-input-shortcut.ts";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { agents$ } from "../../signals/agent.ts";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import {
  connectorCatalogStatus$,
  withConnectorCompletion,
} from "../../signals/external/connectors.ts";
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
import {
  CONNECTOR_ACCOUNT_SEARCH_THRESHOLD,
  connectorAccountTargetKey,
} from "../../signals/okou-page/connector-accounts.ts";
import type { ComposerConnectorData } from "../../signals/okou-page/connectors.ts";
import { resolveTemplatePickerCategory } from "../../signals/okou-page/chat-composer.ts";
import { resetCustomTemplatePicker$ } from "../../signals/okou-page/custom-template-library.ts";
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
import {
  matchesConnectorSearch,
  type ConnectorConnectSuccess,
} from "../../signals/okou-page/settings/connectors.ts";
import { savePermissionDraftPolicies } from "../../signals/okou-page/settings/permission-grant-save.ts";
import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";
import { shouldUseUserMessage } from "../../signals/okou-page/user-message-document-codec.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { applyUserPermissionGrants$ } from "../../signals/permission-allow/permission-allow-signals.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { openSkillImportDialog$ } from "../../signals/skill-import/skill-import-dialog.ts";
import { activeUserPermissionGrantSnapshot } from "../../signals/user-permission-grants.ts";
import { Reason, detach, onDomEventFn } from "../../signals/utils.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
} from "../../signals/voice-io/voice-io-stt.ts";
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
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import type { ConnectorConnectHandlers } from "./components/settings/launch-connector-connect.ts";
import { PermissionsDialog } from "./components/settings/permissions-dialog.tsx";
import { useConnectorAccountLabel } from "./components/settings/use-connector-account-label.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";
import { ComposerNoticeTray } from "./composer-notice-tray.tsx";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import {
  defaultPresentationTemplateThemeId,
  presentationTemplateColorSystemId,
  toDocumentGenerationTemplate,
  toIllustrationGenerationTemplate,
  toPresentationGenerationTemplate,
  toWebsiteGenerationTemplate,
} from "./composer-template-catalog.ts";
import { ConnectorDirectoryDialog } from "./connector-directory-dialog.tsx";
import { TemplateSourceSection } from "./template-source-section.tsx";
import { CustomTemplatePickerSection } from "./custom-template-picker-pane.tsx";
import { ImageAnnotationEditor } from "./image-annotation-editor.tsx";
import {
  ComposerPaidToolNotice,
  TemplatePaidToolNotice,
} from "./paid-tool-notice.tsx";
import { ComputerUseDownloadDialog } from "./computer-use-download-dialog.tsx";
import {
  contrastRatio,
  previewTextColorOn,
  safePreviewGround,
} from "./presentation-html-preview.ts";
import { ThreadRemoteAccessSection } from "./remote-access-controls.tsx";
import { TemplateEmptyPanel } from "./template-empty-panel.tsx";
import { TemplateFilterPillRow } from "./template-filter-pill.tsx";
import {
  TEMPLATE_CARD_SHADOW,
  TEMPLATE_TILE_CAPTION,
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_NAME,
  TEMPLATE_TILE_PREVIEW_FOCUS,
  TEMPLATE_TILE_SCRIM,
  TEMPLATE_TILE_SELECTED,
  TEMPLATE_TILE_SELECTION_FRAME,
  TEMPLATE_TILE_USE,
  TEMPLATE_TILE_WRAPPER,
} from "./template-tile.ts";
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
import {
  localizedWorkflowTemplate,
  localizedWorkflowTemplateCategory,
} from "./workflow-template-copy.ts";

const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

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
const ILLUSTRATION_EAGER_IMAGE_COUNT = 24;
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

type ComposerConnectorItem = BuiltinConnectorBrief & {
  readonly authorized: boolean;
};

type ComposerCustomConnectorItem = CustomConnectorBrief & {
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
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
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

/** The cover width every type's shelf uses, so the rows line up across tabs. */
const PRESENTATION_SHELF_COVER = "w-[200px]";

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
    // Keep the full-card preview below the independent Use action locally.
    <div
      className={cn(
        TEMPLATE_TILE_WRAPPER,
        "rounded-xl cursor-zoom-in ring-offset-1 ring-offset-card has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-ring",
      )}
    >
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewWebsite;
          },
          {
            title: item.title,
          },
        )}
        onClick={preview}
        className="absolute inset-0 z-10 cursor-zoom-in focus-visible:outline-none"
      />
      <div
        className={cn(
          TEMPLATE_TILE_SELECTION_FRAME,
          selected && TEMPLATE_TILE_SELECTED,
        )}
      >
        <div className={cn(TEMPLATE_TILE_MEDIA, "aspect-[16/9]")}>
          <img
            alt={t(
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
          <div
            className={cn(
              TEMPLATE_TILE_SCRIM,
              "group-has-[:focus-visible]/tile:opacity-100",
            )}
          />
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
            onClick={() => {
              onSelect(item);
            }}
            className={cn(
              TEMPLATE_TILE_USE,
              "cursor-pointer [@media(hover:hover)]:group-has-[:focus-visible]/tile:opacity-100",
            )}
          >
            {t(($) => {
              return $.artifacts.templates.use;
            })}
          </button>
        </div>
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
        "group/tile flex flex-col rounded-xl border border-border bg-card p-4",
        TEMPLATE_CARD_SHADOW,
        selected && "border-primary",
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
              ? "border-primary/40 bg-primary/10 text-selected-foreground"
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
// Ideas & Use Cases gallery: an "All" pill plus one pill per persona. The pill
// treatment itself belongs to the shared filter row.
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
    <TemplateFilterPillRow
      className="px-6"
      active={active}
      pills={[
        {
          id: "all",
          label: t(($) => {
            return $.artifacts.templates.all;
          }),
        },
        ...pills.map((pill) => {
          return { id: pill, label: localizedWorkflowTemplateCategory(pill) };
        }),
      ]}
      onSelect={onSelect}
    />
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

function presentationTemplateCardSlideImage(
  item: PresentationTemplateItem,
  index: number,
  theme?: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  if (index === 0) {
    return r2ImageTransformUrl(
      presentationTemplateThemedCardPreviewSource(item, theme),
      size,
    );
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

function PresentationTemplateTitleTooltip({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        {children}
        {/* The preview button already includes the full title in its name. */}
        <TooltipContent side="bottom" className="break-words" aria-hidden>
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TemplatePreview({
  item,
  onPreview,
  signals,
  theme,
}: {
  item: PresentationTemplateItem;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  signals: ComposerSignals;
  theme?: PresentationTemplateThemeOption;
}) {
  const { t } = useTranslation();
  const previewId = useGet(signals.template.previewTemplateId$);
  const selection = useGet(signals.template.previewTemplateSelection$);
  const template = useLoadable(signals.template.previewTemplate$);
  const html = useLoadable(signals.template.previewTemplateHtml$);
  const selectPreview = useSet(signals.template.selectPreviewTemplate$);
  const clearPreview = useSet(signals.template.clearPreviewTemplate$);
  const restorePreviewTrigger = useSet(
    signals.template.restoreTemplatePreviewTriggerRef$,
  );
  const active = previewId === item.slug;
  const loadedTemplate =
    template.state === "hasData" && template.data?.item.slug === item.slug
      ? template.data
      : null;
  const slideCount =
    loadedTemplate?.draft.slides.length ?? presentationTemplateSlideCount(item);
  const slideIndex = active
    ? Math.min(selection?.index ?? 0, slideCount - 1)
    : 0;
  const previewTheme =
    theme ??
    findPresentationTemplateTheme(defaultPresentationTemplateThemeId(item));
  const selectSlide = (index: number) => {
    selectPreview({
      item,
      index,
      themeId: previewTheme.id,
      themeCss: presentationTemplateThemeCss(previewTheme),
    });
  };
  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!active || loadedTemplate === null || slideCount < 2) {
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
    const index = Math.min(
      slideCount - 1,
      Math.round((offsetX / rect.width) * (slideCount - 1)),
    );
    if (index !== slideIndex) {
      selectSlide(index);
    }
  };
  return (
    <div
      aria-busy={active && template.state === "loading"}
      className="relative aspect-[16/9] shrink-0 overflow-hidden bg-muted"
      onMouseEnter={() => {
        selectSlide(0);
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={clearPreview}
    >
      <ProgressiveTemplatePreviewImage
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        fetchPriority="high"
        highResolutionUrl={presentationTemplateHighResolutionSlideImage(
          item,
          slideIndex,
          previewTheme,
          TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE,
        )}
        lowResolutionUrl={presentationTemplateCardSlideImage(
          item,
          slideIndex,
          previewTheme,
        )}
      />
      <PresentationTemplateHtmlFrame
        html={
          active && slideIndex > 0 && html.state === "hasData"
            ? html.data
            : null
        }
        title={t(
          ($) => {
            return $.artifacts.templates.activeHtmlPreview;
          },
          {
            title: item.title,
          },
        )}
        dataTestId={`${item.title} card HTML preview`}
      />
      {active && template.state === "loading" ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
      <TooltipTrigger
        render={
          <button
            ref={restorePreviewTrigger}
            data-template-preview-id={`built-in:${item.slug}`}
            type="button"
            aria-label={t(
              ($) => {
                return $.artifacts.templates.previewCurrentSlide;
              },
              {
                title: item.title,
              },
            )}
            className="absolute inset-0 z-10 cursor-zoom-in bg-transparent focus-visible:outline-none"
            onClick={() => {
              onPreview(item, slideIndex);
            }}
          />
        }
      />
    </div>
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
  onBack,
  onSelect,
  signals,
}: {
  item: PresentationTemplateItem;
  onBack: () => void;
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
  const setCardThemeId = useSet(signals.template.setTemplateCardThemeId$);
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
            setCardThemeId(item.slug, selectedTheme.id);
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

function PptCard({
  item,
  selected,
  onSelect,
  onPreview,
  signals,
}: {
  item: PresentationTemplateItem;
  selected: boolean;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const themeIdBySlug = useGet(signals.template.templateCardThemeIdBySlug$);
  const selectedTheme = findPresentationTemplateTheme(
    themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
  );

  return (
    <PresentationTemplateTitleTooltip title={item.title}>
      <div className={TEMPLATE_TILE_WRAPPER}>
        <div
          className={cn(
            TEMPLATE_TILE_SELECTION_FRAME,
            TEMPLATE_TILE_PREVIEW_FOCUS,
            selected && TEMPLATE_TILE_SELECTED,
          )}
        >
          <div className={TEMPLATE_TILE_MEDIA}>
            <TemplatePreview
              item={item}
              onPreview={onPreview}
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
                onSelect(
                  item,
                  presentationTemplateColorSystemId(selectedTheme.id),
                );
              }}
              className={TEMPLATE_TILE_USE}
            >
              {t(($) => {
                return $.artifacts.templates.use;
              })}
            </button>
          </div>
        </div>
        <div className={TEMPLATE_TILE_CAPTION}>
          <TooltipTrigger
            render={
              <p className={cn(TEMPLATE_TILE_NAME, "cursor-default")}>
                {item.title}
              </p>
            }
          />
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
    </PresentationTemplateTitleTooltip>
  );
}

function IllustrationTemplateHero({
  item,
  images,
  activeIndex,
  priority = false,
  source,
  onVariantChange,
}: {
  item: IllustrationTemplateItem;
  images: readonly string[];
  activeIndex: number;
  priority?: boolean;
  source: string;
  onVariantChange: (slug: string, index: number) => void;
}) {
  const { t } = useTranslation();
  const heroImage = illustrationHeroImageUrl(source);
  const navigable = images.length > 1;
  const variantAt = (direction: -1 | 1): number => {
    return (activeIndex + direction + images.length) % images.length;
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
          "absolute inset-0 h-full w-full object-cover",
          // Same affordance the detail preview uses for slide paging: the
          // cursor points at the half that will be navigated to.
          navigable &&
            "data-[half=left]:cursor-w-resize data-[half=right]:cursor-e-resize",
        )}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "low"}
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
                onVariantChange(item.slug, variantAt(direction));
              }
            : undefined
        }
        onLoad={(event) => {
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>("[data-illustration-preview-error]")
            ?.setAttribute("hidden", "");
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
}: {
  item: IllustrationTemplateItem;
  selected: boolean;
  activeIndex: number;
  priority?: boolean;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
}) {
  const { t } = useTranslation();
  const images = item.previewImages;
  const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1));
  const heroSource = images[safeIndex] ?? item.previewImage;
  const hasMultipleVariants = images.length > 1;

  return (
    <div
      className={cn(
        "isolate mb-4 break-inside-avoid supports-[display:grid-lanes]:mb-0 supports-[display:grid-lanes]:break-inside-auto",
        TEMPLATE_TILE_SELECTION_FRAME,
        selected && TEMPLATE_TILE_SELECTED,
      )}
    >
      <div
        className={cn(
          "group/tile overflow-hidden rounded-xl border border-border bg-card",
          TEMPLATE_CARD_SHADOW,
        )}
      >
        <IllustrationTemplateHero
          item={item}
          images={images}
          activeIndex={safeIndex}
          priority={priority}
          source={heroSource}
          onVariantChange={onVariantChange}
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
                    "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border-(length:--border-width-emphasis) bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active ? "border-primary" : "border-border",
                  )}
                  onClick={(event) => {
                    onVariantChange(item.slug, index);
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
                ? "border-primary/40 bg-primary/10 text-selected-foreground"
                : "border-border bg-background text-foreground hover:bg-state-hover",
            )}
          >
            {t(($) => {
              return $.artifacts.templates.use;
            })}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplatePickerCategoryNav({
  selectedCategory,
  onChange,
}: {
  selectedCategory: string;
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
      value: "document",
      label: t(($) => {
        return $.documentTemplates.title;
      }),
      Icon: FileText,
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
        return $.artifacts.kinds.image;
      }),
      Icon: ImageIcon,
    },
    {
      value: "workflow",
      label: t(($) => {
        return $.artifacts.templates.workflow;
      }),
      Icon: Route,
    },
  ];

  const categoryItems = categoryOptions.map(({ value, label, Icon }) => {
    return {
      value,
      label: (
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          {label}
        </span>
      ),
    };
  });

  return (
    <>
      <div className="shrink-0 border-b border-border bg-gray-50 px-4 pb-4 pr-14 pt-4 sm:hidden">
        <Select
          items={categoryItems}
          value={selectedCategory}
          onValueChange={(value, details) => {
            if (
              value === null ||
              !categoryItems.some((item) => {
                return item.value === value;
              })
            ) {
              details.cancel();
              return;
            }
            onChange(value);
          }}
        >
          <SelectTrigger
            data-template-picker-category-select=""
            aria-label={t(($) => {
              return $.artifacts.templates.category;
            })}
            className="h-9 w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryItems.map(({ value, label }) => {
              return (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="hidden shrink-0 sm:flex">
        <div className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
          <TemplatePickerHeader />
          <TabsList
            activateOnFocus
            aria-label={t(($) => {
              return $.artifacts.templates.categories;
            })}
            data-template-picker-sidebar=""
            className="flex h-auto min-h-0 flex-1 flex-col items-stretch justify-start gap-0.5 overflow-y-auto rounded-none bg-transparent p-0 px-3 pb-3"
          >
            {categoryOptions.map(({ value, label, Icon }) => {
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="group h-9 w-full justify-start gap-2.5 rounded-lg px-2.5 text-left font-normal leading-5 text-gray-800 data-active:bg-state-selected data-active:font-medium data-active:text-foreground data-active:!shadow-none focus-visible:ring-inset"
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0 transition-colors",
                      value === selectedCategory
                        ? "text-foreground"
                        : "text-gray-700 group-hover:text-gray-800",
                    )}
                  />
                  <span className="truncate">{label}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
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

/**
 * Every category names itself above its grid, in the rail's own words, so no
 * tab opens onto a bare header band while its neighbours carry a title.
 */
function TemplatePickerCategoryTitle({ category }: { category: string }) {
  const { t } = useTranslation();
  const titles: Record<string, string> = {
    slides: t(($) => {
      return $.artifacts.kinds.presentation;
    }),
    document: t(($) => {
      return $.documentTemplates.title;
    }),
    website: t(($) => {
      return $.artifacts.templates.website;
    }),
    illustration: t(($) => {
      return $.artifacts.kinds.image;
    }),
    workflow: t(($) => {
      return $.artifacts.templates.workflow;
    }),
  };
  return (
    <h2 className="mr-auto hidden text-base font-semibold sm:block">
      {titles[category]}
    </h2>
  );
}

function TemplatePickerSearch({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
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
  value,
  variantIndexBySlug,
  onSelect,
  onVariantChange,
}: {
  items: readonly IllustrationTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  variantIndexBySlug: Readonly<Record<string, number>>;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
}) {
  // Grid Lanes keeps native-aspect cards out of multi-column fragmentation in
  // Safari 26.4+. Other browsers retain the existing multi-column layout.
  return (
    <div className="columns-[244px] gap-4 supports-[display:grid-lanes]:shrink-0 supports-[display:grid-lanes]:columns-auto supports-[display:grid-lanes]:grid-cols-[repeat(auto-fill,minmax(min(244px,100%),1fr))] supports-[display:grid-lanes]:[display:grid-lanes]">
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
          />
        );
      })}
    </div>
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
  compact = false,
  className,
}: {
  signals: ComposerSignals;
  onImported: () => void;
  kind?: UserTemplateKind;
  compact?: boolean;
  className?: string;
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
  return (
    <label
      data-presentation-template-import={
        kind === "presentation" ? "" : undefined
      }
      className={cn(TEMPLATE_TILE_WRAPPER, className)}
    >
      <span
        className={cn(
          TEMPLATE_TILE_MEDIA,
          "block bg-muted/40 transition-colors duration-150 group-hover/tile:bg-muted/60 group-active/tile:bg-muted/80 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-ring",
          kind === "illustration"
            ? "aspect-[4/5]"
            : kind === "document"
              ? "aspect-[4/3]"
              : "aspect-video",
        )}
      >
        {compact ? (
          // On a shelf the accepted formats sit inside the tile, under the
          // plus, so the caption below stays one line like every cover's --
          // and the member still sees what the tile takes before choosing a
          // file.
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-muted-foreground transition-colors duration-150 group-hover/tile:text-foreground">
            <Plus className="size-8" strokeWidth={1.5} aria-hidden />
            <span className="max-w-full truncate text-xs">{hints[kind]}</span>
          </span>
        ) : (
          <Plus
            className="absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 text-muted-foreground transition-colors duration-150 group-hover/tile:text-foreground"
            strokeWidth={1.5}
            aria-hidden
          />
        )}
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
      </span>
      {compact ? (
        // On a shelf the import tile is one cover among many, so its caption
        // is one line in the shelf's metrics and ink, like every cover beside
        // it. A second line made this tile 32px taller than its row, and on
        // the document shelf -- where it shows under Custom only -- switching
        // filters grew and shrank the shelf, which moved the whole centred
        // page under the pointer.
        <span
          className={cn(
            RAIL_TILE_CAPTION,
            "text-muted-foreground transition-colors group-hover/tile:text-foreground",
          )}
        >
          {label}
        </span>
      ) : (
        <span
          className={cn(
            TEMPLATE_TILE_CAPTION,
            "flex-col items-stretch gap-0.5",
          )}
        >
          <span
            className={cn(
              TEMPLATE_TILE_NAME,
              (kind === "illustration" || kind === "document") &&
                "whitespace-normal",
            )}
          >
            {label}
          </span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {hints[kind]}
          </span>
        </span>
      )}
    </label>
  );
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
      className={cn(RAIL_TILE, PRESENTATION_SHELF_COVER)}
      onClick={onSelect}
    >
      <span
        className={cn(
          TEMPLATE_TILE_MEDIA,
          "block aspect-video group-hover/tile:opacity-90",
        )}
      >
        {children}
      </span>
      <span className={RAIL_TILE_CAPTION}>{title}</span>
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
  const custom = useCustomTemplateRecommendations(signals, "presentation");
  const builtIn = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const setMode = useSet(signals.create.setMode$);
  const label = t(($) => {
    return $.chat.taskChips.presentationTemplates;
  });
  // The same header line, rail and cover metrics as every other type's shelf.
  // The import tile leads the rail so members can start with their own deck.
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-base font-medium">{label}</p>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="shrink-0 gap-1.5 font-normal"
          onClick={() => {
            // This shelf is the presentation catalog's entry, so "more" opens
            // the Presentation tab like every other type's shelf does.
            openTemplates({ kind: "insert", category: "slides" });
          }}
        >
          {t(($) => {
            return $.chat.taskChips.moreTemplates;
          })}
          <ArrowRight className="size-3" aria-hidden />
        </Button>
      </div>
      <ComposerRail
        signals={signals}
        rail="templates:presentation"
        gap="gap-3"
        items={[
          <TemplateImportCard
            key="import"
            signals={signals}
            compact
            // A `label` is inline by default, so the shelf width only lands once
            // the tile is a block.
            className={cn("group/tile block", PRESENTATION_SHELF_COVER)}
            onImported={() => {
              setMode(null);
            }}
          />,
          ...custom.map((template) => {
            return (
              <ComposerPresentationSuggestion
                key={template.id}
                title={template.title}
                onSelect={() => {
                  picker.onChange({
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
          }),
        ]}
      />
    </div>
  );
}

function TemplatePickerDialogFrame({
  signals,
  presentationItems,
  gallery,
  onChange,
  onClose,
  onCloseComplete,
  handleSelectPresentation,
}: {
  signals: ComposerSignals;
  presentationItems: readonly PresentationTemplateItem[];
  gallery: () => ReactNode;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  onCloseComplete: () => void;
  handleSelectPresentation: (
    item: PresentationTemplateItem,
    colorSystemId?: string,
  ) => void;
}) {
  const { t } = useTranslation();
  // Visibility stays below the gallery's built-in card construction.
  const open = useGet(signals.template.templatePickerOpen$);
  const initialFocus = useSet(signals.template.templatePickerInitialFocus$);
  const setPopup = useSet(signals.template.setTemplatePickerPopup$);
  const previewSlug = useGet(signals.template.openedTemplateId$);
  const previewItem =
    presentationItems.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const documentPreview = useGet(signals.template.documentPreview$);
  const closeDocumentPreview = useSet(signals.template.closeDocumentPreview$);
  const closeDetailPreview = useSet(signals.template.closeOpenedTemplate$);
  const isPreviewing = Boolean(previewItem ?? documentPreview);
  const dialogContentClassName = cn(
    "gap-0 overflow-hidden p-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0",
    "flex flex-col",
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          if (documentPreview !== undefined) {
            closeDocumentPreview();
            return;
          }
          if (previewItem !== null) {
            closeDetailPreview();
            return;
          }
          onClose();
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          onCloseComplete();
        }
      }}
    >
      <DialogContent
        ref={setPopup}
        initialFocus={initialFocus}
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        maxWidth="6xl"
        height={760}
        contentClassName={dialogContentClassName}
        // Website and Custom open a template in a dialog of their own rather
        // than in this frame, at this frame's size. The gallery steps back
        // while one is open, so the detail reads as the same surface the
        // built-in decks open into, not as a panel over the grid.
        hideWhenNestedOpen
        aria-describedby={undefined}
      >
        {!isPreviewing ? gallery() : null}
        {documentPreview ? (
          <DocumentTemplatePreviewPage
            signals={signals}
            item={documentPreview}
            onSelect={(item) => {
              onChange(toDocumentGenerationTemplate(item));
              onClose();
            }}
          />
        ) : previewItem ? (
          <TemplatePreviewPage
            item={previewItem}
            onBack={() => {
              closeDetailPreview();
            }}
            onSelect={handleSelectPresentation}
            signals={signals}
          />
        ) : null}
        <WebsiteTemplatePreviewDialogSlot signals={signals} />
      </DialogContent>
    </Dialog>
  );
}

function TemplatePickerDialog({
  value,
  onChange,
  onClose,
  onCloseComplete,
  presentationItems,
  signals,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  onCloseComplete: () => void;
  presentationItems: readonly PresentationTemplateItem[];
  signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selectedCategory = useGet(
    signals.template.selectedTemplatePickerCategory$,
  );
  const setCategory = useSet(signals.template.setTemplatePickerCategory$);
  const search = useGet(signals.template.templatePickerSearch$);
  const setSearch = useSet(signals.template.setTemplatePickerSearch$);
  const resetCustomTemplatePicker = useSet(resetCustomTemplatePicker$);
  const restorePresentationGridScroll = useSet(
    signals.template.restoreTemplatePickerPresentationScrollRef$,
  );
  const setPresentationGridScrollTop = useSet(
    signals.template.setTemplatePickerPresentationScrollTop$,
  );
  const clearPresentationPreviews = useSet(
    signals.template.clearPresentationTemplatePreviews$,
  );
  const openDetailPreview = useSet(signals.template.openPresentationTemplate$);
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
  const closeDocumentPreview = useSet(signals.template.closeDocumentPreview$);
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

  const showTemplatePickerSearch = [
    "workflow",
    "slides",
    "document",
    "illustration",
  ].includes(selectedCategory);

  const closeTemplatePicker = () => {
    onClose();
  };

  const completeTemplatePickerClose = () => {
    clearPresentationPreviews();
    closeDocumentPreview();
    resetCustomTemplatePicker();
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

  const handleSelectCustom = (template: UserTemplateCatalogEntry) => {
    // The row id alone. What this template produces lives on the row, so the
    // selection does not restate it and cannot disagree with it.
    onChange({
      type: "custom",
      selection: { userTemplateId: template.id },
    });
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
    openDetailPreview({
      index: selectedSlideIndex,
      item,
      themeCss: presentationTemplateThemeCss(selectedTheme),
      themeId: selectedTheme.id,
    });
  };

  // The frame mounts these controls only while showing the gallery.
  const handleCategoryChange = (nextCategory: string) => {
    setCategory(nextCategory);
    setSearch("");
  };

  const presentationCards = presentationItems
    .filter((item) => {
      return item.title.toLowerCase().includes(search.trim().toLowerCase());
    })
    .map((item) => {
      return (
        <PptCard
          key={item.slug}
          item={item}
          selected={isSelectedPresentationTemplate(item, value)}
          onSelect={handleSelectPresentation}
          onPreview={handlePreview}
          signals={signals}
        />
      );
    });

  return (
    <TemplatePickerDialogFrame
      signals={signals}
      presentationItems={presentationItems}
      onChange={onChange}
      onClose={closeTemplatePicker}
      onCloseComplete={completeTemplatePickerClose}
      handleSelectPresentation={handleSelectPresentation}
      gallery={() => {
        return (
          <div className="min-h-0 flex flex-1 flex-col">
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4 sm:hidden">
              <DialogTitle>
                {t(($) => {
                  return $.artifacts.templates.template;
                })}
              </DialogTitle>
            </DialogHeader>
            <Tabs
              value={selectedCategory}
              onValueChange={(nextCategory) => {
                if (typeof nextCategory === "string") {
                  handleCategoryChange(nextCategory);
                }
              }}
              orientation="vertical"
              className="flex min-h-0 flex-1 flex-col sm:flex-row"
            >
              <TemplatePickerCategoryNav
                selectedCategory={selectedCategory}
                onChange={handleCategoryChange}
              />
              {/* Keep the existing single active content tree and its category
                  unmounting runModel; signals retain search and scroll state. */}
              <TabsContent
                value={selectedCategory}
                className="relative flex min-h-0 min-w-0 flex-1 flex-col focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <TemplatePaidToolNotice category={selectedCategory} />
                <div
                  className={cn(
                    "relative h-[68px] shrink-0 items-center px-6 pr-14",
                    showTemplatePickerSearch ? "flex" : "hidden sm:flex",
                  )}
                >
                  <TemplatePickerCategoryTitle category={selectedCategory} />
                  {showTemplatePickerSearch ? (
                    <TemplatePickerSearch
                      search={search}
                      onSearchChange={setSearch}
                    />
                  ) : null}
                </div>
                <TemplatePickerCategoryContent
                  signals={signals}
                  selectedCategory={selectedCategory}
                  search={search}
                  pptCards={presentationCards}
                  websiteItems={WEBSITE_TEMPLATE_ITEMS}
                  illustrationItems={ILLUSTRATION_TEMPLATE_ITEMS.filter(
                    (item) => {
                      return item.title
                        .toLowerCase()
                        .includes(search.trim().toLowerCase());
                    },
                  )}
                  workflowCatalog={workflowCatalog}
                  value={value}
                  illustrationVariantIndex={illustrationVariantIndex}
                  onPresentationScroll={setPresentationGridScrollTop}
                  onRestorePresentationScroll={restorePresentationGridScroll}
                  onSelectDocument={(item) => {
                    onChange(toDocumentGenerationTemplate(item));
                    closeTemplatePicker();
                  }}
                  onSelectCustom={handleSelectCustom}
                  onImported={closeTemplatePicker}
                  onSelectWebsite={handleSelectWebsite}
                  onPreviewWebsite={handlePreviewWebsite}
                  onSelectIllustration={handleSelectIllustration}
                  onIllustrationVariantChange={setIllustrationVariantIndex}
                  onWorkflowCategoryChange={setWorkflowCategoryFilter}
                  onSelectWorkflow={handleSelectWorkflow}
                />
              </TabsContent>
            </Tabs>
          </div>
        );
      }}
    />
  );
}

function TemplatePickerCategoryContent({
  signals,
  selectedCategory,
  search,
  pptCards,
  websiteItems,
  illustrationItems,
  workflowCatalog,
  value,
  illustrationVariantIndex,
  onPresentationScroll,
  onRestorePresentationScroll,
  onSelectCustom,
  onSelectDocument,
  onImported,
  onSelectWebsite,
  onPreviewWebsite,
  onSelectIllustration,
  onIllustrationVariantChange,
  onWorkflowCategoryChange,
  onSelectWorkflow,
}: {
  signals: ComposerSignals;
  selectedCategory: string;
  search: string;
  pptCards: ReactNode;
  websiteItems: readonly WebsiteTemplateItem[];
  illustrationItems: readonly IllustrationTemplateItem[];
  workflowCatalog: ResolvedWorkflowTemplateCatalog;
  value: GenerationTemplateRequest | undefined;
  illustrationVariantIndex: Readonly<Record<string, number>>;
  onPresentationScroll: (value: number) => void;
  onRestorePresentationScroll: RefCallback<HTMLDivElement>;
  onSelectCustom: (template: UserTemplateCatalogEntry) => void;
  onSelectDocument: (
    item: import("@okouai/core/document-template-items").DocumentTemplateItem,
  ) => void;
  /** Both import entries leave the picker for the thread they send into. */
  onImported: () => void;
  onSelectWebsite: (item: WebsiteTemplateItem) => void;
  onPreviewWebsite: (item: WebsiteTemplateItem) => void;
  onSelectIllustration: (item: IllustrationTemplateItem) => void;
  onIllustrationVariantChange: (slug: string, index: number) => void;
  onWorkflowCategoryChange: (category: string) => void;
  onSelectWorkflow: (item: WorkflowTemplateItem) => void;
}) {
  const customSection = (kind: UserTemplateKind) => {
    return (
      <CustomTemplatePickerSection
        signals={signals}
        kind={kind}
        query={search}
        onSelect={onSelectCustom}
        importCard={
          <TemplateImportCard
            kind={kind}
            signals={signals}
            onImported={onImported}
          />
        }
      />
    );
  };
  if (selectedCategory === "document") {
    return (
      <DocumentTemplatePickerPane
        signals={signals}
        value={value}
        onSelect={onSelectDocument}
        customTemplates={customSection("document")}
      />
    );
  }
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
        {customSection("presentation")}
        <TemplateSourceSection source="builtIn">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pptCards}
          </div>
        </TemplateSourceSection>
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
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pb-6 pt-0.5">
        {customSection("illustration")}
        <TemplateSourceSection source="builtIn">
          <IllustrationTemplateGrid
            items={illustrationItems}
            value={value}
            variantIndexBySlug={illustrationVariantIndex}
            onSelect={onSelectIllustration}
            onVariantChange={onIllustrationVariantChange}
          />
        </TemplateSourceSection>
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
): ComposerTemplateAttachment | undefined {
  if (value?.type === "document") {
    const item = findDocumentTemplateItem(value.selection.documentTemplateId);
    return item
      ? { type: "document", title: item.title, category: "document" }
      : undefined;
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

/**
 * Which templates the picker should land on, what to call the affordance that
 * opens it from the add menu.
 */
function useTemplatePickerTrigger(signals: ComposerSignals) {
  const { t } = useTranslation();
  const category = useGet(signals.template.templatePickerCategory$);
  const createMode = useGet(signals.create.mode$);
  const openTemplatePicker = useSet(signals.template.openTemplatePicker$);
  const templateMode = createMode === "image" ? "illustration" : createMode;
  const label =
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
  const selectedCategory = resolveTemplatePickerCategory(
    templateMode === "presentation" ? "slides" : (templateMode ?? category),
  );
  const open = () => {
    openTemplatePicker({ kind: "insert", category: selectedCategory });
  };
  return { label, open };
}

/** Shared dialog for the add menu, slash panel and inline template chips. */
function TemplatePickerDialogSlot({
  picker,
  presentationItems,
  signals,
}: {
  picker: ComposerTemplatePicker;
  presentationItems: readonly PresentationTemplateItem[];
  signals: ComposerSignals;
}) {
  const mounted = useGet(signals.template.templatePickerMounted$);
  const referenceValue = useGet(signals.template.templatePickerReferenceValue$);
  const setOpen = useSet(signals.template.setTemplatePickerOpen$);
  const completeClose = useSet(signals.template.completeTemplatePickerClose$);
  const setReferenceValue = useSet(
    signals.template.setTemplatePickerReferenceValue$,
  );
  if (!mounted) {
    return null;
  }
  return (
    <TemplatePickerDialog
      value={referenceValue ?? undefined}
      onChange={picker.onChange}
      onClose={() => {
        setOpen(false);
      }}
      onCloseComplete={() => {
        setReferenceValue(null);
        completeClose();
      }}
      presentationItems={presentationItems}
      signals={signals}
    />
  );
}

function ComposerTemplatePickerSlot({ signals }: { signals: ComposerSignals }) {
  const picker = useComposerTemplatePicker(signals);
  return (
    <TemplatePickerDialogSlot
      picker={picker}
      presentationItems={PRESENTATION_TEMPLATE_PICKER_ITEMS}
      signals={signals}
    />
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
      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover">
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
  remoteMenuOpen,
  onRemoteMenuOpenChange,
}: {
  signals: ComposerSignals;
  computerUse: ComposerComputerUse | undefined;
  onOpenDownloadDialog: () => void;
  remoteMenuOpen: boolean;
  onRemoteMenuOpenChange: (open: boolean) => void;
}) {
  const remoteAccess = (
    <ThreadRemoteAccessSection
      threadId={signals.threadId}
      remoteAccess$={signals.remoteAccess$}
      defaults$={signals.connector.resources.remoteHostDefaults$}
      pendingRemoteAccess={signals.pendingRemoteAccess}
      open={remoteMenuOpen}
      onOpenChange={onRemoteMenuOpenChange}
    />
  );
  return computerUse ? (
    <ComputerUseConnectorMenuSection
      computerUse={computerUse}
      onOpenDownloadDialog={onOpenDownloadDialog}
      remoteAccess={remoteAccess}
    />
  ) : (
    remoteAccess
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
  item: ComposerPopoverConnectorItem,
): ConnectorAccountTarget {
  return item.kind === "builtin"
    ? { kind: "builtin", connectorSlug: item.connector.slug }
    : { kind: "custom", customConnectorId: item.connector.id };
}

function matchesComposerPopoverConnectorSearch(
  search: string,
  item: ComposerPopoverConnectorItem,
): boolean {
  return item.kind === "builtin"
    ? matchesConnectorSearch(search, item.connector)
    : [item.connector.displayName, item.connector.slug].some((value) => {
        return value.toLowerCase().includes(search.trim().toLowerCase());
      });
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
  target,
  connectorLabel,
  selectedConnection,
  explicit,
}: {
  readonly signals: ComposerSignals;
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
  readonly selectedConnection: ConnectorAccountConnection | undefined;
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
  const effectiveConnection = selectedConnection;
  const resolveAccountLabel = useConnectorAccountLabel();
  const accountLabel = effectiveConnection
    ? resolveAccountLabel(effectiveConnection)
    : t(($) => {
        return $.chat.connectors.useDefault;
      });
  const accessibleLabel = explicit
    ? t(
        ($) => {
          return $.chat.connectors.selectedAccountFor;
        },
        { connector: connectorLabel, account: accountLabel },
      )
    : `${connectorLabel} · ${t(($) => {
        return $.chat.connectors.accountForThread;
      })}`;
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
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-2xs"
                  className="shrink-0"
                  aria-label={accessibleLabel}
                >
                  {explicit ? <UserCheck size={14} /> : <User size={14} />}
                </Button>
              }
            />
          }
        />
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
        {open && (
          <ComposerConnectorAccountMenuContent
            signals={signals}
            target={target}
            connectorLabel={connectorLabel}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

const DEFAULT_CONNECTOR_ACCOUNT = "default";

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
}) {
  const { t } = useTranslation();
  const choiceClassName = cn(
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-state-hover data-highlighted:bg-state-hover data-highlighted:ring-2 data-highlighted:ring-inset data-highlighted:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    saving && "cursor-default opacity-50",
  );
  const accountLabel = useConnectorAccountLabel();
  const defaultLabel = defaultConnection
    ? accountLabel(defaultConnection)
    : t(($) => {
        return $.chat.connectors.noUsableAccount;
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
    <Combobox.List
      className="flex max-h-64 min-h-0 flex-1 flex-col overflow-y-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-label={connectorLabel}
      aria-busy={saving}
      tabIndex={0}
    >
      <Combobox.Item
        disabled={saving}
        value={DEFAULT_CONNECTOR_ACCOUNT}
        className={choiceClassName}
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
      </Combobox.Item>
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
          <Combobox.Item
            key={connection.id}
            disabled={saving}
            value={connection.id}
            className={choiceClassName}
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
          </Combobox.Item>
        );
      })}
      {noResults ? (
        <div className="px-2 py-3 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.accounts.noAccountsFound;
          })}
        </div>
      ) : null}
    </Combobox.List>
  );
}

function ComposerConnectorAccountMenuContent({
  signals,
  target,
  connectorLabel,
}: {
  readonly signals: ComposerSignals;
  readonly target: ConnectorAccountTarget;
  readonly connectorLabel: string;
}) {
  const { t } = useTranslation();
  const preferenceLoadable = useLastLoadable(
    signals.connector.accounts.preferenceState$,
  );
  const accountsLoadable = useLastLoadable(
    signals.connector.accounts.accounts$,
  );
  const search = useGet(signals.connector.accounts.search$);
  const closeMenu = useSet(signals.connector.accounts.closeMenu$);
  const setSearch = useSet(signals.connector.accounts.setSearch$);
  const [saveOperation, commitSelection] = useLoadableSet(
    signals.connector.accounts.commitSelection$,
  );
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
  const accountList =
    accountsLoadable.state === "hasData"
      ? accountsLoadable.data
      : {
          connections: [],
          nextCursor: null,
          available: true,
          defaultConnection: null,
        };
  const defaultConnection = accountList.defaultConnection;
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
    accountList.connections.length > CONNECTOR_ACCOUNT_SEARCH_THRESHOLD ||
    accountList.hasMultiplePages === true ||
    accountList.nextCursor !== null;
  const saving = saveOperation.state === "loading";
  return (
    <Combobox.Root<string>
      inline
      open
      readOnly={saving}
      value={selection ? selection.connectionId : DEFAULT_CONNECTOR_ACCOUNT}
      filter={null}
      onValueChange={(value, details) => {
        if (details.reason !== "item-press") {
          return;
        }
        // The server (or new-chat pending state) owns the accepted selection.
        // Reject the immediate transition, including its automatic close.
        details.cancel();
        if (saving) {
          return;
        }
        if (value === DEFAULT_CONNECTOR_ACCOUNT) {
          detach(commitSelection(null, signal), Reason.DomCallback);
          return;
        }
        const connection = connections.find((candidate) => {
          return candidate.id === value;
        });
        if (connection) {
          detach(commitSelection(connection, signal), Reason.DomCallback);
        }
      }}
    >
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
          <div className="relative shrink-0 border-b border-border/50 px-3 py-2">
            <Search
              size={16}
              aria-hidden="true"
              className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value, signal);
              }}
              readOnly={saving}
              aria-label={t(($) => {
                return $.connectors.accounts.find;
              })}
              placeholder={t(($) => {
                return $.connectors.accounts.find;
              })}
              className="h-8 pl-9"
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
          loadingAccountCount={2}
        />
        {accountList.nextCursor ? (
          <div className="shrink-0 border-t border-border/50 p-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={saving || loadMoreLoadable.state === "loading"}
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
    </Combobox.Root>
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
}) {
  const sorted = args.sortOrder
    ? [...args.connectorItems].sort((a, b) => {
        const order = { builtin: 0, ssh: 1, vnc: 2, custom: 3 };
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
  return visibleConnectors;
}

function ComposerConnectorAccountAction({
  signals,
  item,
}: {
  readonly signals: ComposerSignals;
  readonly item: ComposerPopoverConnectorItem;
}) {
  const preference = useLastResolved(
    signals.connector.accounts.preferenceState$,
  );
  const target = composerPopoverConnectorTarget(item);
  const targetKey = connectorAccountTargetKey(target);
  if (
    !item.connector.authorized ||
    (item.kind === "custom" && item.connector.integrationManaged)
  ) {
    return null;
  }
  const selection = preference?.selections.find((candidate) => {
    return connectorAccountTargetKey(candidate.target) === targetKey;
  });
  return (
    <ComposerConnectorAccountMenu
      signals={signals}
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
    />
  );
}

function composerPopoverItems({
  agentConnectors,
  agentCustomConnectors,
}: {
  readonly agentConnectors: ComposerConnectorItem[];
  readonly agentCustomConnectors: ComposerCustomConnectorItem[];
}): ComposerPopoverConnectorItem[] {
  return [
    ...agentConnectors.map((connector) => {
      return { kind: "builtin" as const, connector };
    }),
    ...agentCustomConnectors.map((connector) => {
      return { kind: "custom" as const, connector };
    }),
  ];
}

function resolveComposerAgentConnectors(
  connectorData: ComposerConnectorData | undefined,
): {
  readonly agentConnectors: ComposerConnectorItem[];
  readonly agentCustomConnectors: ComposerCustomConnectorItem[];
} {
  const authorizedSet = new Set(
    connectorData?.authorization.enabledConnectorSlugs ?? [],
  );
  const authorizedCustomSet = new Set(
    connectorData?.authorization.customConnectorIds ?? [],
  );
  return {
    agentConnectors: (connectorData?.overview.builtinConnectors ?? []).map(
      (connector) => {
        return {
          ...connector,
          authorized: authorizedSet.has(connector.slug),
        };
      },
    ),
    agentCustomConnectors: (connectorData?.overview.customConnectors ?? []).map(
      (connector) => {
        return {
          ...connector,
          authorized: authorizedCustomSet.has(connector.id),
        };
      },
    ),
  };
}

/**
 * The composer's connector entry. The trigger is a static mark so the composer
 * needs neither the connector overview nor the agent's connector access until
 * the popover opens and mounts its body.
 */
function ConnectorsPopoverButton({
  signals,
  actions,
  onOpenAddDialog,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
  onOpenAddDialog: () => void;
}) {
  const { t } = useTranslation();
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const remoteMenuOpen = connectorUi.remoteMenuOpen;
  const setRemoteMenuOpen = (open: boolean) => {
    updateConnectorUi({ remoteMenuOpen: open });
  };
  const accountMenuOpen = useGet(signals.connector.accounts.menuOpen$);
  const closeAccountMenu = useSet(signals.connector.accounts.closeMenu$);
  const downloadDialogOpen = useGet(
    signals.computer.computerUseDownloadDialogOpen$,
  );
  const setDownloadDialogOpen = useSet(
    signals.computer.setComputerUseDownloadDialogOpen$,
  );
  const handleOpenChange = (open: boolean) => {
    if (open) {
      updateConnectorUi({ popoverOpen: true });
    } else {
      updateConnectorUi({
        popoverOpen: false,
        popoverSortOrder: null,
        popoverSearch: "",
      });
      closeAccountMenu();
      setRemoteMenuOpen(false);
    }
  };

  return (
    <Popover
      open={connectorUi.popoverOpen}
      onOpenChange={(open, eventDetails) => {
        if (!open && eventDetails.reason === "outside-press") {
          if (accountMenuOpen) {
            eventDetails.cancel();
            closeAccountMenu();
            return;
          }
          if (remoteMenuOpen) {
            eventDetails.cancel();
            setRemoteMenuOpen(false);
            return;
          }
        }
        handleOpenChange(open);
      }}
    >
      <TooltipProvider delay={300}>
        <Tooltip>
          <PopoverTrigger
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
        initialFocus={isMobileTextInputDevice() ? false : undefined}
        side="top"
        align="start"
        aria-label={t(($) => {
          return $.chat.connectors.title;
        })}
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        className="flex max-h-[var(--available-height)] w-72 flex-col overflow-hidden p-0"
      >
        {connectorUi.popoverOpen && (
          <ComposerConnectorsPopoverBody
            signals={signals}
            actions={actions}
            remoteMenuOpen={remoteMenuOpen}
            onRemoteMenuOpenChange={setRemoteMenuOpen}
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
    </Popover>
  );
}

function focusComposerConnectorSearch(element: HTMLElement | null) {
  const panel = element?.closest("[data-connector-panel]");
  if (
    panel?.closest("[data-slot='popover-content'][data-open]") &&
    panel.ownerDocument.activeElement === panel &&
    !isMobileTextInputDevice()
  ) {
    panel
      .querySelector<HTMLInputElement>("[data-connector-search]")
      ?.focus({ preventScroll: true });
  }
}

/**
 * The open popover. Mounted only while the popover is open, so it is the
 * component that asks for the agent's connectors and their access.
 */
function ComposerConnectorsPopoverBody({
  signals,
  actions,
  remoteMenuOpen,
  onRemoteMenuOpenChange,
  onOpenAddDialog,
  onOpenDownloadDialog,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
  remoteMenuOpen: boolean;
  onRemoteMenuOpenChange: (open: boolean) => void;
  onOpenAddDialog: () => void;
  onOpenDownloadDialog: () => void;
}) {
  const { t } = useTranslation();
  const agentId = signals.agentId;
  const computerUse = useComposerComputerUse(signals);
  const connectorState = useLoadable(signals.connector.data$);
  const previousConnectorData = useLastResolved(signals.connector.data$);
  const connectorData =
    connectorState.state === "hasData"
      ? connectorState.data
      : connectorState.state === "loading"
        ? previousConnectorData
        : undefined;
  const connectorsLoading =
    connectorState.state === "loading" && connectorData === undefined;
  const { agentConnectors, agentCustomConnectors } =
    resolveComposerAgentConnectors(connectorData);
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const search = connectorUi.popoverSearch;
  const sortOrder = connectorUi.popoverSortOrder;
  const pageSignal = useGet(pageSignal$);
  const waitingForConnectors = connectorsLoading;
  const connectorItems = composerPopoverItems({
    agentConnectors,
    agentCustomConnectors,
  });
  const showSearch = connectorItems.length > 20;
  const visibleConnectors = deriveComposerConnectorPopoverState({
    connectorItems,
    sortOrder,
    search,
    showSearch,
  });
  // The rows are loaded after the popover opens, so their order is pinned when
  // the first toggle could otherwise move them rather than at open time.
  const pinSortOrder = () => {
    if (sortOrder === null) {
      updateConnectorUi({
        popoverSortOrder: connectorItems.map(composerPopoverConnectorId),
      });
    }
  };
  const handleToggle = async (
    connectorSlug: ConnectorSlug,
    checked: boolean,
  ) => {
    pinSortOrder();
    await actions.setAuthorization(
      { kind: "builtin", connectorSlug },
      checked,
      pageSignal,
    );
  };
  const handleCustomToggle = async (connectorId: string, checked: boolean) => {
    pinSortOrder();
    const connector = agentCustomConnectors.find((candidate) => {
      return candidate.id === connectorId;
    });
    if (checked && connector?.permissionBundleRef) {
      return;
    }
    await actions.setAuthorization(
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
    <div
      data-connector-panel
      // Base UI focuses this while loading; once ready, search is first.
      tabIndex={connectorsLoading ? 0 : -1}
      onFocus={(event) => {
        focusComposerConnectorSearch(event.currentTarget);
      }}
      className={cn(
        "flex min-h-0 flex-col outline-none",
        showSearch && "h-100",
      )}
    >
      {connectorState.state === "hasError" && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 p-3 text-sm text-destructive"
        >
          <span>
            {t(($) => {
              return $.chat.connectors.loadFailed;
            })}
          </span>
        </div>
      )}
      {(connectorItems.length > 0 || connectorsLoading) && (
        <div className="flex min-h-0 flex-1 flex-col">
          {showSearch && (
            <div className="mt-1 flex shrink-0 items-center gap-2 px-3 py-1 border-b border-border/50">
              <Search
                size={16}
                aria-hidden="true"
                className="pointer-events-none shrink-0 text-muted-foreground"
              />
              <input
                ref={focusComposerConnectorSearch}
                data-connector-search
                type="text"
                aria-label={t(($) => {
                  return $.chat.connectors.find;
                })}
                placeholder={t(($) => {
                  return $.chat.connectors.find;
                })}
                value={search}
                onChange={(e) => {
                  return updateConnectorUi({
                    popoverSearch: e.target.value,
                  });
                }}
                className="min-w-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
          )}
          {waitingForConnectors ? (
            <div className="flex flex-col pt-1 pb-2 animate-pulse">
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
              // The list's air lives inside the scroller, so a clipped row runs
              // to the card edge and the rule instead of stopping short of
              // them. With search the panel's fixed height bounds the list.
              className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto pb-2",
                !showSearch && "max-h-67 pt-1",
              )}
            >
              {visibleConnectors.map((item) => {
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
                          item={item}
                        />
                      }
                      checked={connector.authorized}
                      onCheckedChange={onDomEventFn(async (checked) => {
                        await handleCustomToggle(connector.id, checked);
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
                    item={item}
                  />
                ) : null;
                const showPermissionAction =
                  Boolean(agentId) &&
                  connector.authorized &&
                  connector.hasPermissions;
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
                            <PopoverClose
                              render={
                                <Button
                                  showTooltip
                                  type="button"
                                  onClick={() => {
                                    updateConnectorUi({
                                      permissionConnectorSlug: connector.slug,
                                      permissionConnector: connector,
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
                              }
                            />
                          ) : null}
                        </>
                      ) : null
                    }
                    checked={connector.authorized}
                    onCheckedChange={onDomEventFn(async (checked) => {
                      await handleToggle(connector.slug, checked);
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
          <div className="mx-3 shrink-0 border-t border-border/50" />
        </div>
      )}
      <div className="flex shrink-0 flex-col p-1">
        <PopoverClose
          render={
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
          }
        />
      </div>
      <ComposerRemoteAccessMenu
        signals={signals}
        computerUse={computerUse}
        remoteMenuOpen={remoteMenuOpen}
        onRemoteMenuOpenChange={onRemoteMenuOpenChange}
        onOpenDownloadDialog={onOpenDownloadDialog}
      />
    </div>
  );
}

/**
 * The permission dialog retains its selected brief and loads only the target's
 * permission metadata and agent grants after the resource menu closes.
 */
function ComposerConnectorPermissionDialogSlot({
  signals,
  connectorSlug,
}: {
  signals: ComposerSignals;
  connectorSlug: ConnectorSlug;
}) {
  const agentId = signals.agentId;
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const agents = useLastResolved(agents$) ?? [];
  const permissionConnector = connectorUi.permissionConnector;
  if (!permissionConnector || permissionConnector.slug !== connectorSlug) {
    return null;
  }
  return (
    <ComposerConnectorPermissionDialog
      signals={signals}
      agentId={agentId}
      agentDisplayName={
        agents.find((agent) => {
          return agent.agentId === agentId;
        })?.displayName ?? ""
      }
      connector={{ ...permissionConnector, authorized: true }}
      onClose={() => {
        updateConnectorUi({
          permissionConnectorSlug: null,
          permissionConnector: null,
        });
      }}
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
  const quotaState = useLoadableState(audioInputQuota$);
  const quotaResolved = useLastResolved(audioInputQuota$) !== undefined;
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
  const recording = capture !== null;
  const [operation, runVoice] = useLoadableSet(signals.voice.run$);
  const status = operation.state === "loading" ? "transcribing" : draftStatus;
  const starting = false;
  const recordingStartedAt = capture?.startedAt ?? null;

  const voiceLevelSamples = useGet(signals.voice.voiceLevelSamples$);
  const signal = useGet(pageSignal$);

  if (status === undefined || status === "idle") {
    return children;
  }
  if (status === "recorded" || status === "failed") {
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
            onClick={() => {
              detach(runVoice("discard", signal), Reason.DomCallback);
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
          disabled={
            !recordingAvailable ||
            operation.state === "hasError" ||
            voiceMessage !== undefined
          }
          onClick={() => {
            detach(runVoice("finish", signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.chat.voice.useRecording;
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
          detach(runVoice("toggle", signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.chat.voice.confirmRecording;
        })}
      </Button>
    </div>
  );
}

/**
 * Group attachments and templates separately from importing skills, which
 * brings workflows in from the user's Claude Code or Codex.
 *
 * Starting a presentation, image, website or visualization deliberately
 * stays out: the task chips sit directly under the composer and already reach
 * every one of them in a single click, so a second copy behind the `+` would be
 * the longer route to the same place.
 */
function useComposerAddMenuGroups(
  signals: ComposerSignals,
): readonly ComposerAddMenuGroup[] {
  const { t } = useTranslation();
  const fileInput = useGet(signals.draft.composerFileInput$);
  const template = useTemplatePickerTrigger(signals);
  const openSkillImportDialog = useSet(openSkillImportDialog$);
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
      {
        id: "template",
        Icon: SwatchBook,
        label: template.label,
        onSelect: template.open,
      },
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
      <ComposerAddMenu groups={groups} />
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

function useComposerTemplatePicker(
  signals: ComposerSignals,
): ComposerTemplatePicker {
  const selectTemplateAndSave = useSet(signals.template.selectTemplateAndSave$);
  const pageSignal = useGet(pageSignal$);
  return {
    onChange(value) {
      if (!value) {
        return;
      }
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
  { singleLineOnMobile, forwardComposer }: ComposerSignals["editor"],
  hasTemplateAttachment: boolean,
): ComposerLayoutHeightClassNames {
  // The start page opens at the compact shell at every width. Most first
  // messages are a line or two, and a field several lines deep reads as a
  // demand for a long message rather than an invitation. The page centres the
  // composer, so every pixel of empty field is also taken from the room the
  // slash and mention menus open into. The input still grows with the draft.
  // The forward dialog shares these signals and is not that page, so it keeps
  // the dialog's shell.
  const startPage = !singleLineOnMobile && !forwardComposer;
  if (hasTemplateAttachment) {
    return singleLineOnMobile
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
  return singleLineOnMobile
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
    <TooltipProvider delay={200}>
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
  onUseForFutureChats: () => void;
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
    </ComposerNoticeTray>
  );
}

function runServiceTier(
  selection: ModelProviderSelection | null | undefined,
): "priority" | null {
  return selection?.codexServiceTier === "fast" ? "priority" : null;
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
    return withChatScrollLayout(null);
  }
  const updating = updateLoadable.state === "loading";
  const modelName = selectedModelDisplayName(catalog, selection.selectedModel);
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

function ComposerTemporaryModelNoticeSlot({
  signals,
}: {
  signals: ComposerSignals;
}) {
  if (!signals.model.temporaryModelNoticeEnabled) {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <ComposerTemporaryModelNotice signals={signals} />,
  );
}

/** The one tray below the card, and the notice that currently owns it. */
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

interface ResolvedComposerConnectorCollections {
  readonly authorizedSet: ReadonlySet<ConnectorSlug>;
  readonly connectorMap: ReadonlyMap<
    ConnectorSlug,
    PlatformConnectorCatalogStatusItem
  >;
  readonly selectedCustomConnector: CustomConnectorResponse | undefined;
}

function resolveComposerConnectorCollections({
  addDialogCatalogItems,
  addDialogCustomConnectors,
  authorizedConnectorSlugs,
  selectedCustomConnectorId,
}: {
  addDialogCatalogItems: readonly PlatformConnectorCatalogStatusItem[];
  addDialogCustomConnectors: readonly CustomConnectorResponse[];
  authorizedConnectorSlugs: readonly ConnectorSlug[] | null;
  selectedCustomConnectorId: string | null;
}): ResolvedComposerConnectorCollections {
  const authorizedSet = new Set(authorizedConnectorSlugs ?? []);
  const connectorMap = new Map(
    addDialogCatalogItems.map((connector) => {
      return [connector.slug, connector];
    }),
  );
  const selectedCustomConnector = selectedCustomConnectorId
    ? addDialogCustomConnectors.find((connector) => {
        return connector.id === selectedCustomConnectorId;
      })
    : undefined;
  return {
    authorizedSet,
    connectorMap,
    selectedCustomConnector,
  };
}

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
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <AttachmentChips
      attachments={attachments}
      annotationSignals={signals.imageAnnotation}
      annotationActions={signals.draft}
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
  onCustomSuccess,
}: {
  readonly selectedConnector: PlatformConnectorCatalogStatusItem | undefined;
  readonly selectedConnectorAccountOptions: DefaultConnectorAccountMutationOptions | null;
  readonly selectedCustomConnector: CustomConnectorResponse | undefined;
  readonly selectedCustomConnectorAccountOptions: CustomConnectorAccountMutationOptions | null;
  readonly agentId: string;
  readonly onBuiltinClose: () => void;
  readonly onBuiltinSuccess: ConnectorConnectSuccess;
  readonly onCustomClose: () => void;
  readonly onCustomSuccess: () => void;
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
          onSuccess={onCustomSuccess}
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
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const openAddConnectorsDialog = useSet(
    signals.connector.openAddConnectorsDialog$,
  );
  const dialogsOpen =
    connectorUi.showAddDialog ||
    connectorUi.selectedConnector !== null ||
    connectorUi.selectedCustomConnectorId !== null;
  return (
    <>
      <ConnectorsPopoverButton
        signals={signals}
        actions={actions}
        onOpenAddDialog={openAddConnectorsDialog}
      />
      {connectorUi.permissionConnectorSlug !== null && (
        <ComposerConnectorPermissionDialogSlot
          signals={signals}
          connectorSlug={connectorUi.permissionConnectorSlug}
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
 * because they are what needs the connector catalog and the agent's access.
 */
function ComposerConnectorDialogsSlot({
  signals,
  actions,
}: {
  signals: ComposerSignals;
  actions: ComposerConnectorActions;
}) {
  const { t } = useTranslation();
  const lastAuthorization = useLastResolved(
    signals.connector.connectorAuthorization$,
  );
  const authorization =
    lastAuthorization?.agentId === signals.agentId
      ? lastAuthorization
      : undefined;
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
  const agents = useLastResolved(agents$) ?? [];
  const connectorUi = useGet(signals.connector.connectorUiState$);
  const updateConnectorUi = useSet(signals.connector.updateConnectorUiState$);
  const completeAddition = useSet(
    signals.connectorCompletion.completeConnectorAddition$,
  );
  const completeCustomAddition = useSet(
    signals.connectorCompletion.completeCustomConnectorAddition$,
  );

  const pageSignal = useGet(pageSignal$);
  const selectedConnectorSlug = connectorUi.selectedConnectorSlug;
  const selectedCustomConnectorId = connectorUi.selectedCustomConnectorId;
  const agentRecordId = signals.agentId;
  const displayName =
    agents.find((agent) => {
      return agent.agentId === agentRecordId;
    })?.displayName ?? "";

  const { authorizedSet, connectorMap, selectedCustomConnector } =
    resolveComposerConnectorCollections({
      addDialogCatalogItems,
      addDialogCustomConnectors,
      authorizedConnectorSlugs: authorization?.enabledConnectorSlugs ?? null,
      selectedCustomConnectorId,
    });
  const selectedConnector = connectorUi.selectedConnector ?? undefined;
  const selectedConnectorAccountOptions =
    defaultBuiltinConnectorAccountOptions(selectedConnector);
  const selectedCustomConnectorAccountOptions =
    defaultCustomConnectorAccountOptions(selectedCustomConnector);

  const showConnectSuccess = (connectorSlug: ConnectorSlug) => {
    const label = connectorMap.get(connectorSlug)?.label ?? connectorSlug;
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
    signal: AbortSignal,
  ): Promise<void> => {
    const newlyAuthorized = await completeAddition(
      connectorSlug,
      authorization?.agentId === agentRecordId &&
        authorizedSet.has(connectorSlug),
      signal,
    );
    signal.throwIfAborted();
    if (newlyAuthorized) {
      showConnectSuccess(connectorSlug);
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
    const completeDirectConnection: ConnectorConnectSuccess = (
      connectionId,
      signal,
    ) => {
      return actions.runConnectSuccess(
        (_completedConnectionId, continuationSignal) => {
          return completeConnectorAddition(connectorSlug, continuationSignal);
        },
        connectionId,
        connectorSlug,
        signal,
      );
    };
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
              agentId: agentRecordId,
              ...accountOptions,
            },
            onSuccess: completeDirectConnection,
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
            onSuccess: completeDirectConnection,
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

  return (
    <>
      <ComposerConnectorConnectDialogs
        selectedConnector={selectedConnector}
        selectedConnectorAccountOptions={selectedConnectorAccountOptions}
        selectedCustomConnector={selectedCustomConnector}
        selectedCustomConnectorAccountOptions={
          selectedCustomConnectorAccountOptions
        }
        agentId={agentRecordId}
        onBuiltinClose={() => {
          updateConnectorUi({
            selectedConnectorSlug: null,
            selectedConnector: null,
          });
        }}
        onBuiltinSuccess={async (_connectionId, signal) => {
          const connectorSlug = selectedConnectorSlug;
          if (connectorSlug) {
            await completeConnectorAddition(connectorSlug, signal);
          }
        }}
        onCustomClose={() => {
          updateConnectorUi({ selectedCustomConnectorId: null });
        }}
        onCustomSuccess={() => {
          completeCustomAddition();
        }}
      />
      {connectorUi.showAddDialog && (
        <ConnectorDirectoryDialog
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
            updateConnectorUi({
              showAddDialog: false,
              permissionConnectorSlug: connectorSlug,
              permissionConnector: {
                slug: connector.slug,
                label: connector.label,
                icon: connector.icon,
                hasPermissions: connector.permissionSummary.hasPermissions,
              },
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
        <ComposerTemplatePickerSlot signals={signals} />
        <ComposerConnectorsSlot signals={signals} actions={connectorActions} />
        <ComposerTaskControls signals={signals} />
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
  return withChatScrollLayout(
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
    </div>,
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

function ComposerCard({ signals }: { signals: ComposerSignals }) {
  const actions = useComposerActions(signals);
  const connectorActions = useComposerConnectorActions(signals.connector);
  const hasTemplateAttachment = useGet(signals.template.hasTemplateAttachment$);
  const dragOver = useGet(signals.draft.dragOver$);
  const setDragOver = useSet(signals.draft.setDragOver$);
  const uploadFile = useComposerFileUpload(signals);
  const notifyDraftChanged = useComposerDraftChange(signals);
  const layoutHeightClassNames = composerLayoutHeightClassNames(
    signals.editor,
    hasTemplateAttachment,
  );

  return (
    <Card
      data-slot="chat-composer-card"
      surface="composer"
      className={cn(
        "z-10",
        "[@media(display-mode:standalone)]:[[data-chat-composer]_&]:scroll-mb-4",
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
}: ChatComposerProps) {
  const setImageAnnotationLifecycleRef = useSet(
    signals.setImageAnnotationLifecycleRef$,
  );
  return (
    <>
      {/* The composer group's width, named once. The card is not the container
          itself: the model-scope notice and the pending-items strip are its
          siblings at exactly this width, and a control that reads a width it is
          not inside reads the window instead. */}
      <div
        ref={setImageAnnotationLifecycleRef}
        className="@container/composer relative flex w-full min-w-0 flex-col"
      >
        {showPendingItems ? <PendingItemsStrip signals={signals} /> : null}
        <ComposerCard signals={signals} />
        <ComposerNoticeSlot signals={signals} />
        <ImageAnnotationEditor signals={signals.imageAnnotation} />
      </div>
    </>
  );
}
