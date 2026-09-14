import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEditorState } from "@tiptap/react";
import { Popover, type KeyboardEventLike } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { i18n } from "../../i18n/index.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { importPresentationTemplateDeck$ } from "../../signals/okou-page/presentation-template-import.ts";
import type { ComposerAgentSuggestion } from "../../signals/okou-page/composer-agent-suggestion-domain.ts";
import type { ComposerChatThreadSuggestion } from "../../signals/okou-page/chat-thread-suggestion-domain.ts";
import type { ComposerSignals } from "../../signals/okou-page/composer-signals.ts";
import type { ComposerTask } from "../../signals/okou-page/composer-task-chips.ts";
import { ComposerMentionSuggestionMenu } from "./chat-thread-suggestion.tsx";
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
  SlashTemplatePanel,
  slashTemplateCategoryLabel,
} from "./slash-template-panel.tsx";
import {
  SLASH_TEMPLATE_CATEGORIES,
  type SlashTemplateCategory,
  type SlashTemplatePreview,
} from "./composer-template-catalog.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";

import {
  composerCreateCommandLabel,
  composerCreateModeLabel,
  composerCreateModeName,
  composerCreatePlaceholder,
  type ComposerCreateCommand,
} from "../../signals/okou-page/composer-create.ts";

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

interface ComposerSuggestionRange {
  readonly start: number;
  readonly end: number;
}

function composerSuggestionCaretAnchor(
  editor: Editor,
  range: ComposerSuggestionRange | null,
) {
  if (!range || !editor.isInitialized) {
    return undefined;
  }
  return {
    contextElement: editor.view.dom,
    getBoundingClientRect() {
      const suggestionStart = Math.max(
        editor.state.selection.head - (range.end - range.start),
        0,
      );
      const coords = editor.view.coordsAtPos(suggestionStart);
      return new DOMRect(
        coords.left,
        coords.top,
        0,
        coords.bottom - coords.top,
      );
    },
  };
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
  sending,
}: {
  composer: ComposerSignals;
  sending: boolean | undefined;
}) {
  const { t } = useTranslation();
  const createMode = useGet(composer.create.mode$);
  const choosing = useGet(composer.create.choosing$);
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
      {choosing
        ? t(($) => {
            return $.chat.composer.create.question;
          })
        : createMode
          ? composerCreatePlaceholder(createMode)
          : workflowComposerPlaceholder(sending)}
    </div>
  );
}

interface TiptapWorkflowComposerProps {
  readonly signals: ComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
}

interface ComposerKeyDownContext {
  readonly composer: ComposerSignals;
  readonly selectedTask: ComposerTask | null;
  readonly selectTask: (task: ComposerTask | null) => void;
  readonly suggestionCount: number;
  readonly selectedSuggestionIndex: number;
  readonly showSuggestionMenu: boolean;
  readonly setSelectedSuggestionIndex: (index: number) => void;
  readonly closeSuggestionMenu: () => void;
  readonly selectSuggestion: (index: number) => void;
  readonly scrollSuggestionIntoView: (index: number) => void;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
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
): boolean {
  return (
    event.key === "Backspace" &&
    !context.showSuggestionMenu &&
    context.selectedTask !== null &&
    context.composer.editor.editor.isEmpty
  );
}

