import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
} from "lucide-react";
import {
  Badge,
  Button,
  DialogHeader,
  DialogTitle,
  IconButton,
} from "@okouai/ui";
import type { DocumentTemplateItem } from "@okouai/core/document-template-items";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";

type Props = {
  readonly signals: ComposerSignals;
  readonly item: DocumentTemplateItem;
  readonly onSelect: (item: DocumentTemplateItem) => void;
};

export function DocumentTemplatePreviewPage({
  signals,
  item,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const close = useSet(signals.template.closeDocumentPreview$);
  const focusBack = useSet(signals.template.focusDocumentPreviewRef$);
  const page = useGet(signals.template.documentPreviewPage$);
  const setPage = useSet(signals.template.setDocumentPreviewPage$);
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
            aria-label={t(($) => {
              return $.documentTemplates.back;
            })}
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
      <div className="min-h-0 flex-1 overflow-y-auto sm:grid sm:grid-cols-[minmax(0,1fr)_320px] sm:overflow-hidden">
        <DocumentPreviewImage signals={signals} url={url} page={page} />
        <DocumentPreviewDetails item={item} onSelect={onSelect} />
      </div>
      <DocumentPreviewPagination
        page={page}
        total={item.previewPages.length}
        url={url}
        onChange={setPage}
      />
    </div>
  );
}

function DocumentPreviewImage({
  signals,
  url,
  page,
}: {
  readonly signals: ComposerSignals;
  readonly url: string;
  readonly page: number;
}) {
  const { t } = useTranslation();
  const failures = useGet(signals.template.documentImageFailures$);
  const failImage = useSet(signals.template.failDocumentImage$);
  const retryImage = useSet(signals.template.retryDocumentImage$);
  return (
    <div className="flex h-[440px] min-h-0 items-center justify-center bg-muted p-6 sm:h-auto">
      {failures.has(url) ? (
        <div className="flex flex-col items-center gap-4 text-muted-foreground">
          <FileText className="size-8" />
          <p>
            {t(($) => {
              return $.documentTemplates.imageError;
            })}
          </p>
          <Button
            variant="outline"
            onClick={() => {
              retryImage(url);
            }}
          >
            {t(($) => {
              return $.documentTemplates.retry;
            })}
          </Button>
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
    </div>
  );
}

function DocumentPreviewDetails({ item, onSelect }: Omit<Props, "signals">) {
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
  return (
    <aside className="flex flex-col items-start gap-4 border-t border-border p-6 sm:min-h-0 sm:overflow-y-auto sm:border-l sm:border-t-0">
      <Badge className="text-xs text-muted-foreground">
        {t(($) => {
          return $.documentTemplates.categories[item.category];
        })}
      </Badge>
      <h3 className="text-xl font-semibold leading-snug">{item.title}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {item.description}
      </p>
      <h4 className="mt-1 text-sm font-medium">
        {t(($) => {
          return $.documentTemplates.included;
        })}
      </h4>
      <ul className="flex flex-col gap-3 text-xs leading-relaxed">
        {[
          contents.overview,
          contents.content,
          contents.details,
          contents.delivery,
        ].map((content) => {
          return (
            <li key={content} className="flex items-start gap-2">
              <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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
      <p className="text-xs text-muted-foreground">
        {t(
          ($) => {
            return $.documentTemplates.samplePages;
          },
          { total: formatLocalizedNumber(item.previewPages.length) },
        )}
      </p>
      {agreement ? (
        <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
          {t(($) => {
            return $.documentTemplates.agreementNote;
          })}
        </p>
      ) : null}
      <div className="sticky bottom-0 mt-auto w-full bg-background pt-3 sm:static sm:bg-transparent">
        <Button
          className="w-full"
          onClick={() => {
            onSelect(item);
          }}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </aside>
  );
}

function DocumentPreviewPagination({
  page,
  total,
  url,
  onChange,
}: {
  readonly page: number;
  readonly total: number;
  readonly url: string;
  readonly onChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <footer className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-2 text-xs text-muted-foreground">
      <IconButton
        aria-label={t(($) => {
          return $.documentTemplates.previousPage;
        })}
        disabled={page === 0}
        onClick={() => {
          onChange(page - 1);
        }}
      >
        <ChevronLeft className="size-4" />
      </IconButton>
      <span aria-live="polite">
        {formatLocalizedNumber(page + 1)} / {formatLocalizedNumber(total)}
      </span>
      <IconButton
        aria-label={t(($) => {
          return $.documentTemplates.nextPage;
        })}
        disabled={page === total - 1}
        onClick={() => {
          onChange(page + 1);
        }}
      >
        <ChevronRight className="size-4" />
      </IconButton>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto inline-flex items-center gap-1 hover:text-foreground hover:underline"
      >
        {t(($) => {
          return $.documentTemplates.openLarger;
        })}
        <ArrowUpRight className="size-3.5" />
      </a>
    </footer>
  );
}
