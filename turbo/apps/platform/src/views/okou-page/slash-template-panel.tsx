// The slash panel indexes creation types and workflows, with desktop previews
// embedded on the right.
// It renders inside the slash menu's popover shell from slash-workflow.tsx.
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Image,
  LayoutGrid,
  Plus,
  Presentation,
  Route,
  Settings2,
} from "lucide-react";
import { cn, useMediaQuery } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { useGet, useLastLoadable, useLastResolved } from "ccstate-react";
import type { UserTemplateKind } from "@okouai/api-contracts/contracts/user-templates";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  customTemplateCatalog$,
  projectCustomTemplate$,
  slashCustomTemplatesEnabled$,
} from "../../signals/okou-page/custom-template-library.ts";
import { SlashWorkflowName, slashWorkflowOptionId } from "./slash-workflow.tsx";
import { CustomTemplatesLoadError } from "./custom-template-preview-dialog.tsx";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import { i18n } from "../../i18n/index.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import type { ComposerSlashWorkflowMatch } from "../../signals/okou-page/workflow-composer-domain.ts";
import { Link } from "../router/link.tsx";
import { slashCustomTemplateCounts$ } from "../../signals/okou-page/slash-actions.ts";
import type { SlashAction } from "./slash-actions.ts";
import {
  isSlashTemplateNativeAspectCategory,
  customSlashTemplatePreview,
  slashTemplatePreviews,
  type SlashTemplateCategory,
  type SlashTemplatePreview,
} from "./composer-template-catalog.ts";

// Concentric corners, the same rule the shared DropdownMenu states: an inner
// radius equals the outer radius minus the gap. The popover is 12px and the row
// gutters are `p-1` (4px), so every hoverable row is `rounded-lg` (8px).
const SLASH_TEMPLATE_CATEGORY_ICONS = {
  slides: Presentation,
  document: FileText,
  illustration: Image,
  website: Globe,
} as const satisfies Record<SlashTemplateCategory, typeof Presentation>;

// The overview lists the four most recent workflows and reveals the rest in
// place, from a row directly beneath them.
export const SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT = 4;

// Option ids for the controls following the visible workflows.
export const SLASH_PANEL_SHOW_MORE_ID = "show-more-workflows";
export const SLASH_PANEL_NEW_WORKFLOW_ID = "new-workflow";
export const SLASH_PANEL_MANAGE_WORKFLOWS_ID = "manage-workflows";

// A full-width row whose label is quieter than a creation type's.
const SLASH_QUIET_ROW =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors";

function slashQuietRowState(marked: boolean): string {
  return marked
    ? cn(SLASH_ROW_MARKED, "text-foreground")
    : "text-muted-foreground hover:bg-state-hover hover:text-foreground";
}

// The row the pointer or the keyboard has marked. Pointing at Browse all takes
// the mark off it, so the only fill in the index is the one under the pointer,
// while the preview keeps showing the type it last opened.
export const SLASH_ROW_MARKED =
  "bg-state-selected hover:bg-state-selected-hover group-has-[[data-slot=slash-browse-all]:hover]/slash-panel:bg-transparent";

