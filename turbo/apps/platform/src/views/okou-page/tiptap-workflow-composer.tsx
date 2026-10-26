import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { ReactNode } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { Popover, useMediaQuery, type KeyboardEventLike } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import type { ComposerAgentSuggestion } from "../../signals/okou-page/composer-agent-suggestion-domain.ts";
import type { ComposerChatThreadSuggestion } from "../../signals/okou-page/chat-thread-suggestion-domain.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { ComposerMentionSuggestionMenu } from "./chat-thread-suggestion.tsx";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "./sidebar-breakpoint.ts";
import {
  buildComposerSlashWorkflows,
  findWorkflowQueryMatches,
  type ComposerSlashWorkflow,
  type ComposerSlashWorkflowMatch,
} from "../../signals/okou-page/workflow-composer-domain";
import {
  scrollSlashWorkflowIntoView,
  slashWorkflowOptionId,
  SlashWorkflowMenu,
} from "./slash-workflow.tsx";
import {
  SlashActionsPanel,
  useSlashActionsMenu,
  type SlashActionsOverview,
} from "./slash-actions-overview.tsx";
import {
  SlashTemplatePanel,
  SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT,
  SLASH_PANEL_MANAGE_WORKFLOWS_ID,
  SLASH_PANEL_NEW_WORKFLOW_ID,
  SLASH_PANEL_SHOW_MORE_ID,
  slashActionOptionId,
  slashTemplateCategoryLabel,
} from "./slash-template-panel.tsx";
import type { SlashAction } from "./slash-actions.ts";
import {
  SLASH_TEMPLATE_CATEGORIES,
  type SlashTemplateCategory,
  type SlashTemplatePreview,
} from "./composer-template-catalog.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";
import {
  useComposerKeyboard,
  type ComposerActions,
} from "./composer-actions.ts";

import { composerCreatePlaceholder } from "../../signals/okou-page/composer-create.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../signals/chat-page/workflow-prompt-action.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";

function isMacKeyboard(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

function serializeTextblockSegment(
  node: ProseMirrorNode,
  from: number,
  to: number,
): string {
  return node.textBetween(from, to, "\n", (leafNode) => {
    return leafNode.type.name === "hardBreak" ? "\n" : "";
  });
}

function resolveMacControlLineNavigation(
  editor: Editor,
  event: KeyboardEvent,
): number | null {
  if (
    !isMacKeyboard() ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (key !== "a" && key !== "e") {
    return null;
  }
  const { $head } = editor.state.selection;
  const { parent, parentOffset } = $head;
  if (!parent.isTextblock) {
    return null;
  }
  const beforeCaret = serializeTextblockSegment(parent, 0, parentOffset);
  if (key === "a") {
    return $head.start() + beforeCaret.lastIndexOf("\n") + 1;
  }
  const afterCaret = serializeTextblockSegment(
    parent,
    parentOffset,
    parent.content.size,
  );
  const nextBreak = afterCaret.indexOf("\n");
  return (
    $head.start() +
    (nextBreak === -1 ? parent.content.size : parentOffset + nextBreak)
  );
}

function workflowComposerPlaceholder(sending: boolean | undefined): string {
  return sending
    ? i18n.t(($) => {
        return $.workflows.composer.nextMessage;
      })
    : i18n.t(($) => {
        return $.workflows.composer.placeholder;
      });
}

function workflowComposerHasContent(editor: Editor): boolean {
  let textblockCount = 0;
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (!node.isTextblock) {
      continue;
    }
    textblockCount += 1;
    if (node.content.size > 0 || textblockCount > 1) {
      return true;
    }
  }
  return false;
}

function WorkflowComposerPlaceholder({
  composer,
}: {
  composer: ComposerSignals;
}) {
  useTranslation();
  const sending = useLastResolved(composer.submission.sending$);
  const createMode = useGet(composer.create.mode$);
  const hasInput = useGet(composer.editor.hasInput$);
  const hasEditorContent = useEditorState({
    editor: composer.editor.editor,
    selector: ({ editor }) => {
      return workflowComposerHasContent(editor);
    },
  });
  const hasTemplateAttachment = useGet(
    composer.template.hasTemplateAttachment$,
  );
  if (hasInput || hasEditorContent) {
    return null;
  }
  return (
    <div
      className={`pointer-events-none absolute left-0 px-4 text-[0.9375rem] leading-6 text-muted-foreground/80 ${
        hasTemplateAttachment ? "top-[54px]" : "top-0 pt-4"
      }`}
      aria-hidden="true"
    >
      {createMode
        ? composerCreatePlaceholder(createMode)
        : workflowComposerPlaceholder(sending)}
    </div>
  );
}

interface TiptapWorkflowComposerProps {
  readonly signals: ComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly actions: ComposerActions;
  readonly onPaste: (event: ComposerPasteEvent) => void;
}

interface ComposerKeyDownContext {
  readonly composer: ComposerSignals;
  readonly selectedTask: ComposerTask | null;
  readonly selectTask: (task: ComposerTask | null) => void;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}

interface ComposerSuggestionKeyDownContext {
  readonly suggestionOrder: readonly number[];
  readonly selectedSuggestionIndex: number;
  readonly showSuggestionMenu: boolean;
  readonly setSelectedSuggestionIndex: (index: number) => void;
  readonly closeSuggestionMenu: () => void;
  readonly selectSuggestion: (index: number) => void;
  readonly scrollSuggestionIntoView: (index: number) => void;
  /**
   * Moves the selection into (1) or out of (-1) the list a row opens, and
   * reports whether there was one to cross.
   */
  readonly crossSuggestionSubmenu?: (direction: 1 | -1) => boolean;
}

function eventTargetsNonEditableNodeView(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest('[contenteditable="false"]') !== null
  );
}

