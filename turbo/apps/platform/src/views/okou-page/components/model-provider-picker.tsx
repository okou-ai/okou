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
} from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { Check, Cpu } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../../i18n/index.ts";
import {
  modelCatalog$,
  type ModelCatalog,
} from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models";
import { resolveExplicitModelSelection$ } from "../../../signals/okou-page/model-default-selection";
import { memberRunModelAllowedForPlan } from "../../../signals/okou-page/model-plan-capabilities";
import {
  openSettingsBillingPlans$,
  setSettingsDialogOpen$,
} from "../../../signals/okou-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../../signals/page-signal";
import { detach, Reason } from "../../../signals/utils";
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

// Keep Auto distinct from the Select's empty (placeholder) value.
const AUTO_VALUE = "__auto__";

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

export function ModelFirstTriggerLabel({
  selection,
  placeholder,
  mobileIcon,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  mobileIcon: boolean;
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
          {selectedModelDisplayName(catalog, selection.selectedModel)}
        </span>
      }
    />
  );
}

function ModelFirstDisabledPickerLabel({
  value,
  placeholder,
  triggerClassName,
}: Pick<
  ModelProviderPickerProps,
  "value" | "placeholder" | "triggerClassName"
> & {
  placeholder: string;
}) {
  const catalog = useLastResolved(modelCatalog$);
  const label = value
    ? selectedModelDisplayName(catalog, value.selectedModel)
    : placeholder;
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
      />
    </span>
  );
}

/** The control value of a selected model; Auto has a reserved value. */
export function selectedModelControlValue(model: string | null): string {
  return model === null || isAutoSelectedModel(model) ? AUTO_VALUE : model;
}

/** The selected model a control value names; the reserved value is Auto. */
export function selectedModelFromControlValue(value: string): string | null {
  return value === AUTO_VALUE || isAutoSelectedModel(value) ? null : value;
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

/**
 * Pickers offer Auto first, then the active catalog models
 * (`replacedBy === null`) routed through the member's personal subscriptions,
 * in catalog `sortOrder`.
 */
export function resolveModelFirstModelPickerState({
  value,
  modelsResponse,
  catalog,
}: {
  value: ModelProviderSelection | null;
  modelsResponse: AvailableRunModelsResponse | null | undefined;
  catalog: ModelCatalog | null | undefined;
}) {
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
  return {
    models,
    selection: selectionAllowedValue(value, models, catalog),
  };
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

function EnabledExplicitModelFirstModelPicker({
  value,
  onChange,
  placeholder,
  triggerClassName,
  open,
  onOpenChange,
  modal,
}: ModelProviderPickerProps & { placeholder: string }) {
  const { t } = useTranslation();
  const handleSelectionChange = useExplicitModelSelectionChange({
    value,
    onChange,
  });
  const modelsLoadable = useLastLoadable(availableRunModels$);
  const catalogLoadable = useLastLoadable(modelCatalog$);
  const modelsResponse = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const { models } = resolveModelFirstModelPickerState({
    value,
    modelsResponse,
    catalog,
  });
  const selectValue = value
    ? selectedModelControlValue(value.selectedModel)
    : null;
  const label = value
    ? selectedModelDisplayName(catalog, value.selectedModel)
    : placeholder;
  const handleRawValueChange: NonNullable<
    ComponentProps<typeof Select<string>>["onValueChange"]
  > = (raw, details) => {
    if (raw === null) {
      details.cancel();
      return;
    }
    // Replaying the displayed selection must not save a model preference.
    // Explicit item presses still reach the command, including failed saves.
    if (raw === selectValue && details.reason === "none") {
      return;
    }
    const selectedModel = selectedModelFromControlValue(raw);
    if (selectedModel !== null && !catalog?.isActive(selectedModel)) {
      details.cancel();
      return;
    }
    // This control only changes the model. The composer's options own Fast
    // and effort; choosing the current model keeps its existing options.
    handleSelectionChange(
      value && sameSelectedModel(value.selectedModel, selectedModel)
        ? value
        : { selectedModel },
    );
  };
  const loading =
    modelsLoadable.state === "loading" || catalogLoadable.state === "loading";
  return (
    <Select
      value={selectValue}
      onValueChange={handleRawValueChange}
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
    >
      <SelectTrigger
        aria-label={label}
        className={cn("h-9 w-full", triggerClassName)}
      >
        <SelectValue placeholder={placeholder}>
          <ModelFirstTriggerLabel
            selection={value}
            placeholder={placeholder}
            mobileIcon={false}
          />
        </SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-[260px] max-h-[var(--available-height)]">
        {modelsResponse === undefined || catalog === undefined ? (
          <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
            {loading
              ? t(($) => {
                  return $.settings.models.picker.loading;
                })
              : t(($) => {
                  return $.settings.models.picker.loadError;
                })}
          </p>
        ) : models.length === 0 ? (
          <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        ) : (
          <SelectGroup>
            <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
              {t(($) => {
                return $.settings.models.picker.models;
              })}
            </SelectLabel>
            {models.map((runModel) => {
              return (
                <SelectItem
                  key={selectedModelControlValue(runModel.model)}
                  value={selectedModelControlValue(runModel.model)}
                  disabled={!isMemberRunModelConfigurable(runModel)}
                >
                  <ModelFirstRunModelRowContent runModel={runModel} />
                </SelectItem>
              );
            })}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
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
  if (disabled) {
    return (
      <ModelFirstDisabledPickerLabel
        value={value}
        placeholder={resolvedPlaceholder}
        triggerClassName={triggerClassName}
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
    />
  );
}
