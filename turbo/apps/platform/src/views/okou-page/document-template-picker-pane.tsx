import type { ReactNode } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { cn } from "@okouai/ui";
import {
  DOCUMENT_TEMPLATE_CATEGORIES,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { TemplateSourceSection } from "./template-source-section.tsx";
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
  readonly customTemplates?: ReactNode;
};

export function DocumentTemplatePickerPane({
  signals,
  onSelect,
  customTemplates,
}: Props) {
  const { t } = useTranslation();
  const category = useGet(signals.template.documentCategory$);
  const items = useGet(signals.template.documentItems$);
  const search = useGet(signals.template.templatePickerSearch$);
  const features = useGet(featureSwitch$);
  const filteredItems = customTemplates
    ? items.filter((item) => {
        return item.title.toLowerCase().includes(search.trim().toLowerCase());
      })
    : items;
  const setCategory = useSet(signals.template.setDocumentCategory$);
  const saveScroll = useSet(signals.template.saveDocumentScroll$);
  const restoreScroll = useSet(signals.template.restoreDocumentScroll$);
  const filters = (
    <TemplateFilterPillRow
      className={customTemplates ? "mb-4" : "shrink-0 px-6 py-5 pr-14"}
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
  );
  const cards = (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {filteredItems.map((item) => {
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
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {customTemplates ? null : filters}
      <div
        key={customTemplates ? undefined : category}
        ref={restoreScroll}
        onScroll={(event) => {
          return saveScroll(event.currentTarget.scrollTop);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
        data-document-template-grid-scroll=""
      >
        {customTemplates}
        {customTemplates ? (
          features[FeatureSwitchKey.BuiltinDocumentTemplates] === true ? (
            <TemplateSourceSection source="builtIn">
              {filters}
              {cards}
            </TemplateSourceSection>
          ) : null
        ) : (
          cards
        )}
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
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <span className={TEMPLATE_TILE_NAME}>{item.title}</span>
      </div>
    </div>
  );
}