function shouldRemoveSelectedTask(
  event: KeyboardEvent,
  context: ComposerKeyDownContext,
  showSuggestionMenu: boolean,
): boolean {
  return (
    event.key === "Backspace" &&
    !showSuggestionMenu &&
    context.selectedTask !== null &&
    context.composer.editor.editor.isEmpty
  );
}

function nextSuggestionIndex(
  order: readonly number[],
  selectedIndex: number,
  direction: 1 | -1,
): number | undefined {
  const position = order.indexOf(selectedIndex);
  const nextPosition =
    position === -1
      ? direction > 0
        ? 0
        : order.length - 1
      : Math.max(0, Math.min(position + direction, order.length - 1));
  return order[nextPosition];
}

function crossesSuggestionSubmenu(
  event: KeyboardEvent,
  context: ComposerSuggestionKeyDownContext,
): boolean {
  if (
    !context.crossSuggestionSubmenu ||
    (event.key !== "ArrowRight" && event.key !== "ArrowLeft") ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  ) {
    return false;
  }
  return context.crossSuggestionSubmenu(event.key === "ArrowRight" ? 1 : -1);
}

function handleComposerKeyDownCapture(
  event: KeyboardEvent,
  context: ComposerKeyDownContext,
  suggestions?: ComposerSuggestionKeyDownContext,
): boolean {
  // ProseMirror normally gives node views first ownership through stopEvent.
  // React capture runs earlier, so preserve that boundary for their controls.
  if (eventTargetsNonEditableNodeView(event)) {
    return false;
  }
  if (event.isComposing || context.composer.editor.editor.view.composing) {
    return false;
  }
  if (event.keyCode === 229) {
    // A confirming key can arrive after compositionend. Keep it out of editor
    // keymaps without preventing the input method's native confirmation.
    return true;
  }
  if (
    shouldRemoveSelectedTask(
      event,
      context,
      suggestions?.showSuggestionMenu ?? false,
    )
  ) {
    event.preventDefault();
    context.selectTask(null);
    return true;
  }
  if (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    event.preventDefault();
    context.composer.editor.editor.commands.splitBlock();
    return true;
  }
  const lineNavigationPos = resolveMacControlLineNavigation(
    context.composer.editor.editor,
    event,
  );
  if (lineNavigationPos !== null) {
    event.preventDefault();
    context.composer.editor.editor.commands.setTextSelection(lineNavigationPos);
    return true;
  }
  if (!suggestions?.showSuggestionMenu) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  return handleSuggestionMenuKeyDown(event, suggestions, context.onKeyDown);
}

function handleSuggestionMenuKeyDown(
  event: KeyboardEvent,
  context: ComposerSuggestionKeyDownContext,
  onKeyDown: ComposerKeyDownContext["onKeyDown"],
): boolean {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const next = nextSuggestionIndex(
      context.suggestionOrder,
      context.selectedSuggestionIndex,
      direction,
    );
    if (next !== undefined) {
      context.setSelectedSuggestionIndex(next);
      context.scrollSuggestionIntoView(next);
    }
    return true;
  }
  if (crossesSuggestionSubmenu(event, context)) {
    // Only a row that opens a list takes the arrow from the caret.
    event.preventDefault();
    return true;
  }
  if (
    (event.key === "Enter" || event.key === "Tab") &&
    context.suggestionOrder.includes(context.selectedSuggestionIndex)
  ) {
    event.preventDefault();
    context.selectSuggestion(context.selectedSuggestionIndex);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    context.closeSuggestionMenu();
    return true;
  }
  onKeyDown(event);
  return event.defaultPrevented;
}

