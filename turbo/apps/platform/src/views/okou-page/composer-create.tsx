import { withChatScrollLayout } from "../components/chat-scroll-layout.tsx";
import { ComposerPresentationOptions } from "./composer-presentation-options.tsx";
import type { KeyboardEvent, ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  Globe,
  Route,
  X,
} from "lucide-react";
import { toast } from "@okouai/ui/components/ui/sonner";
import { resolveVideoRunOptions } from "../../signals/okou-page/video-run-options.ts";
import { Button } from "@okouai/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import {
  IMAGE_MODEL_CONFIGS,
  PUBLIC_IMAGE_MODELS,
} from "@okouai/core/image-model-catalog";
import {
  VIDEO_MODEL_CONFIGS,
  PUBLIC_VIDEO_MODELS,
} from "@okouai/core/video-model-catalog";
import type {
  ComposerSignals,
  ComposerImageModelSignals,
  ComposerVideoModelSignals,
} from "../../signals/okou-page/composer-signals.ts";
import {
  composerCreateModeDescription,
  composerCreateModeLabel,
  composerCreateModeName,
} from "../../signals/okou-page/composer-create.ts";
import { cn } from "@okouai/ui/lib/utils";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { COMPOSER_CREATE_ICONS } from "./slash-workflow.tsx";
import {
  ImageModelBrandIcon,
  VideoModelBrandIcon,
} from "./components/model-provider-picker.tsx";

const CREATE_CONTROL_FOCUS =
  "focus-visible:bg-state-hover focus-visible:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0";

/**
 * One muted ink for every type. Only presentation, video and image ever had an
 * `--artifact-*` foreground, so the six choices read as three coloured and
 * three grey; colour on a picker is decoration, and the real colour here comes
 * from the template covers.
 */
const CREATE_MODE_ICON_CLASS = "text-muted-foreground";

const TASK_ICONS = {
  ...COMPOSER_CREATE_ICONS,
  workflow: Route,
  website: Globe,
  visualization: ChartNoAxesCombined,
} as const;

export function ComposerSelectedTask({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const task = useGet(signals.taskChips.task$);
  const selectTask = useSet(signals.taskChips.selectTask$);
  const labels = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const Icon = task ? TASK_ICONS[task] : null;
  /*
    The presentation options sit on this line, beside the chip they describe.
    In the action row below they were 260px right and 112px down from it, among
    controls that act on the message rather than on the artifact.

    Video is the exception, and it is not the same case: its spec has to be read
    against the model that accepts it, and that model's picker lives in the
    action row, so the spec is back there next to the connectors rather than two
    rows above the value it depends on.

    The row is not the chip's: the chip is gated by a switch the options are
    not, so it also has to stand on its own. `empty:hidden` keeps it from
    claiming space when neither is showing.
  */
  return withChatScrollLayout(
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-4 pt-4 empty:hidden">
      {/*
        One control, not a label plus a button. The chip is the exit: its
        leading type icon becomes the cross on hover, so nothing operable is
        visible while the selection is just a state, and the hit area is the
        whole chip rather than a 28px square.
      */}
      {task && Icon ? (
        <Button
          type="button"
          variant="neutral"
          className={cn(
            "group h-8 max-w-full gap-2 px-2.5 text-[13px] font-normal",
            CREATE_CONTROL_FOCUS,
          )}
          aria-label={t(
            ($) => {
              return $.chat.taskChips.removeTask;
            },
            { task: labels[task] },
          )}
          onClick={() => {
            selectTask(null);
          }}
        >
          {/*
          Both glyphs share one box and cross-fade, so the chip's width does
          not change between rest and hover.
        */}
          <span className="relative inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <Icon
              size={16}
              className="transition-opacity group-hover:opacity-0"
              aria-hidden
            />
            <X
              size={16}
              className="absolute opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden
            />
          </span>
          <span className="truncate">{labels[task]}</span>
        </Button>
      ) : null}
      <ComposerPresentationOptions signals={signals} />
    </div>,
  );
}

function handleCreateTypeNavigation(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const options = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  );
  if (event.key.length === 1 && /\S/.test(event.key)) {
    const match = options.find((option) => {
      return option
        .getAttribute("aria-label")
        ?.toLocaleLowerCase()
        .startsWith(event.key.toLocaleLowerCase());
    });
    if (match) {
      event.preventDefault();
      match.focus();
    }
    return;
  }
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  ) {
    return;
  }
  const index = options.findIndex((option) => {
    return option === event.target;
  });
  if (index === -1) {
    return;
  }
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : (index +
            (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) +
            options.length) %
          options.length;
  options[next]?.focus();
}

