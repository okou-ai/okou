import { ComposerPresentationOptions } from "./composer-presentation-options.tsx";
import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ChartNoAxesCombined, Globe, Route, X } from "lucide-react";
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
 * The footer states one type at a time, as the chip the chosen task leaves
 * behind.
 *
 * `leading-5` pairs a line height with the arbitrary font size: `text-[13px]`
 * emits `font-size` alone, so without it the control inherits whatever line
 * height the row it sits in happens to carry.
 */
const TASK_CONTROL_SHAPE =
  "h-8 min-w-0 shrink-0 gap-2 px-2.5 text-[13px] font-normal leading-5";
/**
 * The label appears at the composer's width rule, the same width at which the
 * model picker shows its own, so a narrow composer keeps the icons, the type
 * and send on one line. The icon and the accessible name still carry the type.
 */
const TASK_CONTROL_LABEL = "hidden truncate composer-wide:block";

const TASK_ICONS = {
  ...COMPOSER_CREATE_ICONS,
  workflow: Route,
  website: Globe,
  visualization: ChartNoAxesCombined,
} as const;

function ComposerSelectedTask({
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
  if (!task) {
    return null;
  }
  const Icon = TASK_ICONS[task];
  /*
    One control, not a label plus a button. The chip is the exit: its leading
    type icon becomes the cross on hover, so nothing operable is visible while
    the selection is just a state, and the hit area is the whole chip rather
    than a 28px square.
  */
  return (
    <Button
      type="button"
      variant="neutral"
      className={cn(
        "group max-w-full",
        TASK_CONTROL_SHAPE,
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
        Both glyphs share one box and cross-fade, so the chip's width does not
        change between rest and hover.
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
      <span className={TASK_CONTROL_LABEL}>{labels[task]}</span>
    </Button>
  );
}

/**
 * What the run will make, at the end of the footer's icon row.
 *
 * The divider marks the break the row now carries: everything left of it adds
 * content to the message and is cleared by a send, everything right of it is
 * the composer's own state and is not. The type's parameters follow it on the
 * same line -- the slide count here, Creative Video's spec in the chip after
 * this group -- so a value sits beside the type it belongs to instead of two
 * rows above the controls that act on it.
 */
export function ComposerTaskControls({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const task = useGet(signals.taskChips.task$);
  if (task === null) {
    return null;
  }
  return (
    <>
      <div className="h-5 w-px shrink-0 bg-divider/60" aria-hidden />
      <ComposerSelectedTask signals={signals} />
      <ComposerPresentationOptions signals={signals} />
    </>
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
    <Select
      value={value}
      onValueChange={(next, details) => {
        if (next === null || !models.includes(next)) {
          details.cancel();
          return;
        }
        // A replay of the effective display value must not create a thread pin.
        // Explicit item presses still reach persistence, including save retries.
        if (next === value && details.reason === "none") {
          return;
        }
        onChange(next);
      }}
      modal={false}
    >
      <SelectTrigger
        aria-label={label}
        className="h-8 w-8 shrink-0 gap-1 border-transparent bg-transparent px-0 text-sm text-muted-foreground hover:bg-state-hover composer-wide:w-auto composer-wide:max-w-[11rem] composer-wide:px-2 [&>[data-slot=select-icon]]:hidden composer-wide:[&>[data-slot=select-icon]]:block"
      >
        <SelectValue>
          <span className="flex min-w-0 items-center justify-center gap-1.5 composer-wide:justify-start">
            {modelIcon(value)}
            <span className="hidden truncate composer-wide:block">
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
            if (next !== value && adjusted) {
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
