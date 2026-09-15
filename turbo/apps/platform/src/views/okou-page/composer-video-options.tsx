import type { ReactNode } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { ChevronDown, Volume2, VolumeX } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Slider } from "@okouai/ui/components/ui/slider";
import { Switch } from "@okouai/ui/components/ui/switch";
import { Button, cn } from "@okouai/ui";
import {
  VIDEO_MODEL_CONFIGS,
  type ResolvedVideoGenerationOptions,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoModelConfig,
} from "@okouai/core/video-model-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useTranslation } from "react-i18next";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type {
  ComposerSignals,
  ComposerVideoModelSignals,
} from "../../signals/okou-page/composer-signals.ts";
import {
  resolveVideoRunOptions,
  videoRunOptionsPatch,
  videoRunOptionsText,
} from "../../signals/okou-page/video-run-options.ts";

/**
 * Groups the settings so the pane reads as blocks rather than a run of loose
 * rows. Concentric corners: the popover is 12px and the gap between panels
 * matches its padding at 6px, so a panel is `rounded-md` (12 − 6).
 *
 * The fill is the lightest grey in the scale — `gray-50` was heavy enough that
 * the panels read as the subject rather than as grouping.
 */
function SettingsPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-gray-0 px-2.5 py-2 dark:bg-gray-50">
      {children}
    </div>
  );
}

/** Longest side of an aspect-ratio glyph inside its 24px box. */
const RATIO_GLYPH_SPAN = 20;

/**
 * Proportions per accepted ratio. A table keyed by the literal union keeps the
 * unparseable ratio unrepresentable, rather than parsing a string and choosing
 * what to draw when it does not split into two numbers.
 */
const RATIO_GLYPH_SIDES = {
  "21:9": [21, 9],
  "16:9": [16, 9],
  "4:3": [4, 3],
  "1:1": [1, 1],
  "3:4": [3, 4],
  "9:16": [9, 16],
} as const satisfies Record<VideoAspectRatio, readonly [number, number]>;

/**
 * The ratio drawn at its true proportion. Numbers alone make the user do the
 * arithmetic; the outline answers "which way up, and how wide" before the label
 * is read. Lucide's rectangles are a single fixed shape, so the rect is sized
 * here instead.
 */
function AspectRatioGlyph({ ratio }: { readonly ratio: VideoAspectRatio }) {
  const [width, height] = RATIO_GLYPH_SIDES[ratio];
  const longest = Math.max(width, height);
  const boxWidth = (width / longest) * RATIO_GLYPH_SPAN;
  const boxHeight = (height / longest) * RATIO_GLYPH_SPAN;
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-6 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
    >
      <rect
        x={(24 - boxWidth) / 2}
        y={(24 - boxHeight) / 2}
        width={boxWidth}
        height={boxHeight}
        rx={2.5}
      />
    </svg>
  );
}

/**
 * A value chip, following the segmented-control language TabsTrigger already
 * uses: hover carries the neutral state layer and the selected value carries
 * the heavier one. The selected label and glyph go dark rather than brand —
 * six orange cells in a grid compete with each other, and with the duration
 * readout that is genuinely brand-coloured.
 */
function OptionChip({
  label,
  glyph,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly glyph?: ReactNode;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "w-full rounded-md text-[13px] leading-none transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        glyph ? "flex flex-col items-center gap-1 py-1.5" : "h-7 px-2",
        selected
          ? "bg-state-selected font-medium text-foreground hover:bg-state-selected-hover"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {glyph}
      {label}
    </button>
  );
}

/** A setting with a value the chosen model does not let the user change. */
function FixedValueField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-foreground">{value}</span>
    </div>
  );
}

/**
 * One setting, fully expanded. Models disagree on how many values they take, so
 * the field adapts instead of forcing every setting through a dropdown: a
 * single accepted value is read only, and everything else is a grid of
 * equal-width chips the user can hit in one click.
 */