export function ComposerCreateControls({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const mode = useGet(signals.create.mode$);
  const task = useGet(signals.taskChips.task$);
  const pickerOpen = useGet(signals.create.pickerOpen$);
  const setPickerOpen = useSet(signals.create.setPickerOpen$);
  const setMode = useSet(signals.create.setMode$);
  if (task || !mode) {
    return withChatScrollLayout(null);
  }
  const Icon = COMPOSER_CREATE_ICONS[mode];
  return withChatScrollLayout(
    <div
      className="@container/create-controls flex shrink-0 items-center gap-1 px-4 pt-4 pb-1"
      data-testid="composer-create-mode"
      onKeyDown={(event) => {
        if (event.key === "Escape" && pickerOpen) {
          event.preventDefault();
          setPickerOpen(false);
        }
      }}
    >
      <Button
        type="button"
        variant="quiet"
        size="sm"
        role="combobox"
        aria-label={t(($) => {
          return $.chat.composer.create.chooseType;
        })}
        aria-haspopup="listbox"
        aria-expanded={pickerOpen}
        aria-controls={pickerOpen ? signals.create.pickerId : undefined}
        className={cn(
          "min-w-0 gap-2 bg-gray-50 px-2.5 font-normal text-foreground",
          CREATE_CONTROL_FOCUS,
        )}
        onClick={() => {
          setPickerOpen(!pickerOpen);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (pickerOpen) {
              const picker = document.getElementById(signals.create.pickerId);
              const option =
                picker?.querySelector<HTMLElement>('[aria-selected="true"]') ??
                picker?.querySelector<HTMLElement>('[role="option"]');
              option?.focus();
              return;
            }
            setPickerOpen(true);
          }
        }}
      >
        <Icon className={CREATE_MODE_ICON_CLASS} aria-hidden />
        <span className="truncate">{composerCreateModeLabel(mode)}</span>
        <ChevronDown
          className={cn("shrink-0 opacity-50", pickerOpen && "rotate-180")}
          aria-hidden
        />
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="icon-sm"
        className={cn("shrink-0", CREATE_CONTROL_FOCUS)}
        aria-label={t(($) => {
          return $.chat.composer.create.exit;
        })}
        showTooltip
        onClick={() => {
          setMode(null);
        }}
      >
        <X aria-hidden />
      </Button>
    </div>,
  );
}

export function ComposerCreatePicker({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const mode = useGet(signals.create.mode$);
  const pickerOpen = useGet(signals.create.pickerOpen$);
  const setMode = useSet(signals.create.setMode$);
  const setPickerOpen = useSet(signals.create.setPickerOpen$);
  if (!pickerOpen) {
    return withChatScrollLayout(null);
  }
  return withChatScrollLayout(
    <div className="col-start-1 row-start-1 min-w-0 px-4 pt-2 pb-4">
      <div
        id={signals.create.pickerId}
        role="listbox"
        aria-label={t(($) => {
          return $.chat.composer.create.chooseType;
        })}
        className="flex w-72 max-w-full flex-col gap-1 rounded-xl border border-control-border bg-card p-1"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setPickerOpen(false);
            return;
          }
          handleCreateTypeNavigation(event);
        }}
      >
        {signals.create.modes.map((type, index) => {
          const Icon = COMPOSER_CREATE_ICONS[type];
          const selected = type === mode;
          const initialFocus = mode ? selected : index === 0;
          return (
            <Button
              key={type}
              type="button"
              variant="quiet"
              role="option"
              aria-label={composerCreateModeName(type)}
              aria-selected={selected}
              autoFocus={initialFocus}
              tabIndex={initialFocus ? 0 : -1}
              className={cn(
                "relative h-auto w-full justify-start gap-2.5 py-2.5 pl-2 pr-8 text-left font-normal text-foreground",
                CREATE_CONTROL_FOCUS,
                "hover:bg-gray-50 focus-visible:bg-gray-50",
                selected && "bg-gray-50",
              )}
              onClick={() => {
                setMode(type);
              }}
            >
              <Icon className={CREATE_MODE_ICON_CLASS} aria-hidden />
              <span className="min-w-0">
                <span className="block text-sm">
                  {composerCreateModeName(type)}
                </span>
                <span className="block whitespace-normal text-xs text-muted-foreground">
                  {composerCreateModeDescription(type)}
                </span>
              </span>
              {selected && <Check className="absolute right-2" aria-hidden />}
            </Button>
          );
        })}
      </div>
    </div>,
  );
}

