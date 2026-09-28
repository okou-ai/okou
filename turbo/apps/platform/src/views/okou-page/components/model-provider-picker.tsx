import {
  getMemberModelPolicyRoute,
  isMemberModelPolicyConfigurable,
} from "@okouai/api-contracts/contracts/member-model-policy";
import type { ComponentProps, ReactNode } from "react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { Check, ChevronDown, Cpu, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Button,
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
  cn,
} from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  getModelProviderPresentationLabel,
  getProvidersForModel,
  isBuiltInModelProviderType,
  isCodexFastModeModel,
  isSupportedRunModel,
  type ModelProviderType,
  type OrgModelPolicy,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { useTranslation } from "react-i18next";
import { orgModelPolicies$ } from "../../../signals/external/org-model-policies";
import {
  DEFAULT_MODEL_PLAN_CAPABILITIES,
  modelAllowedForPlan,
  modelPlanCapabilities$,
  memberModelPolicyAllowedForPlan,
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
  getModelBrandIconType,
  getBuiltInModelPriceTier,
  getBuiltInModelPriceTierLabel,
} from "./settings/provider-ui-config";
import { ProviderIcon } from "./settings/provider-icons";
import { PriceTierBadge } from "./model-picker-price-tier.tsx";
import { ModelFastImpact } from "./model-fast-impact.tsx";
import { ModelPickerMenuContent } from "./model-picker-menu.tsx";

import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";

