import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Image } from "lucide-react";
import type { UserTemplateCatalogEntry } from "@okouai/api-contracts/contracts/user-templates";
import {
  DOCUMENT_TEMPLATE_ITEMS,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ComposerTask,
  ComposerTemplateTask,
} from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ComposerPresentationRecommendations,
  TemplateImportCard,
} from "./chat-composer.tsx";
import { ComposerRail } from "./composer-rail.tsx";
import { TemplateCard } from "./template-card.tsx";
import { DocumentTemplateCover } from "./document-template-cover.tsx";
import {
  composerTemplatePreviews,
  toDocumentGenerationTemplate,
  type ComposerTemplatePreviewCategory,
} from "./composer-template-catalog.ts";
import { useCustomTemplateRecommendations } from "./use-custom-template-recommendations.ts";
import { ComposerVisualizationOptions } from "./composer-visualization-options.tsx";
import { ComposerTemplateSuggestion } from "./composer-template-suggestion.tsx";

/**
 * Illustration styles run 20 portrait, 9 square and 3 landscape, so their own
 * proportions cannot line up. One 4:5 tile centre-crops them into a single
 * rhythm; a style sample is judged on texture and palette, and the uncropped
 * artwork is used when generating. The other two catalogs are
 * screenshots of 16:9 artifacts and keep that ratio.
 */
const TASK_TEMPLATE_SHELF = {
  image: {
    category: "illustration",
    width: 118,
    ratio: "aspect-[4/5]",
  },
  website: { category: "website", width: 200, ratio: "aspect-video" },
} as const satisfies Record<
  ComposerTemplateTask,
  {
    readonly category: ComposerTemplatePreviewCategory;
    readonly width: number;
    readonly ratio: string;
  }
>;

/**
 * One cover. Selecting it attaches the template to the composer the same way
 * the slash panel does; the catalog already pairs each preview with the
 * attachment its chip stores.
 */
function ComposerTemplateCover({
  title,
  coverUrl,
  ratio,
  documentPage,
  onSelect,
  onPreview,
}: {
  readonly title: string;
  readonly coverUrl: string | null;
  readonly ratio: string;
  /**
   * A document's first page sits on the tile's ground, cropped at the bottom.
   */
  readonly documentPage?: { readonly hasMorePages: boolean };
  readonly onSelect: () => void;
  readonly onPreview?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ComposerTemplateSuggestion title={title} onPreview={onPreview}>
      <TemplateCard
        title={title}
        label={t(
          ($) => {
            return $.chat.composer.slashPanel.useTemplate;
          },
          { title },
        )}
        ratio={ratio}
        onSelect={onSelect}
      >
        {coverUrl && documentPage ? (
          <DocumentTemplateCover
            coverUrl={coverUrl}
            hasMorePages={documentPage.hasMorePages}
          />
        ) : coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover object-center"
          />
        ) : (
          <Image size={24} aria-hidden />
        )}
      </TemplateCard>
    </ComposerTemplateSuggestion>
  );
}

