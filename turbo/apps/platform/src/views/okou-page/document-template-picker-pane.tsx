import { formatLocalizedNumber } from "../../i18n/format.ts";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileText } from "lucide-react";
import { Button, DialogTitle, cn } from "@okouai/ui";
import {
  DOCUMENT_TEMPLATE_CATEGORIES,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import { DocumentTemplateCover } from "./document-template-cover.tsx";
import { TemplateFilterPillRow } from "./template-filter-pill.tsx";
import {
  TEMPLATE_TILE_CAPTION,
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_NAME,
  TEMPLATE_TILE_USE,
  TEMPLATE_TILE_WRAPPER,
} from "./template-tile.ts";

type Props = {
  readonly signals: ComposerSignals;
  readonly onSelect: (item: DocumentTemplateItem) => void;
};

export function DocumentTemplatePickerPane({ signals, onSelect }: Props) {
  const { t } = useTranslation();
  const category = useGet(signals.template.documentCategory$);
  const items = useGet(signals.template.documentItems$);
  const setCategory = useSet(signals.template.setDocumentCategory$);
  const saveScroll = useSet(signals.template.saveDocumentScroll$);
  const restoreScroll = useSet(signals.template.restoreDocumentScroll$);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TemplateFilterPillRow
        className="shrink-0 px-6 pb-4 pr-14 pt-6"
        active={category}
        label={t(($) => {
          return $.documentTemplates.filter;
        })}
        pills={DOCUMENT_TEMPLATE_CATEGORIES.map((id) => {
          return {
            id,
            label: t(($) => {
              return $.documentTemplates.categories[id];
            }),
          };
        })}
        onSelect={(id) => {
          const found = DOCUMENT_TEMPLATE_CATEGORIES.find((entry) => {
            return entry === id;
          });
          if (found) {
            setCategory(found);
          }
        }}
      />
      <div
        key={category}
        ref={restoreScroll}
        onScroll={(event) => {
          saveScroll(event.currentTarget.scrollTop);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
        data-document-template-grid-scroll=""
      >
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            return (
              <DocumentTemplateCard
                key={item.id}
                signals={signals}
                item={item}
                onSelect={onSelect}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DocumentTemplateCard({
  signals,
  item,
  onSelect,
}: Props & { readonly item: DocumentTemplateItem }) {
  const { t } = useTranslation();
  const openPreview = useSet(signals.template.openDocumentPreview$);
  const failures = useGet(signals.template.documentImageFailures$);
  const failImage = useSet(signals.template.failDocumentImage$);
  return (
    <div className={TEMPLATE_TILE_WRAPPER}>
      <div className={cn(TEMPLATE_TILE_MEDIA, "aspect-[4/3]")}>
        <button
          type="button"
          className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          data-document-template-preview={item.id}
          aria-label={t(
            ($) => {
              return $.documentTemplates.preview;
            },
            {
              title: item.title,
            },
          )}
          onClick={() => {
            openPreview(item.id);
          }}
        >
          {failures.has(item.previewImageUrl) ? (
            <span className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <FileText className="size-8" />
              <span className="text-xs">
                {t(($) => {
                  return $.documentTemplates.imageError;
                })}
              </span>
            </span>
          ) : (
            <DocumentTemplateCover
              coverUrl={item.previewImageUrl}
              hasMorePages={item.previewPages.length > 1}
              onError={() => {
                failImage(item.previewImageUrl);
              }}
            />
          )}
        </button>
        <button
          type="button"
          className={TEMPLATE_TILE_USE}
          onClick={() => {
            onSelect(item);
          }}
          aria-label={t(
            ($) => {
              return $.documentTemplates.useNamed;
            },
            {
              title: item.title,
            },
          )}
        >
          {t(($) => {
            return $.documentTemplates.use;
          })}
        </button>
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <span className={TEMPLATE_TILE_NAME}>{item.title}</span>
      </div>
    </div>
  );
}

export function DocumentTemplatePreviewPage({
  signals,
  item,
  onSelect,
}: Props & { readonly item: DocumentTemplateItem }) {
  const { t } = useTranslation();
  const close = useSet(signals.template.closeDocumentPreview$);
  const failures = useGet(signals.template.documentImageFailures$);
  const failImage = useSet(signals.template.failDocumentImage$);
  const retryImage = useSet(signals.template.retryDocumentImage$);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[68px] shrink-0 items-center gap-3 border-b border-border px-6 pr-14">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t(($) => {
            return $.documentTemplates.back;
          })}
          onClick={() => {
            close();
          }}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <DialogTitle className="min-w-0 flex-1 truncate">
          {item.title}
        </DialogTitle>
        <Button
          onClick={() => {
            onSelect(item);
          }}
        >
          {t(($) => {
            return $.documentTemplates.use;
          })}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-muted p-4 sm:p-8">
        <p className="mx-auto mb-5 max-w-2xl text-sm text-muted-foreground">
          {item.description}
        </p>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          {item.previewPages.map((url, index) => {
            return (
              <div
                key={url}
                className="overflow-hidden rounded-sm border border-border bg-[#ffffff]"
              >
                {failures.has(url) ? (
                  <div className="flex aspect-[210/297] flex-col items-center justify-center gap-4 text-muted-foreground">
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
                    onError={() => {
                      failImage(url);
                    }}
                    className="h-auto w-full"
                    loading={index === 0 ? "eager" : "lazy"}
                    src={url}
                    alt={t(
                      ($) => {
                        return $.documentTemplates.page;
                      },
                      {
                        page: formatLocalizedNumber(index + 1),
                      },
                    )}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
