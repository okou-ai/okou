import { orgModelPolicies$ } from "../../../signals/external/org-model-policies.ts";
import { Slider } from "@okouai/ui/components/ui/slider";
import { featureSwitch$ } from "../../../signals/external/feature-switch.ts";
import {
  availableChatReasoningEfforts,
  effectiveChatReasoningEffort,
} from "../../../signals/okou-page/model-reasoning-effort.ts";
import { withModelReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { KeyboardEvent, ReactNode } from "react";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  MessageCircle,
  SlidersHorizontal,
} from "lucide-react";
import { Button, Switch, cn } from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { useTranslation } from "react-i18next";
import type { ModelPickerMenuSignals } from "../../../signals/okou-page/model-picker-menu.ts";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import { PriceTierBadge } from "./model-picker-price-tier.tsx";
import {
  getMediaModelPriceTierLabel,
  getModelBrandIconType,
} from "./settings/provider-ui-config.ts";
import { ProviderIcon } from "./settings/provider-icons.tsx";
import type {
  MediaModelCategoryId,
  MediaModelPanelState,
  ModelProviderSelection,
} from "./model-provider-picker.tsx";

interface ModelPickerMenuOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled: boolean;
  readonly fastAvailable: boolean;
}

function useChatEffort(selection: ModelProviderSelection | null | undefined) {
  const switches = useGet(featureSwitch$);
  const policies = useLastResolved(orgModelPolicies$);
  const policy = policies?.policies.find((entry) => {
    return entry.model === selection?.selectedModel;
  });
  return {
    efforts: availableChatReasoningEfforts(selection, switches, policy),
    effort: effectiveChatReasoningEffort(selection, switches, policy),
  };
}

function MenuHeader({
  label,
  onBack,
  backLabel,
}: {
  label: string;
  onBack?: () => void;
  backLabel?: string;
}) {
  return (
    <div className="sticky top-0 z-10 flex h-7 items-center gap-1 bg-card px-2 text-xs text-muted-foreground">
      {onBack && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="-ml-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </Button>
      )}
      <span>{label}</span>
    </div>
  );
}

function CurrentModelRow({
  model,
  category,
  icon,
  summary,
  onChange,
  onSettings,
}: {
  model: string;
  category: string;
  icon: ReactNode;
  summary?: string;
  onChange: () => void;
  onSettings?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative h-12 rounded-lg">
      <Button
        variant="ghost"
        className={cn(
          "h-full w-full justify-start gap-2 px-2 pr-7 text-left font-normal text-foreground",
          onSettings && "pr-16",
        )}
        aria-label={t(
          ($) => {
            return $.settings.models.picker.menu.changeModel;
          },
          { category, model },
        )}
        onClick={onChange}
      >
        <span className="flex w-5 shrink-0 items-center justify-center">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[13px] leading-[19px]">{model}</span>
          <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
            {category}
            {summary && <> · {summary}</>}
          </span>
        </span>
        <ChevronRight
          size={13}
          aria-hidden="true"
          className="absolute right-2 text-muted-foreground"
        />
      </Button>
      {onSettings && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="absolute right-7 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label={t(
            ($) => {
              return $.settings.models.picker.menu.adjustSettings;
            },
            { model },
          )}
          onClick={onSettings}
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

/** Keep arrow navigation in the same order as the menu's tabbable controls. */
function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    return;
  }
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [role="switch"]:not([data-disabled])',
    ),
  );
  const current = controls.findIndex((button) => {
    return button === event.target;
  });
  if (controls.length === 0 || current === -1) {
    return;
  }
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? controls.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) %
          controls.length;
  controls[next]?.focus();
}

interface ModelPickerMenuContentProps {
  signals: ModelPickerMenuSignals;
  value: ModelProviderSelection | null;
  placeholder: string;
  options: readonly ModelPickerMenuOption[];
  mediaModelPanel: MediaModelPanelState | undefined;
  onChange: (selection: ModelProviderSelection) => void;
  /** Only the flyout uses it: the menu's pages stay open after a selection. */
  onSelected?: (() => void) | undefined;
}

function formatChatEffort(
  model: string | undefined,
  effort: string | null | undefined,
) {
  return model?.startsWith("claude-") && effort
    ? effort.charAt(0).toUpperCase() + effort.slice(1)
    : effort;
}