export interface ModelProviderSelection {
  selectedModel: SupportedRunModel;
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
  /** Lets settings callers clear a personal choice and inherit workspace default. */
  showInheritOption?: boolean;
  /**
   * Renders the composer's native menu of chat models. Callers that leave it
   * unset get the plain select instead.
   */
  nativeMenu?: boolean;
  /**
   * When true, the trigger leaves the Fast suffix off the model's name because
   * the caller already shows that state. The composer's effort control sits
   * beside the model and carries the bolt, so repeating the word on the model
   * would say it twice and change the model's name as a side effect. The
   * accessible name still carries it, for callers who cannot see the bolt.
   */
  fastShownByCaller?: boolean;
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

function ByokBadge({
  subscriptionProvider,
}: {
  subscriptionProvider?: ModelProviderType;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="shrink-0 cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-muted-foreground">
              BYOK
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
            return subscriptionProvider
              ? $.settings.models.personal.description
              : $.settings.models.picker.byokHelp;
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
    ? memberModelPolicyAllowedForPlan(policy, modelCapabilities)
    : modelAllowedForPlan(value.selectedModel, modelCapabilities);
  return allowed ? value : null;
}

function selectionLabel({
  selection,
  placeholder,
  fastLabel,
  fastShownByCaller = false,
}: {
  selection: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  /** See `ModelProviderPickerProps.fastShownByCaller`. */
  fastShownByCaller?: boolean;
}): string {
  if (!selection) {
    return placeholder;
  }
  const modelLabel = getCanonicalModelDisplayName(selection.selectedModel);
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
            fastLabel,
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
  mobileIconTrigger,
  triggerClassName,
  fastLabel,
}: Pick<
  ModelProviderPickerProps,
  "value" | "placeholder" | "mobileIconTrigger" | "triggerClassName"
> & {
  placeholder: string;
  mobileIconTrigger: boolean;
  fastLabel: string;
}) {
  const label = selectionLabel({
    selection: value,
    placeholder,
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
        fastLabel={fastLabel}
      />
    </span>
  );
}

function modelFirstSelectionFromRaw(
  raw: string,
): ModelProviderSelection | null {
  if (raw === INHERIT_SENTINEL) {
    return null;
  }
  if (raw.startsWith(CODEX_FAST_OPTION_PREFIX)) {
    const selectedModel = raw.slice(CODEX_FAST_OPTION_PREFIX.length);
    if (
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
): ModelProviderSelection | null | undefined {
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
  return modelFirstSelectionFromRaw(raw);
}

function isHiddenModelFirstSelectValue(value: string): boolean {
  return (
    value === INHERIT_SENTINEL || value.startsWith(CODEX_FAST_SELECTED_PREFIX)
  );
}

export function ModelFirstPolicyRowContent({
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
  const route = getMemberModelPolicyRoute(policy);
  const builtInPriceTier = isBuiltInModelProviderType(route.providerType)
    ? getBuiltInModelPriceTier(policy.model)
    : undefined;
  const restricted = !memberModelPolicyAllowedForPlan(
    policy,
    modelCapabilities,
  );
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
        <ByokBadge
          subscriptionProvider={
            route.credentialScope === "member" ? route.providerType : undefined
          }
        />
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
}: {
  policy: OrgModelPolicy;
  modelCapabilities: ModelPlanCapabilities;
  selection: ModelProviderSelection | null;
}) {
  const { t } = useTranslation();
  const fastAvailable =
    isMemberModelPolicyConfigurable(policy) &&
    isCodexFastModeModel(policy.model);
  if (fastAvailable) {
    const modelLabel =
      policy.modelLabel || getCanonicalModelDisplayName(policy.model);
    const selected = selection?.selectedModel === policy.model;
    const fastSelected = selected && selection.codexServiceTier === "fast";
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
        <TooltipProvider delay={800} timeout={0}>
          <Tooltip>
            <TooltipTrigger
              render={
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
              }
            />
            <TooltipContent side="top" className="text-xs">
              {fastLabel} · <ModelFastImpact policy={policy} />
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
      disabled={!isMemberModelPolicyConfigurable(policy)}
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
  placeholder,
  showInheritOption,
  showSeparator = true,
}: {
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  placeholder: string;
  showInheritOption: boolean;
  showSeparator?: boolean;
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
          <SelectLabel className="pl-2 pr-8 py-1.5 text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.models;
            })}
          </SelectLabel>
          {policies.map((policy) => {
            return (
              <ModelFirstPolicyRow
                key={policy.id}
                policy={policy}
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
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  modelCapabilities: ModelPlanCapabilities;
  fastLabel: string;
  showInheritOption: boolean;
}

function ModelFirstModelPickerContentLayout({
  selectValue,
  placeholder,
  policies,
  selection,
  modelCapabilities,
  fastLabel,
  showInheritOption,
}: ModelFirstModelPickerContentBaseProps) {
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
            })}
          </SelectItem>
        )}
      <ModelFirstPolicyItems
        policies={policies}
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
  policies: OrgModelPolicy[];
  selection: ModelProviderSelection | null;
  selectValue: string;
  triggerAriaLabel: string;
}

export function resolveModelFirstModelPickerState({
  value,
  policyResponse,
  modelCapabilities,
  placeholder,
  fastLabel,
}: {
  value: ModelProviderSelection | null;
  policyResponse: { policies: OrgModelPolicy[] } | null | undefined;
  modelCapabilities: ModelPlanCapabilities;
  placeholder: string;
  fastLabel: string;
}): ModelFirstModelPickerState {
  const policies = policyResponse?.policies ?? [];
  const selection = selectionAllowedValue(value, policies, modelCapabilities);
  return {
    policies,
    selection,
    selectValue: modelFirstSelectValue(selection),
    triggerAriaLabel: selectionLabel({
      selection,
      placeholder,
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
  fastLabel,
  fastShownByCaller,
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
  fastLabel: string;
  fastShownByCaller: boolean;
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
            mobileIcon={mobileIconTrigger}
            fastLabel={fastLabel}
            fastShownByCaller={fastShownByCaller}
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
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
}): ModelFirstModelPickerState {
  return {
    policies: [],
    selection: value,
    selectValue: modelFirstSelectValue(value),
    triggerAriaLabel: selectionLabel({
      selection: value,
      placeholder,
      fastLabel,
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
  nativeMenu,
  onMenuChange,
}: {
  value: ModelProviderSelection | null;
  placeholder: string;
  fastLabel: string;
  showInheritOption: boolean;
  nativeMenu: boolean;
  onMenuChange: (selection: ModelProviderSelection) => void;
}) {
  const { t } = useTranslation();
  const policiesLoadable = useLastLoadable(orgModelPolicies$);
  const policyResponse = useLastResolved(orgModelPolicies$);
  const modelCapabilities =
    useLastResolved(modelPlanCapabilities$) ?? DEFAULT_MODEL_PLAN_CAPABILITIES;
  if (policyResponse === undefined) {
    if (nativeMenu) {
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
    policyResponse,
    modelCapabilities: DEFAULT_MODEL_PLAN_CAPABILITIES,
    placeholder,
    fastLabel,
  });
  if (nativeMenu) {
    return (
      <ModelPickerMenuContent
        value={state.selection}
        onChange={onMenuChange}
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
            disabled: !isMemberModelPolicyConfigurable(policy),
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
    mobileIconTrigger: boolean;
    fastLabel: string;
  },
) {
  const handleSelectionChange = useExplicitModelSelectionChange(props);
  const state = resolveExplicitModelFirstModelPickerState({
    value: props.value,
    placeholder: props.placeholder,
    fastLabel: props.fastLabel,
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
    const selection = modelFirstSelectionFromInteraction(raw, state.selection);
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
      nativeMenu={props.nativeMenu ?? false}
      onMenuChange={handleSelectionChange}
    />
  );
  if (props.nativeMenu) {
    return (
      <ComposerModelMenu
        {...props}
        triggerAriaLabel={state.triggerAriaLabel}
        triggerLabel={
          <ModelFirstTriggerLabel
            selection={state.selection}
            placeholder={props.placeholder}
            mobileIcon={props.mobileIconTrigger}
            fastLabel={props.fastLabel}
            fastShownByCaller={props.fastShownByCaller ?? false}
          />
        }
      >
        {content}
      </ComposerModelMenu>
    );
  }
  return (
    <ModelFirstSelectPicker
      state={state}
      content={content}
      placeholder={props.placeholder}
      triggerClassName={props.triggerClassName}
      mobileIconTrigger={props.mobileIconTrigger}
      fastShownByCaller={props.fastShownByCaller ?? false}
      fastLabel={props.fastLabel}
      open={props.open}
      onOpenChange={props.onOpenChange}
      modal={props.modal}
      onValueChange={handleRawValueChange}
    />
  );
}

/**
 * The composer's native menu. It lists only the chat models; effort and Fast
 * live on the effort control beside it.
 */
function ComposerModelMenu({
  open,
  onOpenChange,
  modal,
  triggerClassName,
  triggerAriaLabel,
  triggerLabel,
  children,
}: Pick<
  ModelProviderPickerProps,
  "open" | "onOpenChange" | "modal" | "triggerClassName"
> & {
  triggerAriaLabel: string;
  triggerLabel: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu open={open} modal={modal} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={<Button variant="ghost" />}
        aria-label={triggerAriaLabel}
        className={cn(
          "h-9 w-full justify-start gap-2 rounded-lg text-sm font-normal",
          triggerClassName,
        )}
      >
        <span data-slot="select-value" className="min-w-0">
          {triggerLabel}
        </span>
        <span data-slot="select-icon">
          <ChevronDown
            size={16}
            className="shrink-0 opacity-50"
            aria-hidden="true"
          />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        collisionPadding={8}
        aria-labelledby={undefined}
        aria-label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        className="w-[252px] max-w-[calc(100vw-16px)] overscroll-contain"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
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
  showInheritOption = false,
  nativeMenu = false,
  fastShownByCaller,
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
      showInheritOption={showInheritOption}
      fastLabel={fastLabel}
      nativeMenu={nativeMenu}
      fastShownByCaller={fastShownByCaller ?? false}
    />
  );
}