// A workflow description is written for the agent and often runs a paragraph,
// so a row shows only its first clause: up to the first comma, colon,
// semicolon, dash, parenthesis or sentence end, in Latin or CJK punctuation.
// A period inside a word such as `app.vm0.ai` does not end the clause.
const WORKFLOW_SUMMARY_END = /[,;:，；：。—(（\n]|\.(?=\s|$)/u;

function workflowSummary(description: string): string {
  const end = description.search(WORKFLOW_SUMMARY_END);
  return (end === -1 ? description : description.slice(0, end)).trim();
}

interface SlashTemplatePanelProps {
  /** Already filtered by the typed slash query. */
  readonly categories: readonly SlashTemplateCategory[];
  /**
   * The chat actions the typed query names, indexed after the categories and
   * before the workflows. Empty unless the slash-actions switch is on.
   */
  readonly actions: readonly SlashAction[];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly workflowsLoading: boolean;
  readonly collapseWorkflows: boolean;
  readonly onExpandWorkflows: () => void;
  /**
   * The height the menu opened with, held while the overview's workflows are
   * revealed so the row that revealed them does not move. Null otherwise.
   */
  readonly expandedHeight: number | null;
  /** New workflow and Manage workflows follow the revealed workflows. */
  readonly showWorkflowActions: boolean;
  readonly onNewWorkflow: () => void;
  /** Runs before the Manage workflows link navigates. */
  readonly onManageWorkflows: () => void;
  /** Keep overview categories anchored nearest the composer on desktop. */
  readonly reversed: boolean;
  readonly reverseWorkflows: boolean;
  /**
   * Categories, then actions, precede workflows in the editor's shared
   * suggestion index.
   */
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
  readonly workflowOptionId: (workflowId: string) => string;
  readonly categoryOptionId: (category: SlashTemplateCategory) => string;
}

export function slashTemplateCategoryLabel(
  category: SlashTemplateCategory,
): string {
  switch (category) {
    case "document": {
      return i18n.t(($) => {
        return $.documentTemplates.title;
      });
    }
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
  category,
  onSelectTemplate,
}: {
  readonly preview: SlashTemplatePreview;
  readonly category: SlashTemplateCategory;
  readonly onSelectTemplate: () => void;
}) {
  const { t } = useTranslation();
  const aspect = preview.aspect;
  const Icon = SLASH_TEMPLATE_CATEGORY_ICONS[category];
  // A document page is cropped to its head rather than fitted whole; other
  // custom artwork has no known shape, so it is fitted.
  const documentPage = category === "document";
  return (
    <button
      type="button"
      data-slot="slash-template-cover"
      className={cn(
        "group min-w-0 text-left",
        isSlashTemplateNativeAspectCategory(category) &&
          "mb-2.5 block w-full break-inside-avoid supports-[display:grid-lanes]:mb-0 supports-[display:grid-lanes]:break-inside-auto",
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
          "flex items-center justify-center overflow-hidden rounded-lg bg-muted ring-1 ring-border/60 transition-colors group-hover:bg-state-hover",
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
        {preview.coverUrl ? (
          <img
            src={preview.coverUrl}
            alt=""
            loading="lazy"
            className={cn(
              "h-full w-full",
              documentPage
                ? "bg-[#ffffff] object-cover object-top"
                : preview.template.type === "custom"
                  ? "object-contain"
                  : "object-cover transition-transform duration-200 group-hover:scale-[1.04]",
            )}
          />
        ) : (
          <Icon className="size-6 text-muted-foreground" aria-hidden />
        )}
      </span>
      <span className="mt-1 block truncate text-[12px] text-muted-foreground">
        {preview.title}
      </span>
    </button>
  );
}

/** The custom templates a category lists; websites have none. */
function customTemplateKind(
  category: Exclude<SlashTemplateCategory, "website">,
): UserTemplateKind {
  return category === "slides" ? "presentation" : category;
}

/** The built-in covers a category shows; Document's wait for their switch. */
function useBuiltInSlashTemplates(): (
  category: SlashTemplateCategory,
) => readonly SlashTemplatePreview[] {
  const documentTemplatesEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.BuiltinDocumentTemplates] === true;
  return (category) => {
    return category === "document" && !documentTemplatesEnabled
      ? []
      : slashTemplatePreviews(category);
  };
}

/**
 * How many covers a category shows: its built-in templates plus the custom
 * ones listed beside them, so a count matches the covers it opens.
 */
export function useSlashTemplateCount(): (
  category: SlashTemplateCategory,
) => number {
  const builtIn = useBuiltInSlashTemplates();
  const customCounts = useLastResolved(slashCustomTemplateCounts$);
  return (category) => {
    const custom =
      category === "website"
        ? 0
        : (customCounts?.get(customTemplateKind(category)) ?? 0);
    return builtIn(category).length + custom;
  };
}

/** Mounted only while a category can show custom templates. */
function SlashCustomTemplateCovers({
  category,
  onSelectTemplate,
}: {
  readonly category: Exclude<SlashTemplateCategory, "website">;
  readonly onSelectTemplate: SlashTemplatePanelProps["onSelectTemplate"];
}) {
  const catalog = useLastLoadable(customTemplateCatalog$);
  const project = useGet(projectCustomTemplate$);
  const kind = customTemplateKind(category);
  if (catalog.state === "hasError") {
    return (
      <div className="col-span-full break-inside-avoid pb-2.5">
        <CustomTemplatesLoadError />
      </div>
    );
  }
  if (catalog.state !== "hasData") {
    return null;
  }
  return catalog.data.flatMap((template) => {
    const projected = project(template);
    if (projected?.kind !== kind) {
      return [];
    }
    const preview = customSlashTemplatePreview(projected);
    return [
      <SlashTemplateCover
        key={preview.slug}
        preview={preview}
        category={category}
        onSelectTemplate={() => {
          onSelectTemplate(preview, category);
        }}
      />,
    ];
  });
}

/**
 * The covers of one category, filling a positioned pane. Shared by the type
 * preview and the slash-actions Templates list.
 */
export function SlashTemplateCovers({
  category,
  onSelectTemplate,
}: {
  readonly category: SlashTemplateCategory;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
}) {
  const customTemplatesEnabled = useGet(slashCustomTemplatesEnabled$);
  const previews = useBuiltInSlashTemplates()(category);
  const nativeAspect = isSlashTemplateNativeAspectCategory(category);
  return (
    <>
      {/*
        No top or bottom padding: the covers scroll all the way to the panel's
        top and bottom edges, so a half-visible row reads as more content
        rather than being cut off by a white gutter. The leading and trailing
        space live inside the scroller.
      */}
      <div
        // The command list owns the menu height; previews scroll within it.
        className="absolute inset-0 flex flex-col px-4"
      >
        {/*
          The scroller reaches the pane's right edge and pads its content back,
          so the overlay scrollbar — which draws inward from the viewport edge —
          lands in that gutter instead of on top of the right-hand covers.
          The grid is a child of the scroller rather than the scroller itself,
          so its trailing padding is an ordinary block margin every engine
          measures, not padding on a scroll container.

          The 16px top inset is padding on the scroller, not on the pane, so
          the first row rests 16px down but scrolls up to the pane's top edge.
          The 1px left padding keeps the left column's hairline visible: `ring`
          is an outset shadow and `overflow-y-auto` clips to the padding box on
          both axes. `-ml-px` cancels it.
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
          className="-ml-px -mr-4 min-h-0 flex-1 overflow-y-auto pl-px pr-4 pt-4"
        >
          {/*
            Native-aspect covers use Grid Lanes when available, with multi-column
            masonry as a fallback. Other categories keep their 16:9 grid rows.
          */}
          <div
            className={cn(
              nativeAspect
                ? "columns-2 gap-2.5 pb-4 supports-[display:grid-lanes]:columns-auto supports-[display:grid-lanes]:grid-cols-2 supports-[display:grid-lanes]:[display:grid-lanes]"
                : "grid grid-cols-2 gap-2.5 pb-4",
            )}
          >
            {customTemplatesEnabled && category !== "website" && (
              <SlashCustomTemplateCovers
                category={category}
                onSelectTemplate={onSelectTemplate}
              />
            )}
            {previews.map((preview) => {
              return (
                <SlashTemplateCover
                  key={preview.slug}
                  preview={preview}
                  category={category}
                  onSelectTemplate={() => {
                    onSelectTemplate(preview, category);
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
    </>
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
  return (
    <div
      className="relative w-[400px] max-w-1/2 shrink-0 overflow-hidden border-l border-border/60"
      role="region"
      aria-label={slashTemplateCategoryLabel(category)}
      data-slot="slash-template-detail"
      data-category={category}
    >
      <SlashTemplateCovers
        category={category}
        onSelectTemplate={onSelectTemplate}
      />
    </div>
  );
}

// Keep this ref stable: pointer previews must not re-scroll the keyboard's
// selected row while the user browses an expanded workflow list.
function scrollSelectedSlashOptionOnMount(
  option: HTMLButtonElement | null,
): (() => void) | undefined {
  if (!option) {
    return;
  }
  const frame = window.requestAnimationFrame(() => {
    option.scrollIntoView?.({ block: "nearest" });
  });
  return () => {
    window.cancelAnimationFrame(frame);
  };
}

function SlashPanelWorkflowList({
  workflows,
  loading,
  markedIndex,
  selectedIndex,
  reversed,
  onPreview,
  onSelect,
  workflowOptionId,
}: {
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly reversed: boolean;
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
  return (
    <div className="px-1">
      {(reversed ? [...workflows].reverse() : workflows).map(
        (workflow, visualIndex) => {
          const index = reversed
            ? workflows.length - 1 - visualIndex
            : visualIndex;
          const summary = workflow.description
            ? workflowSummary(workflow.description)
            : "";
          return (
            <button
              key={workflow.id}
              id={workflowOptionId(workflow.id)}
              ref={
                selectedIndex === index
                  ? scrollSelectedSlashOptionOnMount
                  : undefined
              }
              type="button"
              data-active={markedIndex === index ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                markedIndex === index
                  ? SLASH_ROW_MARKED
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
              {/*
                One line that truncates as a whole: the name comes first, so the
                summary is what the ellipsis eats, and the ellipsis takes this
                span's colour, the summary's. The space keeps the two apart in
                the row's accessible name.
              */}
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground/50">
                <SlashWorkflowName workflow={workflow} />
                {summary && (
                  <>
                    {" "}
                    <span className="ml-1">{summary}</span>
                  </>
                )}
              </span>
            </button>
          );
        },
      )}
    </div>
  );
}

/**
 * Reveals the rest of the overview's workflows in place: they take this row's
 * position, so the first of them lands under the pointer that clicked it.
 */
function SlashPanelShowMore({
  id,
  index,
  hiddenCount,
  marked,
  onPreview,
  onExpand,
}: {
  readonly id: string;
  readonly index: number;
  readonly hiddenCount: number;
  readonly marked: boolean;
  readonly onPreview: (index: number) => void;
  readonly onExpand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      id={id}
      type="button"
      aria-expanded={false}
      data-active={marked ? "true" : undefined}
      className={cn(SLASH_QUIET_ROW, slashQuietRowState(marked))}
      onMouseMove={() => {
        onPreview(index);
      }}
      onClick={onExpand}
    >
      <SlashQuietRowContent icon={<ChevronDown size={16} aria-hidden />}>
        {t(
          ($) => {
            return $.chat.composer.workflows.showMore;
          },
          { total: hiddenCount },
        )}
      </SlashQuietRowContent>
    </button>
  );
}

function SlashQuietRowContent({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: string;
}) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </>
  );
}

/** The two things to do besides picking one, after the whole list. */
function SlashPanelWorkflowActions({
  index,
  markedIndex,
  onPreview,
  onNewWorkflow,
  onManageWorkflows,
  workflowOptionId,
}: Pick<
  SlashTemplatePanelProps,
  "onNewWorkflow" | "onManageWorkflows" | "workflowOptionId"
> & {
  /** Relative index of New workflow; Manage workflows follows it. */
  readonly index: number;
  readonly markedIndex: number;
  readonly onPreview: (index: number) => void;
}) {
  const { t } = useTranslation();
  const manageIndex = index + 1;
  return (
    <>
      <button
        id={workflowOptionId(SLASH_PANEL_NEW_WORKFLOW_ID)}
        type="button"
        data-active={markedIndex === index ? "true" : undefined}
        className={cn(
          SLASH_QUIET_ROW,
          slashQuietRowState(markedIndex === index),
        )}
        onMouseMove={() => {
          onPreview(index);
        }}
        onClick={onNewWorkflow}
      >
        <SlashQuietRowContent icon={<Plus size={16} aria-hidden />}>
          {t(($) => {
            return $.chat.composer.workflows.newWorkflow;
          })}
        </SlashQuietRowContent>
      </button>
      <Link
        id={workflowOptionId(SLASH_PANEL_MANAGE_WORKFLOWS_ID)}
        pathname={ROUTES.workflows}
        data-active={markedIndex === manageIndex ? "true" : undefined}
        className={cn(
          SLASH_QUIET_ROW,
          slashQuietRowState(markedIndex === manageIndex),
        )}
        onMouseMove={() => {
          onPreview(manageIndex);
        }}
        onClick={onManageWorkflows}
      >
        <SlashQuietRowContent icon={<Settings2 size={16} aria-hidden />}>
          {t(($) => {
            return $.chat.composer.workflows.manage;
          })}
        </SlashQuietRowContent>
      </Link>
    </>
  );
}

function SlashPanelWorkflowSection({
  collapseWorkflows,
  onExpandWorkflows,
  showWorkflowActions,
  onNewWorkflow,
  onManageWorkflows,
  workflows,
  ...listProps
}: ComponentProps<typeof SlashPanelWorkflowList> &
  Pick<
    SlashTemplatePanelProps,
    | "collapseWorkflows"
    | "onExpandWorkflows"
    | "showWorkflowActions"
    | "onNewWorkflow"
    | "onManageWorkflows"
  >) {
  const { t } = useTranslation();
  if (!listProps.loading && workflows.length === 0) {
    return null;
  }
  const hasCollapsedWorkflows =
    collapseWorkflows &&
    workflows.length > SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT;
  const visibleWorkflows = hasCollapsedWorkflows
    ? workflows.slice(0, SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT)
    : workflows;
  return (
    <div>
      <SectionLabel>
        {t(($) => {
          return $.chat.composer.workflows.title;
        })}
      </SectionLabel>
      <SlashPanelWorkflowList {...listProps} workflows={visibleWorkflows} />
      {/*
        The control sits directly beneath the rows it continues, in the
        position the first revealed row takes. Arrow keys select it without
        expanding; activation reveals the rest.
      */}
      {(hasCollapsedWorkflows || showWorkflowActions) && (
        <div className="px-1">
          {hasCollapsedWorkflows && (
            <SlashPanelShowMore
              id={listProps.workflowOptionId(SLASH_PANEL_SHOW_MORE_ID)}
              index={SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT}
              hiddenCount={
                workflows.length - SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT
              }
              marked={
                listProps.markedIndex === SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT
              }
              onPreview={listProps.onPreview}
              onExpand={onExpandWorkflows}
            />
          )}
          {showWorkflowActions && (
            <SlashPanelWorkflowActions
              index={workflows.length}
              markedIndex={listProps.markedIndex}
              onPreview={listProps.onPreview}
              onNewWorkflow={onNewWorkflow}
              onManageWorkflows={onManageWorkflows}
              workflowOptionId={listProps.workflowOptionId}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SlashPanelCategoryList({
  categories,
  markedIndex,
  selectedIndex,
  reversed,
  onPreview,
  onSelectCategory,
  categoryOptionId,
}: Pick<
  SlashTemplatePanelProps,
  | "categories"
  | "selectedIndex"
  | "reversed"
  | "onPreview"
  | "onSelectCategory"
  | "categoryOptionId"
> & { readonly markedIndex: number }) {
  const { t } = useTranslation();
  if (categories.length === 0) {
    return null;
  }
  return (
    <div>
      <SectionLabel>
        {t(($) => {
          return $.chat.composer.slashPanel.make;
        })}
      </SectionLabel>
      <div className="px-1">
        {(reversed ? [...categories].reverse() : categories).map(
          (category, visualIndex) => {
            const index = reversed
              ? categories.length - 1 - visualIndex
              : visualIndex;
            const Icon = SLASH_TEMPLATE_CATEGORY_ICONS[category];
            const label = slashTemplateCategoryLabel(category);
            return (
              <button
                key={category}
                id={categoryOptionId(category)}
                ref={
                  selectedIndex === index
                    ? scrollSelectedSlashOptionOnMount
                    : undefined
                }
                type="button"
                aria-label={label}
                data-active={markedIndex === index ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors",
                  markedIndex === index
                    ? SLASH_ROW_MARKED
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
          },
        )}
      </div>
    </div>
  );
}

export function slashActionOptionId(id: string): string {
  return `action-${id}`;
}

/** A command reads like GPT's: its name, then what it does, quieter. */
export function SlashActionRow({
  action,
  index,
  marked,
  scrollOnMount = false,
  expanded,
  onOpen,
  onPreview,
}: {
  readonly action: SlashAction;
  readonly index: number;
  readonly marked: boolean;
  /** Bring the keyboard's row into view when the list opens on it. */
  readonly scrollOnMount?: boolean;
  /**
   * Whether the second level this row opens is showing. Set only where the
   * row opens one, which also draws its chevron.
   */
  readonly expanded?: boolean;
  /** Opens the second level instead of running the action. */
  readonly onOpen?: () => void;
  readonly onPreview: (index: number) => void;
}) {
  const { Icon } = action;
  return (
    <button
      id={slashWorkflowOptionId(slashActionOptionId(action.id))}
      ref={scrollOnMount ? scrollSelectedSlashOptionOnMount : undefined}
      type="button"
      aria-expanded={expanded}
      data-active={marked ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors",
        marked ? SLASH_ROW_MARKED : "hover:bg-state-hover",
      )}
      onMouseMove={() => {
        onPreview(index);
      }}
      onClick={onOpen ?? action.run}
    >
      <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {action.label}
        {action.hint && (
          <>
            {" "}
            <span className="ml-1 text-[13px] text-muted-foreground/50">
              {action.hint}
            </span>
          </>
        )}
      </span>
      {expanded !== undefined && (
        <ChevronRight
          size={16}
          // Points at the second level, which opens on the left at the end
          // edge of the slash-actions overview.
          className="shrink-0 text-muted-foreground/50 group-data-[side=end]/slash-panel:-scale-x-100"
          aria-hidden
        />
      )}
    </button>
  );
}

function SlashPanelActionList({
  actions,
  firstIndex,
  markedIndex,
  selectedIndex,
  reversed,
  onPreview,
}: Pick<
  SlashTemplatePanelProps,
  "actions" | "selectedIndex" | "reversed" | "onPreview"
> & {
  /** Where the first action sits in the shared suggestion index. */
  readonly firstIndex: number;
  readonly markedIndex: number;
}) {
  const { t } = useTranslation();
  if (actions.length === 0) {
    return null;
  }
  return (
    <div>
      <SectionLabel>
        {t(($) => {
          return $.chat.composer.slashActions.actions;
        })}
      </SectionLabel>
      <div className="px-1">
        {(reversed ? [...actions].reverse() : actions).map(
          (action, visualIndex) => {
            const index =
              firstIndex +
              (reversed ? actions.length - 1 - visualIndex : visualIndex);
            return (
              <SlashActionRow
                key={action.id}
                action={action}
                index={index}
                marked={markedIndex === index}
                scrollOnMount={selectedIndex === index}
                onPreview={onPreview}
              />
            );
          },
        )}
      </div>
    </div>
  );
}

function SlashPanelBrowseAll({
  onBrowseAll,
}: Pick<SlashTemplatePanelProps, "onBrowseAll">) {
  const { t } = useTranslation();
  // This is one more row of the list: no gap above it, and the
  // scroller's 4px below it matches the 4px inset at the sides.
  return (
    <div className="px-1">
      {/*
        Full width like the rows above it, so its hover fill has the same shape
        as theirs instead of a pill around the label.
      */}
      <button
        type="button"
        data-slot="slash-browse-all"
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        onClick={onBrowseAll}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <LayoutGrid size={14} strokeWidth={1.6} aria-hidden />
        </span>
        <span className="min-w-0 truncate">
          {t(($) => {
            return $.chat.composer.slashPanel.browseAll;
          })}
        </span>
        <ChevronRight
          size={16}
          className="ml-auto shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      </button>
    </div>
  );
}

export function SlashTemplatePanel({
  categories,
  actions,
  workflows,
  workflowsLoading,
  collapseWorkflows,
  onExpandWorkflows,
  expandedHeight,
  showWorkflowActions,
  onNewWorkflow,
  onManageWorkflows,
  reversed,
  reverseWorkflows,
  selectedIndex,
  previewIndex,
  onPreview,
  onSelectCategory,
  onSelectTemplate,
  onSelectWorkflow,
  onBrowseAll,
  workflowOptionId,
  categoryOptionId,
}: SlashTemplatePanelProps) {
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  // Keep the mark on the previewed row while the pointer crosses into its
  // preview. Keyboard navigation or leaving the panel restores the keyboard
  // selection and its preview together.
  const markedIndex = previewIndex ?? selectedIndex;
  // A workflow row indexes past the categories, so it previews nothing and the
  // preview closes.
  const detailCategory = categories[markedIndex] ?? null;
  // The list owns the menu height and the covers fill it, so a query that
  // leaves one type and no workflow would be shorter than one row of covers.
  // The floor follows whether any type can be previewed, not the marked row:
  // the menu grows upward from the composer, so a height that changed with the
  // pointer would move the row under it.
  const previewFloor = isDesktop && categories.length > 0;
  const makeSection = (
    <SlashPanelCategoryList
      key="make"
      categories={categories}
      markedIndex={markedIndex}
      selectedIndex={selectedIndex}
      reversed={reversed}
      onPreview={onPreview}
      onSelectCategory={onSelectCategory}
      categoryOptionId={categoryOptionId}
    />
  );
  const actionSection = (
    <SlashPanelActionList
      key="actions"
      actions={actions}
      firstIndex={categories.length}
      markedIndex={markedIndex}
      selectedIndex={selectedIndex}
      reversed={reversed}
      onPreview={onPreview}
    />
  );
  const headCount = categories.length + actions.length;
  const workflowSection = (
    <SlashPanelWorkflowSection
      key="workflows"
      workflows={workflows}
      loading={workflowsLoading}
      collapseWorkflows={collapseWorkflows}
      onExpandWorkflows={onExpandWorkflows}
      showWorkflowActions={showWorkflowActions}
      onNewWorkflow={onNewWorkflow}
      onManageWorkflows={onManageWorkflows}
      markedIndex={markedIndex - headCount}
      selectedIndex={selectedIndex - headCount}
      reversed={reverseWorkflows}
      onPreview={(index) => {
        onPreview(headCount + index);
      }}
      onSelect={onSelectWorkflow}
      workflowOptionId={workflowOptionId}
    />
  );
  return (
    <div
      className={cn(
        "group/slash-panel flex w-full flex-row overflow-hidden",
        // One full row of covers with their titles, and the top of the next so
        // the pane reads as scrollable. Capped like the menu, so a short
        // viewport still scrolls the list instead of clipping its last rows.
        previewFloor ? "min-h-[min(11rem,var(--available-height))]" : "min-h-0",
        // Revealing the rest of the workflows keeps the menu's height, so the
        // menu never grows away from the composer and moves the row that was
        // clicked; the revealed rows scroll inside instead.
        expandedHeight !== null && "h-(--slash-panel-expanded-height)",
      )}
      data-slot="slash-panel"
      style={
        expandedHeight === null
          ? undefined
          : ({
              "--slash-panel-expanded-height": `${String(expandedHeight)}px`,
            } as CSSProperties)
      }
      onMouseLeave={() => {
        onPreview(null);
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/*
          Each section's label carries the space above it. Every row shares one
          scroller, so revealing the rest of the workflows adds no nested
          scrolling region.
        */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-1">
          {reversed
            ? [workflowSection, actionSection, makeSection]
            : [makeSection, actionSection, workflowSection]}
          <SlashPanelBrowseAll onBrowseAll={onBrowseAll} />
        </div>
      </div>
      {detailCategory !== null && isDesktop && (
        <SlashTemplateDetailPane
          category={detailCategory}
          onSelectTemplate={onSelectTemplate}
        />
      )}
    </div>
  );
}