function canAdjustChatSettings(
  option: ModelPickerMenuOption | undefined,
  hasEffortControls: boolean,
) {
  return (
    option?.disabled === false && (option.fastAvailable || hasEffortControls)
  );
}

function ModelPickerOverview({
  signals,
  value,
  placeholder,
  options,
  mediaModelPanel,
}: Omit<ModelPickerMenuContentProps, "onChange">) {
  const { t } = useTranslation();
  const { efforts, effort: savedEffort } = useChatEffort(value);
  const showModels = useSet(signals.showModels$);
  const editSettings = useSet(signals.editSettings$);
  const selectedOption = options.find((option) => {
    return option.model === value?.selectedModel;
  });
  const chatLabel =
    selectedOption?.label ??
    (value ? getCanonicalModelDisplayName(value.selectedModel) : placeholder);
  const chatIconType = value
    ? getModelBrandIconType(value.selectedModel)
    : undefined;
  const speedLabel =
    value?.codexServiceTier === "fast"
      ? t(($) => {
          return $.settings.models.picker.fast;
        })
      : t(($) => {
          return $.settings.models.picker.standard;
        });
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.models;
        })}
      />
      <div className="flex flex-col gap-0.5">
        <CurrentModelRow
          model={chatLabel}
          category={t(($) => {
            return $.settings.models.picker.categoryChat;
          })}
          icon={
            chatIconType ? (
              <ProviderIcon type={chatIconType} size={17} />
            ) : (
              <Cpu size={17} />
            )
          }
          summary={
            [
              selectedOption?.fastAvailable ? speedLabel : undefined,
              formatChatEffort(value?.selectedModel, savedEffort),
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          onChange={() => {
            mediaModelPanel?.onActiveCategoryChange(null);
            showModels("chat");
          }}
          onSettings={
            value &&
            canAdjustChatSettings(
              selectedOption,
              efforts.length > 0 || Boolean(savedEffort),
            )
              ? () => {
                  mediaModelPanel?.onActiveCategoryChange(null);
                  editSettings();
                }
              : undefined
          }
        />
        {mediaModelPanel?.categories.map((category) => {
          const selected = category.options.find((option) => {
            return option.selected;
          });
          return (
            <CurrentModelRow
              key={category.id}
              model={selected?.label ?? category.label}
              category={category.tabLabel}
              icon={selected?.icon}
              onChange={() => {
                mediaModelPanel.onActiveCategoryChange(category.id);
                showModels(category.id);
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function ChatReasoningEffortSettings({
  selection,
  disabled,
  onChange,
}: {
  selection: ModelProviderSelection;
  disabled: boolean;
  onChange: ModelPickerMenuContentProps["onChange"];
}) {
  const { t } = useTranslation();
  const { efforts, effort: value } = useChatEffort(selection);
  if (efforts.length === 0) {
    return null;
  }
  const label = t(($) => {
    return $.settings.models.picker.effort;
  });
  if (value === undefined) {
    return null;
  }
  const displayValue = formatChatEffort(selection.selectedModel, value);
  const index = efforts.findIndex((effort) => {
    return effort === value;
  });
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 px-2 py-4">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <span className="font-medium text-foreground">{displayValue}</span>
      </div>
      {index !== -1 ? (
        <Slider
          ticks
          min={0}
          max={efforts.length - 1}
          step={1}
          value={index}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={displayValue ?? undefined}
          onValueChange={(next) => {
            const effort = efforts[next];
            if (effort !== undefined) {
              onChange({
                ...selection,
                modelSettings: withModelReasoningEffort(
                  selection.modelSettings,
                  { model: selection.selectedModel, effort },
                ),
              });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ChatModelSettings({
  signals,
  options,
  selection,
  onChange,
}: Pick<ModelPickerMenuContentProps, "signals" | "options" | "onChange"> & {
  selection: ModelProviderSelection;
}) {
  const { t } = useTranslation();
  const back = useSet(signals.reset$);
  const option = options.find((candidate) => {
    return candidate.model === selection.selectedModel;
  });
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.menu.chatSettings;
        })}
        onBack={back}
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
      />
      <div className="border-b border-border/60 px-2 py-2.5 text-sm">
        {option?.content ??
          getCanonicalModelDisplayName(selection.selectedModel)}
      </div>
      <ChatReasoningEffortSettings
        selection={selection}
        disabled={option?.disabled ?? true}
        onChange={onChange}
      />
      {option?.fastAvailable && (
        <div className="flex items-center justify-between gap-3 px-2 py-4">
          <div>
            <span className="text-[13px]">
              {t(($) => {
                return $.settings.models.picker.fast;
              })}
            </span>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t(($) => {
                return $.settings.models.picker.fastImpact;
              })}
            </p>
          </div>
          <Switch
            size="compact"
            aria-label={t(($) => {
              return $.settings.models.picker.fast;
            })}
            checked={selection.codexServiceTier === "fast"}
            onCheckedChange={(fast) => {
              onChange({
                ...selection,
                codexServiceTier: fast ? "fast" : undefined,
              });
            }}
            disabled={option.disabled}
          />
        </div>
      )}
    </>
  );
}

function ChatModelList({
  signals,
  options,
  value,
  onChange,
}: Pick<
  ModelPickerMenuContentProps,
  "signals" | "options" | "value" | "onChange"
>) {
  const { t } = useTranslation();
  const reset = useSet(signals.reset$);
  const chooseChat = (option: ModelPickerMenuOption) => {
    onChange(
      value?.selectedModel === option.model
        ? value
        : { selectedModel: option.model },
    );
    reset();
  };
  return (
    <>
      <MenuHeader
        label={t(($) => {
          return $.settings.models.picker.chatModels;
        })}
        onBack={reset}
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
      />
      <div className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1">
        {options.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        )}
        {options.map((option) => {
          return (
            <Button
              key={option.model}
              variant="ghost"
              className="relative h-9 w-full justify-start px-2 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
              aria-pressed={value?.selectedModel === option.model}
              disabled={option.disabled}
              onClick={() => {
                chooseChat(option);
              }}
            >
              {option.content}
              {value?.selectedModel === option.model && (
                <Check
                  size={15}
                  aria-hidden="true"
                  className="absolute right-2"
                />
              )}
            </Button>
          );
        })}
      </div>
    </>
  );
}

function MediaModelList({
  signals,
  mediaModelPanel,
  categoryId,
}: Pick<ModelPickerMenuContentProps, "signals" | "mediaModelPanel"> & {
  categoryId: "image" | "video";
}) {
  const { t } = useTranslation();
  const reset = useSet(signals.reset$);
  const category = mediaModelPanel?.categories.find((candidate) => {
    return candidate.id === categoryId;
  });
  return (
    <>
      <MenuHeader
        label={
          category?.label ??
          t(($) => {
            return $.settings.models.picker.models;
          })
        }
        onBack={reset}
        backLabel={t(($) => {
          return $.settings.models.picker.menu.backToModels;
        })}
      />
      <div className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1">
        {category?.options.map((option) => {
          return (
            <Button
              key={option.key}
              variant="ghost"
              className="relative h-9 w-full justify-start gap-2 px-2 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
              aria-pressed={option.selected}
              aria-current={option.selected ? "true" : undefined}
              onClick={() => {
                option.onSelect();
                reset();
              }}
            >
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <PriceTierBadge
                tier={option.priceTier}
                description={getMediaModelPriceTierLabel(option.priceTier)}
              />
              {option.selected && (
                <Check
                  size={15}
                  aria-hidden="true"
                  className="absolute right-2"
                />
              )}
            </Button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The type rail is the popover surface itself. The flyout panel floats outside
 * that box, so it restates the same surface -- hairline, radius and the
 * popover's own drop shadow, which PopoverContent applies as an inline style
 * and `shadow-lg` reproduces exactly.
 */
const FLYOUT_PANEL_CLASS =
  "rounded-[12px] border border-[hsl(var(--gray-400))] bg-card p-1 text-foreground shadow-lg outline-none";

/**
 * Flyout layout: model types on the left, that type's models in a panel beside
 * it. The two panels are separate cards -- joining them would make the root
 * resize whenever a longer list opened, and the type rows would move out from
 * under the pointer.
 */
function ModelPickerFlyoutTypeRow({
  icon,
  label,
  current,
  active,
  index,
  total,
  onActivate,
  onHover,
  onHoverEnd,
}: {
  icon: ReactNode;
  label: string;
  current: string;
  active: boolean;
  index: number;
  total: number;
  onActivate: () => void;
  onHover: () => void;
  onHoverEnd: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="tab"
      aria-selected={active}
      aria-posinset={index + 1}
      aria-setsize={total}
      tabIndex={active ? 0 : -1}
      className={cn(
        // shrink-0 keeps the row at its own height: a flex column with a
        // max-height compresses its children before it will scroll.
        "h-11 w-full shrink-0 justify-start gap-2 px-2 text-left font-normal",
        active && "bg-state-hover",
      )}
      // Hover waits for the pointer to settle; a click or a keyboard move is
      // deliberate and swaps the panel straight away.
      onMouseEnter={onHover}
      onMouseLeave={onHoverEnd}
      onFocus={onActivate}
      onClick={onActivate}
    >
      <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[13px] leading-[17px] text-foreground">
          {label}
        </span>
        <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
          {current}
        </span>
      </span>
      <ChevronRight
        size={13}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground"
      />
    </Button>
  );
}

function ModelPickerFlyoutOption({
  content,
  selected,
  disabled,
  index,
  total,
  onSelect,
}: {
  content: ReactNode;
  selected: boolean;
  disabled: boolean;
  index: number;
  total: number;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      // Unavailable routes stay in the list and stay reachable: a native
      // disabled row is invisible to keyboard and screen reader users.
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cn(
        // shrink-0: without it a long list compresses every row instead of
        // scrolling, so the same row is 36px in a short list and 26px in a
        // long one.
        "relative h-9 w-full shrink-0 justify-start gap-2 pl-2 pr-8 text-left",
        "text-[13px] font-normal text-foreground",
        disabled && "opacity-55 hover:bg-transparent active:bg-transparent",
      )}
      onClick={() => {
        if (!disabled) {
          onSelect();
        }
      }}
    >
      {content}
      {selected && (
        <Check size={15} aria-hidden="true" className="absolute right-2" />
      )}
    </Button>
  );
}

function ModelPickerFlyoutOptions({
  activeMedia,
  options,
  value,
  onChange,
  onSelected,
}: {
  activeMedia: MediaModelPanelState["categories"][number] | undefined;
  options: readonly ModelPickerMenuOption[];
  value: ModelProviderSelection | null;
  onChange: (selection: ModelProviderSelection) => void;
  onSelected: (() => void) | undefined;
}) {
  if (activeMedia) {
    return activeMedia.options.map((option, index) => {
      return (
        <ModelPickerFlyoutOption
          key={option.key}
          content={
            <>
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <PriceTierBadge
                tier={option.priceTier}
                description={getMediaModelPriceTierLabel(option.priceTier)}
              />
            </>
          }
          selected={option.selected}
          disabled={false}
          index={index}
          total={activeMedia.options.length}
          onSelect={() => {
            option.onSelect();
            onSelected?.();
          }}
        />
      );
    });
  }
  return options.map((option, index) => {
    return (
      <ModelPickerFlyoutOption
        key={option.model}
        content={option.content}
        selected={value?.selectedModel === option.model}
        disabled={option.disabled}
        index={index}
        total={options.length}
        onSelect={() => {
          onChange(
            value?.selectedModel === option.model
              ? value
              : { selectedModel: option.model },
          );
          // Picking a model is the whole task: leave rather than making the
          // user dismiss a panel that has nothing left to offer.
          onSelected?.();
        }}
      />
    );
  });
}

function ModelPickerFlyoutPanel({
  activeMedia,
  panelLabel,
  ...props
}: ModelPickerMenuContentProps & {
  activeMedia: MediaModelPanelState["categories"][number] | undefined;
  panelLabel: string;
}) {
  const { t } = useTranslation();
  const page = useGet(props.signals.page$);
  const editSettings = useSet(props.signals.editSettings$);
  const panelRef = useSet(props.signals.focusFlyoutPanelRef$);
  const settingsRef = useSet(props.signals.focusPanelRef$);
  const selectedOption = props.options.find((option) => {
    return option.model === props.value?.selectedModel;
  });
  const { efforts, effort: savedEffort } = useChatEffort(props.value);
  const showSettingsRow =
    !activeMedia &&
    Boolean(props.value) &&
    Boolean(selectedOption) &&
    canAdjustChatSettings(
      selectedOption,
      efforts.length > 0 || Boolean(savedEffort),
    );
  if (!activeMedia && page.kind === "settings" && props.value) {
    return (
      <div
        ref={settingsRef}
        role="region"
        className="max-h-[360px] overflow-y-auto overscroll-contain"
        aria-label={t(($) => {
          return $.settings.models.picker.menu.chatSettings;
        })}
      >
        <ChatModelSettings {...props} selection={props.value} />
      </div>
    );
  }
  return (
    <>
      <div
        ref={panelRef}
        role="listbox"
        aria-label={panelLabel}
        className={cn(
          // Rows have to appear and disappear at the card's own edge. The card
          // insets this box by `p-1`, which left a blank band where a row was
          // cut short of the border, so pull the box back over that inset and
          // restate it as scroll padding: the list still rests clear of the
          // border at either end, but a row mid-scroll runs to the edge.
          // The heights keep the visible area at 244px either way.
          "-mt-1 flex flex-col gap-0.5 overflow-y-auto overscroll-contain pt-1",
          showSettingsRow
            ? "max-h-[248px]"
            : // Nothing follows, so the bottom reaches the card's edge too.
              "-mb-1 max-h-[252px] pb-1",
        )}
      >
        <ModelPickerFlyoutOptions
          {...props}
          activeMedia={activeMedia}
          onSelected={props.onSelected}
        />
        {props.options.length === 0 && !activeMedia && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        )}
      </div>
      {showSettingsRow && selectedOption && (
        <Button
          variant="ghost"
          className="h-9 shrink-0 justify-start gap-2 border-t border-border/60 px-2 text-xs text-muted-foreground"
          aria-label={t(
            ($) => {
              return $.settings.models.picker.menu.adjustSettings;
            },
            { model: selectedOption.label },
          )}
          onClick={editSettings}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t(($) => {
            return $.settings.models.picker.menu.chatSettings;
          })}
        </Button>
      )}
    </>
  );
}

interface ModelPickerFlyoutType {
  readonly id: "chat" | MediaModelCategoryId;
  readonly label: string;
  readonly current: string;
  readonly icon: ReactNode;
}

/**
 * The type rail owns hover intent for the whole flyout: a row opens its panel
 * on a settled pointer, and a pointer that leaves before then opens nothing.
 * Reaching the panel means crossing the rows between it and the pointer, and
 * without the dwell each of those rows would swap the panel on the way past.
 */
function ModelPickerFlyoutTypeRail({
  signals,
  types,
  activeType,
}: {
  signals: ModelPickerMenuSignals;
  types: readonly ModelPickerFlyoutType[];
  activeType: ModelPickerFlyoutType["id"];
}) {
  const { t } = useTranslation();
  const setCategory = useSet(signals.setFlyoutCategory$);
  const hoverCategory = useSet(signals.hoverFlyoutCategory$);
  const cancelCategoryHover = useSet(signals.cancelFlyoutCategoryHover$);
  const pageSignal = useGet(pageSignal$);
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={t(($) => {
        return $.settings.models.picker.models;
      })}
      className="flex flex-col gap-0.5"
    >
      {types.map((type, index) => {
        return (
          <ModelPickerFlyoutTypeRow
            key={type.id}
            icon={type.icon}
            label={type.label}
            current={type.current}
            active={type.id === activeType}
            index={index}
            total={types.length}
            onActivate={() => {
              setCategory(type.id);
            }}
            onHover={() => {
              detach(hoverCategory(type.id, pageSignal), Reason.DomCallback);
            }}
            onHoverEnd={cancelCategoryHover}
          />
        );
      })}
    </div>
  );
}

export function ModelPickerFlyoutContent({
  signals,
  value,
  placeholder,
  options,
  mediaModelPanel,
  onChange,
  onSelected,
}: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const category = useGet(signals.flyoutCategory$);
  const side = useGet(signals.flyoutSide$);
  const rootRef = useSet(signals.flyoutRootRef$);
  const selectedOption = options.find((option) => {
    return option.model === value?.selectedModel;
  });
  const chatLabel =
    selectedOption?.label ??
    (value ? getCanonicalModelDisplayName(value.selectedModel) : placeholder);
  const types = [
    {
      id: "chat" as const,
      label: t(($) => {
        return $.settings.models.picker.categoryChat;
      }),
      current: chatLabel,
      icon: <MessageCircle size={15} aria-hidden="true" />,
    },
    ...(mediaModelPanel?.categories ?? []).map((mediaCategory) => {
      const selected = mediaCategory.options.find((option) => {
        return option.selected;
      });
      return {
        id: mediaCategory.id,
        label: mediaCategory.tabLabel,
        current: selected?.label ?? mediaCategory.label,
        icon: selected?.icon ?? null,
      };
    }),
  ];
  const activeType = types.some((type) => {
    return type.id === category;
  })
    ? category
    : "chat";
  const activeMedia = mediaModelPanel?.categories.find((mediaCategory) => {
    return mediaCategory.id === activeType;
  });
  const panelLabel =
    activeMedia?.label ??
    t(($) => {
      return $.settings.models.picker.chatModels;
    });
  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        moveFlyoutFocus(event, types.length);
      }}
    >
      {types.length > 1 && (
        <ModelPickerFlyoutTypeRail
          signals={signals}
          types={types}
          activeType={activeType}
        />
      )}
      <div
        className={cn(
          "flex flex-col gap-0.5",
          types.length > 1
            ? cn(
                // The two cards share a bottom edge. This box is anchored to
                // the rail's content edge, which sits the popover's `p-1`
                // (4px) plus the shared 0.5px hairline above the card's own
                // bottom, so cancel both.
                "absolute bottom-[-4.5px] w-[252px]",
                FLYOUT_PANEL_CLASS,
                side === "right"
                  ? "left-[calc(100%+6px)]"
                  : "right-[calc(100%+6px)]",
              )
            : "w-full",
        )}
      >
        <ModelPickerFlyoutPanel
          signals={signals}
          placeholder={placeholder}
          mediaModelPanel={mediaModelPanel}
          activeMedia={activeMedia}
          panelLabel={panelLabel}
          options={options}
          value={value}
          onChange={onChange}
          onSelected={onSelected}
        />
      </div>
    </div>
  );
}

/** Vertical tablist paired with a listbox: up/down inside each, arrows across. */
function moveFlyoutFocus(
  event: KeyboardEvent<HTMLDivElement>,
  typeCount: number,
): void {
  const target = event.target as HTMLElement;
  const root = event.currentTarget;
  const onType = target.getAttribute("role") === "tab";
  const onOption = target.getAttribute("role") === "option";
  if (!onType && !onOption) {
    return;
  }
  const options = Array.from(
    root.querySelectorAll<HTMLElement>('[role="option"]'),
  );
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (onType && (event.key === "ArrowRight" || event.key === "Enter")) {
    event.preventDefault();
    (
      options.find((option) => {
        return option.getAttribute("aria-selected") === "true";
      }) ?? options[0]
    )?.focus();
    return;
  }
  if (!onType && event.key === "ArrowLeft" && typeCount > 1) {
    event.preventDefault();
    tabs
      .find((tab) => {
        return tab.getAttribute("aria-selected") === "true";
      })
      ?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const ring = onType ? tabs : options;
  const current = ring.indexOf(target);
  if (current === -1 || ring.length === 0) {
    return;
  }
  event.preventDefault();
  const next =
    (current + (event.key === "ArrowDown" ? 1 : -1) + ring.length) %
    ring.length;
  ring[next]?.focus();
}

export function ModelPickerMenuContent(props: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const page = useGet(props.signals.page$);
  const back = useSet(props.signals.reset$);
  const focusPanel = useSet(props.signals.focusPanelRef$);
  let content: ReactNode;
  let label: string;
  if (page.kind === "overview") {
    label = t(($) => {
      return $.settings.models.picker.models;
    });
    content = <ModelPickerOverview {...props} />;
  } else if (page.kind === "settings") {
    label = t(($) => {
      return $.settings.models.picker.menu.chatSettings;
    });
    content = props.value && (
      <ChatModelSettings {...props} selection={props.value} />
    );
  } else if (page.category === "chat") {
    label = t(($) => {
      return $.settings.models.picker.chatModels;
    });
    content = <ChatModelList {...props} />;
  } else {
    label =
      page.category === "image"
        ? t(($) => {
            return $.settings.models.picker.imageModels;
          })
        : t(($) => {
            return $.settings.models.picker.videoModels;
          });
    content = <MediaModelList {...props} categoryId={page.category} />;
  }
  return (
    <div
      key={page.kind === "models" ? page.category : page.kind}
      ref={focusPanel}
      role="region"
      aria-label={label}
      className="motion-safe:duration-150 [&_button:focus-visible]:ring-inset [&_button:focus-visible]:ring-offset-0"
      onKeyDown={(event) => {
        if (event.key === "Escape" && page.kind !== "overview") {
          event.preventDefault();
          event.stopPropagation();
          back();
        } else {
          moveMenuFocus(event);
        }
      }}
    >
      {content}
    </div>
  );
}
