import {
  isAutoSelectedModel,
  sameSelectedModel,
} from "@okouai/core/auto-run-model";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type {
  AvailableRunModel,
  AvailableRunModelsResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  cn,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
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
  resolveExplicitModelSelection$,
} from "../../../signals/okou-page/model-default-selection";
import { memberRunModelAllowedForPlan } from "../../../signals/okou-page/model-plan-capabilities";
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
  /** An active catalog model ID, or null for Auto. */
  selectedModel: string | null;
  codexServiceTier?: CodexServiceTier;
  modelSettings?: ModelSettings;
}

interface ModelProviderPickerProps {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  placeholder?: string;
  /** Classes applied to the picker trigger. Defaults to `h-9 w-full`. */
  triggerClassName?: string;
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
}

// Select values are strings. Keep "no selection yet" and Auto distinct from
// model identifiers so their values remain stable across controlled updates.
const NO_SELECTION_VALUE = "__no_selection__";
const AUTO_VALUE = "__auto__";
const CODEX_FAST_OPTION_PREFIX = "__codex_fast_option__:";
const CODEX_FAST_SELECTED_PREFIX = "__codex_fast_selected__:";

// Select uses the selected item's offsetHeight as the scroll-button
// step. Keep hidden selected items measurable so native hover scrolling works.
// These items are also `disabled`, and SelectItem's base `data-[disabled]:opacity-50`
// outranks a plain `opacity-0` on specificity, so restate the hidden opacity under
// the disabled variant to stop the measuring item from bleeding through.
const MEASURABLE_HIDDEN_SELECT_ITEM_CLASS =
  "absolute left-0 top-0 h-8 w-px overflow-hidden opacity-0 data-[disabled]:opacity-0 pointer-events-none";

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
  model: string | null,
  catalog: ModelCatalog | null | undefined,
): ModelProviderType | undefined {
  if (model === null || isAutoSelectedModel(model)) {
    return "built-in";
  }
  return catalog?.has(model)
    ? getModelBrandIconType(model, catalog)
    : undefined;
}

/** The display name of a selected model; null is Auto. */
export function selectedModelDisplayName(
  catalog: ModelCatalog | null | undefined,
  model: string | null,
): string {
  if (model === null || isAutoSelectedModel(model)) {
    return i18n.t(($) => {
      return $.settings.models.picker.auto;
    });
  }
  return catalog?.displayName(model) ?? model;
}

function selectionAllowedValue(
  value: ModelProviderSelection | null,
  models: AvailableRunModel[],
  catalog: ModelCatalog | null | undefined,
): ModelProviderSelection | null {
  if (
    !value ||
    (value.selectedModel !== null && !catalog?.isActive(value.selectedModel))
  ) {
    return null;
  }
  const runModel = models.find((candidate) => {
    return sameSelectedModel(candidate.model, value.selectedModel);
  });
  return runModel === undefined || memberRunModelAllowedForPlan(runModel)
    ? value
    : null;
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
  const modelLabel = selectedModelDisplayName(catalog, selection.selectedModel);
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
  if (raw === NO_SELECTION_VALUE) {
    return null;
  }
  if (raw === AUTO_VALUE || isAutoSelectedModel(raw)) {
    return { selectedModel: null };
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
    return NO_SELECTION_VALUE;
  }
  if (
    selection.selectedModel === null ||
    isAutoSelectedModel(selection.selectedModel)
  ) {
    return AUTO_VALUE;
  }
  return selection.codexServiceTier === "fast"
    ? `${CODEX_FAST_SELECTED_PREFIX}${selection.selectedModel}`
    : selection.selectedModel;
}

function codexFastOptionValue(model: string): string {
  return `${CODEX_FAST_OPTION_PREFIX}${model}`;
}

/** The control value of a selected model; Auto has a reserved value. */
export function selectedModelControlValue(model: string | null): string {
  return model === null || isAutoSelectedModel(model) ? AUTO_VALUE : model;
}

/** The selected model a control value names; the reserved value is Auto. */
export function selectedModelFromControlValue(value: string): string | null {
  return value === AUTO_VALUE || isAutoSelectedModel(value) ? null : value;
}

function runModelSelectValue(runModel: AvailableRunModel): string {
  return selectedModelControlValue(runModel.model);
}

function modelFirstSelectionFromInteraction(
  raw: string,
  currentSelection: ModelProviderSelection | null,
  catalog: ModelCatalog | null | undefined,
): ModelProviderSelection | null | undefined {
  // Service tiers belong to a concrete model; Auto has none.
  const currentModel = currentSelection?.selectedModel ?? null;
  if (currentModel !== null) {
    // Fast uses a hidden selected-value marker, distinct from its toggle
    // option. Replaying that value must not parse it as the empty selection.
    if (currentSelection?.codexServiceTier === "fast") {
      if (raw === modelFirstSelectValue(currentSelection)) {
        return undefined;
      }
      if (raw === currentModel) {
        return undefined;
      }
      if (raw === codexFastOptionValue(currentModel)) {
        return { selectedModel: currentModel };
      }
    }
  }
  return modelFirstSelectionFromRaw(raw, catalog);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === NO_SELECTION_VALUE || value.startsWith(CODEX_FAST_SELECTED_PREFIX)
  );
}

