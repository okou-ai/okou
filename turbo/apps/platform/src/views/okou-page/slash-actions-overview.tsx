// The slash overview when the slash-actions switch is on: chat actions first,
// then Workflows and Templates as single rows whose lists open as the second
// level in the menu's right half, where template covers already appear.
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Plus,
  Route,
  Settings2,
  SwatchBook,
  type LucideIcon,
} from "lucide-react";
import { cn, useMediaQuery } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type {
  ComposerSlashWorkflow,
  ComposerSlashWorkflowMatch,
} from "../../signals/okou-page/workflow-composer-domain.ts";
import {
  setSlashTemplateTab$,
  slashTemplateTab$,
} from "../../signals/okou-page/slash-actions.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import { SlashWorkflowName, slashWorkflowOptionId } from "./slash-workflow.tsx";
import {
  SLASH_PANEL_MANAGE_WORKFLOWS_ID,
  SLASH_PANEL_NEW_WORKFLOW_ID,
  SLASH_ROW_MARKED,
  SlashActionRow,
  SlashTemplateCovers,
  slashActionOptionId,
  slashTemplateCategoryLabel,
  useSlashTemplateCount,
} from "./slash-template-panel.tsx";
import type {
  SlashTemplateCategory,
  SlashTemplatePreview,
} from "./composer-template-catalog.ts";
import {
  type SlashAction,
  slashActionMatches,
  useSlashActions,
  useSlashActionsEnabled,
} from "./slash-actions.ts";

const WORKFLOWS_ENTRY_ID = "workflows-entry";
const TEMPLATES_ENTRY_ID = "templates-entry";

/**
 * Where each row sits in the editor's shared suggestion index: the actions,
 * the Workflows and Templates entries, then the workflow list the first one
 * opens with its New workflow and Manage workflows rows.
 */
function slashActionsLayout(actionCount: number, workflowCount: number) {
  const workflowsEntry = actionCount;
  const firstWorkflow = workflowsEntry + 2;
  return {
    workflowsEntry,
    templatesEntry: workflowsEntry + 1,
    firstWorkflow,
    newWorkflow: firstWorkflow + workflowCount,
    manageWorkflows: firstWorkflow + workflowCount + 1,
  };
}

type SlashActionsLayout = ReturnType<typeof slashActionsLayout>;

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, offset) => {
    return from + offset;
  });
}

export interface SlashActionsOverview {
  readonly actions: readonly SlashAction[];
  readonly layout: SlashActionsLayout;
  /** Keyboard order: the first level, or the workflow list once entered. */
  readonly order: readonly number[];
  readonly select: (index: number) => void;
  readonly scrollTarget: (index: number) => { readonly id: string };
  /** Right enters the workflow list from its entry, Left leaves it. */
  readonly cross: (direction: 1 | -1) => boolean;
  readonly openWorkflows: () => void;
  readonly closeWorkflows: () => void;
}

