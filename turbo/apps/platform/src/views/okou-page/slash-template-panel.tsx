// The two-pane slash panel. The left column indexes what you can make and the
// workflows you have; the right pane previews a type independently of selection.
// Kept beside the flat menu in slash-workflow.tsx so both can render from the
// same suggestion state while the feature switch decides which one is shown.
import type { Ref } from "react";
import { ChevronRight, Globe, Image, Presentation, Route } from "lucide-react";
import { cn, Popover, PopoverContent } from "@okouai/ui";
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
  readonly menuRef: Ref<HTMLDivElement>;
  /** Already filtered by the typed slash query. */
  readonly categories: readonly SlashTemplateCategory[];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly workflowsLoading: boolean;
  /** Categories precede workflows in the editor's shared suggestion index. */
  readonly selectedIndex: number;
  /** The row the pointer is previewing, or null while the keyboard leads. */
  readonly previewIndex: number | null;
  readonly onPreview: (index: number | null) => void;
  readonly onSelectCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly onSelectWorkflow: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly onBrowseAll: () => void;
  readonly onClose: () => void;
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
      onClick={onSelectTemplate}
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
  const previews = slashTemplatePreviews(category);
  const nativeAspect = isSlashTemplateNativeAspectCategory(category);
  return (
    <div
      // The flyout's own surface: it floats beside the index rather than inside
      // it, so it restates the popover's hairline, radius and drop shadow the
      // same way the model picker's flyout panel does — `shadow-lg` reproduces
      // the shadow the shared popover applies as an inline style.
      className="h-full w-[320px] overflow-hidden rounded-[12px] border border-[hsl(var(--gray-400))] bg-card shadow-lg"
      data-slot="slash-template-detail"
      data-category={category}
    >
      {/*
        No bottom padding: the covers scroll all the way to the panel's bottom
        edge, so a half-visible row reads as more content rather than sitting
        above a white gutter. The trailing space lives inside the scroller.
      */}
      <div className="flex h-full flex-col px-4 pt-4">
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
          the edge of their ring. `-ml-px` cancels the left padding. The bottom
          stays unpadded, since the covers are meant to bleed off that edge.
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
          className="-ml-px -mr-4 min-h-0 flex-1 overflow-y-auto pl-px pr-4 pt-px"
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

/** The index popup this panel fills. The flyout hangs off it. */
function slashPanelAnchor(): Element | null {
  return document.querySelector('[data-slot="slash-panel"]');
}

/**
 * True while the pointer is over either card. The flyout is portalled, so
 * crossing between the two is a real `mouseleave` on the one being left even
 * though, to the user, the pointer never left the menu.
 */
function insideSlashPanel(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      '[data-slot="slash-panel"],[data-slot="slash-template-flyout"]',
    ) !== null
  );
}

/**
 * The detail pane, floating beside the index instead of sharing its box. Base
 * UI anchors it to the index and flips it to the index's other side when the
 * caret leaves no room, so the pane always opens into the space there is while
 * the index itself never moves. A pane inside the box made the popover
 * content-width, and a popover that changes width re-pins itself against the
 * viewport edge — which slid the whole index out from under the pointer.
 */
function SlashTemplateDetailFlyout({
  menuRef,
  onClose,
  category,
  onSelectTemplate,
  onPreview,
}: {
  readonly menuRef: Ref<HTMLDivElement>;
  readonly onClose: () => void;
  readonly category: SlashTemplateCategory;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly onPreview: (index: number | null) => void;
}) {
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        // Hover/category selection owns this flyout's visibility, while
        // Escape dismisses the whole suggestion interaction from any surface.
        if (!open && details.reason === "escape-key") {
          onClose();
        }
      }}
    >
      <PopoverContent
        ref={menuRef}
        aria-label={slashTemplateCategoryLabel(category)}
        anchor={slashPanelAnchor}
        side="right"
        align="start"
        sideOffset={0}
        updatePositionStrategy="always"
        // The menu's keyboard navigation stays in the editor, and the row that
        // opened this flyout keeps its focus.
        initialFocus={false}
        finalFocus={false}
        // A bare positioning box: the pane paints its own surface, and the gap
        // that reads as air between the two cards is padding on the index's
        // side, so a pointer crossing it never leaves the flyout.
        className="h-[min(380px,var(--available-height))] w-auto border-0 bg-transparent p-0 data-[side=left]:pr-1.5 data-[side=right]:pl-1.5"
        style={FLYOUT_BOX_STYLE}
        data-slot="slash-template-flyout"
        onMouseLeave={(event) => {
          if (insideSlashPanel(event.relatedTarget)) {
            return;
          }
          onPreview(null);
        }}
      >
        <SlashTemplateDetailPane
          category={category}
          onSelectTemplate={onSelectTemplate}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The shared popover paints its shadow inline, so only a style can clear it. */
const FLYOUT_BOX_STYLE = { boxShadow: "none" } as const;

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
            onClick={() => {
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
  menuRef,
  categories,
  workflows,
  workflowsLoading,
  selectedIndex,
  previewIndex,
  onPreview,
  onSelectCategory,
  onSelectTemplate,
  onSelectWorkflow,
  onBrowseAll,
  onClose,
  workflowOptionId,
  categoryOptionId,
}: SlashTemplatePanelProps) {
  const { t } = useTranslation();
  // Keep the mark on the previewed row while the pointer crosses into its
  // flyout. Keyboard navigation or leaving both cards restores the keyboard
  // selection and its preview together.
  const markedIndex = previewIndex ?? selectedIndex;
  // A workflow row indexes past the categories, so it previews nothing and the
  // flyout closes.
  const detailCategory = categories[markedIndex] ?? null;
  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-slot="slash-panel"
      onMouseLeave={(event) => {
        // Moving into the flyout is not leaving the menu, even though the two
        // cards are separate elements.
        if (insideSlashPanel(event.relatedTarget)) {
          return;
        }
        onPreview(null);
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
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
          <div className="px-1">
            {categories.map((category, index) => {
              const Icon = SLASH_TEMPLATE_CATEGORY_ICONS[category];
              const label = slashTemplateCategoryLabel(category);
              return (
                <button
                  key={category}
                  id={categoryOptionId(category)}
                  type="button"
                  aria-label={label}
                  data-active={markedIndex === index ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors",
                    markedIndex === index
                      ? "bg-state-selected hover:bg-state-selected-hover"
                      : "hover:bg-state-hover",
                  )}
                  onMouseMove={() => {
                    onPreview(index);
                  }}
                  onClick={() => {
                    onSelectCategory(category);
                  }}
                >
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
            onClick={onBrowseAll}
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
        <SlashTemplateDetailFlyout
          menuRef={menuRef}
          onClose={onClose}
          category={detailCategory}
          onSelectTemplate={onSelectTemplate}
          onPreview={onPreview}
        />
      )}
    </div>
  );
}
