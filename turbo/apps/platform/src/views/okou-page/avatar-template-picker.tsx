import {
  ArrowLeft,
  Check,
  Loader2,
  Pause,
  Play,
  SlidersHorizontal,
  User,
} from "lucide-react";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  AvatarVideoAvatar,
  AvatarVideoAvatarsQuery,
  AvatarVideoVoice,
  AvatarVideoVoicesQuery,
} from "@okouai/api-contracts/contracts/avatar-video";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentControl,
  SegmentControlItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cn,
} from "@okouai/ui";
import { readAvatarTemplateOptions } from "@okouai/core/avatar-template";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  SyntheticEvent,
  UIEvent as ReactUIEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isSelectedAvatarTemplate } from "../../signals/okou-page/avatar-template-selection.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";

const AVATAR_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";
const ALL_FILTER_VALUE = "__all__";
const CATALOG_AUTO_LOAD_THRESHOLD_PX = 320;

const AVATAR_STYLE_VALUES = [
  "professional",
  "social",
] as const satisfies readonly NonNullable<AvatarVideoAvatarsQuery["style"]>[];
const AVATAR_GENDER_VALUES = [
  "female",
  "male",
] as const satisfies readonly NonNullable<AvatarVideoAvatarsQuery["gender"]>[];
const AVATAR_AGE_VALUES = [
  "adult",
  "senior",
  "young_adult",
] as const satisfies readonly NonNullable<AvatarVideoAvatarsQuery["age"]>[];
const AVATAR_SCENE_VALUES = [
  "lifestyle",
  "outdoors",
  "business",
  "studio",
  "health_fitness",
  "education",
  "news",
] as const satisfies readonly NonNullable<AvatarVideoAvatarsQuery["scene"]>[];
const AVATAR_ETHNICITY_VALUES = [
  "european",
  "african",
  "south_asian",
  "east_asian",
  "middle_eastern",
  "south_american",
  "north_american",
] as const satisfies readonly NonNullable<
  AvatarVideoAvatarsQuery["ethnicity"]
>[];
const VOICE_GENDER_VALUES = [
  "female",
  "male",
] as const satisfies readonly NonNullable<AvatarVideoVoicesQuery["gender"]>[];
const VOICE_AGE_VALUES = [
  "young",
  "middle_aged",
  "old",
] as const satisfies readonly NonNullable<AvatarVideoVoicesQuery["age"]>[];

interface CatalogFilterOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

function formatCatalogCategoryValue(value: string): string {
  const words = value.replaceAll("_", " ").replaceAll("-", " ");
  return `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}`;
}

function catalogFilterOptions<T extends string>(
  values: readonly T[],
): readonly CatalogFilterOption<T>[] {
  return values.map((value) => {
    return { value, label: formatCatalogCategoryValue(value) };
  });
}

