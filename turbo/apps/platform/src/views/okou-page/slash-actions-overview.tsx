// The slash overview when the slash-actions switch is on: chat actions first,
// then Workflows and Templates as single rows whose lists open as the second
// level in the menu's right half, where template covers already appear.
import { useGet, useSet } from "ccstate-react";
import type { ReactNode } from "react";
import {
  Check,
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
import type { SlashMenuSide } from "../../signals/okou-page/tiptap-workflow-composer.ts";
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
import { ModelFirstRunModelRowContent } from "./components/model-provider-picker.tsx";
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
  type SlashSubmenu,
  type SlashSubmenuItem,
  slashActionMatches,
  useSlashActions,
  useSlashActionsEnabled,
} from "./slash-actions.ts";

const WORKFLOWS_ENTRY_ID = "workflows-entry";
const TEMPLATES_ENTRY_ID = "templates-entry";

/** The indexes one action's second level takes, after the first level. */
interface SubmenuRange {
  readonly entry: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Where each row sits in the editor's shared suggestion index: the actions,
 * the Workflows and Templates entries, then each action's second level in
 * turn, then the workflow list with its New workflow and Manage workflows rows.
 */
function slashActionsLayout(
  actions: readonly SlashAction[],
  workflowCount: number,
) {
  const workflowsEntry = actions.length;
  const templatesEntry = workflowsEntry + 1;
  let next = templatesEntry + 1;
  const submenus: SubmenuRange[] = [];
  for (const [entry, action] of actions.entries()) {
    if (action.submenu) {
      const size =
        action.submenu.items.length + (action.submenu.footer ? 1 : 0);
      submenus.push({ entry, start: next, end: next + size });
      next += size;
    }
  }
  const firstWorkflow = next;
  return {
    workflowsEntry,
    templatesEntry,
    submenus,
    firstWorkflow,
    newWorkflow: firstWorkflow + workflowCount,
    manageWorkflows: firstWorkflow + workflowCount + 1,
  };
}

type SlashActionsLayout = ReturnType<typeof slashActionsLayout>;

/** The entry whose second level an index shows: its own, or the one it is in. */
function secondLevelEntry(
  layout: SlashActionsLayout,
  actions: readonly SlashAction[],
  index: number,
): number | null {
  if (index < 0) {
    return null;
  }
  if (index < layout.workflowsEntry) {
    return actions[index]?.submenu ? index : null;
  }
  if (index === layout.workflowsEntry || index >= layout.firstWorkflow) {
    return layout.workflowsEntry;
  }
  if (index === layout.templatesEntry) {
    return layout.templatesEntry;
  }
  return (
    layout.submenus.find((submenu) => {
      return index >= submenu.start && index < submenu.end;
    })?.entry ?? null
  );
}

/** The indexes an entry's second level takes; Templates has none. */
function secondLevelRange(
  layout: SlashActionsLayout,
  entry: number,
): readonly [number, number] | null {
  if (entry === layout.workflowsEntry) {
    return [layout.firstWorkflow, layout.manageWorkflows + 1];
  }
  const submenu = layout.submenus.find((candidate) => {
    return candidate.entry === entry;
  });
  return submenu ? [submenu.start, submenu.end] : null;
}

/** The second-level row an index names, with the action it belongs to. */
function submenuRowAt(
  layout: SlashActionsLayout,
  actions: readonly SlashAction[],
  index: number,
): { readonly action: SlashAction; readonly item: SlashSubmenuItem } | null {
  const range = layout.submenus.find((submenu) => {
    return index >= submenu.start && index < submenu.end;
  });
  const action = range ? actions[range.entry] : undefined;
  if (!range || !action?.submenu) {
    return null;
  }
  const offset = index - range.start;
  const item = action.submenu.items[offset] ?? action.submenu.footer;
  return item ? { action, item } : null;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, offset) => {
    return from + offset;
  });
}

