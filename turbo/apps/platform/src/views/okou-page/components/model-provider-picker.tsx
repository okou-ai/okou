import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  getMemberRunModelRoute,
  isMemberRunModelConfigurable,
} from "@okouai/api-contracts/contracts/member-run-model";
import {
  getModelProviderPresentationLabel,
  type AvailableRunModel,
  type AvailableRunModelsResponse,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  cn,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { Check, Cpu, Zap } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../i18n/index.ts";
import {
  modelCatalog$,
  type ModelCatalog,
} from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models";
import {
  isRunModelFastModeAvailable,
  isRunModelUltrafastAvailable,
  resolveExplicitModelSelection$,
} from "../../../signals/okou-page/model-default-selection";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  memberRunModelAllowedForPlan,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  type ModelPlanCapabilities,
} from "../../../signals/okou-page/model-plan-capabilities";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../signals/page-signal";
import { detach, Reason } from "../../../signals/utils";
import { ModelFastImpact } from "./model-fast-impact.tsx";
import { ProviderIcon } from "./settings/provider-icons";
import { getModelBrandIconType } from "./settings/provider-ui-config";

import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";

export interface ModelProviderSelection {
  /** An active catalog model ID. */
  selectedModel: string;
  codexServiceTier?: CodexServiceTier;
  modelSettings?: ModelSettings;
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
  /** Lets settings callers clear a personal choice and inherit workspace default. */
  showInheritOption?: boolean;
}

// Keep the inherit option distinct from an empty model identifier at the UI
// boundary so its value remains stable across controlled Select updates.
const INHERIT_SENTINEL = "__inherit_default__";
const CODEX_FAST_OPTION_PREFIX = "__codex_fast_option__:";
const CODEX_FAST_SELECTED_PREFIX = "__codex_fast_selected__:";
const CODEX_ULTRAFAST_OPTION_PREFIX = "__codex_ultrafast_option__:";
const CODEX_ULTRAFAST_SELECTED_PREFIX = "__codex_ultrafast_selected__:";

// Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
// These items are also `disabled`, and SelectItem's base `data-[disabled]:opacity-50`
// outranks a plain `opacity-0` on specificity, so restate the hidden opacity under
// the disabled variant to stop the measuring item from bleeding through.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 data-[disabled]:opacity-0 pointer-events-none";