function useSlashActionsOverview({
  composer,
  actions,
  workflows,
  selectedIndex,
  insertWorkflow,
  newWorkflow,
  manageWorkflows,
  browseTemplates,
}: {
  readonly composer: ComposerSignals;
  readonly actions: readonly SlashAction[];
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly selectedIndex: number;
  readonly insertWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly newWorkflow: () => void;
  readonly manageWorkflows: () => void;
  readonly browseTemplates: () => void;
}): SlashActionsOverview {
  const setSelectedIndex = useSet(
    composer.suggestion.setSelectedSuggestionIndex$,
  );
  const layout = slashActionsLayout(actions.length, workflows.length);
  const inList = selectedIndex >= layout.firstWorkflow;
  function scrollTarget(index: number): { readonly id: string } {
    const action = actions.at(index);
    if (index < layout.workflowsEntry && action) {
      return { id: slashActionOptionId(action.id) };
    }
    if (index === layout.workflowsEntry) {
      return { id: WORKFLOWS_ENTRY_ID };
    }
    if (index === layout.templatesEntry) {
      return { id: TEMPLATES_ENTRY_ID };
    }
    if (index === layout.newWorkflow) {
      return { id: SLASH_PANEL_NEW_WORKFLOW_ID };
    }
    if (index === layout.manageWorkflows) {
      return { id: SLASH_PANEL_MANAGE_WORKFLOWS_ID };
    }
    return { id: workflows[index - layout.firstWorkflow]?.id ?? "" };
  }
  function moveSelection(index: number): void {
    // Clicking a row that keeps the menu open focuses that button, but the
    // editor owns the menu's keyboard navigation. Hand focus back without
    // moving the caret, which still closes the slash token.
    composer.editor.editor.view.focus();
    setSelectedIndex(index);
    const option = document.getElementById(
      slashWorkflowOptionId(scrollTarget(index).id),
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }
  const openWorkflows = () => {
    moveSelection(layout.firstWorkflow);
  };
  const closeWorkflows = () => {
    moveSelection(layout.workflowsEntry);
  };
  return {
    actions,
    layout,
    // Up from the first workflow returns to its entry.
    order: inList
      ? [
          layout.workflowsEntry,
          ...range(layout.firstWorkflow, layout.manageWorkflows + 1),
        ]
      : range(0, layout.templatesEntry + 1),
    select(index) {
      if (index < layout.workflowsEntry) {
        actions.at(index)?.run();
      } else if (index === layout.workflowsEntry) {
        openWorkflows();
      } else if (index === layout.templatesEntry) {
        browseTemplates();
      } else if (index === layout.newWorkflow) {
        newWorkflow();
      } else if (index === layout.manageWorkflows) {
        manageWorkflows();
      } else {
        const workflow = workflows[index - layout.firstWorkflow];
        if (workflow) {
          insertWorkflow(workflow);
        }
      }
    },
    scrollTarget,
    cross(direction) {
      if (direction > 0 && selectedIndex === layout.workflowsEntry) {
        openWorkflows();
        return true;
      }
      if (direction < 0 && inList) {
        closeWorkflows();
        return true;
      }
      return false;
    },
    openWorkflows,
    closeWorkflows,
  };
}

function rowState(marked: boolean): string {
  return marked ? SLASH_ROW_MARKED : "hover:bg-state-hover";
}

const ROW =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-foreground transition-colors";

/**
 * A row whose list opens as the second level. The count shares the label's
 * line, so both sit on one baseline.
 */
function SlashEntryRow({
  id,
  Icon,
  label,
  count,
  index,
  marked,
  open,
  onPreview,
  onOpen,
}: {
  readonly id: string;
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  readonly index: number;
  readonly marked: boolean;
  readonly open: boolean;
  readonly onPreview: (index: number) => void;
  readonly onOpen: () => void;
}) {
  return (
    <button
      id={slashWorkflowOptionId(id)}
      type="button"
      aria-expanded={open}
      data-active={marked ? "true" : undefined}
      className={cn(ROW, rowState(marked))}
      onMouseMove={() => {
        onPreview(index);
      }}
      onClick={onOpen}
    >
      <Icon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {label}{" "}
        {/* The space keeps the two apart in the row's accessible name. */}
        <span className="ml-0.5 text-muted-foreground/50">{count}</span>
      </span>
      <ChevronRight
        size={16}
        className="shrink-0 text-muted-foreground/50"
        aria-hidden
      />
    </button>
  );
}

const QUIET_ROW =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors";

function quietRowState(marked: boolean): string {
  return marked
    ? cn(SLASH_ROW_MARKED, "text-foreground")
    : "text-muted-foreground hover:bg-state-hover hover:text-foreground";
}

function QuietRowContent({
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

interface WorkflowListProps {
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly loading: boolean;
  readonly layout: SlashActionsLayout;
  readonly markedIndex: number;
  readonly onPreview: (index: number) => void;
  readonly onSelect: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly onNewWorkflow: () => void;
  /** Runs before the Manage workflows link navigates. */
  readonly onManageWorkflows: () => void;
}

/** A workflow in the second level: its name, then its description below. */
function WorkflowListRow({
  workflow,
  index,
  marked,
  onPreview,
  onSelect,
}: {
  readonly workflow: ComposerSlashWorkflowMatch;
  readonly index: number;
  readonly marked: boolean;
  readonly onPreview: (index: number) => void;
  readonly onSelect: (workflow: ComposerSlashWorkflowMatch) => void;
}) {
  return (
    <button
      id={slashWorkflowOptionId(workflow.id)}
      type="button"
      data-active={marked ? "true" : undefined}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left transition-colors",
        rowState(marked),
      )}
      onMouseMove={() => {
        onPreview(index);
      }}
      onClick={() => {
        onSelect(workflow);
      }}
    >
      {/* Centred on the name's 20px line rather than on the whole row. */}
      <Route
        size={16}
        className="mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <SlashWorkflowName workflow={workflow} className="text-[13px]/5" />
        {workflow.description && (
          <>
            {" "}
            <span className="truncate text-xs/4 text-muted-foreground">
              {workflow.description}
            </span>
          </>
        )}
      </span>
    </button>
  );
}

/** The list scrolls from the pane's top edge down to its footer. */
function WorkflowListBody({
  workflows,
  loading,
  layout,
  markedIndex,
  onPreview,
  onSelect,
  children,
}: WorkflowListProps & { readonly children?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-1"
      data-slot="slash-workflow-list"
    >
      {children}
      {loading ? (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.composer.workflows.loading;
          })}
        </div>
      ) : workflows.length === 0 ? (
        <div className="px-2 py-1.5 text-[13px] text-muted-foreground">
          {t(($) => {
            return $.workflows.list.noWorkflows;
          })}
        </div>
      ) : (
        workflows.map((workflow, offset) => {
          const index = layout.firstWorkflow + offset;
          return (
            <WorkflowListRow
              key={workflow.id}
              workflow={workflow}
              index={index}
              marked={markedIndex === index}
              onPreview={onPreview}
              onSelect={onSelect}
            />
          );
        })
      )}
    </div>
  );
}

