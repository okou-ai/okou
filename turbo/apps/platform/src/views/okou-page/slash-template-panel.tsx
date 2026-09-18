// The two-pane slash panel. The left column indexes what you can make and the
// workflows you have; the right pane previews a type independently of selection.
// Kept beside the flat menu in slash-workflow.tsx so both can render from the
// same suggestion state while the feature switch decides which one is shown.
import {
  ChevronRight,
  Globe,
  Image,
  Plus,
  Presentation,
  Route,
} from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { SlashWorkflowName } from "./slash-workflow.tsx";
import { i18n } from "../../i18n/index.ts";
import { PRESENTATION_TEMPLATE_IMPORT_ACCEPT } from "../../signals/okou-page/presentation-template-import.ts";
import type { ComposerSlashWorkflowMatch } from "../../signals/okou-page/workflow-composer-domain.ts";
import {
  isSlashTemplateDetailCategory,
  isSlashTemplateNativeAspectCategory,
  slashTemplatePreviews,
  type SlashTemplateCategory,
  type SlashTemplateDetailCategory,
  type SlashTemplatePreview,
} from "./composer-template-catalog.ts";

// Concentric corners, the same rule the shared DropdownMenu states: an inner
// radius equals the outer radius minus the gap. The popover is 12px and the row
// gutters are `p-1` (4px), so every hoverable row is `rounded-lg` (8px).
const SLASH_TEMPLATE_CATEGORY_ICONS = {
  slides: Presentation,
  illustration: Image,
  website: Globe,
  workflow: Route,
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
  readonly onSelectCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateDetailCategory,
  ) => void;
  readonly onImportDeck: (file: File) => void;
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
    case "workflow": {
      return i18n.t(($) => {
        return $.artifacts.templates.workflow;
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
 * Leads the Presentation covers, because a deck the user already owns is the
 * fastest template of all. It shares the picker dialog's command and accepted
 * formats; only the tile geometry is this pane's own, since these cards are
 * 139px rather than the dialog's full-width tiles.
 */
function SlashTemplateImportCard({
  onImportDeck,
}: {
  readonly onImportDeck: (file: File) => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.templates.importDeck;
  });
  return (
    <label
      className="group min-w-0 cursor-pointer text-left"
      data-slot="slash-template-import"
      onMouseDown={(event) => {
        // The panel is mounted off the editor's slash range, so letting the
        // file input take focus clears the range and unmounts this input
        // before the file dialog can return. Label activation still forwards
        // the click, so the dialog opens with the caret left where it was.
        event.preventDefault();
      }}
    >
      <span className="flex aspect-video flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg bg-muted/50 ring-1 ring-border/60 transition-colors group-hover:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
        <Plus
          className="size-5 text-muted-foreground"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="text-[10px] text-muted-foreground">
          {t(($) => {
            return $.artifacts.templates.importDeckHint;
          })}
        </span>
        <input
          type="file"
          className="sr-only"
          accept={PRESENTATION_TEMPLATE_IMPORT_ACCEPT}
          aria-label={label}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Clear the input so choosing the same deck again still fires.
            event.currentTarget.value = "";
            if (file) {
              onImportDeck(file);
            }
          }}
        />
      </span>
      <span className="mt-1 block truncate text-[12px] text-muted-foreground">
        {label}
      </span>
    </label>
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

/** Both panes open on the same header, so they read as one surface. */
function SlashTemplatePaneHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  readonly icon: typeof Presentation;
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon size={18} className="text-muted-foreground" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-medium">{title}</span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
    </div>
  );
}

/**
 * Where the Workflow type and the workflow rows land. Workflow templates are
 * text, so it carries no covers, but it holds the cover pane's width: the panel
 * is what the popover measures, and a panel that narrows under the pointer
 * moves the whole index out from under it.
 */
function SlashTemplateWorkflowPane() {
  const { t } = useTranslation();
  return (
    <div
      className="w-[320px] shrink-0"
      data-slot="slash-template-workflow-pane"
    >
      <div className="flex h-full flex-col px-4 pt-4">
        <SlashTemplatePaneHeader
          icon={SLASH_TEMPLATE_CATEGORY_ICONS.workflow}
          title={slashTemplateCategoryLabel("workflow")}
          subtitle={t(($) => {
            return $.chat.composer.slashPanel.workflowSubtitle;
          })}
        />
        <p className="mt-[11px] text-[12px] text-muted-foreground">
          {t(($) => {
            return $.chat.composer.slashPanel.workflowHint;
          })}
        </p>
      </div>
    </div>
  );
}

function SlashTemplateDetailPane({
  category,
  onSelectTemplate,
  onImportDeck,
}: {
  readonly category: SlashTemplateDetailCategory;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateDetailCategory,
  ) => void;
  readonly onImportDeck: (file: File) => void;
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
        <SlashTemplatePaneHeader
          icon={Icon}
          title={slashTemplateCategoryLabel(category)}
          subtitle={t(
            ($) => {
              return $.chat.composer.slashPanel.templateCount;
            },
            { count: previews.length },
          )}
        />
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
            {category === "slides" && (
              <SlashTemplateImportCard onImportDeck={onImportDeck} />
            )}
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
  onSelectCategory,
  onSelectTemplate,
  onImportDeck,
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
  const previewCategory = categories[previewIndex ?? selectedIndex] ?? null;
  // Narrowed here rather than inside the pane, so the pane has no unreachable
  // branch for a category that can never reach it.
  const detailCategory =
    previewCategory !== null && isSlashTemplateDetailCategory(previewCategory)
      ? previewCategory
      : null;
  return (
    <div
      className="flex h-[380px] overflow-hidden"
      data-slot="slash-panel"
      onMouseLeave={() => {
        // Hand the preview back to the keyboard once the pointer is gone. The
        // panel's width no longer depends on the hovered row, so a leave here
        // is a real leave rather than the panel having moved.
        onPreview(null);
      }}
    >
      <div className="flex min-h-0 w-[260px] shrink-0 flex-col border-r border-border/60">
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
                  onMouseDown={(event) => {
                    event.preventDefault();
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
      {detailCategory === null ? (
        <SlashTemplateWorkflowPane />
      ) : (
        <SlashTemplateDetailPane
          category={detailCategory}
          onSelectTemplate={onSelectTemplate}
          onImportDeck={onImportDeck}
        />
      )}
    </div>
  );
}
