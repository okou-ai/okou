import type { ReactNode } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, FileText } from "lucide-react";
import { cn } from "@okouai/ui";
import {
  DOCUMENT_TEMPLATE_CATEGORIES,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { TemplateSourceSection } from "./template-source-section.tsx";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { DocumentTemplatePickerCategory } from "../../signals/okou-page/document-template-picker.ts";
import { DocumentTemplateCover } from "./document-template-cover.tsx";
import { TemplateFilterPillRow } from "./template-filter-pill.tsx";
import { composerRailFade } from "./composer-rail.tsx";
import { RailPager } from "./rail-pager.tsx";
import { measureRail } from "../../signals/okou-page/rail-travel.ts";
import {
  TEMPLATE_CARD_GRID,
  TEMPLATE_TILE_CAPTION,
  TEMPLATE_TILE_MEDIA,
  TEMPLATE_TILE_NAME,
  TEMPLATE_TILE_SELECTED,
  TEMPLATE_TILE_SELECTION_FRAME,
  TEMPLATE_TILE_USE,
  TEMPLATE_TILE_WRAPPER,
} from "./template-tile.ts";

type Props = {
  readonly signals: ComposerSignals;
  readonly value?: GenerationTemplateRequest;
  readonly onSelect: (item: DocumentTemplateItem) => void;
  readonly customTemplates: ReactNode;
};

export function DocumentTemplatePickerPane({
  signals,
  value,
  onSelect,
  customTemplates,
}: Props) {
  const category = useGet(signals.template.documentCategory$);
  const items = useGet(signals.template.documentItems$);
  const search = useGet(signals.template.templatePickerSearch$);
  const features = useGet(featureSwitch$);
  const filteredItems = items.filter((item) => {
    return item.title.toLowerCase().includes(search.trim().toLowerCase());
  });
  const saveScroll = useSet(signals.template.saveDocumentScroll$);
  const restoreScroll = useSet(signals.template.restoreDocumentScroll$);
  const builtInEnabled =
    features[FeatureSwitchKey.BuiltinDocumentTemplates] === true;
  // Without the built-in rollout there is nothing to filter.
  const filters = builtInEnabled ? (
    <DocumentTemplatePickerFilters signals={signals} category={category} />
  ) : null;
  const cards = (
    <div className={TEMPLATE_CARD_GRID}>
      {filteredItems.map((item) => {
        return (
          <DocumentTemplateCard
            key={item.id}
            signals={signals}
            item={item}
            selected={
              value?.type === "document" &&
              value.selection.documentTemplateId === item.id
            }
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
  const showCustom =
    !builtInEnabled || category === "all" || category === "custom";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filters}
      <div
        key={category}
        ref={restoreScroll}
        onScroll={(event) => {
          return saveScroll(event.currentTarget.scrollTop);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
        data-document-template-grid-scroll=""
      >
        {showCustom ? customTemplates : null}
        {builtInEnabled && category !== "custom" ? (
          category === "all" ? (
            <TemplateSourceSection source="builtIn">
              {cards}
            </TemplateSourceSection>
          ) : (
            cards
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * Custom is one more filter beside All and the purposes, as on the composer
 * shelf, rather than a section stacked above the filters: the filters stay at
 * the top of the pane instead of scrolling away under the member's own
 * documents.
 */
function DocumentTemplatePickerFilters({
  signals,
  category,
}: {
  readonly signals: ComposerSignals;
  readonly category: DocumentTemplatePickerCategory;
}) {
  const { t } = useTranslation();
  const setCategory = useSet(signals.template.setDocumentCategory$);
  const filterTravel = useGet(signals.taskChips.railTravel$)[
    PICKER_FILTER_RAIL
  ];
  const setTravel = useSet(signals.taskChips.setRailTravel$);
  const bindRail = useSet(signals.taskChips.bindRail$);
  const filterRow = (
    <TemplateFilterPillRow
      className={cn("px-6 py-0.5", composerRailFade(filterTravel))}
      // Under the header band the row holds ten pills, one more than fits on
      // a line, so it travels like the composer shelf's filters rather than
      // wrapping a lone pill onto a second line.
      layout="scroll"
      rail={PICKER_FILTER_RAIL}
      scrollerRef={bindRail}
      onScroll={(event) => {
        setTravel(PICKER_FILTER_RAIL, measureRail(event.currentTarget));
      }}
      active={category}
      label={t(($) => {
        return $.documentTemplates.filter;
      })}
      pills={DOCUMENT_TEMPLATE_CATEGORIES.flatMap((id) => {
        const pill = {
          id,
          label: t(($) => {
            return $.documentTemplates.categories[id];
          }),
        };
        return id === "all"
          ? [
              pill,
              {
                id: "custom",
                label: t(($) => {
                  return $.templates.custom;
                }),
              },
            ]
          : [pill];
      })}
      onSelect={(id) => {
        if (id === "custom") {
          setCategory("custom");
          return;
        }
        const found = DOCUMENT_TEMPLATE_CATEGORIES.find((entry) => {
          return entry === id;
        });
        if (found) {
          setCategory(found);
        }
      }}
    />
  );
  return (
    // A pager centres on its positioning root, so the row's spacing below
    // sits outside that root, as in the connector directory's category row.
    <div className="shrink-0 pb-3.5">
      <div className="relative" data-rail-root="">
        {filterRow}
        {filterTravel?.canScrollBack ? <PickerFilterPager side="back" /> : null}
        {filterTravel?.canScrollForward ? (
          <PickerFilterPager side="forward" />
        ) : null}
      </div>
    </div>
  );
}

/** The picker's filter row, as a rail id beside the composer shelf's. */
const PICKER_FILTER_RAIL = "filters:document-picker";

/**
 * The dialog's surface is `--card`, so the pager takes that fill, and it sits
 * inside the row's 24px gutter like the connector directory's category pager.
 */
function PickerFilterPager({ side }: { readonly side: "back" | "forward" }) {
  const { t } = useTranslation();
  return (
    <RailPager
      side={side}
      surfaceClassName="bg-card"
      className={side === "back" ? "left-3" : "right-3"}
      label={t(($) => {
        return side === "back"
          ? $.chat.taskChips.shelf.previousPage
          : $.chat.taskChips.shelf.nextPage;
      })}
    />
  );
}

function DocumentTemplateCard({
  signals,
  item,
  selected,
  onSelect,
}: Omit<Props, "value" | "customTemplates"> & {
  readonly item: DocumentTemplateItem;
  readonly selected: boolean;
}) {
  const { t } = useTranslation();
  const openPreview = useSet(signals.template.openDocumentPreview$);
  const failures = useGet(signals.template.documentImageFailures$);
  const failImage = useSet(signals.template.failDocumentImage$);
  return (
    <div className={TEMPLATE_TILE_WRAPPER}>
      <div
        className={cn(
          TEMPLATE_TILE_SELECTION_FRAME,
          selected && TEMPLATE_TILE_SELECTED,
        )}
      >
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
          {selected ? (
            <span className="pointer-events-none absolute left-[7px] top-[7px] z-20 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Check size={14} />
            </span>
          ) : null}
          <button
            type="button"
            className={TEMPLATE_TILE_USE}
            aria-pressed={selected}
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
      </div>
      <div className={TEMPLATE_TILE_CAPTION}>
        <span className={TEMPLATE_TILE_NAME}>{item.title}</span>
      </div>
    </div>
  );
}
