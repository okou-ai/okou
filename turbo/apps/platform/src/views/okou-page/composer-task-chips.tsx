import { useGet, useSet, useLastLoadable } from "ccstate-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Image, MessageSquare } from "lucide-react";
import { Button } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import type { UserTemplateCatalogEntry } from "@okouai/api-contracts/contracts/user-templates";
import {
  DOCUMENT_TEMPLATE_CATEGORIES,
  DOCUMENT_TEMPLATE_ITEMS,
  type DocumentTemplateCategory,
  type DocumentTemplateItem,
} from "@okouai/core/document-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ComposerPromptRowTask,
  ComposerTask,
  ComposerTemplateTask,
} from "../../signals/okou-page/composer-task-chips.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ComposerPresentationRecommendations,
  TemplateImportCard,
} from "./chat-composer.tsx";
import {
  ComposerRail,
  RAIL_TILE,
  RAIL_TILE_ART,
  RAIL_TILE_CAPTION,
} from "./composer-rail.tsx";
import { ComposerRailPager } from "./rail-pager.tsx";
import { RAIL_ROOT_CLASS } from "./rail-boundary.ts";
import { DocumentTemplateCover } from "./document-template-cover.tsx";
import {
  slashTemplatePreviews,
  toDocumentGenerationTemplate,
  type SlashTemplatePreviewCategory,
} from "./composer-template-catalog.ts";
import { useCustomTemplateRecommendations } from "./use-custom-template-recommendations.ts";
import { ComposerWorkflowRecommendations } from "./composer-workflow-recommendations.tsx";
import { ComposerVisualizationOptions } from "./composer-visualization-options.tsx";
import { TemplateFilterPillRow } from "./template-filter-pill.tsx";
import { ComposerTaskChipRow } from "./composer-task-chip-row.tsx";
import { ComposerTemplatePickerButton } from "./composer-template-picker-button.tsx";

/**
 * An idea is a sentence, not a label, so it gets a card rather than the pill
 * the task row uses. A fixed box is what makes the row read as one set: the
 * text wraps inside the top of the card and the icon parks on the floor, so a
 * short idea and a long one still occupy the same shape.
 *
 * The card carries no fill of its own. `bg-muted` is warm -- red sits seven
 * steps above blue -- so a row of them read as tinted against the page rather
 * than as neutral surfaces. `bg-card` plus the lighter of the product's two
 * stroke inks draws the box instead: `border-border` rather than the
 * `control-border` a chip carries, which is the same gray-400 the composer's
 * own edge uses and was heavier than a 232x116 perimeter wants. Both weights
 * are the shared `--default-border-width` hairline; only the ink changes.
 *
 * `neutral` still owns the states, so hover and pressed keep painting as
 * overlays above whichever fill is underneath.
 */
const TASK_IDEA_CARD = [
  "h-[116px] w-full flex-col items-start justify-start gap-0",
  "rounded-xl border-border bg-card p-4 pb-3.5",
  // A fixed box holds translated copy, so the overflow is contained here
  // rather than left to spill past the card in a longer language.
  "overflow-hidden whitespace-normal text-left text-sm font-normal leading-5",
  // The label is an anonymous flex item and cannot take `order`, so the
  // ordering is stated from the icon: past the text, then pushed to the floor.
  "[&_svg]:order-2 [&_svg]:mt-auto",
].join(" ");
/**
 * One mark for the whole row. An idea is something the user says, so the same
 * speech bubble fits every type; the four glyphs this replaced carried nothing
 * the sentence beside them did not, and four different marks in one row of one
 * kind of thing are four separate places for the eye to stop.
 */
