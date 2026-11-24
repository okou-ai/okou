import { LoadingSkeleton } from "../components/loading-skeleton.tsx";
// The slash panel indexes actions and workflows inside slash-workflow.tsx's
// popover shell.
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Route,
  Settings2,
} from "lucide-react";
import { cn } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { SlashWorkflowName, slashWorkflowOptionId } from "./slash-workflow.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import type { ComposerSlashWorkflowMatch } from "../../signals/okou-page/workflow-composer-domain.ts";
import { Link } from "../router/link.tsx";
import type { SlashAction } from "./slash-actions.ts";

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

// The row the pointer or the keyboard has marked.
export const SLASH_ROW_MARKED =
  "bg-state-selected hover:bg-state-selected-hover";

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
  /** The capability and chat actions indexed before the workflows. */
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
  /** Keep overview actions anchored nearest the composer on desktop. */
  readonly reversed: boolean;
  readonly reverseWorkflows: boolean;
  /** Actions precede workflows in the editor's shared suggestion index. */
  readonly selectedIndex: number;
  /** The row the pointer is previewing, or null while the keyboard leads. */
  readonly previewIndex: number | null;
  readonly onPreview: (index: number | null) => void;
  readonly onSelectWorkflow: (workflow: ComposerSlashWorkflowMatch) => void;
  readonly workflowOptionId: (workflowId: string) => string;
}

function SectionLabel({ children }: { readonly children: string }) {
  return (
    <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">
      {children}
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
      <LoadingSkeleton
        label={t(($) => {
          return $.chat.composer.workflows.loading;
        })}
        variant="rows"
        className="px-2 py-1.5"
      />
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
  markedIndex,
  selectedIndex,
  reversed,
  onPreview,
}: Pick<
  SlashTemplatePanelProps,
  "actions" | "selectedIndex" | "reversed" | "onPreview"
> & {
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
            const index = reversed
              ? actions.length - 1 - visualIndex
              : visualIndex;
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

export function SlashTemplatePanel({
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
  onSelectWorkflow,
  workflowOptionId,
}: SlashTemplatePanelProps) {
  // Pointer marking is separate from the keyboard's selected row.
  const markedIndex = previewIndex ?? selectedIndex;
  const actionSection = (
    <SlashPanelActionList
      key="actions"
      actions={actions}
      markedIndex={markedIndex}
      selectedIndex={selectedIndex}
      reversed={reversed}
      onPreview={onPreview}
    />
  );
  const headCount = actions.length;
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
        "group/slash-panel flex min-h-0 w-full flex-row overflow-hidden",
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
            ? [workflowSection, actionSection]
            : [actionSection, workflowSection]}
        </div>
      </div>
    </div>
  );
}