interface ComposerSuggestionMenuState {
  readonly open: boolean;
  readonly selectedIndex: number;
  readonly close: (restoreEditorFocus?: boolean) => void;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly panelCategories: readonly SlashTemplateCategory[];
  readonly previewIndex: number | null;
  readonly previewSuggestion: (index: number | null) => void;
  readonly selectCategory: (category: SlashTemplateCategory) => void;
  readonly selectTemplate: (
    preview: SlashTemplatePreview,
    category: SlashTemplateCategory,
  ) => void;
  readonly browseAllTemplates: () => void;
  readonly workflowsLoading: boolean;
  readonly reversed: boolean;
  readonly reverseWorkflows: boolean;
  readonly collapseWorkflows: boolean;
  readonly expandWorkflows: () => void;
  readonly showWorkflowActions: boolean;
  readonly newWorkflow: () => void;
  /** The slash-actions overview, when it replaces the panel's own. */
  readonly actionsOverview: SlashActionsOverview | null;
  /** The overview's first and second levels are separate cards. */
  readonly cascade: boolean;
  /** The chat actions a typed slash query names. */
  readonly searchActions: readonly SlashAction[];
  readonly showWorkflows: boolean;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly showMentions: boolean;
  readonly selectWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly selectAgent: (agent: ComposerAgentSuggestion) => void;
  readonly selectChatThread: (chatThread: ComposerChatThreadSuggestion) => void;
  readonly handleKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Every row names one composer task, so choosing "Presentation" here leaves the
 * composer exactly where the Presentation chip would. Which of those tasks can
 * actually be entered is the chips' own call, and a row that cannot enter one
 * still opens the picker.
 */
const SLASH_TEMPLATE_CATEGORY_TASK = {
  slides: "presentation",
  document: "document",
  illustration: "image",
  website: "website",
} as const satisfies Record<SlashTemplateCategory, ComposerTask>;

/** The template categories the typed slash query leaves, or none outside one. */
function useSlashTemplateCategorySuggestions(
  query: string | undefined,
): readonly SlashTemplateCategory[] {
  useTranslation();
  if (query === undefined) {
    return [];
  }
  const normalized = query.toLowerCase().trim();
  return SLASH_TEMPLATE_CATEGORIES.filter((category) => {
    return slashTemplateCategoryLabel(category)
      .toLowerCase()
      .includes(normalized);
  });
}

/**
 * Everything the two-pane panel needs: which rows the typed query leaves, and
 * what each row does when it is chosen.
 */
function useSlashTemplatePanelActions(
  composer: ComposerSignals,
  query: string | undefined,
  close: () => void,
) {
  const clearSlashRange = useSet(composer.suggestion.clearSlashRange$);
  const openTask = useSet(composer.taskChips.openTask$);
  const insertTemplate = useSet(composer.template.insertTemplate$);
  const openTemplatePicker = useSet(composer.template.openTemplatePicker$);
  const insertText = useSet(composer.editor.insertText$);
  const navigate = useSet(detachedNavigateTo$);
  const categories = useSlashTemplateCategorySuggestions(query);
  return {
    categories,
    /**
     * Consume the token and retire the menu first, then land on the task, and
     * only then open the dialog: the task activation focuses the editor, so
     * opening the picker ahead of it would hand that focus straight back out.
     */
    selectCategory(category: SlashTemplateCategory): void {
      clearSlashRange();
      close();
      openTask(SLASH_TEMPLATE_CATEGORY_TASK[category]);
      openTemplatePicker({ kind: "insert", category });
    },
    /**
     * The cover is a row of this menu, so choosing one consumes the token that
     * opened it, the same way a category row and a workflow row do. The chip
     * then lands where the token was rather than after it.
     *
     * It also names the same task its category row does, so it lands the
     * composer there too — it just brings the template along instead of opening
     * the picker to choose one. The chip goes in before the task, because
     * landing on one ends by focusing the caret at the end of the draft;
     * inserting after that would move the chip off the token it replaces.
     */
    selectTemplate(
      preview: SlashTemplatePreview,
      category: SlashTemplateCategory,
    ): void {
      clearSlashRange();
      close();
      insertTemplate(preview.template, preview.attachment);
      openTask(SLASH_TEMPLATE_CATEGORY_TASK[category]);
    },
    browseAll(): void {
      clearSlashRange();
      close();
      openTemplatePicker({ kind: "insert", category: "slides" });
    },
    /**
     * The same request the Workflows page's Create in chat starts a chat with,
     * written where the token was so the user can still edit it before sending.
     */
    newWorkflow(): void {
      clearSlashRange();
      close();
      insertText(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
    },
    /**
     * Leaves the draft as typed. Its debounced save belongs to this page, so
     * an edit made on the way out would not persist past the navigation.
     */
    manageWorkflows(): void {
      close();
      navigate(ROUTES.workflows);
    },
    /** Consumes the token and closes the menu before an action takes over. */
    leave(): void {
      clearSlashRange();
      close();
    },
  };
}

function useComposerWorkflowSuggestions(
  composer: ComposerSignals,
  query: string | undefined,
) {
  const workflowsLoadable = useLastLoadable(composer.workflow.workflows$);
  const recentIds = useGet(composer.suggestion.recentWorkflowIds$);
  // Null means the list is not requested yet; the last loadable keeps that
  // null while the first request is in flight.
  const requested =
    workflowsLoadable.state === "hasData" ? workflowsLoadable.data : undefined;
  const workflows = buildComposerSlashWorkflows({
    agentId: composer.agentId,
    workflows: requested ?? [],
  });
  return {
    workflows:
      query === undefined
        ? []
        : findWorkflowQueryMatches(workflows, query, recentIds),
    loading: workflowsLoadable.state === "loading" || requested === null,
  };
}

/**
 * The @-mention half of the suggestion menu. Only the result for the current
 * agent and the current query counts; a stale resolution shows nothing.
 */
function useComposerMentionSuggestions(
  composer: ComposerSignals,
  slashRange: { readonly query: string } | null,
) {
  const chatThreadRange = useGet(
    composer.suggestion.activeChatThreadSuggestionRange$,
  );
  const chatThreadResult = useLastResolved(
    composer.suggestion.chatThreadSuggestions$,
  );
  const result =
    chatThreadRange &&
    chatThreadResult &&
    chatThreadResult.agentId === composer.agentId &&
    chatThreadResult.query === chatThreadRange.query
      ? chatThreadResult
      : null;
  const agents = result?.agents ?? [];
  const chatThreads = result?.chatThreads ?? [];
  return {
    agents,
    chatThreads,
    showMentions:
      slashRange === null &&
      chatThreadRange !== null &&
      agents.length + chatThreads.length > 0,
  };
}

interface SuggestionRows {
  readonly showWorkflows: boolean;
  readonly panelCategories: readonly SlashTemplateCategory[];
  /** The typed query's chat actions, indexed after the categories. */
  readonly actions: readonly SlashAction[];
  /** How many rows sit above the workflow suggestions. */
  readonly headCount: number;
  readonly expandIndex: number | null;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  /** New workflow and Manage workflows follow the revealed workflows. */
  readonly workflowActions: boolean;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
}

interface SuggestionRowActions {
  readonly expandWorkflows: () => void;
  readonly newWorkflow: () => void;
  readonly manageWorkflows: () => void;
  readonly selectCategory: (category: SlashTemplateCategory) => void;
  readonly insertWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly insertAgent: (agent: ComposerAgentSuggestion) => void;
  readonly insertChatThread: (chatThread: ComposerChatThreadSuggestion) => void;
}

function buildSuggestionRows({
  collapseWorkflows,
  ...rows
}: Omit<SuggestionRows, "headCount" | "expandIndex"> & {
  readonly collapseWorkflows: boolean;
}): SuggestionRows {
  const headCount = rows.panelCategories.length + rows.actions.length;
  const expandIndex =
    collapseWorkflows &&
    rows.workflows.length > SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT
      ? headCount + SLASH_PANEL_COLLAPSED_WORKFLOW_COUNT
      : null;
  return { ...rows, headCount, expandIndex };
}

function suggestionRowCount(rows: SuggestionRows): number {
  if (!rows.showWorkflows) {
    return rows.agents.length + rows.chatThreads.length;
  }
  return rows.expandIndex === null
    ? rows.headCount + rows.workflows.length + (rows.workflowActions ? 2 : 0)
    : rows.expandIndex + 1;
}

/** New workflow or Manage workflows, when the index is one of them. */
function workflowActionRow(
  index: number,
  rows: SuggestionRows,
): "new" | "manage" | undefined {
  if (!rows.workflowActions) {
    return undefined;
  }
  const offset = index - rows.headCount - rows.workflows.length;
  return offset === 0 ? "new" : offset === 1 ? "manage" : undefined;
}

/** The template category row for an index, if it is one. */
function suggestionHeadRow(
  index: number,
  rows: SuggestionRows,
): SlashTemplateCategory | undefined {
  return rows.panelCategories[index];
}

/** The chat action row for an index, if it is one. */
function suggestionActionRow(
  index: number,
  rows: SuggestionRows,
): SlashAction | undefined {
  const offset = index - rows.panelCategories.length;
  return offset < 0 ? undefined : rows.actions[offset];
}

function selectSlashSuggestionRow(
  index: number,
  rows: SuggestionRows,
  actions: SuggestionRowActions,
): void {
  if (index === rows.expandIndex) {
    // The collapsed overview keeps the first hidden workflow's index.
    // Activating it reveals that row and keeps keyboard selection there.
    actions.expandWorkflows();
    return;
  }
  const category = rows.panelCategories[index];
  if (category) {
    actions.selectCategory(category);
    return;
  }
  const chatAction = suggestionActionRow(index, rows);
  if (chatAction) {
    chatAction.run();
    return;
  }
  const action = workflowActionRow(index, rows);
  if (action !== undefined) {
    (action === "new" ? actions.newWorkflow : actions.manageWorkflows)();
    return;
  }
  const workflow = rows.workflows[index - rows.headCount];
  if (workflow) {
    actions.insertWorkflow(workflow);
  }
}

function selectSuggestionRow(
  index: number,
  rows: SuggestionRows,
  actions: SuggestionRowActions,
): void {
  if (rows.showWorkflows) {
    selectSlashSuggestionRow(index, rows, actions);
    return;
  }
  const agent = rows.agents[index];
  if (agent) {
    actions.insertAgent(agent);
    return;
  }
  const chatThread = rows.chatThreads[index - rows.agents.length];
  if (chatThread) {
    actions.insertChatThread(chatThread);
  }
}

function suggestionRowScrollTarget(
  index: number,
  rows: SuggestionRows,
): { readonly id: string } | undefined {
  if (index === rows.expandIndex) {
    return { id: SLASH_PANEL_SHOW_MORE_ID };
  }
  const head = suggestionHeadRow(index, rows);
  if (head !== undefined) {
    return { id: head };
  }
  const chatAction = suggestionActionRow(index, rows);
  if (chatAction !== undefined) {
    return { id: slashActionOptionId(chatAction.id) };
  }
  const action = workflowActionRow(index, rows);
  if (action !== undefined) {
    return {
      id:
        action === "new"
          ? SLASH_PANEL_NEW_WORKFLOW_ID
          : SLASH_PANEL_MANAGE_WORKFLOWS_ID,
    };
  }
  return rows.workflows[index - rows.headCount];
}

function suggestionNavigationOrder(
  count: number,
  reversed: boolean,
  overviewCategoryCount: number | null,
): readonly number[] {
  return Array.from({ length: count }, (_, visualIndex) => {
    // Above the composer the overview reads workflows from most recent to
    // least recent, then the creation categories in their existing anchored
    // order below them. Below the composer it reads categories then workflows
    // top-down, which is the index order, so callers pass null there.
    if (overviewCategoryCount !== null) {
      return visualIndex < count - overviewCategoryCount
        ? overviewCategoryCount + visualIndex
        : count - visualIndex - 1;
    }
    return reversed ? count - visualIndex - 1 : visualIndex;
  });
}

function scrollSuggestionRowIntoView(
  index: number,
  rows: SuggestionRows,
  actionsOverview: SlashActionsOverview | null,
): void {
  if (rows.showWorkflows) {
    scrollSlashWorkflowIntoView(
      actionsOverview?.scrollTarget(index) ??
        suggestionRowScrollTarget(index, rows),
    );
  }
}

function createComposerSuggestionKeyDown(
  context: ComposerKeyDownContext,
  suggestions: ComposerSuggestionKeyDownContext,
): (event: KeyboardEvent) => boolean {
  return (event) => {
    return handleComposerKeyDownCapture(event, context, suggestions);
  };
}

function useComposerSuggestionMenu({
  composer,
  onKeyDown,
}: {
  readonly composer: ComposerSignals;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}): ComposerSuggestionMenuState {
  const isDesktop = useMediaQuery(SIDEBAR_DESKTOP_MEDIA_QUERY);
  const slashRange = useGet(composer.suggestion.activeSlashRange$);
  const selectedTask = useGet(composer.taskChips.task$);
  const selectTask = useSet(composer.taskChips.selectTask$);
  const selectedIndex = useGet(composer.suggestion.selectedSuggestionIndex$);
  const previewIndex = useGet(composer.suggestion.previewSuggestionIndex$);
  const previewSuggestion = useSet(composer.suggestion.previewSuggestion$);
  const setSelectedIndex = useSet(
    composer.suggestion.setSelectedSuggestionIndex$,
  );
  const close = useSet(composer.suggestion.closeSuggestionMenu$);
  const workflowsExpanded = useGet(composer.suggestion.slashWorkflowsExpanded$);
  const expandWorkflows = useSet(composer.suggestion.expandSlashWorkflows$);
  const workflowOverview = slashRange?.query === "";
  const collapseWorkflows = workflowOverview && !workflowsExpanded;
  const templatePanel = useSlashTemplatePanelActions(
    composer,
    slashRange?.query,
    close,
  );
  const panelCategories = templatePanel.categories;
  const insertWorkflow = useSet(composer.workflow.insertWorkflow$);
  const insertAgent = useSet(composer.suggestion.insertAgent$);
  const insertChatThread = useSet(composer.suggestion.insertChatThread$);
  const workflowResult = useComposerWorkflowSuggestions(
    composer,
    slashRange?.query,
  );
  const workflowSuggestions = workflowResult.workflows;
  const showWorkflows = slashRange !== null;
  // Search results and @ mentions follow priority from top to bottom.
  // Only the desktop slash overview keeps its anchored category order.
  const reversedSuggestions = isDesktop && workflowOverview;
  const mentions = useComposerMentionSuggestions(composer, slashRange);
  const { agents, chatThreads, showMentions } = mentions;
  const open = showWorkflows || showMentions;
  const slashActions = useSlashActionsMenu({
    composer,
    query: slashRange?.query,
    workflows: workflowSuggestions,
    panel: templatePanel,
  });
  const actionsOverview = slashActions.overview;
  const rows = buildSuggestionRows({
    showWorkflows,
    panelCategories,
    actions: slashActions.searchActions,
    collapseWorkflows,
    workflows: workflowSuggestions,
    workflowActions: workflowOverview && workflowsExpanded,
    agents,
    chatThreads,
  });
  const suggestionOrder =
    actionsOverview?.order ??
    suggestionNavigationOrder(
      suggestionRowCount(rows),
      reversedSuggestions,
      reversedSuggestions && workflowOverview ? rows.headCount : null,
    );

  function selectSuggestion(index: number): void {
    if (actionsOverview) {
      actionsOverview.select(index);
      return;
    }
    selectSuggestionRow(index, rows, {
      ...templatePanel,
      expandWorkflows,
      insertWorkflow,
      insertAgent,
      insertChatThread,
    });
  }

  const handleKeyDown = createComposerSuggestionKeyDown(
    { composer, selectedTask, selectTask, onKeyDown },
    {
      suggestionOrder,
      selectedSuggestionIndex: selectedIndex,
      showSuggestionMenu: open,
      setSelectedSuggestionIndex: setSelectedIndex,
      closeSuggestionMenu: close,
      selectSuggestion,
      scrollSuggestionIntoView: (index) => {
        scrollSuggestionRowIntoView(index, rows, actionsOverview);
      },
      crossSuggestionSubmenu: actionsOverview?.cross,
    },
  );

  return {
    open,
    selectedIndex,
    close,
    workflows: workflowSuggestions,
    panelCategories,
    previewIndex,
    previewSuggestion,
    selectCategory: templatePanel.selectCategory,
    selectTemplate: templatePanel.selectTemplate,
    browseAllTemplates: templatePanel.browseAll,
    workflowsLoading: workflowResult.loading,
    reversed: reversedSuggestions,
    reverseWorkflows: reversedSuggestions && !workflowOverview,
    collapseWorkflows,
    expandWorkflows,
    showWorkflowActions: rows.workflowActions,
    newWorkflow: templatePanel.newWorkflow,
    actionsOverview,
    cascade: actionsOverview !== null && isDesktop,
    searchActions: slashActions.searchActions,
    showWorkflows,
    agents,
    chatThreads,
    showMentions,
    selectWorkflow: insertWorkflow,
    selectAgent: insertAgent,
    selectChatThread: insertChatThread,
    handleKeyDown,
  };
}

/**
 * Resolves a paste against the editor before the host handler sees it. The host
 * gets first refusal so it can claim files; anything it leaves is inserted as
 * Markdown so pasted prose keeps its structure instead of arriving flattened.
 */
function useComposerPasteHandler(
  composer: ComposerSignals,
  onPaste: TiptapWorkflowComposerProps["onPaste"],
): (event: ClipboardEvent, currentTarget: HTMLElement) => boolean {
  const insertPromptMarkdown = useSet(composer.editor.insertPromptMarkdown$);

  return function handlePaste(event, currentTarget) {
    if (eventTargetsNonEditableNodeView(event)) {
      return false;
    }
    const clipboardData = event.clipboardData;
    const preventedBeforeHandler = event.defaultPrevented;
    onPaste({
      clipboardData,
      currentTarget,
      preventDefault: () => {
        event.preventDefault();
      },
    });
    if (!preventedBeforeHandler && event.defaultPrevented) {
      return true;
    }
    const plainText =
      clipboardData?.getData("text/plain") || clipboardData?.getData("text");
    if (plainText) {
      event.preventDefault();
      insertPromptMarkdown(plainText);
      return true;
    }
    return event.defaultPrevented;
  };
}

/**
 * The open suggestion session owns its data and editor keyboard integration.
 * It is a sibling of the editor, never a conditional parent of its DOM/ref.
 */
function ComposerSuggestionSession({
  composer,
  onKeyDown,
}: {
  readonly composer: ComposerSignals;
  readonly onKeyDown: ComposerKeyDownContext["onKeyDown"];
}) {
  const suggestionMenu = useComposerSuggestionMenu({
    composer,
    onKeyDown,
  });
  const attachSessionKeyDown = useSet(
    composer.suggestion.attachSessionKeyDown$,
  );
  const expandedSlashHeight = useGet(
    composer.suggestion.slashWorkflowsExpandedHeight$,
  );
  const suggestionAnchor = () => {
    // Resolve the card belonging to this editor, not another chat's composer.
    return composer.editor.editor.view.dom.closest(
      '[data-slot="chat-composer-card"]',
    );
  };
  const setSlashHintMenuRef = useSet(composer.suggestion.setSlashHintMenuRef$);
  const setMentionHintMenuRef = useSet(
    composer.suggestion.setMentionHintMenuRef$,
  );

  return (
    <div
      className="contents"
      // This subtree owns the session listener, not the permanent editor DOM.
      // A new committed row closure detaches the old ref before reattaching;
      // preserve its React 19 cleanup. Abandoned renders never attach a ref.
      ref={(host) => {
        return attachSessionKeyDown(host, suggestionMenu.handleKeyDown);
      }}
    >
      <Popover
        open={suggestionMenu.open}
        onOpenChange={(open, details) => {
          if (!open) {
            suggestionMenu.close(details.reason === "escape-key");
          }
        }}
      >
        {suggestionMenu.showWorkflows && (
          <SlashWorkflowMenu
            menuRef={setSlashHintMenuRef}
            bare={suggestionMenu.cascade}
            anchor={suggestionAnchor}
          >
            {suggestionMenu.actionsOverview ? (
              <SlashActionsPanel
                overview={suggestionMenu.actionsOverview}
                workflows={suggestionMenu.workflows}
                workflowsLoading={suggestionMenu.workflowsLoading}
                categories={suggestionMenu.panelCategories}
                selectedIndex={suggestionMenu.selectedIndex}
                previewIndex={suggestionMenu.previewIndex}
                onPreview={suggestionMenu.previewSuggestion}
                onSelectWorkflow={suggestionMenu.selectWorkflow}
                onSelectTemplate={suggestionMenu.selectTemplate}
                onBrowseAll={suggestionMenu.browseAllTemplates}
                onNewWorkflow={suggestionMenu.newWorkflow}
                onManageWorkflows={() => {
                  suggestionMenu.close();
                }}
              />
            ) : (
              <SlashTemplatePanel
                categories={suggestionMenu.panelCategories}
                actions={suggestionMenu.searchActions}
                reversed={suggestionMenu.reversed}
                reverseWorkflows={suggestionMenu.reverseWorkflows}
                workflows={suggestionMenu.workflows}
                workflowsLoading={suggestionMenu.workflowsLoading}
                collapseWorkflows={suggestionMenu.collapseWorkflows}
                onExpandWorkflows={suggestionMenu.expandWorkflows}
                expandedHeight={expandedSlashHeight}
                showWorkflowActions={suggestionMenu.showWorkflowActions}
                onNewWorkflow={suggestionMenu.newWorkflow}
                onManageWorkflows={() => {
                  suggestionMenu.close();
                }}
                selectedIndex={suggestionMenu.selectedIndex}
                previewIndex={suggestionMenu.previewIndex}
                onPreview={suggestionMenu.previewSuggestion}
                onSelectCategory={suggestionMenu.selectCategory}
                onSelectTemplate={suggestionMenu.selectTemplate}
                onSelectWorkflow={suggestionMenu.selectWorkflow}
                onBrowseAll={suggestionMenu.browseAllTemplates}
                workflowOptionId={slashWorkflowOptionId}
                categoryOptionId={slashWorkflowOptionId}
              />
            )}
          </SlashWorkflowMenu>
        )}
        {suggestionMenu.showMentions && (
          <ComposerMentionSuggestionMenu
            menuRef={setMentionHintMenuRef}
            anchor={suggestionAnchor}
            agents={suggestionMenu.agents}
            chatThreads={suggestionMenu.chatThreads}
            selectedIndex={suggestionMenu.selectedIndex}
            onSelectAgent={suggestionMenu.selectAgent}
            onSelectChatThread={suggestionMenu.selectChatThread}
          />
        )}
      </Popover>
    </div>
  );
}

/**
 * Keep the editor's parent and send owner mounted across menu transitions.
 * Presence only needs token ranges; no workflow/model/mention payload is read
 * until a token opens a session. An empty/loading mention session still owns
 * the fallback keyboard path, even while its popover has no visible rows.
 */
function ComposerSuggestionMenu({
  composer,
  actions,
  children,
}: {
  readonly composer: ComposerSignals;
  readonly actions: ComposerActions;
  readonly children: ReactNode;
}) {
  const sessionActive = useGet(composer.suggestion.sessionActive$);
  const selectedTask = useGet(composer.taskChips.task$);
  const selectTask = useSet(composer.taskChips.selectTask$);
  const onKeyDown = useComposerKeyboard(composer, actions);
  return (
    <>
      <div
        className="relative flex min-h-full flex-col"
        onKeyDownCapture={(event) => {
          if (sessionActive) {
            // The open session handles capture on the editor itself, after
            // this stable parent. Do not send before its menu can claim Enter.
            return;
          }
          const nativeEvent = event.nativeEvent;
          const handled = handleComposerKeyDownCapture(nativeEvent, {
            composer,
            selectedTask,
            selectTask,
            onKeyDown,
          });
          if (handled || nativeEvent.defaultPrevented) {
            event.stopPropagation();
          }
        }}
      >
        {children}
      </div>
      {sessionActive && (
        <ComposerSuggestionSession composer={composer} onKeyDown={onKeyDown} />
      )}
    </>
  );
}

export function TiptapWorkflowComposer({
  signals,
  onDraftChange,
  actions,
  onPaste,
}: TiptapWorkflowComposerProps) {
  const composer = signals;
  const handlePaste = useComposerPasteHandler(composer, onPaste);
  const setContainerRef = useSet(composer.editor.setContainerRef$);

  return (
    <ComposerSuggestionMenu composer={composer} actions={actions}>
      <WorkflowComposerPlaceholder composer={composer} />
      <div
        // The composer card owns responsive height allocation so its footer
        // can change modes without changing the surrounding card height.
        //
        // The editable area has to claim all of that height, the way a
        // textarea does. ProseMirror's own stylesheet only sets `position`
        // and whitespace handling and never sizes the editor, so filling the
        // container is entirely the caller's job:
        // https://github.com/ProseMirror/prosemirror-view/blob/master/style/prosemirror.css
        //
        // This used to be a chain of `min-h-full`, and it silently stopped
        // one level in. A percentage `min-height` only resolves against a
        // parent whose own `height` is definite, and an element carrying just
        // `min-height: 100%` still computes `height: auto`, so the next
        // `min-height: 100%` below it resolved to nothing. On a 900px-wide
        // composer that left `.ProseMirror` 40px tall inside a 144px input
        // area: four fifths of the card looked like the editor but was not.
        // Every click there landed on this wrapper instead, blurring the
        // editor before the slot's click handler focused it again, and that
        // focus round trip re-ran the composer card's `focus-within`
        // border-color and focus-veil transitions, repainting the whole card.
        //
        // Both ProseMirror and Tiptap answer "make the editor fill its box"
        // with flex rather than percentage heights, which is what this does:
        // the wrapper is the column, this container grows into it, and the
        // editor grows into this container. `flex-auto` keeps `flex-basis:
        // auto`, so a long draft still contributes its intrinsic height and
        // the composer keeps growing until the editor's own max-height takes
        // over.
        // https://discuss.prosemirror.net/t/how-can-i-set-a-prosemirror-editor-to-be-100-height/5226
        // https://github.com/ueberdosis/tiptap/discussions/1546
        className="flex min-h-0 flex-auto flex-col [&_.ProseMirror]:flex-auto"
        ref={setContainerRef}
        onInput={(event) => {
          // The mount command targets the container for semantic document
          // changes; native contenteditable input targets ProseMirror.
          if (event.target === event.currentTarget) {
            onDraftChange?.();
          }
        }}
        onPasteCapture={(event) => {
          const handled = handlePaste(
            event.nativeEvent,
            composer.editor.editor.view.dom,
          );
          if (handled) {
            event.stopPropagation();
          }
        }}
      />
    </ComposerSuggestionMenu>
  );
}