const IdeaIcon = MessageSquare;
const IMAGE_IDEAS = [
  "productScene",
  "headshot",
  "eventPoster",
  "businessLogo",
  "newsletterCover",
  "infographic",
  "storePhoto",
  "roomDesign",
  "birthdayInvitation",
  "presentationVisual",
  "profileBanner",
  "cafeMenu",
  "websiteImage",
  "packaging",
  "photoLighting",
  "finishedSketch",
  "greetingCard",
  "brandCharacter",
] as const;
const PRESENTATION_IDEAS = [
  "pitchDeck",
  "teamUpdate",
  "productIntro",
  "clientProposal",
  "training",
  "resultsReadout",
  "companyOverview",
  "eventTalk",
] as const;
const DOCUMENT_IDEAS = [
  "creativeBrief",
  "contract",
  "serviceAgreement",
  "invoice",
] as const;
/** The document shelf's filter row, as a rail id beside its cover rails. */
const DOCUMENT_FILTER_RAIL = "filters:document";
const DOCUMENT_CATEGORIES = DOCUMENT_TEMPLATE_CATEGORIES.filter((category) => {
  return category !== "all";
});
const WEBSITE_IDEAS = [
  "businessSite",
  "portfolio",
  "eventPage",
  "productLaunch",
  "cafeMenu",
  "coursePage",
  "linkPage",
  "bookingPage",
] as const;
/**
 * Illustration styles run 20 portrait, 9 square and 3 landscape, so their own
 * proportions cannot line up. One 4:5 tile centre-crops them into a single
 * rhythm; a style sample is judged on texture and palette, and the uncropped
 * artwork is still what the picker dialog shows. The other two catalogs are
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
    readonly category: SlashTemplatePreviewCategory;
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
}: {
  readonly title: string;
  readonly coverUrl: string | null;
  readonly ratio: string;
  /**
   * A document cover is drawn as the picker draws it -- the first page as a
   * sheet on the tile's ground, cropped by the tile's bottom edge -- so one
   * template looks the same on the shelf, in the slash panel and in the picker.
   */
  readonly documentPage?: { readonly hasMorePages: boolean };
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="quiet"
      className={cn(RAIL_TILE, "w-full")}
      aria-label={t(
        ($) => {
          return $.chat.composer.slashPanel.useTemplate;
        },
        { title },
      )}
      onClick={onSelect}
    >
      <span
        className={cn(
          "relative flex items-center justify-center overflow-hidden rounded-xl border border-border bg-muted",
          RAIL_TILE_ART,
          ratio,
        )}
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
            // The tray's tiles answer the pointer by lifting, so the zoom
            // stays off there: one change per hover.
            className="h-full w-full object-cover object-center transition-transform duration-200 group-hover/tile:scale-[1.04] in-data-[slot=capability-tray]:group-hover/tile:scale-100"
          />
        ) : (
          <Image size={24} aria-hidden />
        )}
      </span>
      <span className={RAIL_TILE_CAPTION}>{title}</span>
    </Button>
  );
}

/**
 * The cover shelf for a type. Its header owns the two actions that used to
 * float in a column of their own: the catalog link stays on the title line,
 * and paging stays beside the covers it moves.
 */
/**
 * What a type's "View all" opens: the template picker on the catalog its shelf
 * samples. The capability tray draws the control in its own tab row, so the
 * shelf and the tray read the same answer from here.
 */
export function useTaskTemplateBrowse(
  signals: ComposerSignals,
  task: ComposerTask,
): (() => void) | null {
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const setPickerCategory = useSet(signals.template.setDocumentCategory$);
  // Workflows browse the workflow picker instead; Chart has no catalog.
  if (task === "workflow" || task === "visualization") {
    return null;
  }
  if (task === "presentation") {
    return () => {
      openTemplates({ kind: "insert", category: "slides" });
    };
  }
  if (task === "document") {
    // The tray's document shelf lists every purpose, so its catalog opens on
    // All rather than on a filter the member never picked.
    return () => {
      setPickerCategory("all");
      openTemplates({ kind: "insert", category: "document" });
    };
  }
  const { category } = TASK_TEMPLATE_SHELF[task];
  return () => {
    openTemplates({ kind: "insert", category });
  };
}

