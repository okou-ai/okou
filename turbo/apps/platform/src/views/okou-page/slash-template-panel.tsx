// The two-pane slash panel. The left column indexes what you can make and the
// workflows you have; the right pane holds the covers of one type.
// The covers belong to the Make section rather than to whichever row carries
// the mark, so moving onto a workflow row leaves them where they are. That is
// what keeps the panel one width: the popover is content-width, so a pane that
// mounts and unmounts under the pointer re-solves the popover's collision and
// walks the left column across the caret between two alignments.
// Kept beside the flat menu in slash-workflow.tsx so both can render from the
// same suggestion state while the feature switch decides which one is shown.
import { ChevronRight, Globe, Image, Presentation, Route } from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { SlashWorkflowName } from "./slash-workflow.tsx";
import { i18n } from "../../i18n/index.ts";
import type { ComposerSlashWorkflowMatch } from "../../signals/okou-page/workflow-composer-domain.ts";
import {
  isSlashTemplateNativeAspectCategory,
  slashTemplatePreviews,
  type SlashTemplateCategory,
  type SlashTemplatePreview,
} from "./composer-template-catalog.ts";

// Concentric corners, the same rule the shared DropdownMenu states: an inner
// radius equals the outer radius minus the gap. The popover is 12px and the row
// gutters are `p-1` (4px), so every hoverable row is `rounded-lg` (8px).
const SLASH_TEMPLATE_CATEGORY_ICONS = {
  slides: Presentation,
  illustration: Image,
  website: Globe,
} as const satisfies Record<SlashTemplateCategory, typeof Presentation>;

interface SlashTemplatePanelProps {
  /** Already filtered by the typed slash query. */
  readonly categories: readonly SlashTemplateCategory[];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly workflowsLoading: boolean;
  /** Categories precede workflows in the editor's shared suggestion index. */
  readonly selectedIndex: number;
  /** The row the pointer is previewing, or null while the keyboard leads. */
  readonly previewIndex: number | null;
  readonly onPreview: (index: number | null) => void;
  /** Which type owns the covers, or null before any row has named one. */
  readonly previewedCategory: SlashTemplateCategory | null;
  readonly onPreviewCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly onSelectWorkflow: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly onBrowseAll: () => void;
  readonly workflowOptionId: (workflowId: string) => string;
  readonly categoryOptionId: (category: SlashTemplateCategory) => string;
}

export function slashTemplateCategoryLabel(
  category: SlashTemplateCategory,
): string {
  switch (category) {
    case "slides": {
      return i18n.t(($) => {
        return $.artifacts.kinds.presentation;
      });
    }
    case "illustration": {
      return i18n.t(($) => {
        return $.artifacts.templates.illustration;
      });
    }
    case "website": {
      return i18n.t(($) => {
        return $.artifacts.templates.website;
      });
    }
  }
}