function handleComposerKeyDownCapture(
  event: KeyboardEvent,
  context: ComposerKeyDownContext,
): boolean {
  // ProseMirror normally gives node views first ownership through stopEvent.
  // React capture runs earlier, so preserve that boundary for their controls.
  if (eventTargetsNonEditableNodeView(event)) {
    return false;
  }
  if (event.isComposing || event.keyCode === 229) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  if (shouldRemoveSelectedTask(event, context)) {
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
  if (!context.showSuggestionMenu) {
    context.onKeyDown(event);
    return event.defaultPrevented;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.max(
      0,
      Math.min(
        context.selectedSuggestionIndex + delta,
        Math.max(context.suggestionCount - 1, 0),
      ),
    );
    context.setSelectedSuggestionIndex(next);
    context.scrollSuggestionIntoView(next);
    return true;
  }
  if (
    (event.key === "Enter" || event.key === "Tab") &&
    context.suggestionCount > 0
  ) {
    event.preventDefault();
    context.selectSuggestion(
      Math.min(context.selectedSuggestionIndex, context.suggestionCount - 1),
    );
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    context.closeSuggestionMenu();
    return true;
  }
  context.onKeyDown(event);
  return event.defaultPrevented;
}

interface ComposerSuggestionMenuState {
  readonly open: boolean;
  readonly range: ComposerSuggestionRange | null;
  readonly selectedIndex: number;
  readonly close: () => void;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly createModes: readonly ComposerCreateCommand[];
  readonly selectCreate: (mode: ComposerCreateCommand) => void;
  /** Non-empty only while ComposerSlashTemplatePanel is on. */
  readonly panelCategories: readonly SlashTemplateCategory[];
  readonly highlightedCategory: SlashTemplateCategory | null;
  readonly highlightCategory: (category: SlashTemplateCategory | null) => void;
  readonly selectCategory: (category: SlashTemplateCategory) => void;
  readonly selectTemplate: (preview: SlashTemplatePreview) => void;
  readonly importDeck: (file: File) => void;
  readonly browseAllTemplates: () => void;
  readonly showTemplatePanel: boolean;
  readonly workflowsLoading: boolean;
  readonly showWorkflows: boolean;
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly showMentions: boolean;
  readonly selectWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly selectAgent: (agent: ComposerAgentSuggestion) => void;
  readonly selectChatThread: (chatThread: ComposerChatThreadSuggestion) => void;
  readonly handleKeyDown: (event: KeyboardEvent) => boolean;
}

function useComposerCreateSuggestions(
  composer: ComposerSignals,
  query: string | undefined,
): readonly ComposerCreateCommand[] {
  useTranslation();
  const enabled = useGet(composer.create.enabled$);
  if (!enabled || query === undefined) {
    return [];
  }
  const normalized = query.toLowerCase().trim();
  if (
    "create".startsWith(normalized) ||
    composerCreateCommandLabel("choose").toLowerCase().startsWith(normalized)
  ) {
    return ["choose"];
  }
  return composer.create.modes.filter((mode) => {
    return (
      `create ${mode}`.includes(normalized) ||
      composerCreateModeLabel(mode).toLowerCase().includes(normalized) ||
      composerCreateModeName(mode).toLowerCase().includes(normalized)
    );
  });
}

/**
 * The three categories that are also composer create modes keep their existing
 * action, so choosing "Presentation" from the panel does exactly what choosing
 * it from the flat menu does today. Website and Workflow have no create mode,
 * so they open the template picker on their own tab instead.
 */
const SLASH_TEMPLATE_CATEGORY_CREATE_MODE = {
  slides: "presentation",
  illustration: "image",
  video: "video",
} as const satisfies Partial<
  Record<SlashTemplateCategory, ComposerCreateCommand>
>;

function createModeForCategory(
  category: SlashTemplateCategory,
): ComposerCreateCommand | undefined {
  return category in SLASH_TEMPLATE_CATEGORY_CREATE_MODE
    ? SLASH_TEMPLATE_CATEGORY_CREATE_MODE[
        category as keyof typeof SLASH_TEMPLATE_CATEGORY_CREATE_MODE
      ]
    : undefined;
}

function useSlashTemplateCategorySuggestions(
  composer: ComposerSignals,
  query: string | undefined,
): readonly SlashTemplateCategory[] {
  useTranslation();
  const enabled = useGet(composer.create.enabled$);
  if (!enabled || query === undefined) {
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
 * Everything the two-pane panel needs that the flat menu does not: which rows
 * the typed query leaves, and what each row does when it is chosen.
 */
function useSlashTemplatePanelActions(
  composer: ComposerSignals,
  query: string | undefined,
  selection: {
    readonly selectedIndex: number;
    readonly setSelectedIndex: (index: number) => void;
    readonly close: () => void;
  },
) {
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ComposerSlashTemplatePanel] ===
    true;
  const selectCreate = useSet(composer.create.selectCommand$);
  const insertTemplate = useSet(composer.template.insertTemplate$);
  const openTemplatePicker = useSet(composer.template.openTemplatePicker$);
  const runDeckImport = useSet(importPresentationTemplateDeck$);
  const rootSignal = useGet(rootSignal$);
  const categories = useSlashTemplateCategorySuggestions(
    composer,
    enabled ? query : undefined,
  );
  return {
    enabled,
    categories,
    selectCategory(category: SlashTemplateCategory): void {
      const mode = createModeForCategory(category);
      if (mode) {
        selectCreate(mode);
        return;
      }
      openTemplatePicker({ kind: "insert", category });
    },
    highlighted:
      enabled && selection.selectedIndex < categories.length
        ? (categories[selection.selectedIndex] ?? null)
        : null,
    highlight(category: SlashTemplateCategory | null): void {
      const index = category === null ? -1 : categories.indexOf(category);
      // A row with no index (a workflow) parks the selection past the head so
      // the pane closes without pointing the keyboard at a category.
      selection.setSelectedIndex(index < 0 ? categories.length : index);
    },
    selectTemplate(preview: SlashTemplatePreview): void {
      insertTemplate(preview.template, preview.attachment);
      selection.close();
    },
    /**
     * The import attaches the deck and sends, which navigates away from the
     * page that started it, so it owns the root signal rather than a page
     * signal — the same reason the picker dialog's import card does.
     */
    importDeck(file: File): void {
      selection.close();
      detach(
        runDeckImport({ signals: composer, file }, rootSignal),
        Reason.DomCallback,
      );
    },
    browseAll(): void {
      openTemplatePicker({ kind: "insert", category: "slides" });
    },
  };
}

function useComposerWorkflowSuggestions(
  composer: ComposerSignals,
  query: string | undefined,
) {
  const workflowsLoadable = useLastLoadable(composer.workflow.workflows$);
  const fuzzyWorkflows =
    useGet(featureSwitch$)[FeatureSwitchKey.ComposerWorkflowFuzzySearch] ===
    true;
  const workflows = buildComposerSlashWorkflows({
    agentId: composer.agentId,
    workflows:
      workflowsLoadable.state === "hasData" ? workflowsLoadable.data : [],
  });
  return {
    workflows:
      query === undefined
        ? []
        : findWorkflowQueryMatches(workflows, query, fuzzyWorkflows),
    loading: workflowsLoadable.state === "loading",
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
    chatThreadRange,
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
  readonly panelEnabled: boolean;
  readonly panelCategories: readonly SlashTemplateCategory[];
  readonly createModes: readonly ComposerCreateCommand[];
  /** How many rows sit above the workflow suggestions. */
  readonly headCount: number;
  readonly workflows: readonly ComposerSlashWorkflowMatch[];
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
}

interface SuggestionRowActions {
  readonly selectCategory: (category: SlashTemplateCategory) => void;
  readonly selectCreate: (mode: ComposerCreateCommand) => void;
  readonly insertWorkflow: (workflow: ComposerSlashWorkflow) => void;
  readonly insertAgent: (agent: ComposerAgentSuggestion) => void;
  readonly insertChatThread: (chatThread: ComposerChatThreadSuggestion) => void;
}

/** The head row for an index, whichever of the two menus is rendered. */
function suggestionHeadRow(
  index: number,
  rows: SuggestionRows,
): SlashTemplateCategory | ComposerCreateCommand | undefined {
  return rows.panelEnabled
    ? rows.panelCategories[index]
    : rows.createModes[index];
}

function selectSlashSuggestionRow(
  index: number,
  rows: SuggestionRows,
  actions: SuggestionRowActions,
): void {
  if (rows.panelEnabled) {
    const category = rows.panelCategories[index];
    if (category) {
      actions.selectCategory(category);
      return;
    }
  } else {
    const mode = rows.createModes[index];
    if (mode) {
      actions.selectCreate(mode);
      return;
    }
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
  const head = suggestionHeadRow(index, rows);
  return head === undefined
    ? rows.workflows[index - rows.headCount]
    : { id: head };
}

function useComposerSuggestionMenu({
  composer,
  onKeyDown,
}: {
  readonly composer: ComposerSignals;
  readonly onKeyDown: (event: KeyboardEventLike) => void;
}): ComposerSuggestionMenuState {
  const selectCreate = useSet(composer.create.selectCommand$);
  const setCreateMode = useSet(composer.create.setMode$);
  const choosing = useGet(composer.create.choosing$);
  const slashRange = useGet(composer.suggestion.activeSlashRange$);
  const selectedTask = useGet(composer.taskChips.task$);
  const selectTask = useSet(composer.taskChips.selectTask$);
  const flatCreateModes = useComposerCreateSuggestions(
    composer,
    slashRange?.query,
  );
  const selectedIndex = useGet(composer.suggestion.selectedSuggestionIndex$);
  const setSelectedIndex = useSet(
    composer.suggestion.setSelectedSuggestionIndex$,
  );
  const close = useSet(composer.suggestion.closeSuggestionMenu$);
  const templatePanel = useSlashTemplatePanelActions(
    composer,
    slashRange?.query,
    { selectedIndex, setSelectedIndex, close },
  );
  const templatePanelEnabled = templatePanel.enabled;
  const panelCategories = templatePanel.categories;
  // The panel replaces the flat Create group, so only one of the two occupies
  // the indexes ahead of the workflow suggestions.
  const createModes = templatePanelEnabled ? [] : flatCreateModes;
  const insertWorkflow = useSet(composer.workflow.insertWorkflow$);
  const insertAgent = useSet(composer.suggestion.insertAgent$);
  const insertChatThread = useSet(composer.suggestion.insertChatThread$);
  const workflowResult = useComposerWorkflowSuggestions(
    composer,
    slashRange?.query,
  );
  const workflowSuggestions = workflowResult.workflows;
  const showWorkflows = slashRange !== null;
  const mentions = useComposerMentionSuggestions(composer, slashRange);
  const { agents, chatThreads, chatThreadRange, showMentions } = mentions;
  const open = showWorkflows || showMentions;
  const range = showWorkflows
    ? slashRange
    : showMentions
      ? chatThreadRange
      : null;
  const headCount = templatePanelEnabled
    ? panelCategories.length
    : createModes.length;
  const suggestionCount = showWorkflows
    ? headCount + workflowSuggestions.length
    : agents.length + chatThreads.length;

  const rows: SuggestionRows = {
    showWorkflows,
    panelEnabled: templatePanelEnabled,
    panelCategories,
    createModes,
    headCount,
    workflows: workflowSuggestions,
    agents,
    chatThreads,
  };

  function selectSuggestion(index: number): void {
    selectSuggestionRow(index, rows, {
      selectCategory: templatePanel.selectCategory,
      selectCreate,
      insertWorkflow,
      insertAgent,
      insertChatThread,
    });
  }

  function scrollSuggestionIntoView(index: number): void {
    if (showWorkflows) {
      scrollSlashWorkflowIntoView(suggestionRowScrollTarget(index, rows));
    }
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (event.key === "Escape" && choosing && !open) {
      event.preventDefault();
      setCreateMode(null);
      return true;
    }
    return handleComposerKeyDownCapture(event, {
      composer,
      selectedTask,
      selectTask,
      suggestionCount,
      selectedSuggestionIndex: selectedIndex,
      showSuggestionMenu: open,
      setSelectedSuggestionIndex: setSelectedIndex,
      closeSuggestionMenu: close,
      selectSuggestion,
      scrollSuggestionIntoView,
      onKeyDown,
    });
  }

  return {
    open,
    range,
    selectedIndex,
    close,
    workflows: workflowSuggestions,
    createModes,
    selectCreate,
    panelCategories,
    highlightedCategory: templatePanel.highlighted,
    highlightCategory: templatePanel.highlight,
    selectCategory: templatePanel.selectCategory,
    selectTemplate: templatePanel.selectTemplate,
    importDeck: templatePanel.importDeck,
    browseAllTemplates: templatePanel.browseAll,
    showTemplatePanel: templatePanelEnabled,
    workflowsLoading: workflowResult.loading,
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

export function TiptapWorkflowComposer({
  signals,
  onDraftChange,
  sending,
  onKeyDown,
  onPaste,
}: TiptapWorkflowComposerProps) {
  const composer = signals;
  const suggestionMenu = useComposerSuggestionMenu({
    composer,
    onKeyDown,
  });
  const insertPromptMarkdown = useSet(composer.editor.insertPromptMarkdown$);
  const setContainerRef = useSet(composer.editor.setContainerRef$);

  function handlePaste(
    event: ClipboardEvent,
    currentTarget: HTMLElement,
  ): boolean {
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
  }

  return (
    <Popover
      open={suggestionMenu.open}
      onOpenChange={(open) => {
        if (!open) {
          suggestionMenu.close();
        }
      }}
    >
      <div className="relative min-h-full">
        <WorkflowComposerPlaceholder composer={composer} sending={sending} />
        <div
          // The composer card owns responsive height allocation so its footer
          // can change modes without changing the surrounding card height.
          className="min-h-full [&_.ProseMirror]:min-h-full"
          ref={setContainerRef}
          onInput={(event) => {
            // The mount command targets the container for semantic document
            // changes; native contenteditable input targets ProseMirror.
            if (event.target === event.currentTarget) {
              onDraftChange?.();
            }
          }}
          onKeyDownCapture={(event) => {
            const nativeEvent = event.nativeEvent;
            const handled = suggestionMenu.handleKeyDown(nativeEvent);
            if (handled || nativeEvent.defaultPrevented) {
              event.stopPropagation();
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
      </div>
      {suggestionMenu.showWorkflows && (
        <SlashWorkflowMenu
          anchor={composerSuggestionCaretAnchor(
            composer.editor.editor,
            suggestionMenu.range,
          )}
          workflows={suggestionMenu.workflows}
          createModes={suggestionMenu.createModes}
          onSelectCreate={suggestionMenu.selectCreate}
          loading={suggestionMenu.workflowsLoading}
          selectedIndex={suggestionMenu.selectedIndex}
          showWorkflowsPageLink
          onSelect={suggestionMenu.selectWorkflow}
          panel={
            suggestionMenu.showTemplatePanel ? (
              <SlashTemplatePanel
                categories={suggestionMenu.panelCategories}
                workflows={suggestionMenu.workflows}
                workflowsLoading={suggestionMenu.workflowsLoading}
                highlighted={suggestionMenu.highlightedCategory}
                onHighlight={suggestionMenu.highlightCategory}
                onSelectCategory={suggestionMenu.selectCategory}
                onSelectTemplate={suggestionMenu.selectTemplate}
                onImportDeck={suggestionMenu.importDeck}
                onSelectWorkflow={suggestionMenu.selectWorkflow}
                onBrowseAll={suggestionMenu.browseAllTemplates}
                workflowOptionId={slashWorkflowOptionId}
                categoryOptionId={slashWorkflowOptionId}
              />
            ) : undefined
          }
        />
      )}
      {suggestionMenu.showMentions && (
        <ComposerMentionSuggestionMenu
          anchor={composerSuggestionCaretAnchor(
            composer.editor.editor,
            suggestionMenu.range,
          )}
          agents={suggestionMenu.agents}
          chatThreads={suggestionMenu.chatThreads}
          selectedIndex={suggestionMenu.selectedIndex}
          onSelectAgent={suggestionMenu.selectAgent}
          onSelectChatThread={suggestionMenu.selectChatThread}
        />
      )}
    </Popover>
  );
}