function VideoOptionField<Option extends string>({
  label,
  value,
  values,
  renderGlyph,
  onChange,
}: {
  readonly label: string;
  readonly value: Option;
  readonly values: readonly Option[];
  readonly renderGlyph?: (option: Option) => ReactNode;
  readonly onChange: (next: Option) => void;
}) {
  if (values.length <= 1) {
    return <FixedValueField label={label} value={value} />;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {/* Three fixed columns, shared by every chip field, so cells are one
          width down the whole pane however many values a model accepts.
          Ragged rows were what made a long list read as clutter. */}
      <div
        className="grid grid-cols-3 gap-1"
        role="radiogroup"
        aria-label={label}
      >
        {values.map((option) => {
          return (
            <OptionChip
              key={option}
              label={option}
              glyph={renderGlyph?.(option)}
              selected={option === value}
              onSelect={() => {
                onChange(option);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Duration is the one setting whose values are a scale rather than a set: they
 * are consecutive seconds, and how far the scale runs is the clearest single
 * difference between two models. So it reads as a ruler — the track length is
 * the model's range, the ticks are the steps it accepts, and the filled portion
 * is the answer to "how long", which no grid of chips can show at a glance.
 *
 * The slider itself is the shared component, so drag, click-anywhere-on-track,
 * arrow keys and Home/End all come from it rather than from this file.
 */
function VideoDurationField({
  label,
  value,
  durations,
  onChange,
}: {
  readonly label: string;
  readonly value: VideoDuration;
  readonly durations: readonly VideoDuration[];
  readonly onChange: (next: VideoDuration) => void;
}) {
  const first = durations[0];
  const last = durations[durations.length - 1];
  if (first === undefined || last === undefined || durations.length <= 1) {
    return <FixedValueField label={label} value={value} />;
  }
  const lastIndex = durations.length - 1;
  const index = Math.max(
    0,
    durations.findIndex((candidate) => {
      return candidate === value;
    }),
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <span className="text-[13px] font-medium tabular-nums text-brand-text">
          {value}
        </span>
      </div>
      <Slider
        ticks
        min={0}
        max={lastIndex}
        step={1}
        value={index}
        aria-label={label}
        aria-valuetext={value}
        onValueChange={(next) => {
          const duration = durations[next];
          if (duration !== undefined) {
            onChange(duration);
          }
        }}
      />
      {/* The two ends state the model's range, which is what actually differs
          from one model to the next. */}
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}

function VideoSettingsPane({
  resolved,
  config,
  onChange,
}: {
  readonly resolved: ResolvedVideoGenerationOptions;
  readonly config: VideoModelConfig;
  readonly onChange: (next: ResolvedVideoGenerationOptions) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      {/* The model these values belong to, as context. It is chosen from the
          composer's own video control, so this pane never nests a picker. */}
      <div className="flex items-baseline justify-between gap-3 px-2.5 pb-0.5 pt-1">
        <span className="text-[13px] text-muted-foreground">
          {t(($) => {
            return $.chat.templates.videoOptionsModel;
          })}
        </span>
        <span className="truncate text-[13px] font-medium text-foreground">
          {config.label}
        </span>
      </div>
      <SettingsPanel>
        <VideoOptionField
          label={t(($) => {
            return $.chat.templates.videoOptionsRatio;
          })}
          value={resolved.aspectRatio}
          values={config.aspectRatios}
          renderGlyph={(option) => {
            return <AspectRatioGlyph ratio={option} />;
          }}
          onChange={(aspectRatio) => {
            onChange({ ...resolved, aspectRatio });
          }}
        />
        <VideoOptionField
          label={t(($) => {
            return $.chat.templates.videoOptionsResolution;
          })}
          value={resolved.resolution}
          values={config.resolutions}
          onChange={(resolution) => {
            onChange({ ...resolved, resolution });
          }}
        />
      </SettingsPanel>
      <SettingsPanel>
        <VideoDurationField
          label={t(($) => {
            return $.chat.templates.videoOptionsDuration;
          })}
          value={resolved.duration}
          durations={config.durations}
          onChange={(duration) => {
            onChange({ ...resolved, duration });
          }}
        />
      </SettingsPanel>
      {config.supportsGenerateAudio && (
        <SettingsPanel>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-muted-foreground">
              {t(($) => {
                return $.chat.templates.videoOptionsAudio;
              })}
            </span>
            <Switch
              size="compact"
              checked={resolved.generateAudio}
              aria-label={t(($) => {
                return $.chat.templates.videoOptionsAudio;
              })}
              onCheckedChange={(checked) => {
                onChange({ ...resolved, generateAudio: checked });
              }}
            />
          </div>
        </SettingsPanel>
      )}
    </div>
  );
}

function VideoToolbarField<Option extends string>({
  label,
  value,
  values,
  onChange,
}: {
  readonly label: string;
  readonly value: Option;
  readonly values: readonly Option[];
  readonly onChange: (value: Option) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        disabled={values.length < 2}
        className="h-8 w-auto gap-1 border-transparent bg-transparent px-2 text-xs text-muted-foreground hover:bg-state-hover [&>[data-slot=select-icon]>svg]:size-3"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {values.map((option) => {
          return (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function VideoToolbar({
  resolved,
  config,
  onChange,
}: {
  readonly resolved: ResolvedVideoGenerationOptions;
  readonly config: VideoModelConfig;
  readonly onChange: (next: ResolvedVideoGenerationOptions) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="hidden shrink-0 items-center gap-0.5 @min-[760px]/composer:flex">
      <div className="mx-1 h-4 w-px bg-divider/60" />
      <VideoToolbarField
        label={t(($) => {
          return $.chat.templates.videoOptionsRatio;
        })}
        value={resolved.aspectRatio}
        values={config.aspectRatios}
        onChange={(aspectRatio) => {
          onChange({ ...resolved, aspectRatio });
        }}
      />
      <VideoToolbarField
        label={t(($) => {
          return $.chat.templates.videoOptionsResolution;
        })}
        value={resolved.resolution}
        values={config.resolutions}
        onChange={(resolution) => {
          onChange({ ...resolved, resolution });
        }}
      />
      <VideoToolbarField
        label={t(($) => {
          return $.chat.templates.videoOptionsDuration;
        })}
        value={resolved.duration}
        values={config.durations}
        onChange={(duration) => {
          onChange({ ...resolved, duration });
        }}
      />
      {config.supportsGenerateAudio && (
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.templates.videoOptionsAudio;
          })}
          aria-pressed={resolved.generateAudio}
          showTooltip
          onClick={() => {
            onChange({
              ...resolved,
              generateAudio: !resolved.generateAudio,
            });
          }}
        >
          {resolved.generateAudio ? (
            <Volume2 size={16} />
          ) : (
            <VolumeX size={16} />
          )}
        </Button>
      )}
    </div>
  );
}

function ComposerVideoOptionsChipBody({
  signals,
  videoModelSignals,
}: {
  readonly signals: ComposerSignals;
  readonly videoModelSignals: ComposerVideoModelSignals;
}) {
  const { t } = useTranslation();
  const open = useGet(signals.videoOptions.videoOptionsOpen$);
  const templatePickerMounted = useGet(signals.template.templatePickerMounted$);
  const setOpen = useSet(signals.videoOptions.setVideoOptionsOpen$);
  const patch = useGet(signals.videoOptions.videoRunOptions$);
  const setPatch = useSet(signals.videoOptions.setVideoRunOptions$);
  const model = useLastResolved(videoModelSignals.effectiveVideoModel$);
  // One control at every width: the summary button already states the whole
  // spec and owns the settings pane, so the wide composer stops expanding the
  // same four values into a row of its own.
  const buttonOnly =
    useGet(featureSwitch$)[FeatureSwitchKey.ComposerVideoOptionsButton] ===
    true;

  if (model === undefined) {
    return null;
  }

  const resolved = resolveVideoRunOptions(patch, model);
  const config: VideoModelConfig = VIDEO_MODEL_CONFIGS[model];
  const spec = videoRunOptionsText(resolved);
  const audioLabel = t(($) => {
    return resolved.generateAudio
      ? $.chat.templates.videoOptionsAudioOn
      : $.chat.templates.videoOptionsAudioOff;
  });

  return (
    <>
      {!buttonOnly && (
        <VideoToolbar
          resolved={resolved}
          config={config}
          onChange={(next) => {
            setPatch(videoRunOptionsPatch(next, model));
          }}
        />
      )}
      <Popover open={open && !templatePickerMounted} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className={cn(
              "shrink-0 gap-1.5 font-normal data-popup-open:bg-state-hover data-popup-open:text-foreground",
              !buttonOnly && "@min-[760px]/composer:hidden",
            )}
            aria-label={t(
              ($) => {
                return $.chat.templates.videoOptionsLabel;
              },
              { spec },
            )}
            aria-description={
              config.supportsGenerateAudio ? audioLabel : undefined
            }
          >
            <span className="tabular-nums">{spec}</span>
            {config.supportsGenerateAudio &&
              (resolved.generateAudio ? (
                <Volume2 size={14} aria-hidden />
              ) : (
                <VolumeX size={14} aria-hidden />
              ))}
            <ChevronDown className="shrink-0 opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[17.5rem] max-w-[calc(100vw-2rem)] p-1.5"
          aria-label={t(($) => {
            return $.chat.templates.videoOptions;
          })}
        >
          <VideoSettingsPane
            resolved={resolved}
            config={config}
            onChange={(next) => {
              setPatch(videoRunOptionsPatch(next, model));
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Creative Video settings. A wide composer lays the values out as a toolbar and
 * a narrow one collapses them into a summary button that opens the settings
 * pane; behind `ComposerVideoOptionsButton` the button is the only form.
 */
export function ComposerVideoOptionsChip({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const creativeVideo = useGet(signals.create.creativeVideo$);
  const videoModelSignals = signals.videoModel;
  if (!creativeVideo || !videoModelSignals) {
    return null;
  }
  return (
    <div className="order-first col-span-2 row-start-1 w-full text-muted-foreground @min-[640px]/composer:order-none @min-[640px]/composer:w-auto">
      <ComposerVideoOptionsChipBody
        signals={signals}
        videoModelSignals={videoModelSignals}
      />
    </div>
  );
}