function SectionLabel({ children }: { readonly children: string }) {
  return (
    <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * One cover. `aspect` is present only for categories that show the artwork
 * uncropped, and then it drives an inline ratio rather than the shared tile —
 * the same thing the picker dialog's illustration card does.
 */
function SlashTemplateCover({
  preview,
  onSelectTemplate,
}: {
  readonly preview: SlashTemplatePreview;
  readonly onSelectTemplate: () => void;
}) {
  const { t } = useTranslation();
  const aspect = preview.aspect;
  return (
    <button
      type="button"
      data-slot="slash-template-cover"
      className={cn(
        "group min-w-0 text-left",
        aspect && "mb-2.5 block w-full break-inside-avoid",
      )}
      aria-label={t(
        ($) => {
          return $.chat.composer.slashPanel.useTemplate;
        },
        { title: preview.title },
      )}
      onMouseDown={(event) => {
        // Keep the editor focused; the panel never takes selection.
        event.preventDefault();
        onSelectTemplate();
      }}
    >
      <span
        className={cn(
          "block overflow-hidden rounded-lg bg-muted ring-1 ring-border/60",
          !aspect && "aspect-video",
        )}
        style={
          aspect
            ? {
                aspectRatio: `${String(aspect.width)} / ${String(aspect.height)}`,
              }
            : undefined
        }
      >
        <img
          src={preview.coverUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
        />
      </span>
      <span className="mt-1 block truncate text-[12px] text-muted-foreground">
        {preview.title}
      </span>
    </button>
  );
}

function SlashTemplateDetailPane({
  category,
  onSelectTemplate,
}: {
  readonly category: SlashTemplateCategory;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
}) {
  const { t } = useTranslation();
  const previews = slashTemplatePreviews(category);
  const nativeAspect = isSlashTemplateNativeAspectCategory(category);
  const Icon = SLASH_TEMPLATE_CATEGORY_ICONS[category];
  return (
    <div
      className="w-[320px] shrink-0"
      data-slot="slash-template-detail"
      data-category={category}
    >
      {/*
        No bottom padding: the covers scroll all the way to the panel's bottom
        edge, so a half-visible row reads as more content rather than sitting
        above a white gutter. The trailing space lives inside the scroller.
      */}
      <div className="flex h-full flex-col px-4 pt-4">
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon size={18} className="text-muted-foreground" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-medium">
              {slashTemplateCategoryLabel(category)}
            </span>
            <span className="block truncate text-[12px] text-muted-foreground">
              {t(
                ($) => {
                  return $.chat.composer.slashPanel.templateCount;
                },
                { count: previews.length },
              )}
            </span>
          </span>
        </div>
        {/*
          The scroller reaches the pane's right edge and pads its content back,
          so the overlay scrollbar — which draws inward from the viewport edge —
          lands in that gutter instead of on top of the right-hand covers.
          The grid is a child of the scroller rather than the scroller itself,
          so its trailing padding is an ordinary block margin every engine
          measures, not padding on a scroll container.

          The 1px top and left padding is what keeps the cards' hairline visible.
          `ring` is an outset shadow and `overflow-y-auto` clips to the padding
          box on both axes, so without it the top row and the left column lose
          the edge of their ring. The grid stays where it was: `-ml-px` cancels
          the left padding, and the top gap is written as 11px + 1px rather than
          a negative margin, because that would collide with `mt-3` on the same
          property. The bottom stays unpadded, since the covers are meant to
          bleed off that edge.
        */}
        {/*
          Keyed by category so each type gets its own scroller. The pane stays
          mounted while the pointer moves down the rows, so a shared one keeps
          the offset the previous type was left at — and now that a category
          carries all of its covers, that offset is deep enough to open the next
          type halfway down its wall.
        */}
        <div
          key={category}
          data-slot="slash-template-covers"
          className="mt-[11px] -ml-px -mr-4 min-h-0 flex-1 overflow-y-auto pl-px pr-4 pt-px"
        >
          {/*
            Illustration keeps each cover's own proportion, so its covers go in
            a CSS multi-column masonry — the same shape the picker dialog uses.
            Every other category's cover really is 16:9, so those stay a grid
            with level rows.
          */}
          <div
            className={cn(
              nativeAspect
                ? "columns-2 gap-2.5 pb-4"
                : "grid grid-cols-2 gap-2.5 pb-4",
            )}
          >
            {previews.map((preview) => {
              return (
                <SlashTemplateCover
                  key={preview.slug}
                  preview={preview}
                  onSelectTemplate={() => {
                    onSelectTemplate(preview, category);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SlashPanelCategoryList({
  categories,
  markedIndex,
  currentCategory,
  onPreview,
  onPreviewCategory,
  onSelectCategory,
  categoryOptionId,
}: {
  readonly categories: readonly SlashTemplateCategory[];
  /** Relative to the whole list, which the categories head. */
  readonly markedIndex: number;
  /** The type whose covers the pane is holding. */
  readonly currentCategory: SlashTemplateCategory | null;
  readonly onPreview: (index: number) => void;
  readonly onPreviewCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectCategory: (category: SlashTemplateCategory) => void;
  readonly categoryOptionId: (category: SlashTemplateCategory) => string;
}) {
  return (
    <div className="px-1">
      {categories.map((category, index) => {
        const Icon = SLASH_TEMPLATE_CATEGORY_ICONS[category];
        const label = slashTemplateCategoryLabel(category);
        // Owning the covers is a second, quieter state than the mark: the mark
        // says what Enter does, and a rule down the row's leading edge says
        // where the covers came from. Both can land on the same row, so owning
        // them does not touch the row's fill.
        const ownsCovers = category === currentCategory;
        return (
          <button
            key={category}
            id={categoryOptionId(category)}
            type="button"
            aria-label={label}
            data-active={markedIndex === index ? "true" : undefined}
            data-current={ownsCovers ? "true" : undefined}
            className={cn(
              "relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors",
              markedIndex === index
                ? "bg-state-selected hover:bg-state-selected-hover"
                : "hover:bg-state-hover",
            )}
            onMouseMove={() => {
              onPreview(index);
              onPreviewCategory(category);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelectCategory(category);
            }}
          >
            {ownsCovers && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-brand-text"
              />
            )}
            <Icon
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SlashPanelWorkflowList({
  workflows,
  loading,
  markedIndex,
  onPreview,
  onSelect,
  workflowOptionId,
}: {
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly loading: boolean;
  /** Relative to this list; negative while no row carries the mark. */
  readonly markedIndex: number;
  readonly onPreview: (index: number) => void;
  readonly onSelect: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly workflowOptionId: (workflowId: string) => string;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.composer.workflows.loading;
        })}
      </div>
    );
  }
  if (workflows.length === 0) {
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.composer.workflows.empty;
        })}
      </div>
    );
  }
  return (
    <div className="px-1">
      {workflows.map((workflow, index) => {
        return (
          <button
            key={workflow.id}
            id={workflowOptionId(workflow.id)}
            type="button"
            data-active={markedIndex === index ? "true" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
              markedIndex === index
                ? "bg-state-selected hover:bg-state-selected-hover"
                : "hover:bg-state-hover",
            )}
            onMouseMove={() => {
              onPreview(index);
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(workflow);
            }}
          >
            <Route
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            <SlashWorkflowName
              workflow={workflow}
              className="min-w-0 flex-1 text-[13px]"
            />
          </button>
        );
      })}
    </div>
  );
}

export function SlashTemplatePanel({
  categories,
  workflows,
  workflowsLoading,
  selectedIndex,
  previewIndex,
  onPreview,
  previewedCategory,
  onPreviewCategory,
  onSelectCategory,
  onSelectTemplate,
  onSelectWorkflow,
  onBrowseAll,
  workflowOptionId,
  categoryOptionId,
}: SlashTemplatePanelProps) {
  const { t } = useTranslation();
  // The pointer owns the index while it is inside the panel, so a row it has
  // left drops back to its default fill even though the right pane still shows
  // what that row previewed — the pointer is on its way into those covers, and
  // a mark left behind would disagree with wherever it lands next. The keyboard
  // mark comes back once the pointer leaves and the preview follows it again.
  // Each row publishes the result as `data-active`, so which row is marked is
  // readable without depending on the utility class that paints it.
  const markedIndex = previewIndex === null ? selectedIndex : -1;
  // Only a Make row names an owner, so a workflow row keeps the one it was
  // handed. The typed query filters the list, so an owner it removed falls
  // back to what is left rather than closing the pane and resizing the panel.
  const detailCategory =
    previewedCategory !== null && categories.includes(previewedCategory)
      ? previewedCategory
      : (categories[0] ?? null);
  return (
    <div
      className="flex h-[380px] overflow-hidden"
      data-slot="slash-panel"
      onMouseLeave={() => {
        onPreview(null);
      }}
    >
      {/*
        The rule separates the two panes, so a query that filters every type
        away drops it rather than drawing a hairline against the popover's own
        right border.
      */}
      <div
        className={cn(
          "flex min-h-0 w-[260px] shrink-0 flex-col",
          detailCategory !== null && "border-r border-border/60",
        )}
      >
        {/*
          Make and Workflows scroll as one list. Scrolling only the workflows
          left a row sliced in half under a pinned section label, and hid that
          the two groups are one index.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-1">
          <SectionLabel>
            {t(($) => {
              return $.chat.composer.slashPanel.make;
            })}
          </SectionLabel>
          <SlashPanelCategoryList
            categories={categories}
            markedIndex={markedIndex}
            currentCategory={detailCategory}
            onPreview={onPreview}
            onPreviewCategory={onPreviewCategory}
            onSelectCategory={onSelectCategory}
            categoryOptionId={categoryOptionId}
          />
          <SectionLabel>
            {t(($) => {
              return $.chat.composer.workflows.title;
            })}
          </SectionLabel>
          <SlashPanelWorkflowList
            workflows={workflows}
            loading={workflowsLoading}
            markedIndex={markedIndex - categories.length}
            onPreview={(index) => {
              onPreview(categories.length + index);
            }}
            onSelect={onSelectWorkflow}
            workflowOptionId={workflowOptionId}
          />
        </div>
        <div className="shrink-0 border-t border-border/60 p-1">
          <button
            type="button"
            className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-sm text-foreground transition-colors hover:bg-state-hover"
            onMouseDown={(event) => {
              event.preventDefault();
              onBrowseAll();
            }}
          >
            <span className="truncate">
              {t(($) => {
                return $.chat.composer.slashPanel.browseAll;
              })}
            </span>
            <ChevronRight
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
          </button>
        </div>
      </div>
      {detailCategory !== null && (
        <SlashTemplateDetailPane
          category={detailCategory}
          onSelectTemplate={onSelectTemplate}
        />
      )}
    </div>
  );
}
