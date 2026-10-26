import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
} from "lucide-react";
import { Badge, Button, DialogHeader, DialogTitle, cn } from "@okouai/ui";
import type { DocumentTemplateItem } from "@okouai/core/document-template-items";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import {
  TEMPLATE_DETAIL_BODY,
  TEMPLATE_DETAIL_FOOTER,
  TEMPLATE_DETAIL_STAGE_ARROW,
} from "./template-detail-layout.tsx";
import { TEMPLATE_TILE_MEDIA } from "./template-tile.ts";

type Props = {
  readonly signals: ComposerSignals;
  readonly item: DocumentTemplateItem;
  readonly onSelect: (item: DocumentTemplateItem) => void;
};

/**
 * A built-in document's detail, in the shell every template detail shares
 * (`template-detail-layout.tsx`): the name said once, in the breadcrumb; the
 * sample page on a bordered stage that pages with the stage's own arrows; a
 * 220px column for what the document contains; and the one action in the
 * footer, as on the presentation and custom details. The page is portrait, so
 * the stage takes the body's height rather than a 16:9 box.
 */
export function DocumentTemplatePreviewPage({
  signals,
  item,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const close = useSet(signals.template.closeDocumentPreview$);
  const focusBack = useSet(signals.template.focusDocumentPreviewRef$);
  const page = useGet(signals.template.documentPreviewPage$);
  const url = item.previewPages[page];
  if (!url) {
    throw new Error("Document preview page not found");
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="h-[68px] shrink-0 justify-center px-6 pr-14 text-left">
        <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
          <button
            ref={focusBack}
            type="button"
            className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              close();
            }}
          >
            {t(($) => {
              return $.documentTemplates.title;
            })}
          </button>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="block min-w-0 truncate leading-none">
            {item.title}
          </span>
        </DialogTitle>
      </DialogHeader>
      <div className={TEMPLATE_DETAIL_BODY}>
        <div className="flex flex-col gap-6 lg:h-full lg:flex-row">
          <DocumentPreviewStage
            signals={signals}
            url={url}
            page={page}
            total={item.previewPages.length}
          />
          <DocumentPreviewDetails item={item} />
        </div>
      </div>
      <div className={TEMPLATE_DETAIL_FOOTER}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t(($) => {
            return $.documentTemplates.openLarger;
          })}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </a>
        <Button
          type="button"
          size="lg"
          onClick={() => {
            onSelect(item);
          }}
        >
          {t(($) => {
            return $.artifacts.templates.useThisTemplate;
          })}
        </Button>
      </div>
    </div>
  );
}

function DocumentPreviewStage({
  signals,
  url,
  page,
  total,
}: {
  readonly signals: ComposerSignals;
  readonly url: string;
  readonly page: number;
  readonly total: number;
}) {
  const { t } = useTranslation();
  const failures = useGet(signals.template.documentImageFailures$);
  const failImage = useSet(signals.template.failDocumentImage$);
  const setPage = useSet(signals.template.setDocumentPreviewPage$);
  return (
    <div
      className={cn(
        TEMPLATE_TILE_MEDIA,
        "group/stage flex h-[440px] items-center justify-center p-6 lg:h-auto lg:min-h-0 lg:min-w-0 lg:flex-1",
      )}
    >
      {failures.has(url) ? (
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <FileText className="size-8" aria-hidden />
          <p>
            {t(($) => {
              return $.documentTemplates.imageError;
            })}
          </p>
        </div>
      ) : (
        <img
          key={url}
          className="max-h-full max-w-full object-contain"
          src={url}
          alt={t(
            ($) => {
              return $.documentTemplates.page;
            },
            { page: formatLocalizedNumber(page + 1) },
          )}
          onError={() => {
            failImage(url);
          }}
        />
      )}

      {total > 1 ? (
        <>
          <button
            type="button"
            aria-label={t(($) => {
              return $.documentTemplates.previousPage;
            })}
            disabled={page === 0}
            onClick={() => {
              setPage(page - 1);
            }}
            className={cn(TEMPLATE_DETAIL_STAGE_ARROW, "left-3")}
          >
            <ChevronLeft size={16} aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t(($) => {
              return $.documentTemplates.nextPage;
            })}
            disabled={page === total - 1}
            onClick={() => {
              setPage(page + 1);
            }}
            className={cn(TEMPLATE_DETAIL_STAGE_ARROW, "right-3")}
          >
            <ChevronRight size={16} aria-hidden />
          </button>
          <span
            aria-live="polite"
            className="pointer-events-none absolute bottom-3 right-3 z-50 rounded-md bg-[rgb(0_0_0_/_0.55)] px-2 py-0.5 text-xs font-medium tabular-nums text-[#ffffff]"
          >
            {t(
              ($) => {
                return $.artifacts.templates.slideCounter;
              },
              {
                current: formatLocalizedNumber(page + 1),
                total: formatLocalizedNumber(total),
              },
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}

function DocumentPreviewDetails({
  item,
}: {
  readonly item: DocumentTemplateItem;
}) {
  const { t } = useTranslation();
  const agreement =
    item.category === "contract" || item.category === "service-agreement";
  const contentGroup = agreement
    ? "agreement"
    : item.category === "creative-brief"
      ? "brief"
      : item.category === "invoice"
        ? "invoice"
        : "general";
  const contents = t(
    ($) => {
      return $.documentTemplates.contents[contentGroup];
    },
    { returnObjects: true },
  );
  const category = t(($) => {
    return $.documentTemplates.categories[item.category];
  });
  return (
    <div className="flex flex-col items-start gap-4 lg:w-[220px] lg:shrink-0 lg:overflow-y-auto">
      {category === item.title ? null : (
        <Badge className="text-xs text-muted-foreground">{category}</Badge>
      )}
      <p className="text-sm leading-relaxed text-muted-foreground">
        {item.description}
      </p>
      <h3 className="mt-1 text-sm font-medium">
        {t(($) => {
          return $.documentTemplates.included;
        })}
      </h3>
      <ul className="flex flex-col gap-3 text-xs leading-relaxed">
        {[
          contents.overview,
          contents.content,
          contents.details,
          contents.delivery,
        ].map((content) => {
          return (
            <li key={content} className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              {content}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
        <Badge>
          {t(($) => {
            return $.documentTemplates.formats.word;
          })}
        </Badge>
        <Badge>
          {t(($) => {
            return $.documentTemplates.formats.pdf;
          })}
        </Badge>
      </div>
      {agreement ? (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(($) => {
            return $.documentTemplates.agreementNote;
          })}
        </p>
      ) : null}
    </div>
  );
}