/** Stays put under the list: the two things to do besides picking one. */
function WorkflowListFooter({
  layout,
  markedIndex,
  onPreview,
  onNewWorkflow,
  onManageWorkflows,
}: WorkflowListProps) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 border-t border-border/60 p-1">
      <button
        id={slashWorkflowOptionId(SLASH_PANEL_NEW_WORKFLOW_ID)}
        type="button"
        data-active={markedIndex === layout.newWorkflow ? "true" : undefined}
        className={cn(
          QUIET_ROW,
          quietRowState(markedIndex === layout.newWorkflow),
        )}
        onMouseMove={() => {
          onPreview(layout.newWorkflow);
        }}
        onClick={onNewWorkflow}
      >
        <QuietRowContent icon={<Plus size={16} aria-hidden />}>
          {t(($) => {
            return $.chat.composer.workflows.newWorkflow;
          })}
        </QuietRowContent>
      </button>
      <Link
        id={slashWorkflowOptionId(SLASH_PANEL_MANAGE_WORKFLOWS_ID)}
        pathname={ROUTES.workflows}
        data-active={
          markedIndex === layout.manageWorkflows ? "true" : undefined
        }
        className={cn(
          QUIET_ROW,
          quietRowState(markedIndex === layout.manageWorkflows),
        )}
        onMouseMove={() => {
          onPreview(layout.manageWorkflows);
        }}
        onClick={onManageWorkflows}
      >
        <QuietRowContent icon={<Settings2 size={16} aria-hidden />}>
          {t(($) => {
            return $.chat.composer.workflows.manage;
          })}
        </QuietRowContent>
      </Link>
    </div>
  );
}

const PANE =
  "relative w-[400px] max-w-1/2 shrink-0 overflow-hidden border-l border-border/60";

function WorkflowPane(props: WorkflowListProps) {
  const { t } = useTranslation();
  return (
    <div
      className={PANE}
      role="region"
      aria-label={t(($) => {
        return $.chat.composer.workflows.title;
      })}
      data-slot="slash-workflow-detail"
    >
      {/* The list scrolls within the height the first level sets. */}
      <div className="absolute inset-0 flex flex-col">
        <WorkflowListBody {...props} />
        <WorkflowListFooter {...props} />
      </div>
    </div>
  );
}