export interface SlashActionsOverview {
  readonly actions: readonly SlashAction[];
  readonly layout: SlashActionsLayout;
  /** Keyboard order: the first level, or a second level once entered. */
  readonly order: readonly number[];
  readonly select: (index: number) => void;
  readonly scrollTarget: (index: number) => { readonly id: string };
  /** Right enters an entry's second level, Left leaves it. */
  readonly cross: (direction: 1 | -1) => boolean;
  /** Moves into the second level of the entry at this index. */
  readonly open: (entry: number) => void;
  /** Returns from a second level to the entry that opened it. */
  readonly back: () => void;
  /**
   * The composer edge the first level hugs on desktop: the half the `/` was
   * typed in. At the end edge the second level opens on the left.
   */
  readonly side: SlashMenuSide;
  /** A ref for the panel, which measures `side` once it mounts. */
  readonly measureSide: (
    element: HTMLElement | null,
  ) => (() => void) | undefined;
}

/** The DOM option an index names, for scrolling it into view. */
function overviewScrollTarget(
  layout: SlashActionsLayout,
  actions: readonly SlashAction[],
  workflows: readonly ComposerSlashWorkflowMatch[],
  index: number,
): { readonly id: string } {
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
  const row = submenuRowAt(layout, actions, index);
  if (row) {
    return { id: slashSubmenuOptionId(row.action.id, row.item.id) };
  }
  if (index === layout.newWorkflow) {
    return { id: SLASH_PANEL_NEW_WORKFLOW_ID };
  }
  if (index === layout.manageWorkflows) {
    return { id: SLASH_PANEL_MANAGE_WORKFLOWS_ID };
  }
  return { id: workflows[index - layout.firstWorkflow]?.id ?? "" };
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
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const measuredSide = useGet(composer.suggestion.slashMenuSide$);
  const measureSide = useSet(composer.suggestion.measureSlashMenuSide$);
  // Narrow screens open second levels in place of the first, at full width.
  const side = isDesktop ? measuredSide : "start";
  // The arrow that points at the second level enters it; the other leaves.
  const enterDirection = side === "end" ? -1 : 1;
  const layout = slashActionsLayout(actions, workflows.length);
  const entry = secondLevelEntry(layout, actions, selectedIndex);
  const opened = entry === null ? null : secondLevelRange(layout, entry);
  const inSecondLevel =
    opened !== null && selectedIndex >= opened[0] && selectedIndex < opened[1];
  function scrollTarget(index: number): { readonly id: string } {
    return overviewScrollTarget(layout, actions, workflows, index);
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
  function open(target: number): void {
    const second = secondLevelRange(layout, target);
    if (second && second[1] > second[0]) {
      moveSelection(second[0]);
    }
  }
  function back(): void {
    if (entry !== null) {
      moveSelection(entry);
    }
  }
  function selectSecondLevel(index: number): void {
    const row = submenuRowAt(layout, actions, index);
    if (row) {
      if (!row.item.disabled) {
        row.item.run();
      }
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
  }
  return {
    actions,
    layout,
    // Up from the first row of a second level returns to its entry.
    order:
      inSecondLevel && entry !== null
        ? [entry, ...range(opened[0], opened[1])]
        : range(0, layout.templatesEntry + 1),
    select(index) {
      const action = index < layout.workflowsEntry ? actions.at(index) : null;
      if (action) {
        if (action.submenu) {
          open(index);
        } else {
          action.run();
        }
      } else if (index === layout.workflowsEntry) {
        open(index);
      } else if (index === layout.templatesEntry) {
        browseTemplates();
      } else {
        selectSecondLevel(index);
      }
    },
    scrollTarget,
    cross(direction) {
      if (direction !== enterDirection) {
        if (inSecondLevel) {
          back();
          return true;
        }
        return false;
      }
      if (
        !inSecondLevel &&
        entry !== null &&
        entry === selectedIndex &&
        entry !== layout.templatesEntry
      ) {
        open(entry);
        return true;
      }
      return false;
    },
    open,
    back,
    side,
    measureSide,
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
        // Points at the second level, which opens on the left at the end edge.
        className="shrink-0 text-muted-foreground/50 group-data-[side=end]/slash-panel:-scale-x-100"
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

// The popover's own surface. On desktop the popover is a bare positioning box
// holding two cards, so each card states it.
const SLASH_CARD =
  "rounded-xl border border-[hsl(var(--gray-400))] bg-card text-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)]";

// The first level keeps one width, so opening a second level beside it moves
// none of its rows or arrows.
const FIRST_LEVEL_CARD = cn(
  "pointer-events-auto w-[368px] max-w-1/2 shrink-0 overflow-hidden",
  SLASH_CARD,
);

// A second level's card fills the column beside the first level and takes its
// height, so whatever it lists scrolls inside rather than growing the menu.
// Its 6px gap faces the first level, on whichever side that is.
const PANE = cn(
  "absolute inset-y-0 right-0 left-1.5 overflow-hidden group-data-[side=end]/slash-panel:right-1.5 group-data-[side=end]/slash-panel:left-0",
  SLASH_CARD,
);

/**
 * The column a second level opens in. The 6px gap is its own inset, so the
 * pointer crossing from the first level never leaves the panel.
 */
function SlashFlyout({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="pointer-events-auto relative min-w-0 flex-1"
      data-slot="slash-flyout"
    >
      {children}
    </div>
  );
}

function BackRow({
  label,
  onBack,
}: {
  readonly label: string;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
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
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

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
        <BackRow
          label={t(($) => {
            return $.chat.composer.workflows.title;
          })}
          onBack={onBack}
        />
      </WorkflowListBody>
      <WorkflowListFooter {...props} />
    </div>
  );
}

export function slashSubmenuOptionId(actionId: string, itemId: string) {
  return `submenu-${actionId}-${itemId}`;
}

interface SubmenuListProps {
  readonly action: SlashAction;
  readonly submenu: SlashSubmenu;
  /** Where the submenu's first row sits in the shared suggestion index. */
  readonly start: number;
  readonly markedIndex: number;
  readonly onPreview: (index: number) => void;
}

function SubmenuRow({
  actionId,
  item,
  index,
  marked,
  onPreview,
}: {
  readonly actionId: string;
  readonly item: SlashSubmenuItem;
  readonly index: number;
  readonly marked: boolean;
  readonly onPreview: (index: number) => void;
}) {
  const { Icon } = item;
  return (
    <button
      id={slashWorkflowOptionId(slashSubmenuOptionId(actionId, item.id))}
      type="button"
      disabled={item.disabled}
      aria-current={item.checked ? "true" : undefined}
      data-active={marked ? "true" : undefined}
      className={cn(
        ROW,
        rowState(marked),
        "disabled:pointer-events-none disabled:opacity-50",
      )}
      onMouseMove={() => {
        onPreview(index);
      }}
      onClick={item.run}
    >
      {item.runModel ? (
        <ModelFirstRunModelRowContent
          runModel={item.runModel}
          selected={item.checked === true}
          showSelectedIndicator
        />
      ) : (
        <>
          {Icon && (
            <Icon
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.checked && <Check size={16} className="shrink-0" aria-hidden />}
        </>
      )}
    </button>
  );
}

function SubmenuBody({
  action,
  submenu,
  start,
  markedIndex,
  onPreview,
  children,
}: SubmenuListProps & { readonly children?: ReactNode }) {
  const { footer } = submenu;
  const footerIndex = start + submenu.items.length;
  const FooterIcon = footer?.Icon;
  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-1"
        data-slot="slash-submenu-list"
      >
        {children}
        {submenu.items.map((item, offset) => {
          return (
            <SubmenuRow
              key={item.id}
              actionId={action.id}
              item={item}
              index={start + offset}
              marked={markedIndex === start + offset}
              onPreview={onPreview}
            />
          );
        })}
      </div>
      {footer && (
        <div className="shrink-0 border-t border-border/60 p-1">
          <button
            id={slashWorkflowOptionId(
              slashSubmenuOptionId(action.id, footer.id),
            )}
            type="button"
            data-active={markedIndex === footerIndex ? "true" : undefined}
            className={cn(
              QUIET_ROW,
              quietRowState(markedIndex === footerIndex),
            )}
            onMouseMove={() => {
              onPreview(footerIndex);
            }}
            onClick={footer.run}
          >
            <QuietRowContent
              icon={FooterIcon && <FooterIcon size={16} aria-hidden />}
            >
              {footer.label}
            </QuietRowContent>
          </button>
        </div>
      )}
    </>
  );
}

/** An action's choices, beside the first level. */
function SubmenuPane(props: SubmenuListProps) {
  return (
    <div
      className={PANE}
      role="region"
      aria-label={props.action.label}
      data-slot="slash-submenu-detail"
    >
      <div className="absolute inset-0 flex flex-col">
        <SubmenuBody {...props} />
      </div>
    </div>
  );
}

/** Without room beside the first level, the choices replace it. */
function SubmenuPage({
  onBack,
  ...props
}: SubmenuListProps & { readonly onBack: () => void }) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="slash-submenu-detail"
    >
      <SubmenuBody {...props}>
        <BackRow label={props.action.label} onBack={onBack} />
      </SubmenuBody>
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
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors",
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
                {/* A flex row drops the space, so `gap-1` keeps them apart. */}
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
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const templateCount = useSlashTemplateCount();
  const { actions, layout } = overview;
  // The pointer owns the mark while it is inside the panel; the keyboard's
  // selection shows otherwise. An entry and everything its second level
  // indexes keep that second level open.
  const markedIndex = previewIndex ?? selectedIndex;
  const openEntry = secondLevelEntry(layout, actions, markedIndex);
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
    ref: overview.measureSide,
    // On desktop the cards cast their own shadows past the panel's edges.
    // With the `/` in the composer's right half, the first level hugs the
    // right edge and its second level opens on the left.
    className: cn(
      "group/slash-panel flex min-h-0 w-full",
      isDesktop ? "overflow-visible" : "overflow-hidden",
      overview.side === "end" && "flex-row-reverse",
    ),
    "data-slot": "slash-panel",
    "data-side": overview.side,
    onMouseLeave: () => {
      onPreview(null);
    },
  };
  const page = isDesktop
    ? null
    : secondLevelPage({ overview, selectedIndex, list });
  if (page) {
    return <div {...panelProps}>{page}</div>;
  }
  // A type with nothing to show gets no tab, as Document has while built-in
  // documents are off and none of its custom ones exist yet.
  const templateCategories = categories.filter((category) => {
    return templateCount(category) > 0;
  });
  const templateTotal = templateCategories.reduce((total, category) => {
    return total + templateCount(category);
  }, 0);
  const pane = isDesktop
    ? secondLevelPane({
        overview,
        entry: openEntry,
        list,
        templates: (
          <TemplatesPane
            categories={templateCategories}
            templateCount={templateCount}
            onSelectTemplate={onSelectTemplate}
            onBrowseAll={onBrowseAll}
          />
        ),
      })
    : null;
  return (
    <div {...panelProps}>
      <div
        className={cn(
          "flex min-h-0 flex-col",
          isDesktop ? FIRST_LEVEL_CARD : "min-w-0 flex-1",
        )}
      >
        {/* No heading: the rows name themselves. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          <FirstLevelRows
            overview={overview}
            workflowCount={workflows.length}
            templateCount={templateCategories.length > 0 ? templateTotal : null}
            markedIndex={markedIndex}
            openEntry={openEntry}
            showsSecondLevel={isDesktop}
            onPreview={onPreview}
            onBrowseAll={onBrowseAll}
          />
        </div>
      </div>
      {pane && <SlashFlyout>{pane}</SlashFlyout>}
    </div>
  );
}

/**
 * The first level: the actions, then Workflows and Templates. A row that
 * opens a second level stays marked while that level is open.
 */
function FirstLevelRows({
  overview,
  workflowCount,
  templateCount,
  markedIndex,
  openEntry,
  showsSecondLevel,
  onPreview,
  onBrowseAll,
}: {
  readonly overview: SlashActionsOverview;
  readonly workflowCount: number;
  /** Null when no template type has anything to show. */
  readonly templateCount: number | null;
  readonly markedIndex: number;
  readonly openEntry: number | null;
  /** Whether a second level shows beside the first rather than over it. */
  readonly showsSecondLevel: boolean;
  readonly onPreview: (index: number) => void;
  readonly onBrowseAll: () => void;
}) {
  const { t } = useTranslation();
  const { actions, layout } = overview;
  return (
    <>
      {actions.map((action, index) => {
        const opens = action.submenu !== undefined;
        return (
          <SlashActionRow
            key={action.id}
            action={action}
            index={index}
            marked={opens ? openEntry === index : markedIndex === index}
            expanded={
              opens ? showsSecondLevel && openEntry === index : undefined
            }
            onOpen={
              opens
                ? () => {
                    overview.open(index);
                  }
                : undefined
            }
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
        count={workflowCount}
        index={layout.workflowsEntry}
        marked={openEntry === layout.workflowsEntry}
        open={showsSecondLevel && openEntry === layout.workflowsEntry}
        onPreview={onPreview}
        onOpen={() => {
          overview.open(layout.workflowsEntry);
        }}
      />
      {templateCount !== null && (
        <SlashEntryRow
          id={TEMPLATES_ENTRY_ID}
          Icon={SwatchBook}
          label={t(($) => {
            return $.chat.composer.slashActions.templates;
          })}
          count={templateCount}
          index={layout.templatesEntry}
          marked={openEntry === layout.templatesEntry}
          open={showsSecondLevel && openEntry === layout.templatesEntry}
          onPreview={onPreview}
          onOpen={onBrowseAll}
        />
      )}
    </>
  );
}

/** The second level the marked entry opens beside the first, if any. */
function secondLevelPane({
  overview,
  entry,
  list,
  templates,
}: {
  readonly overview: SlashActionsOverview;
  readonly entry: number | null;
  readonly list: WorkflowListProps;
  readonly templates: ReactNode;
}): ReactNode {
  const { actions, layout } = overview;
  if (entry === null) {
    return null;
  }
  if (entry === layout.workflowsEntry) {
    return <WorkflowPane {...list} />;
  }
  if (entry === layout.templatesEntry) {
    return templates;
  }
  const action = actions[entry];
  const range = secondLevelRange(layout, entry);
  return action?.submenu && range ? (
    <SubmenuPane
      action={action}
      submenu={action.submenu}
      start={range[0]}
      markedIndex={list.markedIndex}
      onPreview={list.onPreview}
    />
  ) : null;
}

/**
 * On a narrow screen a second level the keyboard or a tap entered replaces
 * the first level, under a row back to it. Null while the first level shows.
 */
function secondLevelPage({
  overview,
  selectedIndex,
  list,
}: {
  readonly overview: SlashActionsOverview;
  readonly selectedIndex: number;
  readonly list: WorkflowListProps;
}): ReactNode {
  const { actions, layout } = overview;
  const entry = secondLevelEntry(layout, actions, selectedIndex);
  const range = entry === null ? null : secondLevelRange(layout, entry);
  if (
    entry === null ||
    range === null ||
    selectedIndex < range[0] ||
    selectedIndex >= range[1]
  ) {
    return null;
  }
  if (entry === layout.workflowsEntry) {
    return <WorkflowPage {...list} onBack={overview.back} />;
  }
  const action = actions[entry];
  return action?.submenu ? (
    <SubmenuPage
      action={action}
      submenu={action.submenu}
      start={range[0]}
      markedIndex={list.markedIndex}
      onPreview={list.onPreview}
      onBack={overview.back}
    />
  ) : null;
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
