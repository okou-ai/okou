import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { ScrollArea } from "@base-ui/react/scroll-area";
import { isMemberRunModelConfigurable } from "@okouai/api-contracts/contracts/member-run-model";
import type {
  AvailableRunModel,
  PersonalSubscriptionProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  Button,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  ScrollBar,
  cn,
} from "@okouai/ui";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { ChevronDown, Loader2, Settings, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { modelCatalog$ } from "../../../signals/external/model-catalog.ts";
import { availableRunModels$ } from "../../../signals/external/run-models.ts";
import { isRunModelFastModeAvailable } from "../../../signals/okou-page/model-default-selection.ts";
import {
  openSubscriptionLinkingSettings$,
  SUBSCRIPTION_PROVIDERS,
  subscriptionLinkingEnabled$,
  subscriptionPlanUsage$,
} from "../../../signals/okou-page/subscription-linking.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { SCROLL_FADE_Y_WHEN_OVERFLOWING } from "../scroll-fade.ts";
import {
  SubscriptionPlanRowText,
  useConnectProvider,
} from "../subscription-linking.tsx";
import {
  ChatEffortSettings,
  ChatFastSetting,
  formatChatEffort,
  useChatEffort,
} from "./chat-effort-controls.tsx";
import { ModelFastImpact } from "./model-fast-impact.tsx";
import {
  ModelFirstRunModelRowContent,
  ModelFirstTriggerLabel,
  resolveModelFirstModelPickerState,
  selectedModelControlValue,
  selectedModelDisplayName,
  selectedModelFromControlValue,
  useExplicitModelSelectionChange,
  type ModelProviderSelection,
} from "./model-provider-picker.tsx";
import { ProviderIcon } from "./settings/provider-icons.tsx";

interface ComposerModelPanelProps {
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection | null) => void;
  placeholder: string;
  triggerClassName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The model list, then the effort and Fast rows for the checked model.
 *
 * The chat model, its effort and its speed are one decision about how the next
 * message runs, so they share one popover. A popover rather than a menu:
 * changing effort or Fast is not a command that finishes the interaction, so
 * nothing in here closes the panel. Escape, a press outside or the trigger
 * closes it.
 */
function ComposerModelPanelBody({
  value,
  onChange,
  onClose,
}: Pick<ComposerModelPanelProps, "value" | "onChange"> & {
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const subscriptionLinkingEnabled = useGet(subscriptionLinkingEnabled$);
  const modelsLoadable = useLastLoadable(availableRunModels$);
  const catalogLoadable = useLastLoadable(modelCatalog$);
  const modelsResponse = useLastResolved(availableRunModels$);
  const catalog = useLastResolved(modelCatalog$);
  const changeModel = useExplicitModelSelectionChange({ value, onChange });
  const chatModelsLabel = t(($) => {
    return $.settings.models.picker.chatModels;
  });
  if (modelsResponse === undefined || catalog === undefined) {
    return (
      <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
        {modelsLoadable.state === "loading" ||
        catalogLoadable.state === "loading"
          ? t(($) => {
              return $.settings.models.picker.loading;
            })
          : t(($) => {
              return $.settings.models.picker.loadError;
            })}
      </p>
    );
  }
  const state = resolveModelFirstModelPickerState({
    value,
    modelsResponse,
    catalog,
  });
  const selectedRunModel = state.models.find((runModel) => {
    return runModel.model === value.selectedModel;
  });
  const configurable =
    selectedRunModel !== undefined &&
    isMemberRunModelConfigurable(selectedRunModel);
  const fastAvailable = isRunModelFastModeAvailable(selectedRunModel);
  return (
    <>
      {/*
       * Normally only the model list scrolls; the effort rows stay put. Keep
       * room for one menu row and its list padding so a very short window can
       * scroll the whole popover instead of collapsing all model choices.
       * The trigger already names the model, and the radio group and popover
       * carry the "Chat models" label for assistive tech. `-mr-1` lands the
       * overlay track on the popover's own edge instead of over the rows.
       */}
      <ScrollArea.Root className="group relative -mr-1 flex min-h-11 flex-col">
        <ScrollArea.Viewport
          data-slot="scroll-area-viewport"
          className={cn(
            "max-h-[284px] min-h-0 overscroll-contain pr-1 focus:outline-none",
            SCROLL_FADE_Y_WHEN_OVERFLOWING,
          )}
        >
          <ScrollArea.Content>
            <RadioGroup
              aria-label={chatModelsLabel}
              value={
                state.selection
                  ? selectedModelControlValue(state.selection.selectedModel)
                  : null
              }
              onValueChange={(controlValue: string) => {
                const model = selectedModelFromControlValue(controlValue);
                changeModel(
                  value.selectedModel === model
                    ? value
                    : { selectedModel: model },
                );
              }}
              className="flex flex-col gap-0.5 py-1"
            >
              {state.models.length === 0 && (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  {t(($) => {
                    return $.settings.models.picker.noConfiguredModels;
                  })}
                </p>
              )}
              <ComposerModelRadioRows
                models={state.models}
                selectedModel={state.selection?.selectedModel}
                showPlans={subscriptionLinkingEnabled}
              />
            </RadioGroup>
            {subscriptionLinkingEnabled && (
              <ComposerModelPlanActions
                models={state.models}
                onClose={onClose}
              />
            )}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollBar data-testid="composer-model-panel-scrollbar" />
      </ScrollArea.Root>
      {selectedRunModel !== undefined && (
        <ComposerModelPanelOptions
          value={value}
          onChange={onChange}
          disabled={!configurable}
          fastImpact={
            fastAvailable ? (
              <ModelFastImpact runModel={selectedRunModel} />
            ) : null
          }
        />
      )}
    </>
  );
}

/** Model routes determine the groups without waiting for subscription usage. */
function ComposerModelRadioRows({
  models,
  selectedModel,
  showPlans,
}: {
  models: readonly AvailableRunModel[];
  selectedModel: string | null | undefined;
  showPlans: boolean;
}) {
  const { t } = useTranslation();
  const groups = showPlans
    ? groupModelsByProvider(models)
    : [{ providerType: null, models }];
  const autoDetail = showPlans
    ? t(($) => {
        return $.settings.models.personal.autoCredits;
      })
    : undefined;
  return groups.map((group) => {
    return (
      <ComposerModelPlanGroup
        key={group.providerType ?? "auto"}
        providerType={group.providerType}
      >
        {group.models.map((runModel) => {
          return (
            <ComposerModelRow
              key={selectedModelControlValue(runModel.model)}
              runModel={runModel}
              selected={selectedModel === runModel.model}
              detail={runModel.model === null ? autoDetail : undefined}
            />
          );
        })}
      </ComposerModelPlanGroup>
    );
  });
}

function ComposerModelRow({
  runModel,
  selected,
  detail,
}: {
  runModel: AvailableRunModel;
  selected: boolean;
  detail?: string;
}) {
  return (
    <RadioPrimitive.Root
      value={selectedModelControlValue(runModel.model)}
      disabled={!isMemberRunModelConfigurable(runModel)}
      nativeButton
      render={<button type="button" />}
      className={cn(
        "relative flex w-full shrink-0 cursor-default select-none items-center rounded-lg px-2 pr-8 text-left font-normal text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50",
        MENU_ROW_HEIGHT_CLASS,
      )}
    >
      <ModelFirstRunModelRowContent
        runModel={runModel}
        selected={selected}
        showSelectedIndicator
        detail={detail}
      />
    </RadioPrimitive.Root>
  );
}

interface ComposerModelPlanGroupData {
  /** Null for Auto, which runs on Okou credits rather than a plan. */
  readonly providerType: PersonalSubscriptionProviderType | null;
  readonly models: readonly AvailableRunModel[];
}

function groupModelsByProvider(
  models: readonly AvailableRunModel[],
): ComposerModelPlanGroupData[] {
  return [
    {
      providerType: null,
      models: models.filter((runModel) => {
        return runModel.model === null;
      }),
    },
    ...SUBSCRIPTION_PROVIDERS.map((providerType) => {
      return {
        providerType,
        models: models.filter((runModel) => {
          return (
            runModel.model !== null &&
            runModel.memberEffective.providerType === providerType
          );
        }),
      };
    }),
  ].filter((group) => {
    return group.models.length > 0;
  });
}

function usePlanGroupTitle() {
  const { t } = useTranslation();
  return (type: PersonalSubscriptionProviderType) => {
    return type === "codex-oauth-token"
      ? t(($) => {
          return $.settings.models.personal.codexGroup;
        })
      : t(($) => {
          return $.settings.models.personal.claudeGroup;
        });
  };
}

function ComposerPlanRemainingUsage({
  providerType,
}: {
  providerType: PersonalSubscriptionProviderType;
}) {
  const { t } = useTranslation();
  const usageLoadable = useLastLoadable(subscriptionPlanUsage$);
  const usages = useLastResolved(subscriptionPlanUsage$);
  const usage = usages?.find((entry) => {
    return entry.type === providerType;
  });
  return (
    <span className="flex h-4 w-28 shrink-0 items-center justify-end whitespace-nowrap tabular-nums">
      {usages === undefined && usageLoadable.state === "loading" ? (
        <Loader2
          size={12}
          className="animate-spin motion-reduce:animate-none"
          aria-label={t(($) => {
            return $.settings.shared.loading;
          })}
        />
      ) : usage !== undefined && usage.remainingPercent !== null ? (
        <span>
          {usage.limitingWindow !== null &&
            `${
              usage.limitingWindow === "week"
                ? t(($) => {
                    return $.settings.models.personal.status.week;
                  })
                : t(($) => {
                    return $.settings.models.personal.status.fiveHour;
                  })
            } · `}
          <span className="text-foreground">
            {t(
              ($) => {
                return $.settings.models.personal.status.left;
              },
              {
                percent: `${String(Math.round(usage.remainingPercent))}%`,
              },
            )}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function ComposerModelPlanCaption({
  providerType,
  showUsage = false,
}: {
  providerType: PersonalSubscriptionProviderType;
  showUsage?: boolean;
}) {
  const groupTitle = usePlanGroupTitle();
  return (
    <p className="flex items-center justify-between gap-2 px-2 pb-1 pt-2 text-xs text-muted-foreground">
      <span className="truncate">{groupTitle(providerType)}</span>
      {showUsage && <ComposerPlanRemainingUsage providerType={providerType} />}
    </p>
  );
}

function ComposerModelPlanGroup({
  providerType,
  children,
}: {
  providerType: PersonalSubscriptionProviderType | null;
  children: ReactNode;
}) {
  return (
    <>
      {providerType !== null && (
        <ComposerModelPlanCaption providerType={providerType} showUsage />
      )}
      {children}
    </>
  );
}

const PLAN_ACTION_ROW_CLASS = cn(
  "relative flex w-full shrink-0 cursor-default select-none items-center gap-2 rounded-lg px-2 text-left font-normal text-foreground outline-none transition-colors hover:bg-state-hover focus-visible:bg-state-hover",
  MENU_ROW_HEIGHT_CLASS,
);

/**
 * A plan that is not linked keeps a Connect row under its own heading, so
 * linking one subscription never hides the other; Manage plans leads to
 * Settings > Models for accounts and usage.
 */
function ComposerModelPlanActions({
  models,
  onClose,
}: {
  models: readonly AvailableRunModel[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { title, plans, connect } = useConnectProvider("composer_model_panel");
  const openSettings = useSet(openSubscriptionLinkingSettings$);
  const pageSignal = useGet(pageSignal$);
  return (
    <div className="flex flex-col gap-0.5 pb-1">
      {SUBSCRIPTION_PROVIDERS.filter((providerType) => {
        return !models.some((runModel) => {
          return runModel.memberEffective.providerType === providerType;
        });
      }).map((providerType) => {
        const detailId = `composer-model-panel-${providerType}-plans`;
        return (
          <div key={providerType} className="flex flex-col gap-0.5">
            <ComposerModelPlanCaption providerType={providerType} />
            <button
              type="button"
              aria-label={title(providerType)}
              aria-describedby={detailId}
              className={PLAN_ACTION_ROW_CLASS}
              onClick={() => {
                onClose();
                connect(providerType);
              }}
            >
              <ProviderIcon type={providerType} size={16} />
              <SubscriptionPlanRowText
                title={title(providerType)}
                detail={plans(providerType)}
                detailId={detailId}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(($) => {
                  return $.settings.models.personal.connect;
                })}
              </span>
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={cn(PLAN_ACTION_ROW_CLASS, "text-muted-foreground")}
        onClick={() => {
          onClose();
          detach(
            openSettings("composer_model_panel", pageSignal),
            Reason.DomCallback,
          );
        }}
      >
        <Settings size={16} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t(($) => {
            return $.settings.models.personal.managePlans;
          })}
        </span>
      </button>
    </div>
  );
}

function ComposerModelPanelOptions({
  value,
  onChange,
  disabled,
  fastImpact,
}: {
  value: ModelProviderSelection;
  onChange: (selection: ModelProviderSelection) => void;
  disabled: boolean;
  fastImpact: ReactNode;
}) {
  const { efforts } = useChatEffort(value);
  if (efforts.length === 0 && fastImpact === null) {
    return null;
  }
  return (
    <div className="mt-1 shrink-0 border-t border-divider pt-0.5">
      <ChatEffortSettings
        selection={value}
        disabled={disabled}
        onChange={onChange}
      />
      {fastImpact !== null && (
        <ChatFastSetting
          selection={value}
          disabled={disabled}
          fastImpact={fastImpact}
          onChange={onChange}
        />
      )}
    </div>
  );
}

/**
 * The composer trigger names the model and then the effort it will run at, with
 * the bolt once Fast is on, so the choice is readable without opening the panel.
 */
function ComposerModelPanelTriggerLabel({
  value,
  placeholder,
}: Pick<ComposerModelPanelProps, "value" | "placeholder">) {
  const { effort } = useChatEffort(value);
  const fast = value.codexServiceTier === "fast";
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ModelFirstTriggerLabel
        selection={value}
        placeholder={placeholder}
        mobileIcon
      />
      {effort !== undefined && (
        <span className="hidden shrink-0 composer-wide:inline">
          · {formatChatEffort(effort)}
        </span>
      )}
      {fast && (
        <Zap
          size={14}
          fill="currentColor"
          className="hidden shrink-0 text-amber-600 composer-wide:block dark:text-amber-300"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function ComposerModelPanel({
  value,
  onChange,
  placeholder,
  triggerClassName,
  open,
  onOpenChange,
}: ComposerModelPanelProps) {
  const { t } = useTranslation();
  const { effort } = useChatEffort(value);
  const catalog = useLastResolved(modelCatalog$);
  const fastLabel = t(($) => {
    return $.settings.models.picker.fast;
  });
  const triggerAriaLabel = [
    selectedModelDisplayName(catalog, value.selectedModel),
    effort === undefined ? undefined : formatChatEffort(effort),
    value.codexServiceTier === "fast" ? fastLabel : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost" />}
        aria-label={triggerAriaLabel}
        className={cn(
          "h-9 w-full justify-start gap-2 rounded-lg text-sm font-normal",
          triggerClassName,
        )}
      >
        <span data-slot="select-value" className="min-w-0">
          <ComposerModelPanelTriggerLabel
            value={value}
            placeholder={placeholder}
          />
        </span>
        <span data-slot="select-icon">
          <ChevronDown
            size={16}
            className="shrink-0 opacity-50"
            aria-hidden="true"
          />
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        // Model and notice changes may resize or move the anchor while open.
        // Shrink the list rather than flipping the panel beside/below it.
        collisionAvoidance={{
          side: "none",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        aria-label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        className="flex max-h-[var(--available-height)] w-[304px] max-w-[var(--available-width)] flex-col overflow-y-auto p-1"
      >
        <ComposerModelPanelBody
          value={value}
          onChange={onChange}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
