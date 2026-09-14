// The two-pane slash panel. The left column indexes what you can make and the
// workflows you have; the right pane previews the highlighted type's covers.
// Kept beside the flat menu in slash-workflow.tsx so both can render from the
// same suggestion state while the feature switch decides which one is shown.
import {
  ChevronRight,
  Globe,
  Image,
  Presentation,
  Route,
  Video,
  Workflow,
} from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { SlashWorkflowName } from "./slash-workflow.tsx";
import { i18n } from "../../i18n/index.ts";
import type { ComposerSlashWorkflowMatch } from "../../signals/okou-page/workflow-composer-domain.ts";
import {
  isSlashTemplatePreviewCategory,
  slashTemplatePreviewGroup,
  type SlashTemplateCategory,
  type SlashTemplatePreview,
  type SlashTemplatePreviewCategory,
} from "./composer-template-catalog.ts";

// Concentric corners, the same rule the shared DropdownMenu states: an inner
// radius equals the outer radius minus the gap. The popover is 12px and the row
// gutters are `p-1` (4px), so every hoverable row is `rounded-lg` (8px).
const SLASH_TEMPLATE_CATEGORY_ICONS = {
  slides: Presentation,
  illustration: Image,
  video: Video,
  website: Globe,
  workflow: Workflow,
} as const satisfies Record<SlashTemplateCategory, typeof Presentation>;

interface SlashTemplatePanelProps {
  /** Already filtered by the typed slash query. */
  readonly categories: readonly SlashTemplateCategory[];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly workflowsLoading: boolean;
  /** Categories precede workflows in the editor's shared suggestion index. */
  readonly selectedIndex: number;
  readonly onHighlight: (index: number) => void;
  readonly onSelectCategory: (category: SlashTemplateCategory) => void;
  readonly onSelectTemplate: (preview: SlashTemplatePreview) => void;
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
    case "video": {
      return i18n.t(($) => {
        return $.artifacts.kinds.video;
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

function categoryDescription(category: SlashTemplateCategory): string {
  switch (category) {
    case "slides": {
      return i18n.t(($) => {
        return $.chat.composer.slashPanel.slidesDescription;
      });
    }
    case "illustration": {
      return i18n.t(($) => {
        return $.chat.composer.slashPanel.illustrationDescription;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.chat.composer.slashPanel.videoDescription;
      });
    }
    case "website": {
      return i18n.t(($) => {
        return $.chat.composer.slashPanel.websiteDescription;
      });
    }
    case "workflow": {
      return i18n.t(($) => {
        return $.chat.composer.slashPanel.workflowDescription;
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

function SlashTemplateDetailPane({
  category,
  onSelectTemplate,
}: {
  readonly category: SlashTemplatePreviewCategory;
  readonly onSelectTemplate: (preview: SlashTemplatePreview) => void;
}) {
  const { t } = useTranslation();
  const group = slashTemplatePreviewGroup(category);
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
                { count: group.total },
              )}
            </span>
          </span>
        </div>
        <p className="mt-3 shrink-0 text-[13px] leading-6 text-muted-foreground">
          {categoryDescription(category)}
        </p>
        {/*
          The scroller reaches the pane's right edge and pads its content back,
          so the overlay scrollbar — which draws inward from the viewport edge —
          lands in that gutter instead of on top of the right-hand covers.
          The grid is a child of the scroller rather than the scroller itself,
          so its trailing padding is an ordinary block margin every engine
          measures, not padding on a scroll container.
        */}
        <div className="-mr-4 mt-3 min-h-0 flex-1 overflow-y-auto pr-4">
          <div className="grid grid-cols-2 gap-2.5 pb-4">
            {group.previews.map((preview) => {
              return (
                <button
                  key={preview.slug}
                  type="button"
                  className="group min-w-0 text-left"
                  aria-label={t(
                    ($) => {
                      return $.chat.composer.slashPanel.useTemplate;
                    },
                    { title: preview.title },
                  )}
                  onMouseDown={(event) => {
                    // Keep the editor focused; the panel never takes selection.
                    event.preventDefault();
                    onSelectTemplate(preview);
                  }}
                >
                  <span className="block aspect-video overflow-hidden rounded-lg bg-muted ring-1 ring-border/60">
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
  selectedIndex,
  onHighlight,
  onSelect,
  workflowOptionId,
}: {
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly onHighlight: (index: number) => void;
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
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
              selectedIndex === index
                ? "bg-state-hover"
                : "hover:bg-state-hover",
            )}
            onMouseEnter={() => {
              onHighlight(index);
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
  onHighlight,
  onSelectCategory,
  onSelectTemplate,
  onSelectWorkflow,
  onBrowseAll,
  workflowOptionId,
  categoryOptionId,
}: SlashTemplatePanelProps) {
  const { t } = useTranslation();
  const highlighted = categories[selectedIndex] ?? null;
  // Narrowed here rather than inside the pane, so the pane has no unreachable
  // branch for a category that can never reach it.
  const detailCategory =
    highlighted !== null && isSlashTemplatePreviewCategory(highlighted)
      ? highlighted
      : null;
  return (
    <div className="flex h-[380px] overflow-hidden" data-slot="slash-panel">
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
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors",
                    highlighted === category
                      ? "bg-state-hover"
                      : "hover:bg-state-hover",
                  )}
                  onMouseEnter={() => {
                    onHighlight(index);
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
            selectedIndex={selectedIndex - categories.length}
            onHighlight={(index) => {
              onHighlight(categories.length + index);
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
