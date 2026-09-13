import type { ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  Check,
  ChevronDown,
  Cpu,
  Image as ImageIcon,
  MessageCircle,
  Video,
  Zap,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SegmentControl,
  SegmentControlItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  getProvidersForModel,
  isBuiltInModelProviderType,
  isCodexFastModeModel,
  isSupportedRunModel,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  VIDEO_MODEL_CONFIGS,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import { useTranslation } from "react-i18next";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  modelPolicyAllowedForPlan,
  type ModelPlanCapabilities,
} from "../../../signals/okou-page/model-plan-capabilities";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../signals/page-signal";
import { resolveExplicitModelSelection$ } from "../../../signals/okou-page/model-default-selection";
import { detach, Reason } from "../../../signals/utils";
import {
  getMediaModelPriceTierLabel,
  getModelBrandIconType,
  getBuiltInModelPriceTier,
  getBuiltInModelPriceTierLabel,
  type ModelPriceTier,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";
import { settingsIconAssetUrl } from "./settings/settings-icon-assets";

import type { ModelPickerMenuSignals } from "../../../signals/okou-page/model-picker-menu.ts";
import { PriceTierBadge } from "./model-picker-price-tier.tsx";
import {
  ModelPickerFlyoutContent,
  ModelPickerMenuContent,
} from "./model-picker-menu.tsx";

import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";

export interface ModelProviderSelection {
  selectedModel: SupportedRunModel;
  codexServiceTier?: CodexServiceTier;
  modelSettings?: ModelSettings;
}

export interface MediaModelPanelOption {
  readonly key: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** What one reference generation costs, relative to the other rows here. */
  readonly priceTier: ModelPriceTier;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

export type MediaModelCategoryId = "image" | "video";

export interface MediaModelPanelCategory {
  readonly id: MediaModelCategoryId;
  readonly label: string;
  /** Short form for the desktop category strip, where three tabs share a row. */
  readonly tabLabel: string;
  readonly options: readonly MediaModelPanelOption[];
}

/**
 * Media-model categories share the run-model popover without joining its
 * Select value space. Both layouts drive the same active category: desktop
 * switches it from the tab strip, mobile from a nested drill-in.
 */
export interface MediaModelPanelState {
  readonly activeCategory: MediaModelCategoryId | null;
  readonly categories: readonly MediaModelPanelCategory[];
  readonly onActiveCategoryChange: (
    category: MediaModelCategoryId | null,
  ) => void;
}

interface ModelProviderPickerProps {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /**
   * Classes applied to the picker trigger. Defaults to `h-9 w-full`. The
   * composer passes an auto-width, compact variant to fit next to Send.
   */
  triggerClassName?: string;
  /**
   * When true, the trigger shows only the friendly model name (no provider
   * label, no price tier badge). Used by the chat composer where horizontal
   * space is tight and the full breakdown lives in the open dropdown.
   */
  compactTrigger?: boolean;
  /**
   * When true, the trigger renders as a provider icon on mobile while keeping
   * the normal label on larger screens.
   */
  mobileIconTrigger?: boolean;
  /** Controlled open state for programmatic toggle (e.g. keyboard shortcut). */
  open?: boolean;
  /** Callback when the open state changes. */
  onOpenChange?: (
    open: boolean,
    eventDetails: { readonly event: Event; readonly cancel: () => void },
  ) => void;
  /** Whether the open picker blocks interaction with surrounding controls. */
  modal?: boolean;
  // When true, picker is read-only for the current caller state.
  disabled?: boolean;
  /** Enables the inline Codex Fast choices in the model list. */
  codexFastModeEnabled?: boolean;
  /** Lets settings callers clear a personal choice and inherit workspace default. */
  showInheritOption?: boolean;
  /** Media-model category panel state for composer callers. */
  mediaModelPanel?: MediaModelPanelState;
  /** Composer-owned navigation for the compact model menu rollout. */
  menuSignals?: ModelPickerMenuSignals;
  /** Replaces the menu's pages with the detached type/model flyout. */
  flyoutLayout?: boolean;
  /** Lets the flyout dismiss itself once a model has been committed. */
  onSelected?: () => void;
  /** Model omitted from this caller's list of available choices. */
  excludedModel?: SupportedRunModel;
}

// Keep the inherit option distinct from an empty model identifier at the UI
// boundary so its value remains stable across controlled Select updates.
const INHERIT_SENTINEL = "__inherit_default__";
const CODEX_FAST_OPTION_PREFIX = "__codex_fast_option__:";
const CODEX_FAST_SELECTED_PREFIX = "__codex_fast_selected__:";

// Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
// These items are also `disabled`, and SelectItem's base `data-[disabled]:opacity-50`
// outranks a plain `opacity-0` on specificity, so restate the hidden opacity under
// the disabled variant to stop the measuring item from bleeding through.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 data-[disabled]:opacity-0 pointer-events-none";

function ByokBadge() {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
            BYOK
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t(($) => {
            return $.settings.models.picker.byokHelp;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ProBadge() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 rounded bg-primary px-1.5 py-0.5 text-[11px] font-medium leading-none text-primary-foreground">
      {t(($) => {
        return $.settings.models.picker.pro;
      })}
    </span>
  );
}

function ResponsiveTriggerContent({
  mobileIcon,
  iconType,
  label,
}: {
  mobileIcon: boolean;
  iconType: ModelProviderType | undefined;
  label: ReactNode;
}) {
  if (!mobileIcon) {
    return label;
  }
  return (
    <span className="flex items-center min-w-0">
      <span className="flex items-center justify-center sm:hidden">
        {iconType ? (
          <ProviderIcon type={iconType} size={18} />
        ) : (
          <Cpu size={18} />
        )}
      </span>
      <span className="hidden min-w-0 sm:inline-flex sm:items-center sm:gap-1.5">
        {iconType && <ProviderIcon type={iconType} size={16} />}
        {label}
      </span>
    </span>
  );
}

// Read-only span reuses the trigger's geometry classes but must not echo
// its interactive affordances (hover/focus/open-state), so callers don't
// have to branch their className for the disabled case.
function stripInteractiveClasses(cls: string | undefined): string | undefined {
  if (!cls) {
    return cls;
  }
  return cls
    .split(/\s+/)
    .filter((c) => {
      return (
        !c.startsWith("hover:") &&
        !c.startsWith("focus:") &&
        !c.startsWith("focus-visible:") &&
        !c.startsWith("active:") &&
        !c.startsWith("data-popup-open:")
      );
    })
    .join(" ");
}

function getModelFirstIconType(model: string): ModelProviderType | undefined {
  if (isSupportedRunModel(model)) {
    return getModelBrandIconType(model);
  }
  return getProvidersForModel(model).find((type) => {
    return !isBuiltInModelProviderType(type);
  });
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  policies: OrgModelPolicy[],
  modelCapabilities: ModelPlanCapabilities,
): ModelProviderSelection | null {
  if (!value) {
    return null;
  }
  const policy = policies.find((candidate) => {
    return candidate.model === value.selectedModel;
  });
  const allowed = policy
    ? modelPolicyAllowedForPlan(policy, modelCapabilities)
    : modelAllowedForPlan(value.selectedModel, modelCapabilities);
  return allowed ? value : null;
}

function selectionLabel({
  selection,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): string {
  if (!selection) {
    return placeholder;
  }
  const modelLabel = getCanonicalModelDisplayName(selection.selectedModel);
  return codexFastModeEnabled && selection.codexServiceTier === "fast"
    ? `${modelLabel} ${fastLabel}`
    : modelLabel;
}

function ModelFirstTriggerLabel({
  selection,
  placeholder,
  mobileIcon,
  codexFastModeEnabled,
  fastLabel,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  if (!selection) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selection.selectedModel);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="min-w-0 truncate">
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </span>
      }
    />
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  mobileIconTrigger,
  triggerClassName,
  codexFastModeEnabled,
  fastLabel,
}: Pick<
  ModelProviderPickerProps,
  "value" | "placeholder" | "mobileIconTrigger" | "triggerClassName"
> & {
  placeholder: string;
  mobileIconTrigger: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}) {
  const label = selectionLabel({
    selection: value,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
  });
  return (
    <span
      aria-label={label}
      className={cn(
        "inline-flex items-center px-2 text-sm text-muted-foreground cursor-default",
        stripInteractiveClasses(triggerClassName),
      )}
    >
      <ModelFirstTriggerLabel
        selection={value}
        placeholder={placeholder}
        mobileIcon={mobileIconTrigger}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (raw.startsWith(CODEX_FAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_FAST_OPTION_PREFIX.length);
    if (
      codexFastModeEnabled &&
      isSupportedRunModel(selectedModel) &&
      isCodexFastModeModel(selectedModel)
    ) {
      return { selectedModel, codexServiceTier: "fast" };
    }
    return null;
  }
  if (!isSupportedRunModel(raw)) {
    return null;
  }
  return {
    selectedModel: raw,
  };
}

function modelFirstSelectValue(
  selection: ModelProviderSelection | null,
): string {
  if (!selection) {
    return INHERIT_SENTINEL;
  }
  return selection.codexServiceTier === "fast"
    ? `${CODEX_FAST_SELECTED_PREFIX}${selection.selectedModel}`
    : selection.selectedModel;
}

function codexFastOptionValue(model: string): string {
  return `${CODEX_FAST_OPTION_PREFIX}${model}`;
}

function modelFirstSelectionFromInteraction(
  raw: string,
  currentSelection: ModelProviderSelection | null,
  codexFastModeEnabled: boolean,
): ModelProviderSelection | null | undefined {
  if (codexFastModeEnabled && currentSelection?.codexServiceTier === "fast") {
    if (raw === currentSelection.selectedModel) {
      return undefined;
    }
    if (raw === codexFastOptionValue(currentSelection.selectedModel)) {
      return { selectedModel: currentSelection.selectedModel };
    }
  }
  return modelFirstSelectionFromRaw(raw, codexFastModeEnabled);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === INHERIT_SENTINEL || value.startsWith(CODEX_FAST_SELECTED_PREFIX)
  );
}

function ModelFirstPolicyRowContent({
  policy,
  modelCapabilities,
  selected = false,
  showSelectedIndicator = false,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const iconType = getModelFirstIconType(policy.model);
  const builtInPriceTier = isBuiltInModelProviderType(
    policy.defaultProviderType,
  )
    ? getBuiltInModelPriceTier(policy.model)
    : undefined;
  const restricted = !modelPolicyAllowedForPlan(policy, modelCapabilities);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {iconType && <ProviderIcon type={iconType} size={16} />}
      <span className="min-w-0 flex-1 truncate">
        {policy.modelLabel || getCanonicalModelDisplayName(policy.model)}
      </span>
      {builtInPriceTier !== undefined ? (
        <PriceTierBadge
          tier={builtInPriceTier}
          description={getBuiltInModelPriceTierLabel(builtInPriceTier)}
        />
      ) : (
        <ByokBadge />
      )}
      {restricted && <ProBadge />}
      {showSelectedIndicator && (
        <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center text-foreground">
          {selected && <Check size={15} />}
        </span>
      )}
    </span>
  );
}

function ModelFirstPolicyRow({
  policy,
  modelCapabilities,
  selection,
  codexFastModeEnabled,
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selection: ModelProviderSelection | null;
  codexFastModeEnabled: boolean;
}) {
  const { t } = useTranslation();
  const fastAvailable =
    codexFastModeEnabled &&
    policy.routeStatus === "valid" &&
    isCodexFastModeModel(policy.model);
  if (fastAvailable) {
    const modelLabel =
      policy.modelLabel || getCanonicalModelDisplayName(policy.model);
    const selected = selection?.selectedModel === policy.model;
    const fastSelected = selected && selection.codexServiceTier === "fast";
    const fastLabel = t(($) => {
      return $.settings.models.picker.fast;
    });
    const fastImpact = t(($) => {
      return $.settings.models.picker.fastImpact;
    });
    return (
      <div
        className={cn(
          "relative flex overflow-hidden rounded-lg transition-colors hover:bg-state-hover has-[[data-highlighted]]:bg-state-hover",
          selected &&
            "bg-state-selected hover:bg-state-selected-hover has-[[data-highlighted]]:bg-state-selected-hover",
        )}
      >
        <SelectItem
          value={policy.model}
          aria-label={modelLabel}
          // Two fixed columns sit at this row's right edge: the checkmark's
          // (`pr-8`, shared with every other row) and the fast toggle's, which
          // `pr-16` reserves immediately left of it. Both are reserved whether
          // or not the row is selected -- shifting the content only when
          // selected is what used to push the checkmark off its column.
          className="min-w-0 flex-1 rounded-lg pr-16 hover:bg-transparent data-highlighted:bg-transparent"
        >
          <ModelFirstPolicyRowContent
            policy={policy}
            modelCapabilities={modelCapabilities}
            selected={selected}
            showSelectedIndicator={fastSelected}
          />
        </SelectItem>
        <TooltipProvider delayDuration={800} skipDelayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectItem
                value={codexFastOptionValue(policy.model)}
                aria-label={`${modelLabel} ${fastLabel}`}
                className={cn(
                  // `right-8` parks the toggle in its own column beside the
                  // checkmark's rather than on top of it, so it keeps a full
                  // 32x32 hit area without ever displacing the check.
                  "group/fast-option absolute inset-y-0 right-8 w-8 justify-center rounded-lg px-0 text-muted-foreground hover:bg-transparent data-highlighted:bg-transparent",
                  fastSelected &&
                    "text-amber-600 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200",
                )}
              >
                <Zap
                  size={18}
                  fill={fastSelected ? "currentColor" : "none"}
                  className={cn(
                    fastSelected
                      ? "group-hover/fast-option:fill-none group-data-[highlighted]/fast-option:fill-none"
                      : "group-hover/fast-option:fill-current group-data-[highlighted]/fast-option:fill-current",
                  )}
                  aria-hidden="true"
                />
              </SelectItem>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {fastLabel} · {fastImpact}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }
  return (
    <SelectItem
      key={policy.id}
      value={policy.model}
      disabled={policy.routeStatus !== "valid"}
    >
      <ModelFirstPolicyRowContent
        policy={policy}
        modelCapabilities={modelCapabilities}
      />
    </SelectItem>
  );
}

function ModelFirstPolicyItems({
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  placeholder,
  showInheritOption,
  showSeparator = true,
  showModelsLabel = true,
}: {
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  placeholder: string;
  showInheritOption: boolean;
  showSeparator?: boolean;
  /** When false, the media-model header already carries the category title. */
  showModelsLabel?: boolean;
}) {
  const { t } = useTranslation();
  const explicitSelectedModel = selection?.selectedModel ?? null;
  const hasExplicitSelectedPolicy =
    explicitSelectedModel === null ||
    policies.some((policy) => {
      return policy.model === explicitSelectedModel;
    });
  return (
    <>
      {showInheritOption && (
        <SelectItem value={INHERIT_SENTINEL}>{placeholder}</SelectItem>
      )}
      {showSeparator && (!hasExplicitSelectedPolicy || policies.length > 0) && (
        <SelectSeparator className="my-0" />
      )}
      {!hasExplicitSelectedPolicy && explicitSelectedModel && (
        <SelectItem
          value={explicitSelectedModel}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {getCanonicalModelDisplayName(explicitSelectedModel)}
        </SelectItem>
      )}
      {policies.length === 0 ? (
        <div className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </div>
      ) : (
        <SelectGroup>
          {showModelsLabel && (
            <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
              {t(($) => {
                return $.settings.models.picker.models;
              })}
            </SelectLabel>
          )}
          {policies.map((policy) => {
            return (
              <ModelFirstPolicyRow
                key={policy.id}
                policy={policy}
                modelCapabilities={modelCapabilities}
                selection={selection}
                codexFastModeEnabled={codexFastModeEnabled}
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

// Rows in media-model panels are plain buttons rather than SelectItems: the
// Select's value space belongs to the run model, and a SelectItem here would
// both join it and close the popover on click.
const MEDIA_MODEL_PANEL_ROW_CLASS =
  "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-lg py-1.5 pl-2 pr-8 text-left text-sm outline-none transition-colors hover:bg-state-hover hover:text-accent-foreground";

const BYTEDANCE_ICON_PATH =
  "M19.8772 1.4685 24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428 4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z";
const FLUX_ICON_PATH =
  "M0 20.683L12.01 2.5 24 20.683h-2.233L12.009 5.878 3.471 18.806h12.122l1.239 1.877H0z M8.069 16.724l2.073-3.115 2.074 3.115H8.069zM18.24 20.683l-5.668-8.707h2.177l5.686 8.707h-2.196zM19.74 11.676l2.13-3.19 2.13 3.19h-4.26z";
const QWEN_ICON_PATH =
  "M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z";
const IDEOGRAM_ICON_PATH =
  "M9.431 12.002C9.431 11.928 9.48 11.864 9.552 11.847C10.709 11.582 10.945 11.006 10.945 10.187C10.945 5.818 7.406 10.636 7.406 7.377C7.406 5.159 11.4 8.389 11.4 6.489C11.4 5.272 9.171 4.326 8.606 3.914C8.244 3.649 7.821 3.152 8.209 2.717C8.533 2.354 9.042 2.424 9.296 2.826C9.587 3.287 9.869 3.972 10.492 3.904C11.97 3.742 11.132 1.868 10.431 1.325C9.608.688 8.392 1.001 7.607 1.543C6.75 2.132 6.498 3.24 5.664 3.846C5.12 4.24 4.353 4.367 3.71 4.571C2.431 4.98 1.156 5.691.471 6.808C-.35 8.147-.106 10.091 1.27 11.045C2.132 11.641 5.099 12.113 5.112 10.133C5.117 9.351 4.782 8.569 3.08 9.586C1.771 10.369 1.656 7.82 2.152 7.216C3.018 6.163 3.189 8.266 4.635 7.603C5.888 7.029 1.959 5.414 6.19 5.521C8.476 5.578 4.88 7.108 5.907 9.343C6.685 11.035 9.218 8.578 7.985 10.558C7.852 10.772 7.674 11.064 7.512 11.329C7.262 11.741 7.262 12.265 7.512 12.677C7.674 12.941 7.851 13.233 7.985 13.447C9.219 15.426 6.685 12.97 5.907 14.662C4.88 16.896 8.476 18.426 6.19 18.483C1.959 18.59 5.887 16.976 4.635 16.402C3.19 15.739 3.018 17.842 2.152 16.788C1.656 16.185 1.771 13.637 3.08 14.419C4.782 15.435 5.117 14.653 5.112 13.872C5.098 11.892 2.132 12.363 1.27 12.96C-.106 13.914-.35 15.858.471 17.197C1.156 18.313 2.432 19.025 3.71 19.433C4.353 19.639 5.12 19.765 5.664 20.16C6.498 20.765 6.75 21.873 7.607 22.463C8.393 23.003 9.608 23.318 10.431 22.681C11.132 22.137 11.97 20.263 10.492 20.101C9.869 20.033 9.587 20.719 9.296 21.179C9.042 21.58 8.532 21.65 8.209 21.288C7.821 20.851 8.243 20.355 8.606 20.091C9.171 19.679 11.4 18.733 11.4 17.515C11.4 15.616 7.406 18.845 7.406 16.627C7.406 13.37 10.945 18.186 10.945 13.818C10.945 12.997 10.709 12.421 9.552 12.157C9.481 12.141 9.431 12.077 9.431 12.004V12.002ZM14.572 12.002C14.572 12.075 14.521 12.139 14.45 12.156C13.294 12.421 13.058 12.997 13.058 13.817C13.058 18.185 16.598 13.368 16.598 16.627C16.598 18.845 12.604 15.615 12.604 17.514C12.604 18.732 14.833 19.677 15.398 20.09C15.76 20.354 16.183 20.851 15.794 21.287C15.471 21.649 14.961 21.578 14.708 21.178C14.417 20.717 14.135 20.032 13.512 20.1C12.034 20.262 12.872 22.136 13.573 22.678C14.395 23.316 15.612 23.002 16.397 22.461C17.253 21.871 17.506 20.764 18.34 20.158C18.883 19.764 19.65 19.637 20.294 19.432C21.572 19.024 22.848 18.313 23.533 17.196C24.353 15.857 24.111 13.913 22.733 12.959C21.872 12.362 18.905 11.891 18.892 13.871C18.886 14.653 19.221 15.434 20.924 14.417C22.232 13.635 22.348 16.184 21.853 16.787C20.986 17.841 20.816 15.738 19.369 16.401C18.117 16.975 22.044 18.588 17.813 18.482C15.528 18.425 19.124 16.895 18.096 14.661C17.318 12.969 14.786 15.425 16.019 13.445C16.151 13.232 16.33 12.939 16.491 12.675C16.742 12.262 16.742 11.738 16.491 11.327C16.33 11.062 16.153 10.771 16.019 10.556C14.785 8.577 17.318 11.034 18.096 9.342C19.124 7.107 15.528 5.577 17.813 5.52C22.044 5.413 18.117 7.028 19.369 7.602C20.815 8.265 20.986 6.162 21.853 7.215C22.349 7.819 22.233 10.367 20.924 9.585C19.221 8.568 18.886 9.351 18.892 10.132C18.905 12.112 21.872 11.64 22.733 11.044C24.11 10.09 24.353 8.146 23.533 6.807C22.848 5.69 21.572 4.979 20.294 4.57C19.65 4.365 18.883 4.239 18.34 3.844C17.506 3.239 17.253 2.13 16.397 1.541C15.611 1 14.395.686 13.573 1.323C12.872 1.867 12.034 3.741 13.512 3.903C14.135 3.971 14.417 3.285 14.708 2.825C14.961 2.423 15.472 2.353 15.794 2.716C16.183 3.152 15.761 3.648 15.398 3.913C14.833 4.324 12.604 5.271 12.604 6.488C12.604 8.388 16.598 5.159 16.598 7.376C16.598 10.634 13.058 5.817 13.058 10.186C13.058 11.006 13.294 11.582 14.45 11.846C14.521 11.862 14.572 11.926 14.572 12V12.002Z";
const GEMINI_ICON_PATH =
  "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";

const MINIMAX_ICON_URL = settingsIconAssetUrl("minimax");

function ImageModelBrandSvg({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={path} />
    </svg>
  );
}

function QwenImageModelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={QWEN_ICON_PATH} fill="url(#image-model-qwen-gradient)" />
      <defs>
        <linearGradient
          id="image-model-qwen-gradient"
          x1="0%"
          x2="100%"
          y1="0%"
          y2="0%"
        >
          <stop offset="0%" stopColor="#6336e7" stopOpacity={0.84} />
          <stop offset="100%" stopColor="#6f69f7" stopOpacity={0.84} />
        </linearGradient>
      </defs>
    </svg>
  );
}

function GeminiImageModelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={GEMINI_ICON_PATH} fill="#3186ff" />
      <path
        d={GEMINI_ICON_PATH}
        fill="url(#image-model-gemini-green-gradient)"
      />
      <path d={GEMINI_ICON_PATH} fill="url(#image-model-gemini-red-gradient)" />
      <path
        d={GEMINI_ICON_PATH}
        fill="url(#image-model-gemini-yellow-gradient)"
      />
      <defs>
        <linearGradient
          id="image-model-gemini-green-gradient"
          x1="7"
          x2="11"
          y1="15.5"
          y2="12"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#08b962" />
          <stop offset="1" stopColor="#08b962" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="image-model-gemini-red-gradient"
          x1="8"
          x2="11.5"
          y1="5.5"
          y2="11"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#f94543" />
          <stop offset="1" stopColor="#f94543" stopOpacity={0} />
        </linearGradient>
        <linearGradient
          id="image-model-gemini-yellow-gradient"
          x1="3.5"
          x2="17.5"
          y1="13.5"
          y2="12"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#fabc12" />
          <stop offset="0.46" stopColor="#fabc12" stopOpacity={0} />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function ImageModelBrandIcon({ model }: { model: ImageModel }) {
  switch (model) {
    case "gpt-image-1":
    case "gpt-image-2":
    case "gpt-image-2.5-flare":
    case "gpt-image-2.5-sunburst": {
      return <ProviderIcon type="openai-api-key" size={16} />;
    }
    case "fal-ai/flux-pro/v1.1":
    case "fal-ai/flux-pro/v1.1-ultra":
    case "fal-ai/flux-2-pro": {
      return <ImageModelBrandSvg path={FLUX_ICON_PATH} />;
    }
    case "fal-ai/qwen-image":
    case "alibaba/qwen-image-3/text-to-image": {
      return <QwenImageModelIcon />;
    }
    case "fal-ai/bytedance/seedream/v4/text-to-image": {
      return <ImageModelBrandSvg path={BYTEDANCE_ICON_PATH} />;
    }
    case "dola-seedream-5-0-pro-260628":
    case "seedream-5-0-lite-260128": {
      return <ImageModelBrandSvg path={BYTEDANCE_ICON_PATH} />;
    }
    case "fal-ai/nano-banana-2":
    case "google/nano-banana-2-lite": {
      return <GeminiImageModelIcon />;
    }
    case "ideogram/v4": {
      return <ImageModelBrandSvg path={IDEOGRAM_ICON_PATH} />;
    }
  }
}

function VideoModelVeoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M5.988 1.622A8.539 8.539 0 0 0 3.45 8.446c.349 4.408 4.506 7.995 8.276 7.995 3.507 0 4.88-3.061 4.541-5.14a4.318 4.318 0 0 0-.95-2.073c.632.34 1.244.776 1.809 1.3 1.52 1.415 2.44 3.229 2.587 5.1C20.04 19.763 16.98 24 11.863 24c-1.695 0-3.48-.432-4.98-1.143C2.816 20.937 0 16.797 0 12.002 0 7.571 2.405 3.7 5.988 1.622zM12.136 0c1.696 0 3.481.432 4.98 1.143C21.186 3.063 24 7.203 24 11.998c0 4.431-2.405 8.303-5.988 10.38a8.539 8.539 0 0 0 2.538-6.824c-.349-4.408-4.506-7.995-8.276-7.995-3.507 0-4.88 3.061-4.541 5.14a4.3 4.3 0 0 0 .953 2.073 8.723 8.723 0 0 1-1.81-1.3c-1.52-1.415-2.44-3.227-2.589-5.1C3.96 4.237 7.02 0 12.137 0z"
        fill="url(#video-model-veo-gradient)"
        fillRule="evenodd"
      />
      <defs>
        <linearGradient
          id="video-model-veo-gradient"
          x1="2"
          x2="22"
          y1="4"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#78b8ff" />
          <stop offset="1" stopColor="#8d8cff" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function VideoModelKlingIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M5.412 13.775A23.193 23.193 0 0 1 7.41 9.32c3.17-5.492 7.795-8.757 10.33-7.294C12.038-1.266 4.598.944 1.122 6.964A13.378 13.378 0 0 0 .085 9.22c-.259.739.092 1.534.77 1.926l4.557 2.63z"
        fill="url(#video-model-kling-outer-start)"
      />
      <path
        d="M18.588 10.164a23.188 23.188 0 0 1-1.999 4.455c-3.17 5.492-7.795 8.758-10.33 7.294 5.703 3.293 13.143 1.082 16.619-4.938a13.392 13.392 0 0 0 1.037-2.255c.259-.738-.092-1.534-.77-1.925l-4.557-2.63z"
        fill="url(#video-model-kling-outer-end)"
      />
      <path
        d="M16.59 14.62c3.17-5.492 3.686-11.13 1.15-12.594C15.207.563 10.582 3.83 7.41 9.32c2.074-3.59 5.809-5.315 8.344-3.852 2.534 1.464 2.908 5.56.835 9.151z"
        fill="url(#video-model-kling-inner-start)"
      />
      <path
        d="M7.41 9.32c-3.17 5.492-3.686 11.13-1.15 12.593 2.534 1.464 7.159-1.802 10.33-7.294-2.074 3.591-5.809 5.316-8.344 3.852-2.534-1.463-2.908-5.56-.835-9.15z"
        fill="url(#video-model-kling-inner-end)"
      />
      <defs>
        <radialGradient
          id="video-model-kling-outer-start"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="matrix(7.47772 -12.51022 17.14368 10.24728 5.173 13.637)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".095" stopColor="#fff959" />
          <stop offset=".326" stopColor="#0df35e" />
          <stop offset=".64" stopColor="#0bf2f9" />
          <stop offset="1" stopColor="#04a6f0" />
        </radialGradient>
        <radialGradient
          id="video-model-kling-outer-end"
          cx="0"
          cy="0"
          r="1"
          gradientTransform="rotate(120.868 6.491 10.491) scale(14.5747 19.9728)"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset=".095" stopColor="#fff959" />
          <stop offset=".326" stopColor="#0df35e" />
          <stop offset=".64" stopColor="#0bf2f9" />
          <stop offset="1" stopColor="#04a6f0" />
        </radialGradient>
        <linearGradient
          id="video-model-kling-inner-start"
          x1="15.578"
          x2="18.062"
          y1="1.798"
          y2="9.861"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#003eff" />
          <stop offset="1" stopColor="#0bffe7" />
        </linearGradient>
        <linearGradient
          id="video-model-kling-inner-end"
          x1="8.422"
          x2="5.938"
          y1="22.142"
          y2="14.079"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#003eff" />
          <stop offset="1" stopColor="#0bffe7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function VideoModelBrandIcon({ model }: { model: VideoModel }) {
  const config = VIDEO_MODEL_CONFIGS[model];
  const brand =
    config.provider === "byteplus"
      ? "bytedance"
      : config.provider === "minimax"
        ? "minimax"
        : config.requestFormat;
  if (brand === "minimax") {
    return (
      <img
        src={MINIMAX_ICON_URL}
        width={16}
        height={16}
        alt=""
        className="shrink-0"
      />
    );
  }
  if (brand === "veo") {
    return <VideoModelVeoIcon />;
  }
  if (brand === "kling") {
    return <VideoModelKlingIcon />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d={BYTEDANCE_ICON_PATH} />
    </svg>
  );
}

function MediaModelPanelRow({ option }: { option: MediaModelPanelOption }) {
  return (
    <button
      type="button"
      aria-label={option.label}
      aria-pressed={option.selected}
      aria-current={option.selected ? "true" : undefined}
      className={MEDIA_MODEL_PANEL_ROW_CLASS}
      onClick={option.onSelect}
    >
      {option.icon}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      <PriceTierBadge
        tier={option.priceTier}
        description={getMediaModelPriceTierLabel(option.priceTier)}
      />
      {option.selected && (
        <Check size={15} className="absolute right-2 text-foreground" />
      )}
    </button>
  );
}

function MediaModelPanel({ category }: { category: MediaModelPanelCategory }) {
  return (
    <SelectGroup>
      {category.options.map((option) => {
        return <MediaModelPanelRow key={option.key} option={option} />;
      })}
    </SelectGroup>
  );
}

/**
 * The list header carries the category title beside the category switch on one
 * row, so the switch stays quiet: it borrows the label's height instead of
 * adding a band of its own above it. It is rendered once for the whole popover
 * (rather than once per panel) so switching category keeps the same switch.
 */
function ModelPickerListHeader({
  label,
  categorySwitch,
}: {
  label: string;
  categorySwitch: ReactNode;
}) {
  return (
    // Pinned so switching category never means scrolling back up for the
    // switch. The negative side and top margins bleed the row over the list's
    // own `p-1` inset so rows scroll under an opaque surface rather than
    // beside it.
    //
    // The 28px switch is what sets this row's height, so its padding is what
    // sets the label's distance from the first option: `py-2` left the label
    // floating in a band nearly four times its own ink. `py-1` seats the
    // switch on the same 4px inset the rows sit on, and `-mb-1` takes back the
    // list's `gap-1` so the header's own padding is the whole distance.
    <div className="sticky top-0 z-10 -mx-1 -mt-1 -mb-1 flex items-center gap-2 bg-card py-1 pl-3 pr-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {categorySwitch}
    </div>
  );
}

const MEDIA_MODEL_CATEGORY_ICONS = {
  image: <ImageIcon size={16} aria-hidden="true" />,
  video: <Video size={16} aria-hidden="true" />,
} satisfies Record<MediaModelCategoryId, ReactNode>;

const CHAT_CATEGORY_VALUE = "chat";

// Icon-only: three glyphs sitting straight on the popover surface. A filled
// track was the darkest thing in a popover otherwise made of quiet rows, and
// the labels it carried repeated the group label beside it. The `plain`
// variant is what drops the track and, with it, the raised fill and shadow the
// selected glyph used to carry; only the square footprint is set here.
const MEDIA_MODEL_CATEGORY_SEGMENT_CLASS = "w-7 px-0";

/**
 * Category switch for the popover. It used to live in the composer as a filled
 * track holding three controls, which read as heavy for a row of quiet
 * controls; the composer keeps one trigger and the split happens here instead.
 * Every viewport gets the same switch -- mobile previously drilled into a
 * nested category from a root menu, which was a second way to express one
 * choice.
 */
function MediaModelCategorySwitch({ panel }: { panel: MediaModelPanelState }) {
  const { t } = useTranslation();
  return (
    <SegmentControl
      size="xs"
      variant="plain"
      className="shrink-0"
      aria-label={t(($) => {
        return $.settings.models.picker.models;
      })}
      value={panel.activeCategory ?? CHAT_CATEGORY_VALUE}
      onValueChange={(next: string) => {
        panel.onActiveCategoryChange(
          next === CHAT_CATEGORY_VALUE ? null : (next as MediaModelCategoryId),
        );
      }}
    >
      <SegmentControlItem
        value={CHAT_CATEGORY_VALUE}
        aria-label={t(($) => {
          return $.settings.models.picker.categoryChat;
        })}
        className={MEDIA_MODEL_CATEGORY_SEGMENT_CLASS}
      >
        <MessageCircle size={16} aria-hidden="true" />
      </SegmentControlItem>
      {panel.categories.map((category) => {
        return (
          <SegmentControlItem
            key={category.id}
            value={category.id}
            aria-label={category.tabLabel}
            className={MEDIA_MODEL_CATEGORY_SEGMENT_CLASS}
          >
            {MEDIA_MODEL_CATEGORY_ICONS[category.id]}
          </SegmentControlItem>
        );
      })}
    </SegmentControl>
  );
}

interface ModelFirstModelPickerContentBaseProps {
  selectValue: string;
  placeholder: string;
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  mediaModelPanel: MediaModelPanelState | undefined;
  showInheritOption: boolean;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  policies,
  selection,
  modelCapabilities,
  codexFastModeEnabled,
  fastLabel,
  mediaModelPanel,
  showInheritOption,
}: ModelFirstModelPickerContentBaseProps) {
  const { t } = useTranslation();
  const activeMediaModelCategoryId = mediaModelPanel?.activeCategory;
  const activeMediaModelCategory = mediaModelPanel?.categories.find(
    (category) => {
      return category.id === activeMediaModelCategoryId;
    },
  );
  const mediaModelPanelOpen = activeMediaModelCategory !== undefined;
  return (
    <SelectContent className="min-w-[260px] max-h-[var(--available-height)]">
      {/* A media-model panel replaces the model rows, so keep the selected run
          model measurable the same way a hidden select value is. */}
      {(mediaModelPanelOpen ||
        (isHiddenModelFirstSelectValue(selectValue) &&
          !(showInheritOption && selectValue === INHERIT_SENTINEL))) && (
        <SelectItem
          value={selectValue}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {selectionLabel({
            selection,
            placeholder,
            codexFastModeEnabled,
            fastLabel,
          })}
        </SelectItem>
      )}
      {mediaModelPanel && (
        <ModelPickerListHeader
          label={
            activeMediaModelCategory?.label ??
            t(($) => {
              return $.settings.models.picker.chatModels;
            })
          }
          categorySwitch={<MediaModelCategorySwitch panel={mediaModelPanel} />}
        />
      )}
      {mediaModelPanel && activeMediaModelCategory ? (
        <MediaModelPanel category={activeMediaModelCategory} />
      ) : (
        <ModelFirstPolicyItems
          policies={policies}
          selection={selection}
          modelCapabilities={modelCapabilities}
          codexFastModeEnabled={codexFastModeEnabled}
          placeholder={placeholder}
          showInheritOption={showInheritOption}
          showSeparator={showInheritOption}
          showModelsLabel={!mediaModelPanel}
        />
      )}
    </SelectContent>
  );
}

interface ModelFirstModelPickerState {
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  selectValue: string;
  triggerAriaLabel: string;
}

function resolveModelFirstModelPickerState({
  value,
  policyResponse,
  modelCapabilities,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
  excludedModel,
}: {
  value: ModelProviderSelection | null;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  excludedModel: SupportedRunModel | undefined;
}): ModelFirstModelPickerState {
  const policies = (policyResponse?.policies ?? []).filter((policy) => {
    return policy.model !== excludedModel;
  });
  const selection = selectionAllowedValue(value, policies, modelCapabilities);
  return {
    policies,
    selection,
    selectValue: modelFirstSelectValue(selection),
    triggerAriaLabel: selectionLabel({
      selection,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function ModelFirstSelectPicker({
  state,
  content,
  placeholder,
  triggerClassName,
  mobileIconTrigger,
  codexFastModeEnabled,
  fastLabel,
  open,
  onOpenChange,
  modal,
  onValueChange,
}: {
  state: ModelFirstModelPickerState;
  content: ReactNode;
  placeholder: string;
  triggerClassName: string | undefined;
  mobileIconTrigger: boolean;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  open: boolean | undefined;
  onOpenChange:
    | ((
        open: boolean,
        eventDetails: { readonly event: Event; readonly cancel: () => void },
      ) => void)
    | undefined;
  modal: boolean | undefined;
  onValueChange: (raw: string) => void;
}) {
  return (
    <Select
      value={state.selectValue}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <SelectTrigger
        aria-label={state.triggerAriaLabel}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selection={state.selection}
            placeholder={placeholder}
            mobileIcon={mobileIconTrigger}
            codexFastModeEnabled={codexFastModeEnabled}
            fastLabel={fastLabel}
          />
        </SelectValue>
      </SelectTrigger>
      {content}
    </Select>
  );
}

function resolveExplicitModelFirstModelPickerState({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
}): ModelFirstModelPickerState {
  return {
    policies: [],
    selection: value,
    selectValue: modelFirstSelectValue(value),
    triggerAriaLabel: selectionLabel({
      selection: value,
      placeholder,
      codexFastModeEnabled,
      fastLabel,
    }),
  };
}

function ModelFirstModelPickerMessageContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
  message,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  message: string;
}) {
  return (
    <SelectContent className="min-w-[260px]">
      <SelectItem
        value={modelFirstSelectValue(value)}
        className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
        disabled
        aria-hidden="true"
      >
        {selectionLabel({
          selection: value,
          placeholder,
          codexFastModeEnabled,
          fastLabel,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">{message}</div>
    </SelectContent>
  );
}

function SubscribedExplicitModelFirstModelPickerContent({
  value,
  placeholder,
  codexFastModeEnabled,
  fastLabel,
  mediaModelPanel,
  excludedModel,
  showInheritOption,
  menuSignals,
  flyoutLayout,
  onSelected,
  onMenuChange,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  codexFastModeEnabled: boolean;
  fastLabel: string;
  mediaModelPanel: MediaModelPanelState | undefined;
  excludedModel: SupportedRunModel | undefined;
  showInheritOption: boolean;
  menuSignals: ModelPickerMenuSignals | undefined;
  flyoutLayout: boolean;
  onSelected: (() => void) | undefined;
  onMenuChange: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (policiesLoadable.state !== "hasData") {
    if (menuSignals) {
      return (
        <div className="px-2 py-2 text-sm text-muted-foreground" role="status">
          {policiesLoadable.state === "loading"
            ? t(($) => {
                return $.settings.models.picker.loading;
              })
            : t(($) => {
                return $.settings.models.picker.loadError;
              })}
        </div>
      );
    }
    return (
      <ModelFirstModelPickerMessageContent
        value={value}
        placeholder={placeholder}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
        message={
          policiesLoadable.state === "loading"
            ? t(($) => {
                return $.settings.models.picker.loading;
              })
            : t(($) => {
                return $.settings.models.picker.loadError;
              })
        }
      />
    );
  }
  const state = resolveModelFirstModelPickerState({
    value,
    policyResponse: policiesLoadable.data,
    modelCapabilities: DEFAULT_MODEL_PLAN_CAPABILITIES,
    placeholder,
    codexFastModeEnabled,
    fastLabel,
    excludedModel,
  });
  if (menuSignals) {
    const MenuContent = flyoutLayout
      ? ModelPickerFlyoutContent
      : ModelPickerMenuContent;
    return (
      <MenuContent
        signals={menuSignals}
        value={state.selection}
        placeholder={placeholder}
        mediaModelPanel={mediaModelPanel}
        onChange={onMenuChange}
        onSelected={onSelected}
        options={state.policies.map((policy) => {
          return {
            model: policy.model,
            label:
              policy.modelLabel || getCanonicalModelDisplayName(policy.model),
            content: (
              <ModelFirstPolicyRowContent
                policy={policy}
                modelCapabilities={modelCapabilities}
              />
            ),
            disabled: policy.routeStatus !== "valid",
            fastAvailable:
              codexFastModeEnabled &&
              policy.routeStatus === "valid" &&
              isCodexFastModeModel(policy.model),
          };
        })}
      />
    );
  }
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      policies={state.policies}
      selection={state.selection}
      modelCapabilities={modelCapabilities}
      codexFastModeEnabled={codexFastModeEnabled}
      fastLabel={fastLabel}
      mediaModelPanel={mediaModelPanel}
      showInheritOption={showInheritOption}
    />
  );
}

function useExplicitModelSelectionChange(
  props: Pick<ModelProviderPickerProps, "value" | "onChange">,
) {
  const resolveSelection = useSet(resolveExplicitModelSelection$);
  const openBillingPlans = useSet(openSettingsBillingPlans$);
  const openSettings = useSet(setSettingsDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  return (selection: ModelProviderSelection | null) => {
    detach(
      (async () => {
        const result = await resolveSelection(
          {
            selection,
            previousSelection: props.value,
          },
          pageSignal,
        );
        if (result.kind === "compare-plans") {
          openBillingPlans();
          await openSettings(true, pageSignal);
          return;
        }
        props.onChange(result.selection);
      })(),
      Reason.DomCallback,
    );
  };
}

function EnabledExplicitModelFirstModelPicker(
  props: ModelProviderPickerProps & {
    placeholder: string;
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const handleSelectionChange = useExplicitModelSelectionChange(props);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
    codexFastModeEnabled: props.codexFastModeEnabled ?? false,
    fastLabel: props.fastLabel,
  });
  const handleRawValueChange = (raw: string) => {
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      props.codexFastModeEnabled ?? false,
    );
    if (selection !== undefined) {
      handleSelectionChange(selection);
    }
  };
  const content = (
    <SubscribedExplicitModelFirstModelPickerContent
      value={props.value}
      placeholder={props.placeholder}
      codexFastModeEnabled={props.codexFastModeEnabled ?? false}
      fastLabel={props.fastLabel}
      mediaModelPanel={props.mediaModelPanel}
      excludedModel={props.excludedModel}
      showInheritOption={props.showInheritOption ?? false}
      menuSignals={props.menuSignals}
      flyoutLayout={props.flyoutLayout ?? false}
      onSelected={props.onSelected}
      onMenuChange={handleSelectionChange}
    />
  );
  if (props.menuSignals) {
    return (
      <Popover
        open={props.open}
        onOpenChange={props.onOpenChange}
        modal={props.modal}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label={state.triggerAriaLabel}
            className={cn(
              "h-9 w-full justify-start gap-2 rounded-lg text-sm font-normal",
              props.triggerClassName,
            )}
          >
            <span data-slot="select-value" className="min-w-0">
              <ModelFirstTriggerLabel
                selection={state.selection}
                placeholder={props.placeholder}
                mobileIcon={props.mobileIconTrigger}
                codexFastModeEnabled={props.codexFastModeEnabled ?? false}
                fastLabel={props.fastLabel}
              />
            </span>
            <span data-slot="select-icon">
              <ChevronDown
                size={16}
                className="shrink-0 opacity-50"
                aria-hidden="true"
              />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          collisionPadding={8}
          aria-label={props.placeholder}
          className={cn(
            props.flyoutLayout
              ? // The popover is the type rail's own card, so it keeps the
                // component's hairline and shadow and only resizes.
                "w-[188px] max-w-[calc(100vw-16px)] p-1"
              : "w-[304px] max-w-[calc(100vw-16px)] max-h-[var(--available-height)] overflow-y-auto overscroll-contain p-1",
          )}
        >
          {content}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <ModelFirstSelectPicker
      state={state}
      content={content}
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
      mobileIconTrigger={props.mobileIconTrigger}
      codexFastModeEnabled={props.codexFastModeEnabled ?? false}
      fastLabel={props.fastLabel}
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal}
      onValueChange={handleRawValueChange}
    />
  );
}

export function ModelProviderPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  mobileIconTrigger = false,
  open,
  onOpenChange,
  modal,
  disabled = false,
  codexFastModeEnabled = false,
  showInheritOption = false,
  mediaModelPanel,
  menuSignals,
  flyoutLayout = false,
  onSelected,
  excludedModel,
}: ModelProviderPickerProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ??
    t(($) => {
      return $.settings.models.picker.inheritDefault;
    });
  const fastLabel = t(($) => {
    return $.settings.models.picker.fast;
  });
  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={value}
        placeholder={resolvedPlaceholder}
        mobileIconTrigger={mobileIconTrigger}
        triggerClassName={triggerClassName}
        codexFastModeEnabled={codexFastModeEnabled}
        fastLabel={fastLabel}
      />
    );
  }
  return (
    <EnabledExplicitModelFirstModelPicker
      value={value}
      onChange={onChange}
      placeholder={resolvedPlaceholder}
      triggerClassName={triggerClassName}
      mobileIconTrigger={mobileIconTrigger}
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      codexFastModeEnabled={codexFastModeEnabled}
      showInheritOption={showInheritOption}
      fastLabel={fastLabel}
      excludedModel={excludedModel}
      menuSignals={menuSignals}
      flyoutLayout={flyoutLayout}
      {...(onSelected ? { onSelected } : {})}
      {...(mediaModelPanel ? { mediaModelPanel } : {})}
    />
  );
}
