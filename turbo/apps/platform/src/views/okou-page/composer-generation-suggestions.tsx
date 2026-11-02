import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FileText, Globe, Image, Presentation, X } from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Toggle,
  ToggleGroup,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { PRESENTATION_SLIDE_COUNTS } from "../../signals/okou-page/composer-create.ts";
import { GENERATION_IMAGE_ASPECT_RATIOS } from "../../signals/okou-page/composer-generation-suggestions.ts";
import type { ComposerGenerationIntent } from "../../signals/okou-page/composer-generation-intent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import { slashTemplatePreviews } from "./composer-template-catalog.ts";
import { DocumentTemplateCover } from "./document-template-cover.tsx";

function GenerationOptions({
  signals,
  intent,
}: {
  readonly signals: ComposerSignals;
  readonly intent: ComposerGenerationIntent;
}) {
  const { t } = useTranslation();
  const slideCount = useGet(signals.generation.slideCount$);
  const setSlideCount = useSet(signals.generation.setSlideCount$);
  const ratio = useGet(signals.generation.imageAspectRatio$);
  const setRatio = useSet(signals.generation.setImageAspectRatio$);
  if (intent === "presentation") {
    const items = PRESENTATION_SLIDE_COUNTS.map((value) => {
      return {
        value,
        label:
          value === "auto"
            ? t(($) => {
                return $.chat.composer.create.slideCountAuto;
              })
            : t(
                ($) => {
                  return $.chat.composer.create.slideCountRange;
                },
                { range: value.replace("-", "–") },
              ),
      };
    });
    return (
      <Select
        items={items}
        value={slideCount}
        onValueChange={(value) => {
          if (value) {
            setSlideCount(value);
          }
        }}
      >
        <SelectTrigger
          aria-label={t(($) => {
            return $.chat.composer.create.slideCount;
          })}
          className="h-8 w-auto gap-2 text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent side={signals.threadId ? "top" : "bottom"}>
          {items.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    );
  }
  if (intent !== "image") {
    return null;
  }
  const items = GENERATION_IMAGE_ASPECT_RATIOS.map((value) => {
    return {
      value,
      label:
        value === "auto"
          ? t(($) => {
              return $.chat.composer.create.slideCountAuto;
            })
          : value,
    };
  });
  return (
    <Select
      items={items}
      value={ratio}
      onValueChange={(value) => {
        if (value) {
          setRatio(value);
        }
      }}
    >
      <SelectTrigger
        aria-label={t(($) => {
          return $.chat.composer.generationSuggestions.aspectRatio;
        })}
        className="h-8 w-auto gap-2 text-xs"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side={signals.threadId ? "top" : "bottom"}>
        {items.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function GenerationTemplateRail({
  signals,
  intent,
}: {
  readonly signals: ComposerSignals;
  readonly intent: ComposerGenerationIntent;
}) {
  const { t } = useTranslation();
  const category =
    intent === "presentation"
      ? "slides"
      : intent === "image"
        ? "illustration"
        : intent;
  const templates = slashTemplatePreviews(category);
  const selectTemplate = useSet(signals.generation.selectTemplate$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ComposerRail
      signals={signals}
      rail={`generation:${category}`}
      gap="gap-3"
      items={templates.map((preview) => {
        return (
          <Button
            key={preview.slug}
            type="button"
            variant="quiet"
            className={`${RAIL_TILE} w-[152px]`}
            aria-label={t(
              ($) => {
                return $.chat.composer.slashPanel.useTemplate;
              },
              { title: preview.title },
            )}
            onClick={() => {
              selectTemplate(preview.template, preview.attachment);
              detach(saveDraft(pageSignal), Reason.DomCallback);
            }}
          >
            <span className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
              {preview.coverUrl && preview.documentPage ? (
                <DocumentTemplateCover
                  coverUrl={preview.coverUrl}
                  hasMorePages={preview.documentPage.hasMorePages}
                />
              ) : preview.coverUrl ? (
                <img
                  src={preview.coverUrl}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-200 group-hover/tile:scale-[1.04]"
                />
              ) : (
                <Image size={24} aria-hidden />
              )}
            </span>
            <span className={RAIL_TILE_CAPTION}>{preview.title}</span>
          </Button>
        );
      })}
    />
  );
}

const GENERATION_ICONS = {
  website: Globe,
  image: Image,
  presentation: Presentation,
  document: FileText,
} as const;

export function ComposerGenerationSuggestions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const intents = useGet(signals.generation.panelIntents$);
  const intent = useGet(signals.generation.panelIntent$);
  const selectIntent = useSet(signals.generation.selectIntent$);
  const dismiss = useSet(signals.generation.dismiss$);
  const apply = useSet(signals.generation.apply$);
  const focus = useSet(signals.editor.focus$);
  if (!intent) {
    return null;
  }
  const labels = t(
    ($) => {
      return $.chat.taskChips.tasks;
    },
    { returnObjects: true },
  );
  const Icon = GENERATION_ICONS[intent];
  return (
    <section
      role="region"
      aria-label={t(($) => {
        return $.chat.composer.generationSuggestions.label;
      })}
      data-placement={signals.threadId ? "above" : "below"}
      className="my-3 flex max-h-[min(40dvh,320px)] min-w-0 shrink-0 flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-card p-4"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !event.nativeEvent.isComposing
        ) {
          dismiss();
          focus();
        }
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Icon size={16} aria-hidden />
          {labels[intent]}
        </h3>
        <Button
          type="button"
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.composer.generationSuggestions.dismiss;
          })}
          onClick={() => {
            dismiss();
            focus();
          }}
        >
          <X size={16} aria-hidden />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.composer.generationSuggestions.description;
        })}
      </p>
      {intents.length > 1 && (
        <ToggleGroup<ComposerGenerationIntent>
          aria-label={t(($) => {
            return $.chat.taskChips.chooseTask;
          })}
          className="flex-wrap"
          value={[intent]}
          onValueChange={(value) => {
            const selected = value[0];
            if (selected) {
              selectIntent(selected);
            }
          }}
        >
          {intents.map((candidate) => {
            return (
              <Toggle key={candidate} value={candidate} variant="filter">
                {labels[candidate]}
              </Toggle>
            );
          })}
        </ToggleGroup>
      )}
      <GenerationTemplateRail signals={signals} intent={intent} />
      <div className="sticky bottom-0 shrink-0 space-y-2 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <GenerationOptions key={intent} signals={signals} intent={intent} />
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="ml-auto"
            onClick={() => {
              apply();
            }}
          >
            {t(($) => {
              return $.chat.composer.generationSuggestions.apply;
            })}
          </Button>
        </div>
        {intent === "image" && (
          <p className="text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.composer.generationSuggestions.ratioHint;
            })}
          </p>
        )}
      </div>
    </section>
  );
}

export function ComposerGenerationSelection({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selection = useGet(signals.generation.appliedSelection$);
  const change = useSet(signals.generation.change$);
  if (!selection) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="quiet"
      size="sm"
      className="h-8 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
      aria-label={t(($) => {
        return $.chat.composer.generationSuggestions.change;
      })}
      onClick={() => {
        change();
      }}
    >
      <span className="hidden composer-wide:inline">
        {t(($) => {
          return $.chat.composer.generationSuggestions.thisMessage;
        })}
      </span>
      {selection.intent === "image" && selection.imageAspectRatio !== "auto" ? (
        <span>{selection.imageAspectRatio}</span>
      ) : null}
      <span>
        {t(($) => {
          return $.chat.composer.generationSuggestions.edit;
        })}
      </span>
    </Button>
  );
}