function ComposerTemplateShelf({
  signals,
  task,
  headerAction,
  headerless = false,
}: {
  readonly signals: ComposerSignals;
  readonly task: ComposerTemplateTask;
  readonly headerAction?: ReactNode;
  /** The host draws the title and "View all" in its own header. */
  readonly headerless?: boolean;
}) {
  const { t } = useTranslation();
  const { category, width, ratio } = TASK_TEMPLATE_SHELF[task];
  const previews = slashTemplatePreviews(category);
  const custom = useCustomTemplateRecommendations(signals, "illustration");
  const setMode = useSet(signals.create.setMode$);
  const insertTemplate = useSet(signals.template.insertTemplate$);
  const browse = useTaskTemplateBrowse(signals, task);
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
      {!headerless && (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-base font-medium">{label}</p>
          <div className="flex shrink-0 items-center gap-2">
            {browse && <ComposerTemplatePickerButton onClick={browse} />}
            {headerAction}
          </div>
        </div>
      )}
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
                  compact
                  className="block w-full"
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
            return (
              <ComposerTemplateCover
                key={preview.slug}
                title={preview.title}
                coverUrl={preview.coverUrl}
                ratio={ratio}
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

function ComposerTaskIdeas({
  signals,
  task,
}: {
  readonly signals: ComposerSignals;
  readonly task: ComposerPromptRowTask;
}) {
  const { t } = useTranslation();
  const copy = t(
    ($) => {
      return $.chat.taskChips.ideas;
    },
    { returnObjects: true },
  );
  const ideas = {
    document: DOCUMENT_IDEAS.map((key) => {
      return copy.document[key];
    }),
    image: IMAGE_IDEAS.map((key) => {
      return copy.image[key];
    }),
    website: WEBSITE_IDEAS.map((key) => {
      return copy.website[key];
    }),
    presentation: PRESENTATION_IDEAS.map((key) => {
      return copy.presentation[key];
    }),
  }[task];
  const insertPrompt = useSet(signals.editor.replacePromptText$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ComposerRail
      rail={`ideas:${task}`}
      label={t(($) => {
        return $.chat.taskChips.ideasLabel;
      })}
      itemWidth={232}
      items={ideas.map((idea) => {
        return (
          <Button
            key={idea.label}
            type="button"
            variant="neutral"
            className={cn("shrink-0", TASK_IDEA_CARD)}
            onClick={() => {
              insertPrompt(idea.prompt);
              detach(saveDraft(pageSignal), Reason.DomCallback);
            }}
          >
            <IdeaIcon
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            {idea.label}
          </Button>
        );
      })}
    />
  );
}

function ComposerDocumentTemplateRail({
  signals,
  category,
  templates,
  items,
}: {
  readonly signals: ComposerSignals;
  readonly category: DocumentTemplateCategory | "custom" | "all" | undefined;
  readonly templates: readonly UserTemplateCatalogEntry[];
  readonly items: readonly DocumentTemplateItem[];
}) {
  const setMode = useSet(signals.create.setMode$);
  const selectTemplate = useSet(signals.taskChips.selectTemplate$);
  const saveDraft = useSet(signals.draft.save$);
  const pageSignal = useGet(pageSignal$);
  return (
    <ComposerRail
      key={category}
      rail={`templates:document:${category}`}
      itemWidth={200}
      items={[
        ...(category === "custom" || category === "all"
          ? [
              <TemplateImportCard
                key="import"
                signals={signals}
                kind="document"
                compact
                className="block w-full"
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
            ]
          : []),
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
  headerAction,
  allTemplates = false,
  headerless = false,
}: {
  readonly signals: ComposerSignals;
  readonly headerAction?: ReactNode;
  readonly allTemplates?: boolean;
  /** The host draws the title and "View all" in its own header. */
  readonly headerless?: boolean;
}) {
  const { t } = useTranslation();
  const categoryResult = useLastLoadable(signals.taskChips.documentCategory$);
  const category = allTemplates
    ? "all"
    : categoryResult.state === "hasData"
      ? categoryResult.data
      : undefined;
  const custom = useCustomTemplateRecommendations(signals, "document");
  const items = DOCUMENT_TEMPLATE_ITEMS.filter((item) => {
    return category === "all" || item.category === category;
  });
  const setCategory = useSet(signals.taskChips.setDocumentCategory$);
  const setPickerCategory = useSet(signals.template.setDocumentCategory$);
  const openTemplates = useSet(signals.template.openTemplatePicker$);
  const label = t(($) => {
    return $.chat.taskChips.shelf.document;
  });
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      role="group"
      aria-label={label}
      aria-busy={category === undefined}
    >
      {!headerless && (
        <div className="flex min-w-0 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-base font-medium">{label}</p>
          <div className="flex shrink-0 items-center gap-2">
            <ComposerTemplatePickerButton
              onClick={() => {
                setPickerCategory(category ?? "all");
                openTemplates({ kind: "insert", category: "document" });
              }}
            />
            {headerAction}
          </div>
        </div>
      )}
      {/* The filter row travels like the cover rail under it: the overrun
          dissolves and a pager moves it, instead of a pill cut in half at the
          column edge. */}
      {!allTemplates && (
        <div className={RAIL_ROOT_CLASS} data-rail-root="">
          <TemplateFilterPillRow
            active={category ?? ""}
            layout="scroll"
            rail={DOCUMENT_FILTER_RAIL}
            label={t(($) => {
              return $.documentTemplates.filter;
            })}
            pills={[
              {
                id: "custom",
                label: t(($) => {
                  return $.templates.custom;
                }),
              },
              ...DOCUMENT_CATEGORIES.map((id) => {
                return {
                  id,
                  label: t(($) => {
                    return $.documentTemplates.categories[id];
                  }),
                };
              }),
            ]}
            onSelect={(id) => {
              if (id === "custom") {
                setCategory("custom");
                return;
              }
              const next = DOCUMENT_CATEGORIES.find((value) => {
                return value === id;
              });
              if (next) {
                setCategory(next);
              }
            }}
          />
          <ComposerRailPager side="back" />
          <ComposerRailPager side="forward" />
        </div>
      )}
      <ComposerDocumentTemplateRail
        signals={signals}
        category={category}
        templates={custom}
        items={items}
      />
    </div>
  );
}

/** The same live catalogs, without the legacy prompt rows. */
export function ComposerTaskTemplates({
  signals,
  selected,
  headerAction,
  headerless = false,
}: {
  readonly signals: ComposerSignals;
  readonly selected: Exclude<ComposerTask, "workflow">;
  readonly headerAction?: ReactNode;
  /**
   * The host already names the type and carries its "View all", so the
   * template shelves drop their own title line. Chart keeps its section
   * labels: they name its two groups, not the type.
   */
  readonly headerless?: boolean;
}) {
  if (selected === "presentation") {
    return (
      <ComposerPresentationRecommendations
        signals={signals}
        headerAction={headerAction}
        headerless={headerless}
      />
    );
  }
  if (selected === "document") {
    return (
      <ComposerDocumentRecommendations
        signals={signals}
        headerAction={headerAction}
        allTemplates
        headerless={headerless}
      />
    );
  }
  if (selected === "visualization") {
    return (
      <ComposerVisualizationOptions
        signals={signals}
        headerAction={headerAction}
      />
    );
  }
  return (
    <ComposerTemplateShelf
      signals={signals}
      task={selected}
      headerAction={headerAction}
      headerless={headerless}
    />
  );
}

function ComposerTaskPanel({
  signals,
  selected,
}: {
  readonly signals: ComposerSignals;
  readonly selected: ComposerTask;
}) {
  return (
    <div
      key={selected}
      className="flex min-w-0 flex-col gap-10 motion-safe:animate-composer-panel-in"
    >
      {selected === "presentation" && (
        <>
          <ComposerTaskIdeas signals={signals} task="presentation" />
          <ComposerPresentationRecommendations signals={signals} />
        </>
      )}
      {selected === "workflow" && (
        <ComposerWorkflowRecommendations signals={signals} />
      )}
      {selected === "document" && (
        <>
          <ComposerTaskIdeas signals={signals} task="document" />
          <ComposerDocumentRecommendations signals={signals} />
        </>
      )}
      {selected === "visualization" && (
        <ComposerVisualizationOptions signals={signals} />
      )}
      {selected !== "presentation" &&
        selected !== "document" &&
        selected !== "workflow" &&
        selected !== "visualization" && (
          <>
            <ComposerTaskIdeas signals={signals} task={selected} />
            <ComposerTemplateShelf signals={signals} task={selected} />
          </>
        )}
    </div>
  );
}

export function ComposerTaskChips({
  signals,
}: {
  readonly signals: ComposerSignals;
}) {
  const { t } = useTranslation();
  const selected = useGet(signals.taskChips.task$);
  const tasks = (
    [
      "workflow",
      "presentation",
      "document",
      "image",
      "website",
      "visualization",
    ] as const
  ).filter((task) => {
    return (
      task === "workflow" ||
      task === "website" ||
      task === "visualization" ||
      signals.create.modes.includes(task)
    );
  });
  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t(($) => {
        return $.chat.taskChips.label;
      })}
    >
      {selected === null && (
        <ComposerTaskChipRow signals={signals} tasks={tasks} />
      )}
      {selected !== null && (
        <ComposerTaskPanel signals={signals} selected={selected} />
      )}
    </section>
  );
}