export function ModelFirstRunModelRowContent({
  runModel,
  selected = false,
  showSelectedIndicator = false,
}: {
  runModel: AvailableRunModel;
  selected?: boolean;
  showSelectedIndicator?: boolean;
}) {
  const catalog = useLastResolved(modelCatalog$);
  const iconType = getModelFirstIconType(runModel.model, catalog);
  const restricted = !memberRunModelAllowedForPlan(runModel);
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      {iconType && <ProviderIcon type={iconType} size={16} />}
      <span className="min-w-0 flex-1 truncate">
        {selectedModelDisplayName(catalog, runModel.model)}
      </span>
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
  selection,
}: {
  runModel: AvailableRunModel;
  selection: ModelProviderSelection | null;
}) {
  const { t } = useTranslation();
  const catalog = useLastResolved(modelCatalog$);
  const model = runModel.model;
  if (model !== null && isRunModelFastModeAvailable(runModel)) {
    const modelLabel = selectedModelDisplayName(catalog, model);
    const selected = sameSelectedModel(selection?.selectedModel, model);
    const fastSelected = selected && selection?.codexServiceTier === "fast";
    const fastLabel = t(($) => {
      return $.settings.models.picker.fast;
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
          value={model}
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
            selected={selected}
            showSelectedIndicator={fastSelected}
          />
        </SelectItem>
        <TooltipProvider delay={800} timeout={0}>
          <Tooltip>
            <TooltipTrigger
              render={
                <SelectItem
                  value={codexFastOptionValue(model)}
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
    );
  }
  return (
    <SelectItem
      value={runModelSelectValue(runModel)}
      disabled={!isMemberRunModelConfigurable(runModel)}
    >
      <ModelFirstRunModelRowContent runModel={runModel} />
    </SelectItem>
  );
}

function ModelFirstRunModelItems({
  models,
  selection,
}: {
  models: AvailableRunModel[];
  selection: ModelProviderSelection | null;
}) {
  const { t } = useTranslation();
  const catalog = useLastResolved(modelCatalog$);
  const explicitSelectedModel = selection?.selectedModel ?? null;
  const hasExplicitSelectedRunModel =
    explicitSelectedModel === null ||
    models.some((runModel) => {
      return sameSelectedModel(runModel.model, explicitSelectedModel);
    });
  return (
    <>
      {!hasExplicitSelectedRunModel && explicitSelectedModel && (
        <SelectItem
          value={explicitSelectedModel}
          className={MEASURABLE_HIDDEN_SELECT_ITEM_CLASS}
          disabled
          aria-hidden="true"
        >
          {selectedModelDisplayName(catalog, explicitSelectedModel)}
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
                key={runModelSelectValue(runModel)}
                runModel={runModel}
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
  fastLabel: string;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  models,
  selection,
  fastLabel,
}: ModelFirstModelPickerContentBaseProps) {
  const catalog = useLastResolved(modelCatalog$);
  return (
    <SelectContent className="min-w-[260px] max-h-[var(--available-height)]">
      {isHiddenModelFirstSelectValue(selectValue) && (
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
      <ModelFirstRunModelItems models={models} selection={selection} />
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
 * Pickers offer Auto first, then the active catalog models
 * (`replacedBy === null`) routed through the member's personal subscriptions,
 * in catalog `sortOrder`.
 */
export function resolveModelFirstModelPickerState({
  value,
  modelsResponse,
  catalog,
  placeholder,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  modelsResponse: AvailableRunModelsResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
  placeholder: string;
  fastLabel: string;
}): ModelFirstModelPickerState {
  const models = (modelsResponse?.models ?? [])
    .filter((runModel) => {
      return (
        runModel.model === null ||
        (runModel.memberEffective.credentialScope === "member" &&
          (catalog?.isActive(runModel.model) ?? false))
      );
    })
    .sort((left, right) => {
      if (left.model === null || right.model === null) {
        return left.model === right.model ? 0 : left.model === null ? -1 : 1;
      }
      return catalog ? catalog.compare(left.model, right.model) : 0;
    });
  const selection = selectionAllowedValue(value, models, catalog);
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
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
}) {
  const { t } = useTranslation();
  const modelsLoadable = useLastLoadable(availableRunModels$);
  const catalogLoadable = useLastLoadable(modelCatalog$);
  const modelsResponse = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const loading =
    modelsLoadable.state === "loading" || catalogLoadable.state === "loading";
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
    placeholder,
    fastLabel,
  });
  return (
    <ModelFirstModelPickerContentLayout
      selectValue={state.selectValue}
      placeholder={placeholder}
      models={state.models}
      selection={state.selection}
      fastLabel={fastLabel}
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
      fastLabel={fastLabel}
    />
  );
}
