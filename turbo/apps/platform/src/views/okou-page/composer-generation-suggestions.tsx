import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FileText, Image, Presentation, X } from "lucide-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { DOCUMENT_TEMPLATE_ITEMS } from "@okouai/core/document-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  PRESENTATION_SLIDE_COUNTS,
  type ComposerCreateMode,
} from "../../signals/okou-page/composer-create.ts";
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
  const reportOutput = useGet(signals.generation.reportOutput$);
  if (
    intent === "presentation" ||
    (intent === "report" && reportOutput === "presentation")
  ) {
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
  const reportOutput = useGet(signals.generation.reportOutput$);
  const mode: ComposerCreateMode =
    intent === "report" ? (reportOutput ?? "document") : intent;
  const category =
    mode === "presentation"
      ? "slides"
      : mode === "image"
        ? "illustration"
        : "document";
  const reportSlugs = new Set(
    DOCUMENT_TEMPLATE_ITEMS.filter((item) => {
      return item.category === "report";
    }).map((item) => {
      return item.slug;
    }),
  );
  const templates = slashTemplatePreviews(category).filter((preview) => {
    return (
      intent !== "report" ||
      mode !== "document" ||
      reportSlugs.has(preview.slug)
    );
  });
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
              selectTemplate(preview.template, preview.attachment, mode);
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

function ReportFormatOptions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const reportOutput = useGet(signals.generation.reportOutput$);
  const setReportOutput = useSet(signals.generation.setReportOutput$);
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t(($) => {
          return $.chat.composer.generationSuggestions.reportFormat;
        })}
      >
        <Button
          type="button"
          variant={reportOutput === "document" ? "neutral" : "outline"}
          size="sm"
          aria-pressed={reportOutput === "document"}
          onClick={() => {
            setReportOutput("document");
          }}
        >
          {t(($) => {
            return $.chat.taskChips.tasks.document;
          })}
        </Button>
        <Button
          type="button"
          variant={reportOutput === "presentation" ? "neutral" : "outline"}
          size="sm"
          aria-pressed={reportOutput === "presentation"}
          onClick={() => {
            setReportOutput("presentation");
          }}
        >
          {t(($) => {
            return $.chat.taskChips.tasks.presentation;
          })}
        </Button>
      </div>
      {reportOutput === null && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.composer.generationSuggestions.reportHint;
          })}
        </p>
      )}
    </>
  );
}

export function ComposerGenerationSuggestions({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const intent = useGet(signals.generation.panelIntent$);
  const reportOutput = useGet(signals.generation.reportOutput$);
  const dismiss = useSet(signals.generation.dismiss$);
  const apply = useSet(signals.generation.apply$);
  const focus = useSet(signals.editor.focus$);
  if (!intent) {
    return null;
  }
  const labels = {
    presentation: t(($) => {
      return $.chat.taskChips.tasks.presentation;
    }),
    image: t(($) => {
      return $.chat.taskChips.tasks.image;
    }),
    document: t(($) => {
      return $.chat.taskChips.tasks.document;
    }),
    report: t(($) => {
      return $.chat.composer.generationSuggestions.report;
    }),
  };
  const Icon =
    intent === "presentation"
      ? Presentation
      : intent === "image"
        ? Image
        : FileText;
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
      {intent === "report" && <ReportFormatOptions signals={signals} />}
      <GenerationTemplateRail signals={signals} intent={intent} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GenerationOptions signals={signals} intent={intent} />
        <Button
          type="button"
          variant="neutral"
          size="sm"
          className="ml-auto"
          disabled={intent === "report" && reportOutput === null}
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