/** Without room for the pane, the list replaces the first level. */
function WorkflowPage({
  onBack,
  ...props
}: WorkflowListProps & { readonly onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="slash-workflow-detail"
    >
      <WorkflowListBody {...props}>
        <button
          type="button"
          aria-label={t(($) => {
            return $.chat.composer.slashActions.back;
          })}
          className={cn(ROW, "hover:bg-state-hover")}
          onClick={onBack}
        >
          <ChevronLeft
            size={16}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate">
            {t(($) => {
              return $.chat.composer.workflows.title;
            })}
          </span>
        </button>
      </WorkflowListBody>
      <WorkflowListFooter {...props} />
    </div>
  );
}

/**
 * The Templates entry's second level: one type at a time, each named with its
 * count; pointing at a type shows its covers.
 */
function TemplatesPane({
  categories,
  templateCount,
  onSelectTemplate,
  onBrowseAll,
}: {
  readonly categories: readonly SlashTemplateCategory[];
  /** The panel's counts, so a type reads the same number as its entry. */
  readonly templateCount: (category: SlashTemplateCategory) => number;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly onBrowseAll: () => void;
}) {
  const { t } = useTranslation();
  const tab = useGet(slashTemplateTab$);
  const setTab = useSet(setSlashTemplateTab$);
  const active =
    categories.find((category) => {
      return category === tab;
    }) ?? categories[0];
  if (active === undefined) {
    return null;
  }
  return (
    <div
      className={PANE}
      role="region"
      aria-label={t(($) => {
        return $.chat.composer.slashActions.templates;
      })}
      data-slot="slash-templates-detail"
      data-category={active}
    >
      <div className="absolute inset-0 flex flex-col">
        <div className="flex shrink-0 gap-0.5 overflow-hidden p-1">
          {categories.map((category) => {
            return (
              <button
                key={category}
                type="button"
                aria-pressed={category === active}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center rounded-md px-1.5 text-xs transition-colors",
                  category === active
                    ? "bg-state-selected text-foreground"
                    : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
                )}
                onMouseMove={() => {
                  setTab(category);
                }}
                onClick={() => {
                  setTab(category);
                }}
              >
                {slashTemplateCategoryLabel(category)}{" "}
                <span className="text-muted-foreground/50">
                  {templateCount(category)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="relative min-h-0 flex-1" key={active}>
          <SlashTemplateCovers
            category={active}
            onSelectTemplate={onSelectTemplate}
          />
        </div>
        <div className="shrink-0 border-t border-border/60 p-1">
          <button
            type="button"
            data-slot="slash-browse-all"
            className={cn(QUIET_ROW, quietRowState(false))}
            onClick={onBrowseAll}
          >
            <QuietRowContent
              icon={<LayoutGrid size={14} strokeWidth={1.6} aria-hidden />}
            >
              {t(($) => {
                return $.chat.composer.slashPanel.browseAll;
              })}
            </QuietRowContent>
            <ChevronRight
              size={16}
              className="ml-auto shrink-0 text-muted-foreground/50"
              aria-hidden
            />
          </button>
        </div>
      </div>
    </div>
  );
}

export function SlashActionsPanel({
  overview,
  workflows,
  workflowsLoading,
  categories,
  selectedIndex,
  previewIndex,
  onPreview,
  onSelectWorkflow,
  onSelectTemplate,
  onBrowseAll,
  onNewWorkflow,
  onManageWorkflows,
}: {
  readonly overview: SlashActionsOverview;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly workflowsLoading: boolean;
  readonly categories: readonly SlashTemplateCategory[];
  readonly selectedIndex: number;
  readonly previewIndex: number | null;
  readonly onPreview: (index: number | null) => void;
  readonly onSelectWorkflow: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly onSelectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly onBrowseAll: () => void;
  readonly onNewWorkflow: () => void;
  readonly onManageWorkflows: () => void;
}) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const templateCount = useSlashTemplateCount();
  const { actions, layout } = overview;
  // The pointer owns the mark while it is inside the panel; the keyboard's
  // selection shows otherwise.
  const markedIndex = previewIndex ?? selectedIndex;
  // The entry and everything it opens index past it, so each of them keeps
  // the workflow list open.
  const workflowsOpen =
    markedIndex === layout.workflowsEntry ||
    markedIndex >= layout.firstWorkflow;
  const templatesOpen = markedIndex === layout.templatesEntry;
  const list: WorkflowListProps = {
    workflows,
    loading: workflowsLoading,
    layout,
    markedIndex,
    onPreview,
    onSelect: onSelectWorkflow,
    onNewWorkflow,
    onManageWorkflows,
  };
  const panelProps = {
    className: "group/slash-panel flex min-h-0 w-full overflow-hidden",
    "data-slot": "slash-panel",
    onMouseLeave: () => {
      onPreview(null);
    },
  };
  if (!isDesktop && selectedIndex >= layout.firstWorkflow) {
    return (
      <div {...panelProps}>
        <WorkflowPage {...list} onBack={overview.closeWorkflows} />
      </div>
    );
  }
  const templateTotal = categories.reduce((total, category) => {
    return total + templateCount(category);
  }, 0);
  return (
    <div {...panelProps}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No heading: the rows name themselves. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {actions.map((action, index) => {
            return (
              <SlashActionRow
                key={action.id}
                action={action}
                index={index}
                marked={markedIndex === index}
                onPreview={onPreview}
              />
            );
          })}
          <SlashEntryRow
            id={WORKFLOWS_ENTRY_ID}
            Icon={Route}
            label={t(($) => {
              return $.chat.composer.workflows.title;
            })}
            count={workflows.length}
            index={layout.workflowsEntry}
            marked={workflowsOpen}
            open={workflowsOpen && isDesktop}
            onPreview={onPreview}
            onOpen={overview.openWorkflows}
          />
          {categories.length > 0 && (
            <SlashEntryRow
              id={TEMPLATES_ENTRY_ID}
              Icon={SwatchBook}
              label={t(($) => {
                return $.chat.composer.slashActions.templates;
              })}
              count={templateTotal}
              index={layout.templatesEntry}
              marked={templatesOpen}
              open={templatesOpen && isDesktop}
              onPreview={onPreview}
              onOpen={onBrowseAll}
            />
          )}
        </div>
      </div>
      {isDesktop && workflowsOpen && <WorkflowPane {...list} />}
      {isDesktop && templatesOpen && (
        <TemplatesPane
          categories={categories}
          templateCount={templateCount}
          onSelectTemplate={onSelectTemplate}
          onBrowseAll={onBrowseAll}
        />
      )}
    </div>
  );
}

export interface SlashActionsMenu {
  /** The overview's model while the token is bare; null otherwise. */
  readonly overview: SlashActionsOverview | null;
  /** The actions a typed query names, listed beside its other matches. */
  readonly searchActions: readonly SlashAction[];
}

/**
 * The slash-actions half of the menu. With the switch off both parts are
 * empty, so the existing panel and its navigation apply unchanged.
 */
export function useSlashActionsMenu({
  composer,
  query,
  workflows,
  panel,
}: {
  readonly composer: ComposerSignals;
  /** The typed slash query; undefined while no slash token is active. */
  readonly query: string | undefined;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly panel: {
    readonly leave: () => void;
    readonly newWorkflow: () => void;
    readonly manageWorkflows: () => void;
    readonly browseAll: () => void;
  };
}): SlashActionsMenu {
  const enabled = useSlashActionsEnabled();
  const selectedIndex = useGet(composer.suggestion.selectedSuggestionIndex$);
  const insertWorkflow = useSet(composer.workflow.insertWorkflow$);
  const actions = useSlashActions(composer, panel.leave);
  const overview = useSlashActionsOverview({
    composer,
    actions,
    workflows,
    selectedIndex,
    insertWorkflow,
    newWorkflow: panel.newWorkflow,
    manageWorkflows: panel.manageWorkflows,
    browseTemplates: panel.browseAll,
  });
  if (!enabled || query === undefined) {
    return { overview: null, searchActions: [] };
  }
  if (query === "") {
    return { overview, searchActions: [] };
  }
  return {
    overview: null,
    searchActions: actions.filter((action) => {
      return slashActionMatches(action, query);
    }),
  };
}