function SubscriptionBadge({
  subscriptionProvider,
}: {
  subscriptionProvider: ModelProviderType;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
              {getModelProviderPresentationLabel(subscriptionProvider)}
            </span>
          }
        />
        <TooltipContent side="top" className="text-xs">
          {subscriptionProvider && (
            <span>
              {getModelProviderPresentationLabel(subscriptionProvider)}:{" "}
            </span>
          )}
          {t(($) => {
            return $.settings.models.personal.description;
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
  // Only the composer asks for the icon-only trigger, and its trigger is
  // `w-8 overflow-hidden` until the composer is wide, so this reads the
  // composer's width rule. Against the window it would hand a 32px trigger the
  // label layout whenever the window is wide, and the label would be clipped to
  // its first character.
  return (
    <span className="flex items-center min-w-0">
      <span className="flex items-center justify-center composer-wide:hidden">
        {iconType ? (
          <ProviderIcon type={iconType} size={18} />
        ) : (
          <Cpu size={18} />
        )}
      </span>
      <span className="hidden min-w-0 composer-wide:inline-flex composer-wide:items-center composer-wide:gap-1.5">
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

function getModelFirstIconType(
  model: string,
  catalog: ModelCatalog | null | undefined,
): ModelProviderType | undefined {
  return catalog?.has(model)
    ? getModelBrandIconType(model, catalog)
    : undefined;
}

function catalogDisplayName(
  catalog: ModelCatalog | null | undefined,
  model: string,
): string {
  return catalog?.displayName(model) ?? model;
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  models: AvailableRunModel[],
  modelCapabilities: ModelPlanCapabilities,
  catalog: ModelCatalog | null | undefined,
): ModelProviderSelection | null {
  if (!value || !catalog?.isActive(value.selectedModel)) {
    return null;
  }
  const runModel = models.find((candidate) => {
    return candidate.model === value.selectedModel;
  });
  const allowed = runModel
    ? memberRunModelAllowedForPlan(runModel, modelCapabilities)
    : modelAllowedForPlan(value.selectedModel, modelCapabilities);
  return allowed ? value : null;
}

function selectionLabel({
  selection,
  placeholder,
  fastLabel,
  catalog,
  fastShownByCaller = false,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  catalog: ModelCatalog | null | undefined;
  /**
   * When true, the label leaves the Fast suffix off the model's name because
   * the caller already shows that state. The composer's model panel trigger
   * carries the bolt, so repeating the word on the model would say it twice
   * and change the model's name as a side effect. The accessible name still
   * carries it, for callers who cannot see the bolt.
   */
  fastShownByCaller?: boolean;
}): string {
  if (!selection) {
    return placeholder;
  }
  const modelLabel = catalogDisplayName(catalog, selection.selectedModel);
  if (selection.codexServiceTier === "ultrafast") {
    return `${modelLabel} ${i18n.t(($) => {
      return $.settings.models.picker.ultrafast;
    })}`;
  }
  return !fastShownByCaller && selection.codexServiceTier === "fast"
    ? `${modelLabel} ${fastLabel}`
    : modelLabel;
}

export function ModelFirstTriggerLabel({
  selection,
  placeholder,
  mobileIcon,
  fastLabel,
  fastShownByCaller = false,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
  fastLabel: string;
  fastShownByCaller?: boolean;
}) {
  const catalog = useLastResolved(modelCatalog$);
  if (!selection) {
    return (
      <ResponsiveTriggerContent
        mobileIcon={mobileIcon}
        iconType={undefined}
        label={<span>{placeholder}</span>}
      />
    );
  }
  const iconType = getModelFirstIconType(selection.selectedModel, catalog);
  return (
    <ResponsiveTriggerContent
      mobileIcon={mobileIcon}
      iconType={iconType}
      label={
        <span className="min-w-0 truncate">
          {selectionLabel({
            selection,
            placeholder,
            fastLabel,
            catalog,
            fastShownByCaller,
          })}
        </span>
      }
    />
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  triggerClassName,
  fastLabel,
}: Pick<
  ModelProviderPickerProps,
  "value" | "placeholder" | "triggerClassName"
> & {
  placeholder: string;
  fastLabel: string;
}) {
  const catalog = useLastResolved(modelCatalog$);
  const label = selectionLabel({
    selection: value,
    placeholder,
    fastLabel,
    catalog,
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
        mobileIcon={false}
        fastLabel={fastLabel}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
  catalog: ModelCatalog | null | undefined,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (raw.startsWith(CODEX_ULTRAFAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_ULTRAFAST_OPTION_PREFIX.length);
    return catalog?.isActive(selectedModel) &&
      catalog.supportsServiceTier(selectedModel, "ultrafast")
      ? { selectedModel, codexServiceTier: "ultrafast" }
      : null;
  }
  if (raw.startsWith(CODEX_FAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_FAST_OPTION_PREFIX.length);
    if (
      catalog?.isActive(selectedModel) &&
      catalog.supportsServiceTier(selectedModel, "priority")
    ) {
      return { selectedModel, codexServiceTier: "fast" };
    }
    return null;
  }
  if (!catalog?.isActive(raw)) {
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
  return selection.codexServiceTier === "ultrafast"
    ? `${CODEX_ULTRAFAST_SELECTED_PREFIX}${selection.selectedModel}`
    : selection.codexServiceTier === "fast"
      ? `${CODEX_FAST_SELECTED_PREFIX}${selection.selectedModel}`
      : selection.selectedModel;
}

function codexFastOptionValue(model: string): string {
  return `${CODEX_FAST_OPTION_PREFIX}${model}`;
}

function modelFirstSelectionFromInteraction(
  raw: string,
  currentSelection: ModelProviderSelection | null,
  catalog: ModelCatalog | null | undefined,
): ModelProviderSelection | null | undefined {
  if (currentSelection?.codexServiceTier === "ultrafast") {
    if (
      raw === modelFirstSelectValue(currentSelection) ||
      raw === currentSelection.selectedModel
    ) {
      return undefined;
    }
    if (
      raw ===
      `${CODEX_ULTRAFAST_OPTION_PREFIX}${currentSelection.selectedModel}`
    ) {
      return { selectedModel: currentSelection.selectedModel };
    }
  }
  // Fast uses a hidden selected-value marker, distinct from its toggle option.
  // Replaying that value must not parse it as the inherit-default sentinel.
  if (currentSelection?.codexServiceTier === "fast") {
    if (raw === modelFirstSelectValue(currentSelection)) {
      return undefined;
    }
    if (raw === currentSelection.selectedModel) {
      return undefined;
    }
    if (raw === codexFastOptionValue(currentSelection.selectedModel)) {
      return { selectedModel: currentSelection.selectedModel };
    }
  }
  return modelFirstSelectionFromRaw(raw, catalog);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === INHERIT_SENTINEL ||
    value.startsWith(CODEX_FAST_SELECTED_PREFIX) ||
    value.startsWith(CODEX_ULTRAFAST_SELECTED_PREFIX)
  );
}

export function ModelFirstRunModelRowContent({
  runModel,
  modelCapabilities,
  selected = false,
  showSelectedIndicator = false,
}: {
  runModel: AvailableRunModel;
  modelCapabilities: ModelPlanCapabilities;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const catalog = useLastResolved(modelCatalog$);
  const iconType = getModelFirstIconType(runModel.model, catalog);
  const route = getMemberRunModelRoute(runModel);
  const restricted = !memberRunModelAllowedForPlan(runModel, modelCapabilities);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {iconType && <ProviderIcon type={iconType} size={16} />}
      <span className="min-w-0 flex-1 truncate">
        {catalogDisplayName(catalog, runModel.model)}
      </span>
      {route.credentialScope === "member" && (
        <SubscriptionBadge subscriptionProvider={route.providerType} />
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

function ModelFirstRunModelRow({
  runModel,
  modelCapabilities,
  selection,
}: {
  runModel: AvailableRunModel;
  modelCapabilities: ModelPlanCapabilities;
  selection: ModelProviderSelection | null;
}) {
  const { t } = useTranslation();
  const catalog = useLastResolved(modelCatalog$);
  const fastAvailable = isRunModelFastModeAvailable(runModel, catalog);
  if (fastAvailable) {
    const modelLabel = catalogDisplayName(catalog, runModel.model);
    const selected = selection?.selectedModel === runModel.model;
    const fastSelected = selected && selection?.codexServiceTier === "fast";
    const fastLabel = t(($) => {
      return $.settings.models.picker.fast;
    });
    const ultrafastAvailable = isRunModelUltrafastAvailable(runModel, catalog);
    return (
      <>
        <div
          className={cn(
            "relative flex overflow-hidden rounded-lg transition-colors hover:bg-state-hover has-[[data-highlighted]]:bg-state-hover",
            selected &&
              "bg-state-selected hover:bg-state-selected-hover has-[[data-highlighted]]:bg-state-selected-hover",
          )}
        >
          <SelectItem
            value={runModel.model}
            aria-label={modelLabel}
            // Two fixed columns sit at this row's right edge: the checkmark's
            // (`pr-8`, shared with every other row) and the fast toggle's, which
            // `pr-16` reserves immediately left of it. Both are reserved whether
            // or not the row is selected -- shifting the content only when
            // selected is what used to push the checkmark off its column.
            className="min-w-0 flex-1 rounded-lg pr-16 hover:bg-transparent data-highlighted:bg-transparent"
          >
            <ModelFirstRunModelRowContent
              runModel={runModel}
              modelCapabilities={modelCapabilities}
              selected={selected}
              showSelectedIndicator={fastSelected}
            />
          </SelectItem>
          <TooltipProvider delay={800} timeout={0}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SelectItem
                    value={codexFastOptionValue(runModel.model)}
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
                }
              />
              <TooltipContent side="top" className="text-xs">
                {fastLabel} · <ModelFastImpact runModel={runModel} />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {ultrafastAvailable && (
          <SelectItem
            value={`${CODEX_ULTRAFAST_OPTION_PREFIX}${runModel.model}`}
            aria-label={`${modelLabel} ${t(($) => {
              return $.settings.models.picker.ultrafast;
            })}`}
            className="rounded-lg"
          >
            <Zap size={16} aria-hidden="true" />
            <span className="ml-2">
              {t(($) => {
                return $.settings.models.picker.ultrafastMode;
              })}{" "}
              ·{" "}
              {t(($) => {
                return $.settings.models.picker.ultrafastImpact;
              })}
            </span>
            {selected && selection?.codexServiceTier === "ultrafast" && (
              <Check size={15} className="ml-auto" aria-hidden="true" />
            )}
          </SelectItem>
        )}
      </>
    );
  }
  return (
    <SelectItem
      key={runModel.model}
      value={runModel.model}
      disabled={!isMemberRunModelConfigurable(runModel, catalog)}
    >
      <ModelFirstRunModelRowContent
        runModel={runModel}
        modelCapabilities={modelCapabilities}
      />
    </SelectItem>
  );
}

function ModelFirstRunModelItems({
  models,
  selection,
  modelCapabilities,
  placeholder,
  showInheritOption,
  showSeparator = true,
}: {
  models: AvailableRunModel[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  placeholder: string;
  showInheritOption: boolean;
  showSeparator?: boolean;
}) {
  const { t } = useTranslation();
  const catalog = useLastResolved(modelCatalog$);
  const explicitSelectedModel = selection?.selectedModel ?? null;
  const hasExplicitSelectedRunModel =
    explicitSelectedModel === null ||
    models.some((runModel) => {
      return runModel.model === explicitSelectedModel;
    });
  return (
    <>
      {showInheritOption && (
        <SelectItem value={INHERIT_SENTINEL}>{placeholder}</SelectItem>
      )}
      {showSeparator && (!hasExplicitSelectedRunModel || models.length > 0) && (
        <SelectSeparator className="my-0" />
      )}
      {!hasExplicitSelectedRunModel && explicitSelectedModel && (
        <SelectItem
          value={explicitSelectedModel}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {catalogDisplayName(catalog, explicitSelectedModel)}
        </SelectItem>
      )}
      {models.length === 0 ? (
        <div className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </div>
      ) : (
        <SelectGroup>
          <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.models;
            })}
          </SelectLabel>
          {models.map((runModel) => {
            return (
              <ModelFirstRunModelRow
                key={runModel.model}
                runModel={runModel}
                modelCapabilities={modelCapabilities}
                selection={selection}
              />
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

interface ModelFirstModelPickerContentBaseProps {
  selectValue: string;
  placeholder: string;
  models: AvailableRunModel[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  fastLabel: string;
  showInheritOption: boolean;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  models,
  selection,
  modelCapabilities,
  fastLabel,
  showInheritOption,
}: ModelFirstModelPickerContentBaseProps) {
  const catalog = useLastResolved(modelCatalog$);
  return (
    <SelectContent className="min-w-[260px] max-h-[var(--available-height)]">
      {isHiddenModelFirstSelectValue(selectValue) &&
        !(showInheritOption && selectValue === INHERIT_SENTINEL) && (
          <SelectItem
            value={selectValue}
            className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
            disabled
            aria-hidden="true"
          >
            {selectionLabel({
              selection,
              placeholder,
              fastLabel,
              catalog,
            })}
          </SelectItem>
        )}
      <ModelFirstRunModelItems
        models={models}
        selection={selection}
        modelCapabilities={modelCapabilities}
        placeholder={placeholder}
        showInheritOption={showInheritOption}
        showSeparator={showInheritOption}
      />
    </SelectContent>
  );
}

interface ModelFirstModelPickerState {
  models: AvailableRunModel[];
  selection: ModelProviderSelection | null;
  selectValue: string;
  triggerAriaLabel: string;
}

/**
 * Pickers offer only active catalog models (`replacedBy === null`) that the
 * organization routes, in catalog `sortOrder`.
 */
export function resolveModelFirstModelPickerState({
  value,
  modelsResponse,
  catalog,
  modelCapabilities,
  placeholder,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  modelsResponse: AvailableRunModelsResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  placeholder: string;
  fastLabel: string;
}): ModelFirstModelPickerState {
  const models = (modelsResponse?.models ?? [])
    .filter((runModel) => {
      return (
        (runModel.model === modelsResponse?.defaultModel ||
          getMemberRunModelRoute(runModel).credentialScope === "member") &&
        (catalog?.isActive(runModel.model) ?? false)
      );
    })
    .sort((left, right) => {
      return catalog ? catalog.compare(left.model, right.model) : 0;
    });
  const selection = selectionAllowedValue(
    value,
    models,
    modelCapabilities,
    catalog,
  );
  return {
    models,
    selection,
    selectValue: modelFirstSelectValue(selection),
    triggerAriaLabel: selectionLabel({
      selection,
      placeholder,
      fastLabel,
      catalog,
    }),
  };
}

function ModelFirstSelectPicker({
  state,
  content,
  placeholder,
  triggerClassName,
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
  fastLabel: string;
  open: boolean | undefined;
  onOpenChange:
    | ((
        open: boolean,
        eventDetails: { readonly event: Event; readonly cancel: () => void },
      ) => void)
    | undefined;
  modal: boolean | undefined;
  onValueChange: NonNullable<
    ComponentProps<typeof Select<string>>["onValueChange"]
  >;
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
            mobileIcon={false}
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
  fastLabel,
  catalog,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  catalog: ModelCatalog | null | undefined;
}): ModelFirstModelPickerState {
  return {
    models: [],
    selection: value,
    selectValue: modelFirstSelectValue(value),
    triggerAriaLabel: selectionLabel({
      selection: value,
      placeholder,
      fastLabel,
      catalog,
    }),
  };
}

function ModelFirstModelPickerMessageContent({
  value,
  placeholder,
  fastLabel,
  message,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  message: string;
}) {
  const catalog = useLastResolved(modelCatalog$);
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
          fastLabel,
          catalog,
        })}
      </SelectItem>
      <div className="px-2 py-2 text-sm text-muted-foreground">{message}</div>
    </SelectContent>
  );
}

function SubscribedExplicitModelFirstModelPickerContent({
  value,
  placeholder,
  fastLabel,
  showInheritOption,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  showInheritOption: boolean;
}) {
  const { t } = useTranslation();
  const modelsLoadable = useLastLoadable(availableRunModels$);
  const catalogLoadable = useLastLoadable(modelCatalog$);
  const modelsResponse = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const loading =
    modelsLoadable.state === "loading" || catalogLoadable.state === "loading";
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (modelsResponse === undefined || catalog === undefined) {
    return (
      <ModelFirstModelPickerMessageContent
        value={value}
        placeholder={placeholder}
        fastLabel={fastLabel}
        message={
          loading
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
    modelsResponse,
    catalog,
    modelCapabilities: DEFAULT_MODEL_PLAN_CAPABILITIES,
    placeholder,
    fastLabel,
  });
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      models={state.models}
      selection={state.selection}
      modelCapabilities={modelCapabilities}
      fastLabel={fastLabel}
      showInheritOption={showInheritOption}
    />
  );
}

export function useExplicitModelSelectionChange(
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
    fastLabel: string;
  },
) {
  const handleSelectionChange = useExplicitModelSelectionChange(props);
  const catalog = useLastResolved(modelCatalog$);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
    fastLabel: props.fastLabel,
    catalog,
  });
  const handleRawValueChange: NonNullable<
    ComponentProps<typeof Select<string>>["onValueChange"]
  > = (raw, details) => {
    if (raw === null) {
      details.cancel();
      return;
    }
    // Replaying the displayed selection must not save a model preference.
    // Explicit item presses still reach the command, including failed saves.
    if (raw === state.selectValue && details.reason === "none") {
      return;
    }
    const selection = modelFirstSelectionFromInteraction(
      raw,
      state.selection,
      catalog,
    );
    if (selection !== undefined) {
      handleSelectionChange(selection);
    }
  };
  const content = (
    <SubscribedExplicitModelFirstModelPickerContent
      value={props.value}
      placeholder={props.placeholder}
      fastLabel={props.fastLabel}
      showInheritOption={props.showInheritOption ?? false}
    />
  );
  return (
    <ModelFirstSelectPicker
      state={state}
      content={content}
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
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
  open,
  onOpenChange,
  modal,
  disabled = false,
  showInheritOption = false,
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
        triggerClassName={triggerClassName}
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
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      showInheritOption={showInheritOption}
      fastLabel={fastLabel}
    />
  );
}