function ComposerTemplateShelf({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: ComposerTemplateTask;
}) {
  const { t } = useTranslation();
  const { category, width, ratio } = TASK_TEMPLATE_SHELF[task];
  const previews = composerTemplatePreviews(category);
  const custom = useCustomTemplateRecommendations(signals, "illustration");
  const setMode = useSet(signals.create.setMode$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const previewRecommendation = useSet(signals.template.previewRecommendation$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  // Named one key at a time: the extractor only keeps keys it can see.
  const labels = {
    image: t(($) => {
      return $.chat.taskChips.shelf.image;
    }),
    website: t(($) => {
      return $.chat.taskChips.shelf.website;
    }),
  };
  const label = labels[task];
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <ComposerRail
        rail={`templates:${task}`}
        itemWidth={width}
        items={[
          ...(task === "image"
            ? [
                <TemplateImportCard
                  key="import"
                  signals={signals}
                  kind="illustration"
                  onImported={() => {
                    setMode(null);
                  }}
                />,
              ]
            : []),
          ...(task === "image" ? custom : []).map((template) => {
            return (
              <ComposerTemplateCover
                key={template.id}
                title={template.title}
                coverUrl={template.previewAssets[0]?.url ?? null}
                ratio={ratio}
                onSelect={() => {
                  insertTemplate(
                    {
                      type: "custom",
                      selection: { userTemplateId: template.id },
                    },
                    {
                      type: "custom",
                      title: template.title,
                      category: "illustration",
                      ...(template.coverUrl === null
                        ? {}
                        : { previewImageUrl: template.coverUrl }),
                    },
                  );
                  detach(saveDraft(pageSignal), Reason.DomCallback);
                }}
              />
            );
          }),
          ...previews.map((preview) => {
            const websiteTemplateId =
              preview.template.type === "website"
                ? preview.template.selection.websiteTemplateId
                : null;
            return (
              <ComposerTemplateCover
                key={preview.slug}
                title={preview.title}
                coverUrl={preview.coverUrl}
                ratio={ratio}
                onPreview={
                  websiteTemplateId === null
                    ? undefined
                    : () => {
                        previewRecommendation({
                          type: "website",
                          templateId: websiteTemplateId,
                        });
                      }
                }
                onSelect={() => {
                  insertTemplate(preview.template, preview.attachment);
                  detach(saveDraft(pageSignal), Reason.DomCallback);
                }}
              />
            );
          }),
        ]}
      />
    </div>
  );
}

function ComposerDocumentTemplateRail({
  signals,
  templates,
  items,
}: {
  readonly signals: ComposerSignals;
  readonly templates: readonly UserTemplateCatalogEntry[];
  readonly items: readonly DocumentTemplateItem[];
}) {
  const setMode = useSet(signals.create.setMode$);
  const selectTemplate = useSet(signals.taskChips.selectTemplate$);
  const previewRecommendation = useSet(signals.template.previewRecommendation$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ComposerRail
      rail="templates:document:all"
      itemWidth={200}
      items={[
        <TemplateImportCard
          key="import"
          signals={signals}
          kind="document"
          onImported={() => {
            setMode(null);
          }}
        />,
        ...templates.map((template) => {
          return (
            <ComposerTemplateCover
              key={template.id}
              title={template.title}
              coverUrl={template.coverUrl}
              ratio="aspect-[4/3]"
              documentPage={{
                hasMorePages: template.coverHasMorePages,
              }}
              onPreview={() => {
                previewRecommendation({
                  type: "custom",
                  templateId: template.id,
                  kind: "document",
                });
              }}
              onSelect={() => {
                selectTemplate(
                  {
                    type: "custom",
                    selection: { userTemplateId: template.id },
                  },
                  {
                    type: "custom",
                    title: template.title,
                    category: "document",
                  },
                  "document",
                );
                detach(saveDraft(pageSignal), Reason.DomCallback);
              }}
            />
          );
        }),
        ...items.map((item) => {
          return (
            <ComposerTemplateCover
              key={item.id}
              title={item.title}
              coverUrl={r2ImageTransformUrl(item.previewImageUrl, {
                width: 284,
              })}
              ratio="aspect-[4/3]"
              documentPage={{ hasMorePages: item.previewPages.length > 1 }}
              onPreview={() => {
                previewRecommendation({
                  type: "document",
                  templateId: item.id,
                });
              }}
              onSelect={() => {
                selectTemplate(toDocumentGenerationTemplate(item), {
                  type: "document",
                  title: item.title,
                  category: "document",
                });
                detach(saveDraft(pageSignal), Reason.DomCallback);
              }}
            />
          );
        }),
      ]}
    />
  );
}

function ComposerDocumentRecommendations({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const custom = useCustomTemplateRecommendations(signals, "document");
  const label = t(($) => {
    return $.chat.taskChips.shelf.document;
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
    >
      <ComposerDocumentTemplateRail
        signals={signals}
        templates={custom}
        items={DOCUMENT_TEMPLATE_ITEMS}
      />
    </div>
  );
}

/** The tray owns the title and "View all"; shelves retain accessible labels. */
export function ComposerTaskTemplates({
  signals,
  selected,
}: {
  readonly signals: ComposerSignals;
  readonly selected: Exclude<ComposerTask, "workflow">;
}) {
  if (selected === "presentation") {
    return <ComposerPresentationRecommendations signals={signals} />;
  }
  if (selected === "document") {
    return <ComposerDocumentRecommendations signals={signals} />;
  }
  if (selected === "visualization") {
    return <ComposerVisualizationOptions signals={signals} />;
  }
  return <ComposerTemplateShelf signals={signals} task={selected} />;
}
