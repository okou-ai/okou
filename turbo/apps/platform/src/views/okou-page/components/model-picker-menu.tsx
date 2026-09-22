import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Cpu,
  MessageCircle,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  cn,
} from "@okouai/ui";
import {
  getCanonicalModelDisplayName,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { useTranslation } from "react-i18next";
import type { ModelPickerMenuSignals } from "../../../signals/okou-page/model-picker-menu.ts";
import { formatChatEffort, useChatEffort } from "./chat-effort-controls.tsx";
import { PriceTierBadge } from "./model-picker-price-tier.tsx";
import {
  getMediaModelPriceTierLabel,
  getModelBrandIconType,
} from "./settings/provider-ui-config.ts";
import { ProviderIcon } from "./settings/provider-icons.tsx";
import type {
  MediaModelPanelState,
  ModelProviderSelection,
} from "./model-provider-picker.tsx";

interface ModelPickerMenuOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly content: ReactNode;
  readonly disabled: boolean;
  readonly fastAvailable: boolean;
  readonly fastImpact: ReactNode;
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
    <div
      className={cn(
        "sticky top-0 z-10 flex items-center gap-1 bg-card px-2 text-xs text-muted-foreground",
        onBack ? "h-9" : "h-7",
      )}
    >
      {onBack && (
        <DropdownMenuItem
          closeOnClick={false}
          className="-ml-1 w-7 shrink-0 justify-center px-0 text-muted-foreground hover:text-foreground"
          aria-label={backLabel}
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </DropdownMenuItem>
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
}: {
  model: string;
  category: string;
  icon: ReactNode;
  summary?: string;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative h-12 rounded-lg">
      <DropdownMenuItem
        closeOnClick={false}
        className="min-h-12 w-full justify-start gap-2 px-2 pr-7 text-left font-normal text-foreground"
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
      </DropdownMenuItem>
    </div>
  );
}

interface ModelPickerMenuContentProps {
  signals: ModelPickerMenuSignals;
  value: ModelProviderSelection | null;
  placeholder: string;
  options: readonly ModelPickerMenuOption[];
  mediaModelPanel: MediaModelPanelState | undefined;
  onChange: (selection: ModelProviderSelection) => void;
}

function ModelPickerOverview({
  signals,
  value,
  placeholder,
  options,
  mediaModelPanel,
}: Omit<ModelPickerMenuContentProps, "onChange">) {
  const { t } = useTranslation();
  const { effort: savedEffort } = useChatEffort(value);
  const showModels = useSet(signals.showModels$);
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
              savedEffort === undefined
                ? undefined
                : formatChatEffort(savedEffort),
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          onChange={() => {
            mediaModelPanel?.onActiveCategoryChange(null);
            showModels("chat");
          }}
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
      <DropdownMenuRadioGroup
        value={value?.selectedModel}
        className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1"
      >
        {options.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t(($) => {
              return $.settings.models.picker.noConfiguredModels;
            })}
          </p>
        )}
        {options.map((option) => {
          return (
            <DropdownMenuRadioItem
              key={option.model}
              value={option.model}
              label={option.label}
              className="w-full shrink-0 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
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
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
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
      <DropdownMenuRadioGroup
        value={
          category?.options.find((option) => {
            return option.selected;
          })?.key
        }
        className="flex max-h-[284px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1"
      >
        {category?.options.map((option) => {
          return (
            <DropdownMenuRadioItem
              key={option.key}
              value={option.key}
              label={option.label}
              className="w-full shrink-0 pr-8 text-left font-normal text-foreground"
              aria-label={option.label}
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
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}

function ModelPickerFlyoutOptions({
  activeMedia,
  mediaModelPanel,
  options,
  value,
  onChange,
}: Pick<
  ModelPickerMenuContentProps,
  "mediaModelPanel" | "options" | "value" | "onChange"
> & {
  activeMedia?: MediaModelPanelState["categories"][number];
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuRadioGroup
      value={
        activeMedia
          ? activeMedia.options.find((option) => {
              return option.selected;
            })?.key
          : value?.selectedModel
      }
      className="-my-1 flex max-h-[252px] flex-col gap-0.5 overflow-y-auto overscroll-contain py-1"
    >
      {activeMedia
        ? activeMedia.options.map((option) => {
            return (
              <DropdownMenuRadioItem
                key={option.key}
                value={option.key}
                label={option.label}
                closeOnClick
                className="w-full shrink-0 pr-8 text-[13px] font-normal text-foreground"
                onClick={() => {
                  mediaModelPanel?.onActiveCategoryChange(activeMedia.id);
                  option.onSelect();
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
              </DropdownMenuRadioItem>
            );
          })
        : options.map((option) => {
            return (
              <DropdownMenuRadioItem
                key={option.model}
                value={option.model}
                label={option.label}
                disabled={option.disabled}
                closeOnClick
                className="w-full shrink-0 pr-8 text-[13px] font-normal text-foreground"
                onClick={() => {
                  mediaModelPanel?.onActiveCategoryChange(null);
                  onChange(
                    value?.selectedModel === option.model
                      ? value
                      : { selectedModel: option.model },
                  );
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
              </DropdownMenuRadioItem>
            );
          })}
      {!activeMedia && options.length === 0 && (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.models.picker.noConfiguredModels;
          })}
        </p>
      )}
    </DropdownMenuRadioGroup>
  );
}

/** Native submenus own hover intent, keyboard traversal and collision placement. */
export function ModelPickerFlyoutContent(props: ModelPickerMenuContentProps) {
  const { signals, value, placeholder, options, mediaModelPanel } = props;
  const { t } = useTranslation();
  const root = useGet(signals.flyoutRoot$);
  const rootRef = useSet(signals.flyoutRootRef$);
  const selectedOption = options.find((option) => {
    return option.model === value?.selectedModel;
  });
  const chatLabel =
    selectedOption?.label ??
    (value ? getCanonicalModelDisplayName(value.selectedModel) : placeholder);
  const chatModelsLabel = t(($) => {
    return $.settings.models.picker.chatModels;
  });
  if (!mediaModelPanel?.categories.length) {
    return <ModelPickerFlyoutOptions {...props} />;
  }
  const types = [
    {
      id: "chat",
      label: t(($) => {
        return $.settings.models.picker.categoryChat;
      }),
      panelLabel: chatModelsLabel,
      current: chatLabel,
      icon: <MessageCircle size={15} aria-hidden="true" />,
      media: undefined,
    },
    ...mediaModelPanel.categories.map((category) => {
      const selected = category.options.find((option) => {
        return option.selected;
      });
      return {
        id: category.id,
        label: category.tabLabel,
        panelLabel: category.label,
        current: selected?.label ?? category.label,
        icon: selected?.icon,
        media: category,
      };
    }),
  ];
  return (
    <div ref={rootRef} className="flex flex-col gap-0.5">
      {types.map((type) => {
        return (
          <DropdownMenuSub
            key={type.id}
            defaultOpen={type.id === "chat"}
            closeParentOnEsc
          >
            <DropdownMenuSubTrigger
              label={type.label}
              delay={200}
              className="min-h-11 w-full shrink-0 gap-2 text-left font-normal"
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
                {type.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate text-[13px] leading-[17px] text-foreground">
                  {type.label}
                </span>
                <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
                  {type.current}
                </span>
              </span>
              <ChevronRight
                size={13}
                aria-hidden="true"
                className="shrink-0 text-muted-foreground"
              />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              anchor={root}
              side="right"
              align="end"
              alignOffset={-4}
              sideOffset={6}
              aria-labelledby={undefined}
              aria-label={type.panelLabel}
              className="w-[252px] max-w-[calc(100vw-16px)]"
            >
              <ModelPickerFlyoutOptions {...props} activeMedia={type.media} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </div>
  );
}

export function ModelPickerMenuContent(props: ModelPickerMenuContentProps) {
  const { t } = useTranslation();
  const page = useGet(props.signals.page$);
  let content: ReactNode;
  let label: string;
  if (page.kind === "overview") {
    label = t(($) => {
      return $.settings.models.picker.models;
    });
    content = <ModelPickerOverview {...props} />;
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
    <div role="region" aria-label={label} className="motion-safe:duration-150">
      {content}
    </div>
  );
}