function CatalogFilterField<T extends string>({
  label,
  allLabel,
  value,
  options,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly value: T | undefined;
  readonly options: readonly CatalogFilterOption<T>[];
  readonly disabled?: boolean;
  readonly onChange: (value: T | undefined) => void;
}) {
  const selectedLabel =
    options.find((option) => {
      return option.value === value;
    })?.label ?? allLabel;
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <Select
        value={value ?? ALL_FILTER_VALUE}
        disabled={disabled}
        onValueChange={(nextValue) => {
          if (nextValue === ALL_FILTER_VALUE) {
            onChange(undefined);
            return;
          }
          const nextOption = options.find((option) => {
            return option.value === nextValue;
          });
          if (nextOption) {
            onChange(nextOption.value);
          }
        }}
      >
        <SelectTrigger
          aria-label={`${label}: ${selectedLabel}`}
          className="h-9 w-full rounded-lg bg-background text-sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>{allLabel}</SelectItem>
          {options.map((option) => {
            return (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function CatalogFiltersPopover({
  activeCount,
  onClear,
  children,
}: {
  readonly activeCount: number;
  readonly onClear: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline">
          <SlidersHorizontal />
          {t(($) => {
            return $.artifacts.templates.filters.title;
          })}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(340px,calc(100vw-2rem))] p-4"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">
            {t(($) => {
              return $.artifacts.templates.filters.title;
            })}
          </p>
          {activeCount > 0 && (
            <button
              type="button"
              className="text-xs font-medium text-brand-text hover:text-brand-text/80"
              onClick={onClear}
            >
              {t(($) => {
                return $.artifacts.templates.filters.clear;
              })}
            </button>
          )}
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

function AvatarAspectRatioPicker({
  value,
  onChange,
}: {
  readonly value: "portrait" | "landscape";
  readonly onChange: (value: "portrait" | "landscape") => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.filters.aspectRatio;
  });
  return (
    <SegmentControl aria-label={label} value={value} onValueChange={onChange}>
      <SegmentControlItem value="portrait" aria-label={`${label}: 9:16`}>
        <span className="h-4 w-2.5 rounded-[2px] border-2 border-current" />
        9:16
      </SegmentControlItem>
      <SegmentControlItem value="landscape" aria-label={`${label}: 16:9`}>
        <span className="h-2.5 w-4 rounded-[2px] border-2 border-current" />
        16:9
      </SegmentControlItem>
    </SegmentControl>
  );
}

function hasPlayableAvatarVideo(videoUrl: string | undefined): boolean {
  return Boolean(
    videoUrl && /\.(?:m4v|mov|mp4|ogv|webm)(?:[?#]|$)/iu.test(videoUrl),
  );
}

function setAvatarTemplateVideoLoading(
  video: HTMLVideoElement,
  loading: boolean,
): void {
  const preview = video.closest<HTMLElement>("[data-avatar-template-preview]");
  if (preview) {
    preview.dataset.loading = String(loading);
  }
}

function playAvatarTemplatePreview(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (!video) {
    return;
  }
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  setAvatarTemplateVideoLoading(
    video,
    video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
  );
  detach(video.play(), Reason.DomCallback);
}

function resetAvatarTemplatePreview(event: SyntheticEvent<HTMLElement>): void {
  const video = event.currentTarget.querySelector("video");
  if (!video) {
    return;
  }
  setAvatarTemplateVideoLoading(video, false);
  video.pause();
  video.currentTime = 0;
}

function avatarMediaAspectClass(aspectRatio: "portrait" | "landscape"): string {
  return aspectRatio === "portrait" ? "aspect-[9/16]" : "aspect-video";
}

function AvatarTemplateMedia({
  avatar,
  aspectRatio,
  className,
}: {
  readonly avatar: AvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly className?: string;
}) {
  const previewVideoUrl = hasPlayableAvatarVideo(avatar.videoUrl)
    ? avatar.videoUrl
    : undefined;
  const previewImageUrl = avatar.coverUrl ?? avatar.videoUrl;
  return (
    <div
      data-avatar-template-preview=""
      data-loading="false"
      className={cn(
        "group/avatar-preview relative flex w-full shrink-0 items-center justify-center overflow-hidden bg-muted",
        avatarMediaAspectClass(aspectRatio),
        className,
      )}
    >
      {previewVideoUrl ? (
        <>
          <video
            src={previewVideoUrl}
            poster={avatar.coverUrl}
            muted
            loop
            playsInline
            preload="none"
            className="h-full w-full object-cover"
            onWaiting={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, true);
            }}
            onPlaying={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, false);
            }}
            onError={(event) => {
              setAvatarTemplateVideoLoading(event.currentTarget, false);
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/15 group-data-[loading=true]/avatar-preview:flex"
          >
            <Loader2 className="size-6 animate-spin text-white drop-shadow" />
          </span>
        </>
      ) : previewImageUrl ? (
        <img
          src={previewImageUrl}
          alt={avatar.name}
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <User size={40} className="text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}

function avatarTemplateCardClass(selected: boolean): string {
  return cn(
    "group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    AVATAR_CARD_SHADOW,
    selected ? "border-primary" : "border-border",
  );
}

function AvatarTemplateCardContent({
  avatar,
  aspectRatio,
  selected,
}: {
  readonly avatar: AvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly selected: boolean;
}) {
  return (
    <>
      <AvatarTemplateMedia avatar={avatar} aspectRatio={aspectRatio} />
      <div className="flex min-h-11 items-center justify-between gap-2 px-3 py-2.5">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {avatar.name}
        </p>
        {selected && (
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Check size={13} />
          </span>
        )}
      </div>
    </>
  );
}

function AvatarTemplateCard({
  avatar,
  aspectRatio,
  selected,
  onSelect,
}: {
  readonly avatar: AvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
  readonly selected: boolean;
  readonly onSelect: (avatar: AvatarVideoAvatar) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.artifacts.templates.selectTemplate;
        },
        { title: avatar.name },
      )}
      aria-pressed={selected}
      onClick={() => {
        onSelect(avatar);
      }}
      className={avatarTemplateCardClass(selected)}
      onFocus={playAvatarTemplatePreview}
      onBlur={resetAvatarTemplatePreview}
      onMouseEnter={playAvatarTemplatePreview}
      onMouseLeave={resetAvatarTemplatePreview}
    >
      <AvatarTemplateCardContent
        avatar={avatar}
        aspectRatio={aspectRatio}
        selected={selected}
      />
    </button>
  );
}

function AvatarCatalogFilters({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const filters = useGet(signals.template.avatarTemplateFilters$);
  const setFilters = useSet(signals.template.setAvatarTemplateFilters$);
  const allLabel = t(($) => {
    return $.artifacts.templates.filters.all;
  });
  const activeCount = [
    filters.style,
    filters.gender,
    filters.age,
    filters.scene,
    filters.ethnicity,
  ].filter(Boolean).length;

  return (
    <div
      data-avatar-catalog-toolbar=""
      className="flex w-full flex-wrap items-center justify-between gap-3"
    >
      <AvatarAspectRatioPicker
        value={filters.aspectRatio}
        onChange={(aspectRatio) => {
          setFilters({ ...filters, aspectRatio });
        }}
      />
      <CatalogFiltersPopover
        activeCount={activeCount}
        onClear={() => {
          setFilters({
            aspectRatio: filters.aspectRatio,
            style: undefined,
            gender: undefined,
            age: undefined,
            scene: undefined,
            ethnicity: undefined,
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.style;
            })}
            allLabel={allLabel}
            value={filters.style}
            options={catalogFilterOptions(AVATAR_STYLE_VALUES)}
            onChange={(style) => {
              setFilters({ ...filters, style });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.gender;
            })}
            allLabel={allLabel}
            value={filters.gender}
            options={catalogFilterOptions(AVATAR_GENDER_VALUES)}
            onChange={(gender) => {
              setFilters({ ...filters, gender });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.age;
            })}
            allLabel={allLabel}
            value={filters.age}
            options={catalogFilterOptions(AVATAR_AGE_VALUES)}
            onChange={(age) => {
              setFilters({ ...filters, age });
            }}
          />
          <CatalogFilterField
            label={t(($) => {
              return $.artifacts.templates.filters.scene;
            })}
            allLabel={allLabel}
            value={filters.scene}
            options={catalogFilterOptions(AVATAR_SCENE_VALUES)}
            onChange={(scene) => {
              setFilters({ ...filters, scene });
            }}
          />
          <div className="col-span-2">
            <CatalogFilterField
              label={t(($) => {
                return $.artifacts.templates.filters.ethnicity;
              })}
              allLabel={allLabel}
              value={filters.ethnicity}
              options={catalogFilterOptions(AVATAR_ETHNICITY_VALUES)}
              onChange={(ethnicity) => {
                setFilters({ ...filters, ethnicity });
              }}
            />
          </div>
        </div>
      </CatalogFiltersPopover>
    </div>
  );
}

function AvatarVoiceFilters({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const filters = useGet(signals.template.avatarTemplateVoiceFilters$);
  const setFilters = useSet(signals.template.setAvatarTemplateVoiceFilters$);
  const filterOptions = useLoadable(
    signals.template.avatarTemplateVoiceFilterOptions$,
  );
  const allLabel = t(($) => {
    return $.artifacts.templates.filters.all;
  });
  const languages =
    filterOptions.state === "hasData" ? filterOptions.data.languages : [];
  const useCases =
    filterOptions.state === "hasData" ? filterOptions.data.useCases : [];
  const activeCount = [
    filters.language,
    filters.gender,
    filters.age,
    filters.useCase,
  ].filter(Boolean).length;

  return (
    <CatalogFiltersPopover
      activeCount={activeCount}
      onClear={() => {
        setFilters({
          language: undefined,
          gender: undefined,
          age: undefined,
          useCase: undefined,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.language;
          })}
          allLabel={allLabel}
          value={filters.language}
          options={catalogFilterOptions(languages)}
          disabled={filterOptions.state !== "hasData"}
          onChange={(language) => {
            setFilters({ ...filters, language });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.gender;
          })}
          allLabel={allLabel}
          value={filters.gender}
          options={catalogFilterOptions(VOICE_GENDER_VALUES)}
          onChange={(gender) => {
            setFilters({ ...filters, gender });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.age;
          })}
          allLabel={allLabel}
          value={filters.age}
          options={catalogFilterOptions(VOICE_AGE_VALUES)}
          onChange={(age) => {
            setFilters({ ...filters, age });
          }}
        />
        <CatalogFilterField
          label={t(($) => {
            return $.artifacts.templates.filters.useCase;
          })}
          allLabel={allLabel}
          value={filters.useCase}
          options={catalogFilterOptions(useCases)}
          disabled={filterOptions.state !== "hasData"}
          onChange={(useCase) => {
            setFilters({ ...filters, useCase });
          }}
        />
      </div>
    </CatalogFiltersPopover>
  );
}

function AvatarVoicePickerToolbar({
  signals,
  avatar,
}: {
  readonly signals: ComposerSignals;
  readonly avatar: AvatarVideoAvatar;
}) {
  const { t } = useTranslation();
  const clearVoiceSelection = useSet(
    signals.template.clearAvatarTemplateVoiceSelection$,
  );

  return (
    <div
      data-avatar-voice-toolbar=""
      className="flex w-full items-center gap-3"
    >
      <Button
        showTooltip
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={t(($) => {
          return $.artifacts.templates.backToAvatars;
        })}
        onClick={() => {
          clearVoiceSelection();
        }}
      >
        <ArrowLeft className="size-4" />
      </Button>
      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {t(
          ($) => {
            return $.artifacts.templates.chooseVoice;
          },
          { title: avatar.name },
        )}
      </h3>
      <AvatarVoiceFilters signals={signals} />
    </div>
  );
}

function AvatarTemplateSkeletonGrid({
  aspectRatio,
}: {
  readonly aspectRatio: "portrait" | "landscape";
}) {
  return (
    <div
      data-avatar-template-skeleton-grid=""
      className={cn(
        "grid gap-4",
        aspectRatio === "portrait"
          ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
          : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
      )}
    >
      {Array.from(
        { length: aspectRatio === "portrait" ? 8 : 6 },
        (_, index) => {
          return (
            <Skeleton
              key={index}
              className={cn(avatarMediaAspectClass(aspectRatio), "rounded-xl")}
            />
          );
        },
      )}
    </div>
  );
}

function AvatarVoiceSkeletonGrid() {
  return (
    <div
      data-avatar-voice-skeleton-grid=""
      className="grid grid-cols-1 gap-2.5"
    >
      {Array.from({ length: 6 }, (_, index) => {
        return <Skeleton key={index} className="h-[86px] rounded-xl" />;
      })}
    </div>
  );
}

function CatalogLoadingSpinner() {
  const { t } = useTranslation();
  return (
    // The status row owns the containing block: an sr-only label is absolute,
    // so without it the label escapes the list scroller's clip and lands
    // thousands of pixels below, growing the dialog's scrollable area.
    <div
      role="status"
      className="relative flex h-14 shrink-0 items-center justify-center text-muted-foreground"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">
        {t(($) => {
          return $.settings.shared.loading;
        })}
      </span>
    </div>
  );
}

function AvatarTemplateEmpty({ error }: { readonly error: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <p className="text-sm font-semibold text-muted-foreground">
        {error
          ? t(($) => {
              return $.artifacts.catalog.error;
            })
          : t(($) => {
              return $.artifacts.templates.noMatches;
            })}
      </p>
    </div>
  );
}

function setVoiceCardPlaying(
  event: SyntheticEvent<HTMLAudioElement>,
  playing: boolean,
): void {
  const card = event.currentTarget.closest("[data-avatar-voice-card]");
  if (card instanceof HTMLElement) {
    card.dataset.playing = String(playing);
  }
}

function toggleVoicePreview(event: ReactMouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
  const card = event.currentTarget.closest("[data-avatar-voice-card]");
  if (!(card instanceof HTMLElement)) {
    return;
  }
  const audio = card.querySelector("audio[data-avatar-voice-preview]");
  if (!(audio instanceof HTMLAudioElement)) {
    return;
  }
  if (!audio.paused) {
    audio.pause();
    return;
  }
  const picker = card.closest("[data-avatar-voice-picker]");
  const candidates =
    picker?.querySelectorAll("audio[data-avatar-voice-preview]") ?? [];
  for (const candidate of candidates) {
    if (candidate instanceof HTMLAudioElement && candidate !== audio) {
      candidate.pause();
    }
  }
  detach(audio.play(), Reason.DomCallback);
}

interface VoiceCardVoice {
  readonly id: string;
  readonly name: string;
  readonly sampleUrl?: string;
  readonly language?: string;
  readonly gender?: string;
  readonly age?: string;
  readonly accent?: string;
  readonly useCase?: string;
}

/**
 * DOM contract for the row that hosts a {@link VoicePreviewControl}: the toggle
 * finds its audio through the card and flips `data-playing` for the icon swap.
 */
const VOICE_PREVIEW_CARD_PROPS = {
  "data-avatar-voice-card": "",
  "data-playing": "false",
} as const;

const VOICE_PREVIEW_CARD_CLASS = "group/voice";

function VoicePreviewControl({ voice }: { readonly voice: VoiceCardVoice }) {
  const { t } = useTranslation();
  return (
    <>
      <IconTooltipButton
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewVoice;
          },
          { title: voice.name },
        )}
        disabled={!voice.sampleUrl}
        onClick={toggleVoicePreview}
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/10 text-brand-text transition-all hover:scale-105 hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40",
          "group-data-[playing=true]/voice:bg-primary group-data-[playing=true]/voice:text-primary-foreground",
        )}
      >
        <Play
          size={17}
          className="ml-0.5 group-data-[playing=true]/voice:hidden"
        />
        <Pause
          size={17}
          className="hidden group-data-[playing=true]/voice:block"
        />
      </IconTooltipButton>
      {voice.sampleUrl && (
        <audio
          data-avatar-voice-preview=""
          src={voice.sampleUrl}
          preload="none"
          className="hidden"
          onPlay={(event) => {
            setVoiceCardPlaying(event, true);
          }}
          onPause={(event) => {
            setVoiceCardPlaying(event, false);
          }}
          onEnded={(event) => {
            setVoiceCardPlaying(event, false);
          }}
        />
      )}
    </>
  );
}

function AvatarVoiceCard<T extends VoiceCardVoice>({
  voice,
  selected,
  recommended,
  highlightRecommendation,
  onSelect,
}: {
  readonly voice: T;
  readonly selected: boolean;
  readonly recommended: boolean;
  readonly highlightRecommendation: boolean;
  readonly onSelect: (voice: T) => void;
}) {
  const { t } = useTranslation();
  const recommendedDescriptionId = `avatar-voice-recommendation-${encodeURIComponent(voice.id)}`;
  const metadata = Array.from(
    new Set(
      [voice.language, voice.gender, voice.age, voice.accent]
        .filter((value): value is string => {
          return value !== undefined;
        })
        .map(formatCatalogCategoryValue),
    ),
  );
  const description = voice.useCase
    ? formatCatalogCategoryValue(voice.useCase)
    : undefined;
  const selectVoice = () => {
    onSelect(voice);
  };
  return (
    <div
      {...VOICE_PREVIEW_CARD_PROPS}
      data-recommended={recommended ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.templates.selectVoice;
        },
        { title: voice.name },
      )}
      aria-pressed={selected}
      aria-describedby={recommended ? recommendedDescriptionId : undefined}
      onClick={selectVoice}
      onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectVoice();
        }
      }}
      className={cn(
        VOICE_PREVIEW_CARD_CLASS,
        "flex cursor-pointer items-center gap-3 rounded-xl border bg-card p-3 transition-colors duration-200 hover:border-foreground/20 hover:bg-card-hover hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        AVATAR_CARD_SHADOW,
        selected
          ? "border-primary bg-primary/[0.04]"
          : highlightRecommendation
            ? "border-primary/40 bg-primary/[0.025]"
            : "border-border",
      )}
    >
      <VoicePreviewControl voice={voice} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {voice.name}
            </p>
            {description && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {recommended && (
              <span
                id={recommendedDescriptionId}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-brand-text"
              >
                {t(($) => {
                  return $.artifacts.templates.recommended;
                })}
              </span>
            )}
            {selected && (
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                aria-hidden="true"
              >
                <Check size={13} />
              </span>
            )}
          </div>
        </div>
        {metadata.length > 0 && (
          <div className="mt-2 flex min-w-0 flex-wrap gap-1.5">
            {metadata.map((item) => {
              return (
                <span
                  key={item}
                  className="max-w-32 truncate rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {item}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function recommendedVoiceFirst(
  voices: readonly AvatarVideoVoice[],
  recommendedVoice: AvatarVideoVoice | null,
): readonly AvatarVideoVoice[] {
  if (!recommendedVoice) {
    return voices;
  }
  return [
    recommendedVoice,
    ...voices.filter((voice) => {
      return voice.id !== recommendedVoice.id;
    }),
  ];
}

function SelectedAvatarCard({
  avatar,
  aspectRatio,
}: {
  readonly avatar: AvatarVideoAvatar;
  readonly aspectRatio: "portrait" | "landscape";
}) {
  const { t } = useTranslation();
  const playable = hasPlayableAvatarVideo(avatar.videoUrl);
  return (
    <div
      data-selected-avatar-card=""
      tabIndex={playable ? 0 : undefined}
      aria-label={
        playable
          ? t(
              ($) => {
                return $.artifacts.templates.previewAvatarVideo;
              },
              { title: avatar.name },
            )
          : undefined
      }
      className={avatarTemplateCardClass(false)}
      onFocus={playAvatarTemplatePreview}
      onBlur={resetAvatarTemplatePreview}
      onMouseEnter={playAvatarTemplatePreview}
      onMouseLeave={resetAvatarTemplatePreview}
    >
      <AvatarTemplateCardContent
        avatar={avatar}
        aspectRatio={aspectRatio}
        selected={false}
      />
    </div>
  );
}

function AvatarVoiceCatalog({
  signals,
  selectionActive,
  selectedVoiceId,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly selectionActive: boolean;
  readonly selectedVoiceId: string | undefined;
  readonly onSelect: (voice: AvatarVideoVoice) => void;
}) {
  const catalog = useLoadable(signals.template.avatarTemplateVoiceCatalogPage$);
  const recommendation = useLoadable(
    signals.template.avatarTemplateRecommendedVoice$,
  );
  const lastCatalog = useLastResolved(
    signals.template.avatarTemplateVoiceCatalogPage$,
  );
  const generation = useGet(
    signals.template.avatarTemplateVoiceCatalogGeneration$,
  );
  const loadMore = useSet(signals.template.loadMoreAvatarTemplateVoices$);
  const loadingMore = useGet(signals.template.avatarTemplateVoicesLoadingMore$);
  const visibleCatalog =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const pageSignal = useGet(pageSignal$);
  const recommendedVoice =
    recommendation.state === "hasData"
      ? (recommendation.data ?? visibleCatalog?.voices[0] ?? null)
      : recommendation.state === "hasError"
        ? null
        : undefined;
  const visibleVoices =
    visibleCatalog && recommendedVoice !== undefined
      ? recommendedVoiceFirst(visibleCatalog.voices, recommendedVoice)
      : undefined;
  const handleVoiceScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (catalog.state !== "hasData" || !catalog.data.hasNext) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > CATALOG_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "avatar voice paging");
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div
        data-avatar-voice-list-scroll=""
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={handleVoiceScroll}
      >
        {catalog.state === "hasError" ? (
          <AvatarTemplateEmpty error />
        ) : visibleVoices === undefined ? (
          <AvatarVoiceSkeletonGrid />
        ) : visibleVoices.length > 0 ? (
          <div className="grid grid-cols-1 gap-2.5">
            {visibleVoices.map((voice) => {
              const recommended = voice.id === recommendedVoice?.id;
              return (
                <AvatarVoiceCard
                  key={voice.id}
                  voice={voice}
                  selected={voice.id === selectedVoiceId}
                  recommended={recommended}
                  highlightRecommendation={recommended && !selectionActive}
                  onSelect={onSelect}
                />
              );
            })}
          </div>
        ) : (
          <AvatarTemplateEmpty error={false} />
        )}
        {loadingMore && <CatalogLoadingSpinner />}
      </div>
    </section>
  );
}

function AvatarVoicePickerContent({
  signals,
  avatar,
  value,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly avatar: AvatarVideoAvatar;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (
    avatar: AvatarVideoAvatar,
    voice: AvatarVideoVoice,
  ) => void;
}) {
  const aspectRatio = useGet(
    signals.template.avatarTemplateFilters$,
  ).aspectRatio;
  const selectedVoiceId =
    value?.type === "video"
      ? readAvatarTemplateOptions(value.selection).voiceId
      : undefined;

  return (
    <div
      data-avatar-voice-picker=""
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-5 overflow-hidden md:grid-cols-[minmax(210px,0.72fr)_minmax(0,1.55fr)] md:grid-rows-1">
        <div
          className={cn(
            "mx-auto w-full self-start",
            aspectRatio === "portrait" ? "max-w-[210px]" : "max-w-72",
          )}
        >
          <SelectedAvatarCard avatar={avatar} aspectRatio={aspectRatio} />
        </div>
        <AvatarVoiceCatalog
          signals={signals}
          selectionActive={selectedVoiceId !== undefined}
          selectedVoiceId={selectedVoiceId}
          onSelect={(voice) => {
            onSelect(avatar, voice);
          }}
        />
      </div>
    </div>
  );
}

function AvatarCatalogPickerContent({
  signals,
  value,
  onUse,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onUse: (avatar: AvatarVideoAvatar) => void;
}) {
  const catalog = useLoadable(signals.template.avatarTemplateCatalogPage$);
  const lastCatalog = useLastResolved(
    signals.template.avatarTemplateCatalogPage$,
  );
  const generation = useGet(signals.template.avatarTemplateCatalogGeneration$);
  const filters = useGet(signals.template.avatarTemplateFilters$);
  const loadMore = useSet(signals.template.loadMoreAvatarTemplates$);
  const loadingMore = useGet(signals.template.avatarTemplatesLoadingMore$);
  const visibleCatalog =
    catalog.state === "hasData"
      ? catalog.data
      : lastCatalog?.generation === generation
        ? lastCatalog
        : undefined;
  const pageSignal = useGet(pageSignal$);
  const handleAvatarScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (catalog.state !== "hasData" || !catalog.data.hasNext) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > CATALOG_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(loadMore(pageSignal), Reason.DomCallback, "avatar catalog paging");
  };

  return (
    <div
      data-avatar-template-grid-scroll=""
      className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onScroll={handleAvatarScroll}
    >
      {catalog.state === "hasError" ? (
        <AvatarTemplateEmpty error />
      ) : visibleCatalog === undefined ? (
        <AvatarTemplateSkeletonGrid aspectRatio={filters.aspectRatio} />
      ) : (
        <>
          {visibleCatalog.avatars.length > 0 ? (
            <div
              className={cn(
                "grid gap-4",
                filters.aspectRatio === "portrait"
                  ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"
                  : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
              )}
            >
              {visibleCatalog.avatars.map((avatar) => {
                return (
                  <AvatarTemplateCard
                    key={avatar.id}
                    avatar={avatar}
                    aspectRatio={filters.aspectRatio}
                    selected={isSelectedAvatarTemplate(avatar, value)}
                    onSelect={onUse}
                  />
                );
              })}
            </div>
          ) : (
            <AvatarTemplateEmpty error={false} />
          )}
        </>
      )}
      {loadingMore && <CatalogLoadingSpinner />}
    </div>
  );
}

/**
 * Avatar picker toolbar, rendered by the template dialog into the header row
 * that already reserves space for the close button.
 */
export function AvatarTemplatePickerToolbar({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const selectedAvatar = useGet(
    signals.template.selectedAvatarTemplateForVoice$,
  );
  if (selectedAvatar) {
    return (
      <AvatarVoicePickerToolbar signals={signals} avatar={selectedAvatar} />
    );
  }
  return <AvatarCatalogFilters signals={signals} />;
}

export function AvatarTemplatePickerContent({
  signals,
  value,
  onSelect,
}: {
  readonly signals: ComposerSignals;
  readonly value: GenerationTemplateRequest | undefined;
  readonly onSelect: (
    avatar: AvatarVideoAvatar,
    voice: AvatarVideoVoice,
    aspectRatio: "portrait" | "landscape",
  ) => void;
}) {
  const selectedAvatar = useGet(
    signals.template.selectedAvatarTemplateForVoice$,
  );
  const selectAvatar = useSet(signals.template.selectAvatarTemplateForVoice$);
  const clearVoiceSelection = useSet(
    signals.template.clearAvatarTemplateVoiceSelection$,
  );
  const aspectRatio = useGet(
    signals.template.avatarTemplateFilters$,
  ).aspectRatio;

  if (selectedAvatar) {
    return (
      <AvatarVoicePickerContent
        signals={signals}
        avatar={selectedAvatar}
        value={value}
        onSelect={(avatar, voice) => {
          clearVoiceSelection();
          onSelect(avatar, voice, aspectRatio);
        }}
      />
    );
  }

  return (
    <AvatarCatalogPickerContent
      signals={signals}
      value={value}
      onUse={(avatar) => {
        selectAvatar(avatar);
      }}
    />
  );
}