function MediaModelSelect<Model extends string>({
  value,
  models,
  label,
  modelLabel,
  modelIcon,
  onChange,
}: {
  readonly value: Model;
  readonly models: readonly Model[];
  readonly label: string;
  readonly modelLabel: (model: Model) => string;
  readonly modelIcon: (model: Model) => ReactNode;
  readonly onChange: (model: Model) => void;
}) {
  return (
    // Keep adjacent composer actions tappable while the model menu is open.
    <Select value={value} onValueChange={onChange} modal={false}>
      <SelectTrigger
        aria-label={label}
        className="h-8 w-8 shrink-0 gap-1 border-transparent bg-transparent px-0 text-sm text-muted-foreground hover:bg-state-hover @min-[600px]/composer:w-auto @min-[600px]/composer:max-w-[11rem] @min-[600px]/composer:px-2 [&>[data-slot=select-icon]]:hidden @min-[600px]/composer:[&>[data-slot=select-icon]]:block"
      >
        <SelectValue>
          <span className="flex min-w-0 items-center justify-center gap-1.5 @min-[600px]/composer:justify-start">
            {modelIcon(value)}
            <span className="hidden truncate @min-[600px]/composer:block">
              {modelLabel(value)}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="end">
        {models.map((model) => {
          return (
            <SelectItem key={model} value={model}>
              <span className="flex items-center gap-2">
                {modelIcon(model)}
                {modelLabel(model)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

export function ComposerCreateImageModelPicker({
  model,
}: {
  readonly model: ComposerImageModelSignals;
}) {
  const { t } = useTranslation();
  const value = useLastResolved(model.effectiveImageModel$);
  const setModel = useSet(model.setImageModel$);
  const signal = useGet(pageSignal$);
  if (!value) {
    return null;
  }
  return (
    <MediaModelSelect
      value={value}
      models={PUBLIC_IMAGE_MODELS}
      label={t(($) => {
        return $.settings.models.picker.imageModels;
      })}
      modelLabel={(item) => {
        return IMAGE_MODEL_CONFIGS[item].label;
      }}
      modelIcon={(item) => {
        return <ImageModelBrandIcon model={item} />;
      }}
      onChange={(next) => {
        detach(setModel(next, signal), Reason.DomCallback);
      }}
    />
  );
}

export function ComposerCreateVideoModelPicker({
  model,
  signals,
}: {
  readonly model: ComposerVideoModelSignals;
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const value = useLastResolved(model.effectiveVideoModel$);
  const setModel = useSet(model.setVideoModel$);
  const patch = useGet(signals.videoOptions.videoRunOptions$);
  const signal = useGet(pageSignal$);
  if (!value) {
    return null;
  }
  return (
    <MediaModelSelect
      value={value}
      models={PUBLIC_VIDEO_MODELS}
      label={t(($) => {
        return $.settings.models.picker.videoModels;
      })}
      modelLabel={(item) => {
        return VIDEO_MODEL_CONFIGS[item].label;
      }}
      modelIcon={(item) => {
        return <VideoModelBrandIcon model={item} />;
      }}
      onChange={(next) => {
        detach(
          (async () => {
            await setModel(next, signal);
            signal.throwIfAborted();
            const resolved = resolveVideoRunOptions(patch, next);
            const adjusted =
              (patch.aspectRatio !== undefined &&
                patch.aspectRatio !== resolved.aspectRatio) ||
              (patch.resolution !== undefined &&
                patch.resolution !== resolved.resolution) ||
              (patch.duration !== undefined &&
                patch.duration !== resolved.duration) ||
              (patch.generateAudio !== undefined &&
                patch.generateAudio !== resolved.generateAudio);
            if (adjusted) {
              toast.info(
                t(($) => {
                  return $.chat.composer.create.settingsAdjusted;
                }),
              );
            }
          })(),
          Reason.DomCallback,
        );
      }}
    />
  );
}
