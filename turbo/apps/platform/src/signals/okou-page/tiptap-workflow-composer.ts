import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { Editor, Extension, Node, type JSONContent } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Dropcursor, Gapcursor, UndoRedo } from "@tiptap/extensions";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type NodeView } from "@tiptap/pm/view";
import { createCompositionGate, type CompositionGate } from "@okouai/ui";
import {
  generationTemplateRequestSchema,
  type GenerationTemplateRequest,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import {
  VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS,
  type VoiceIoEditorContext,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  BRAND_MOTION_TEMPLATE_ITEMS,
  isBrandMotionTemplateReady,
} from "@okouai/core/brand-motion-template-items";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { agents$ } from "../agent.ts";
import { currentChatAgentRecordId$ } from "../agent-chat.ts";
import { onRef, resetSignal } from "../utils.ts";
import type { DraftInputSyncTarget, DraftSignals } from "./chat-draft.ts";
import {
  createComposerFeedbackModel,
  formatFeedbackPrompt,
  type ComposerFeedbackModel,
  type ComposerFeedbackSignals,
  type FeedbackItem,
} from "./chat-feedback.ts";
import {
  findActiveChatThreadSuggestionRange,
  serializeChatThreadMention,
  splitChatThreadMentionSegments,
  type ChatThreadSuggestionRange,
  type ComposerChatThreadSuggestion,
} from "./chat-thread-suggestion-domain.ts";
import {
  splitAgentMentionSegments,
  type ComposerAgentSuggestion,
} from "./composer-agent-suggestion-domain.ts";
import {
  avatarFramingEnabled$,
  avatarNeckSweaterEnabled$,
  featureSwitch$,
} from "../external/feature-switch.ts";
import { observeFeatureSwitchChanges$ } from "../external/feature-switch-state.ts";
import {
  agentMentionText,
  createAgentMentionAvatarRuntime,
  createAgentMentionNode,
  type AgentMentionAvatarRuntime,
} from "./composer-agent-mention-node.ts";
import {
  createComposerChatThreadSuggestions,
  type ComposerChatThreadSuggestionResult,
} from "./composer-chat-thread-suggestions.ts";
import {
  buildComposerSlashWorkflows,
  findActiveSlashWorkflowRange,
  workflowTokenPattern,
  type ComposerSlashWorkflow,
  type SlashWorkflowRange,
} from "./workflow-composer-domain.ts";
import {
  AGENT_MENTION_NODE_NAME,
  CHAT_THREAD_MENTION_NODE_NAME,
  createEditorDocumentSnapshot,
  draftToEditorDoc,
  INLINE_TEMPLATE_NODE_NAME,
  messageDocumentToEditorDoc,
  TEMPLATE_ATTACHMENT_NODE_NAME,
  type EditorDocumentSnapshot,
} from "./user-message-document-codec.ts";
import {
  createTemplatePreviewRuntime,
  type TemplatePreviewRuntime,
} from "./template-preview-runtime.ts";
import { createComposerWorkflows } from "./composer-workflows.ts";
import type { OpenTemplatePickerDialogCommand } from "./chat-composer.ts";
import { reloadWorkflowData$ } from "../workflows-page/workflow-reload.ts";
import { i18n } from "../../i18n/index.ts";

type AgentIdValue = string | null | Promise<string | null>;
type WorkflowNamesSyncCommand = Command<
  Promise<void>,
  [AbortSignal, AbortSignal]
>;
type AgentMentionAvatarsSyncCommand = Command<Promise<void>, [AbortSignal]>;

interface MountedWorkflowNamesSync {
  readonly command$: WorkflowNamesSyncCommand;
  readonly mountSignal: AbortSignal;
}

const mountedWorkflowNamesSyncs$ = state<ReadonlySet<MountedWorkflowNamesSync>>(
  new Set(),
);

const brandMotionPreviewEnabled$ = computed((get) => {
  return (
    get(featureSwitch$)[FeatureSwitchKey.BrandMotion] &&
    BRAND_MOTION_TEMPLATE_ITEMS.some(isBrandMotionTemplateReady)
  );
});

const registerMountedWorkflowNamesSync$ = command(
  ({ get, set }, mountedWorkflowNamesSync: MountedWorkflowNamesSync): void => {
    const current = get(mountedWorkflowNamesSyncs$);
    if (current.has(mountedWorkflowNamesSync)) {
      return;
    }
    const next = new Set(current);
    next.add(mountedWorkflowNamesSync);
    set(mountedWorkflowNamesSyncs$, next);
  },
);

const unregisterMountedWorkflowNamesSync$ = command(
  ({ get, set }, mountedWorkflowNamesSync: MountedWorkflowNamesSync): void => {
    const current = get(mountedWorkflowNamesSyncs$);
    if (!current.has(mountedWorkflowNamesSync)) {
      return;
    }
    const next = new Set(current);
    next.delete(mountedWorkflowNamesSync);
    set(mountedWorkflowNamesSyncs$, next);
  },
);

export const reloadMountedComposerWorkflows$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(reloadWorkflowData$);
    const pendingSyncs: Promise<void>[] = [];
    for (const mountedWorkflowNamesSync of get(mountedWorkflowNamesSyncs$)) {
      if (mountedWorkflowNamesSync.mountSignal.aborted) {
        continue;
      }
      pendingSyncs.push(
        set(
          mountedWorkflowNamesSync.command$,
          mountedWorkflowNamesSync.mountSignal,
          signal,
        ),
      );
    }
    await Promise.all(pendingSyncs);
    signal.throwIfAborted();
  },
);

const EDITOR_CONTENT_CLASS =
  // Let the editor grow to 40% of the viewport, capped at 320px, then scroll
  // before it crowds out the chat message history.
  "w-full max-h-[min(40vh,320px)] overflow-y-auto whitespace-pre-wrap " +
  "break-words px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-foreground " +
  "caret-foreground outline-none focus:outline-none [&_p]:m-0 " +
  "selection:bg-primary/20";

const WORKFLOW_HIGHLIGHT_CLASS = "text-brand-text";
function composerPlaceholder(): string {
  return i18n.t(($) => {
    return $.chat.composer.placeholder;
  });
}

interface WorkflowHighlightStorage {
  workflowNames: readonly string[];
}

export interface WorkflowComposerSubmissionSnapshot {
  readonly prompt: string;
  readonly editorDocument: EditorDocumentSnapshot;
}

export interface WorkflowComposerSignals {
  readonly editor: Editor;
  readonly templatePreview: TemplatePreviewRuntime;
  readonly setContainerRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  readonly focus$: Command<void, []>;
  readonly hasInput$: Computed<boolean>;
  readonly hasTemplateAttachment$: Computed<boolean>;
  readonly templateRequests$: Computed<readonly GenerationTemplateRequest[]>;
  readonly activeSlashRange$: Computed<SlashWorkflowRange | null>;
  readonly activeChatThreadSuggestionRange$: Computed<ChatThreadSuggestionRange | null>;
  readonly chatThreadSuggestions$: Computed<
    Promise<ComposerChatThreadSuggestionResult>
  >;
  readonly agentId$: Computed<Promise<string | null>>;
  readonly workflows$: Computed<Promise<readonly WorkflowSummary[]>>;
  readonly reloadWorkflows$: Command<Promise<void>, [AbortSignal]>;
  readonly selectedSuggestionIndex$: Computed<number>;
  readonly setSelectedSuggestionIndex$: Command<void, [number]>;
  readonly previewSuggestionIndex$: Computed<number>;
  readonly previewSuggestion$: Command<void, [number | null]>;
  readonly closeSuggestionMenu$: Command<void, []>;
  readonly insertWorkflow$: Command<void, [ComposerSlashWorkflow]>;
  readonly insertAgent$: Command<void, [ComposerAgentSuggestion]>;
  readonly insertChatThread$: Command<void, [ComposerChatThreadSuggestion]>;
  readonly insertPromptMarkdown$: Command<void, [string]>;
  readonly insertUserMessage$: Command<void, [UserMessageDocument]>;
  readonly insertTemplate$: Command<
    void,
    [GenerationTemplateRequest, ComposerTemplateAttachment]
  >;
  readonly openTemplatePicker$: Command<
    void,
    [OpenComposerTemplatePickerIntent]
  >;
  readonly insertText$: Command<void, [string]>;
  readonly readVoiceContext$: Command<VoiceIoEditorContext, []>;
  readonly appendText$: Command<void, [string]>;
  readonly selectOrAppendText$: Command<void, [string]>;
  readonly readInputForSubmission$: Command<
    Promise<WorkflowComposerSubmissionSnapshot>,
    [AbortSignal]
  >;
  readonly feedback: ComposerFeedbackSignals;
}

export type OpenComposerTemplatePickerIntent =
  | { readonly kind: "insert"; readonly category: string }
  | {
      readonly kind: "edit-selected";
      readonly category: string;
      readonly position: number;
    }
  | { readonly kind: "edit-legacy"; readonly category: string };

export type ComposerTemplateAttachmentType =
  | "presentation"
  | "illustration"
  | "video"
  | "brand-motion"
  | "avatar"
  | "workflow"
  | "website";

export interface ComposerTemplateAttachment {
  readonly type: ComposerTemplateAttachmentType;
  readonly title: string;
  readonly category: string;
  readonly previewImageUrl?: string;
}

function createComposerAgentResources<T extends AgentIdValue>(
  agentIdSource$: Computed<T>,
) {
  const agentId$ = computed(async (get): Promise<string | null> => {
    return await get(agentIdSource$);
  });
  return { agentId$, workflows$: createComposerWorkflows(agentId$) };
}

function connectComposerFeedback(
  feedback: ComposerFeedbackModel,
  editor: Editor,
): void {
  feedback.connectEditor({
    insertItem(item) {
      insertFeedbackItem(editor, item);
    },
    removeItem(id) {
      removeFeedbackItem(editor, id);
    },
  });
}

function createReadInputForSubmissionCommand(
  editor: Editor,
  compositionGate: CompositionGate,
) {
  return command((_context, signal: AbortSignal) => {
    return compositionGate.runWhenSettled(() => {
      return {
        prompt: workflowComposerDocToString(editor),
        editorDocument: createEditorDocumentSnapshot(editor.state.doc),
      };
    }, signal);
  });
}

const FEEDBACK_ITEM_NODE_NAME = "feedbackItem";
const COMPOSER_INLINE_REFERENCE_CLASS =
  "relative -top-px mx-0.5 inline-flex h-7 max-w-full select-none items-center " +
  "gap-1.5 whitespace-nowrap rounded-md bg-orange-500/10 px-2 align-middle " +
  "text-[13px] font-medium text-orange-600 transition-colors " +
  "hover:bg-orange-500/15 dark:bg-orange-400/15 dark:text-orange-300 " +
  "dark:hover:bg-orange-400/20 data-[selected]:bg-orange-500/15 " +
  "data-[selected]:ring-1 data-[selected]:ring-inset " +
  "data-[selected]:ring-orange-500/40 dark:data-[selected]:bg-orange-400/20 " +
  "dark:data-[selected]:ring-orange-300/40";

/**
 * Same surface as COMPOSER_INLINE_REFERENCE_CLASS with the padding and hover
 * moved onto the zones below, so each half of a split chip reacts on its own.
 */
const INLINE_TEMPLATE_CHIP_CLASS =
  "relative -top-px mx-0.5 inline-flex h-7 max-w-full select-none items-center " +
  "overflow-hidden whitespace-nowrap rounded-md bg-orange-500/10 align-middle " +
  "text-[13px] font-medium text-orange-600 transition-colors " +
  "dark:bg-orange-400/15 dark:text-orange-300 data-[selected]:bg-orange-500/15 " +
  "data-[selected]:ring-1 data-[selected]:ring-inset " +
  "data-[selected]:ring-orange-500/40 dark:data-[selected]:bg-orange-400/20 " +
  "dark:data-[selected]:ring-orange-300/40";

const INLINE_TEMPLATE_NAME_ZONE_CLASS =
  "flex h-full min-w-0 items-center gap-1.5 px-2 text-orange-600 " +
  "transition-colors dark:text-orange-300 " +
  "hover:bg-orange-500/15 focus-visible:outline-none focus-visible:ring-1 " +
  "focus-visible:ring-inset focus-visible:ring-orange-500/40 " +
  "dark:hover:bg-orange-400/20 dark:focus-visible:ring-orange-300/40 " +
  "disabled:pointer-events-none disabled:opacity-50";

interface ChatThreadMentionAttributes {
  readonly threadId: string;
  readonly title: string;
}

function chatThreadMentionAttributes(
  node: ProseMirrorNode,
): ChatThreadMentionAttributes {
  const threadId: unknown = node.attrs.threadId;
  const title: unknown = node.attrs.title;
  if (typeof threadId !== "string" || typeof title !== "string") {
    throw new Error("Chat thread mention node attributes are invalid");
  }
  return { threadId, title };
}

function chatThreadMentionText(node: ProseMirrorNode): string {
  const { threadId, title } = chatThreadMentionAttributes(node);
  return serializeChatThreadMention(threadId, title);
}

function createChatThreadMentionNodeView(node: ProseMirrorNode): NodeView {
  const dom = document.createElement("span");
  dom.className = COMPOSER_INLINE_REFERENCE_CLASS;
  dom.contentEditable = "false";
  dom.style.outline = "none";
  dom.style.userSelect = "none";
  const icon = createComposerIcon(13, 1.7, [
    "M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1",
  ]);
  icon.setAttribute("class", "shrink-0");
  const title = document.createElement("span");
  title.className = "min-w-0 select-none truncate";
  dom.append(icon, title);

  let currentNode = node;
  function render(nextNode: ProseMirrorNode): void {
    const attributes = chatThreadMentionAttributes(nextNode);
    dom.dataset.chatThreadMention = attributes.threadId;
    title.textContent = attributes.title;
  }
  render(node);

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    selectNode() {
      dom.dataset.selected = "";
    },
    deselectNode() {
      delete dom.dataset.selected;
    },
    ignoreMutation() {
      return true;
    },
  };
}

const ChatThreadMentionNode = Node.create({
  name: CHAT_THREAD_MENTION_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      threadId: { default: "" },
      title: { default: "" },
    };
  },
  parseHTML() {
    return [
      {
        tag: "span[data-chat-thread-mention]",
        getAttrs: (element) => {
          return {
            threadId: element.dataset.chatThreadMention ?? "",
            title: element.textContent ?? "",
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const { threadId, title } = chatThreadMentionAttributes(node);
    return [
      "span",
      {
        "data-chat-thread-mention": threadId,
        class: COMPOSER_INLINE_REFERENCE_CLASS,
      },
      title,
    ];
  },
  renderText({ node }) {
    return chatThreadMentionText(node);
  },
  addNodeView() {
    return ({ node }) => {
      return createChatThreadMentionNodeView(node);
    };
  },
});

interface FeedbackItemNodeAttributes {
  readonly feedbackId: number;
  readonly quote: string;
  readonly showDivider: boolean;
  readonly fill: boolean;
  readonly eventId: string | null;
  readonly rangeStart: number | null;
  readonly rangeEnd: number | null;
  readonly sourceType: "mail" | null;
  readonly sourceId: string | null;
  readonly sourceStatus: "draft" | "sent" | null;
  readonly sourceSentId: string | null;
}

interface FeedbackItemLocationAttributes {
  readonly eventId: string | null;
  readonly rangeStart: number | null;
  readonly rangeEnd: number | null;
}

function feedbackItemLocationAttributes(
  node: ProseMirrorNode,
): FeedbackItemLocationAttributes {
  const eventId: unknown = node.attrs.eventId;
  const rangeStart: unknown = node.attrs.rangeStart;
  const rangeEnd: unknown = node.attrs.rangeEnd;
  if (eventId === null && rangeStart === null && rangeEnd === null) {
    return { eventId, rangeStart, rangeEnd };
  }
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof rangeStart !== "number" ||
    !Number.isInteger(rangeStart) ||
    rangeStart < 0 ||
    typeof rangeEnd !== "number" ||
    !Number.isInteger(rangeEnd) ||
    rangeEnd <= rangeStart
  ) {
    throw new Error("Feedback item node attributes are invalid");
  }
  return { eventId, rangeStart, rangeEnd };
}

function feedbackItemNodeAttributes(
  node: ProseMirrorNode,
): FeedbackItemNodeAttributes {
  const feedbackId: unknown = node.attrs.feedbackId;
  const quote: unknown = node.attrs.quote;
  const showDivider: unknown = node.attrs.showDivider;
  const fill: unknown = node.attrs.fill;
  const location = feedbackItemLocationAttributes(node);
  const sourceType: unknown = node.attrs.sourceType;
  const sourceId: unknown = node.attrs.sourceId;
  const sourceStatus: unknown = node.attrs.sourceStatus;
  const sourceSentId: unknown = node.attrs.sourceSentId;
  if (
    typeof feedbackId !== "number" ||
    typeof quote !== "string" ||
    typeof showDivider !== "boolean" ||
    typeof fill !== "boolean" ||
    (sourceType !== null && sourceType !== "mail") ||
    (sourceId !== null && typeof sourceId !== "string") ||
    (sourceStatus !== null &&
      sourceStatus !== "draft" &&
      sourceStatus !== "sent") ||
    (sourceSentId !== null && typeof sourceSentId !== "string") ||
    (sourceType === null) !== (sourceId === null) ||
    (sourceType === null) !== (sourceStatus === null) ||
    (sourceType === null && sourceSentId !== null)
  ) {
    throw new Error("Feedback item node attributes are invalid");
  }
  return {
    feedbackId,
    quote,
    showDivider,
    fill,
    ...location,
    sourceType,
    sourceId,
    sourceStatus,
    sourceSentId,
  };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function createComposerIcon(
  size: number,
  strokeWidth: number,
  paths: readonly string[],
): SVGSVGElement {
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("width", String(size));
  icon.setAttribute("height", String(size));
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", String(strokeWidth));
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const pathData of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  }
  return icon;
}

interface FeedbackQuoteChip {
  readonly quoteDom: HTMLDivElement;
  readonly quoteText: HTMLSpanElement;
  readonly removeButton: HTMLButtonElement;
}

function createFeedbackQuoteChip(): FeedbackQuoteChip {
  const quoteDom = document.createElement("div");
  quoteDom.className = "flex";
  quoteDom.contentEditable = "false";
  const quoteChip = document.createElement("div");
  quoteChip.className =
    "inline-flex h-8 max-w-full items-center gap-2 rounded-lg border " +
    "border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground " +
    "shadow-[0_1px_2px_rgba(15,23,42,0.05)]";
  const quoteIconContainer = document.createElement("span");
  quoteIconContainer.className =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted";
  const quoteIcon = createComposerIcon(12, 1.5, [
    "M10 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
    "M19 11h-4a1 1 0 0 1 -1 -1v-3a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v6c0 2.667 -1.333 4.333 -4 5",
  ]);
  quoteIcon.setAttribute("class", "-scale-x-100 text-muted-foreground");
  quoteIconContainer.append(quoteIcon);
  const quoteText = document.createElement("span");
  quoteText.className = "min-w-0 truncate text-xs font-medium";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md " +
    "text-muted-foreground/70 transition-colors hover:bg-muted " +
    "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-ring";
  removeButton.append(
    createComposerIcon(14, 1.8, ["M18 6l-12 12", "M6 6l12 12"]),
  );
  quoteChip.append(quoteIconContainer, quoteText, removeButton);
  quoteDom.append(quoteChip);
  return { quoteDom, quoteText, removeButton };
}

/**
 * The quote block's node view dom is the content element, so every
 * mutation anywhere in the block is visible to ProseMirror and its default
 * dirty-node redraw self-heals any damage the browser causes (#27787). The
 * quote chip and the placeholder are not part of this view at all — they are
 * a widget decoration, which ProseMirror renders non-editable, preserves
 * across redraws, and skips when re-parsing the DOM.
 */
function createFeedbackItemNodeView(
  node: ProseMirrorNode,
  localizedUi: Set<() => void>,
): NodeView {
  const dom = document.createElement("div");
  dom.dataset.feedbackItem = "";
  dom.dataset.feedbackNote = "";
  dom.setAttribute("role", "textbox");
  dom.setAttribute("aria-multiline", "true");

  let currentNode = node;
  function localize(): void {
    dom.setAttribute(
      "aria-label",
      i18n.t(($) => {
        return $.chat.feedback.placeholder;
      }),
    );
  }
  function render(nextNode: ProseMirrorNode): void {
    const { showDivider, fill } = feedbackItemNodeAttributes(nextNode);
    // The chrome widget occupies the first 38px (chip row plus gap), so the
    // note area of a filled item keeps its 96px: 38 + 96 = 134.
    const className =
      "flex flex-col gap-1.5 pb-1.5 text-[0.9375rem] leading-snug " +
      "text-foreground outline-none [&_p]:m-0 [&_p]:px-1 " +
      "[&_p:nth-of-type(1)]:pt-1 [&_p:last-of-type]:pb-1" +
      `${fill ? " min-h-[134px]" : ""}${
        showDivider ? " border-t border-dashed border-border/60 pt-1.5" : ""
      }`;
    if (dom.className !== className) {
      dom.className = className;
    }
  }
  localizedUi.add(localize);
  localize();
  render(currentNode);

  return {
    dom,
    contentDOM: dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    destroy() {
      localizedUi.delete(localize);
    },
  };
}

function buildFeedbackItemChrome(
  quote: string,
  onRemove: () => void,
): HTMLElement {
  const { quoteDom, quoteText, removeButton } = createFeedbackQuoteChip();
  quoteText.textContent = quote;
  const removeLabel = i18n.t(($) => {
    return $.chat.feedback.remove;
  });
  removeButton.setAttribute("aria-label", removeLabel);
  removeButton.title = removeLabel;
  removeButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  removeButton.addEventListener("click", onRemove);
  return quoteDom;
}

// Rendered through ::before so an empty note never gains or loses real DOM
// nodes: the placeholder text lives in an attribute and appears via CSS.
const FEEDBACK_PLACEHOLDER_PARAGRAPH_CLASS =
  "before:pointer-events-none before:float-left before:h-0 " +
  "before:text-muted-foreground/80 " +
  "before:content-[attr(data-placeholder)]";

function buildFeedbackChromeDecorations(
  doc: ProseMirrorNode,
  runtime: WorkflowComposerRuntime,
): DecorationSet {
  const decorations: Decoration[] = [];
  let position = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const child = doc.child(index);
    const childPosition = position;
    position += child.nodeSize;
    if (child.type.name !== FEEDBACK_ITEM_NODE_NAME) {
      continue;
    }
    const { feedbackId, quote } = feedbackItemNodeAttributes(child);
    decorations.push(
      Decoration.widget(
        childPosition + 1,
        () => {
          return buildFeedbackItemChrome(quote, () => {
            runtime.removeFeedback(feedbackId);
          });
        },
        {
          // The key must stay stable while the user types: recreating the
          // widget replaces a contenteditable=false element right next to the
          // caret, and WebKit loses the caret when that happens at an IME
          // composition boundary (typing or backspacing the first character).
          key: `feedback-chrome-${feedbackId}-${i18n.language}`,
          side: -2,
          ignoreSelection: true,
          stopEvent: () => {
            return true;
          },
        },
      ),
    );
    if (nodeText(child).length === 0) {
      decorations.push(
        Decoration.node(
          childPosition + 1,
          childPosition + 1 + child.child(0).nodeSize,
          {
            class: FEEDBACK_PLACEHOLDER_PARAGRAPH_CLASS,
            "data-placeholder": i18n.t(($) => {
              return $.chat.feedback.placeholder;
            }),
          },
        ),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

function createFeedbackChromePlugin(runtime: WorkflowComposerRuntime): Plugin {
  return new Plugin({
    key: new PluginKey("feedbackItemChrome"),
    props: {
      decorations(state) {
        return buildFeedbackChromeDecorations(state.doc, runtime);
      },
    },
  });
}

function createFeedbackTextSelectionPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("feedbackTextSelection"),
    appendTransaction(_transactions, previous, current) {
      const { selection } = current;
      if (!(selection instanceof GapCursor)) {
        return null;
      }

      const { $head } = selection;
      if ($head.depth !== 0) {
        return null;
      }
      const before = $head.nodeBefore?.type.name;
      const after = $head.nodeAfter?.type.name;
      if (
        before !== FEEDBACK_ITEM_NODE_NAME &&
        after !== FEEDBACK_ITEM_NODE_NAME
      ) {
        return null;
      }

      // Legacy block templates still need their surrounding insertion points.
      if (
        before === TEMPLATE_ATTACHMENT_NODE_NAME ||
        after === TEMPLATE_ATTACHMENT_NODE_NAME
      ) {
        return null;
      }

      // Keep keyboard and pointer navigation on editable feedback text. At
      // either document edge, stay in the nearest existing paragraph.
      const direction = selection.head < previous.selection.head ? -1 : 1;
      const next =
        Selection.findFrom($head, direction, true) ??
        Selection.findFrom($head, -direction, true);
      return next instanceof TextSelection
        ? current.tr.setSelection(next).setMeta("addToHistory", false)
        : null;
    },
  });
}

function templateAttachmentNodeAttributes(
  node: ProseMirrorNode,
): ComposerTemplateAttachment {
  const type: unknown = node.attrs.templateType;
  const title: unknown = node.attrs.title;
  const category: unknown = node.attrs.category;
  const previewImageUrl: unknown = node.attrs.previewImageUrl;
  if (
    (type !== "presentation" &&
      type !== "illustration" &&
      type !== "video" &&
      type !== "brand-motion" &&
      type !== "avatar" &&
      type !== "workflow" &&
      type !== "website") ||
    typeof title !== "string" ||
    typeof category !== "string" ||
    (previewImageUrl !== null && typeof previewImageUrl !== "string")
  ) {
    throw new Error("Template attachment node attributes are invalid");
  }
  return {
    type,
    title,
    category,
    ...(previewImageUrl === null ? {} : { previewImageUrl }),
  };
}

function templateAttachmentPreviewLabel(
  attachment: ComposerTemplateAttachment,
): string {
  if (attachment.type === "video") {
    return i18n.t(
      ($) => {
        return $.chat.templates.previewVideo;
      },
      {
        title: attachment.title,
      },
    );
  }
  if (attachment.type === "workflow") {
    return i18n.t(
      ($) => {
        return $.chat.templates.previewWorkflow;
      },
      {
        title: attachment.title,
      },
    );
  }
  if (attachment.type === "website") {
    return i18n.t(
      ($) => {
        return $.chat.templates.previewWebsite;
      },
      {
        title: attachment.title,
      },
    );
  }
  return i18n.t(
    ($) => {
      return $.chat.templates.previewTemplate;
    },
    {
      title: attachment.title,
    },
  );
}

function templateAttachmentRemoveLabel(
  attachment: ComposerTemplateAttachment,
): string {
  if (attachment.type === "video") {
    return i18n.t(
      ($) => {
        return $.chat.templates.removeVideo;
      },
      {
        title: attachment.title,
      },
    );
  }
  if (attachment.type === "workflow") {
    return i18n.t(
      ($) => {
        return $.chat.templates.removeWorkflow;
      },
      {
        title: attachment.title,
      },
    );
  }
  if (attachment.type === "website") {
    return i18n.t(
      ($) => {
        return $.chat.templates.removeWebsite;
      },
      {
        title: attachment.title,
      },
    );
  }
  return i18n.t(
    ($) => {
      return $.chat.templates.removeTemplate;
    },
    {
      title: attachment.title,
    },
  );
}

function templateAttachmentTypeLabel(
  type: ComposerTemplateAttachmentType,
): string {
  if (type === "presentation") {
    return i18n.t(($) => {
      return $.chat.templates.categories.presentation;
    });
  }
  if (type === "illustration") {
    return i18n.t(($) => {
      return $.chat.templates.categories.illustration;
    });
  }
  if (type === "video") {
    return i18n.t(($) => {
      return $.chat.templates.categories.video;
    });
  }
  if (type === "brand-motion") {
    return i18n.t(($) => {
      return $.chat.templates.categories.brandMotion;
    });
  }
  if (type === "avatar") {
    return i18n.t(($) => {
      return $.artifacts.templates.avatar;
    });
  }
  if (type === "website") {
    return i18n.t(($) => {
      return $.chat.templates.categories.website;
    });
  }
  return i18n.t(($) => {
    return $.chat.templates.categories.workflow;
  });
}

function createTemplateAttachmentNodeView(
  node: ProseMirrorNode,
  openTemplate: (category: string) => void,
  removeTemplate: () => void,
  templateEnabled: (type: ComposerTemplateAttachmentType) => boolean,
  localizedUi: Set<() => void>,
): NodeView {
  const dom = document.createElement("div");
  dom.dataset.composerTemplateAttachment = "";
  dom.className = "flex pb-1.5";
  dom.contentEditable = "false";

  const chip = document.createElement("div");
  chip.className =
    "inline-flex h-8 max-w-full items-center gap-1 rounded-lg border " +
    "border-border/80 bg-background/90 pl-1 pr-1 text-foreground " +
    "shadow-[0_1px_2px_rgba(15,23,42,0.05)]";
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className =
    "flex min-w-0 items-center gap-2 rounded-md px-1 py-1 " +
    "transition-colors hover:bg-muted focus-visible:outline-none " +
    "focus-visible:ring-2 focus-visible:ring-ring " +
    "disabled:pointer-events-none disabled:opacity-50";
  const iconContainer = document.createElement("span");
  iconContainer.className =
    "flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden " +
    "rounded-md bg-muted";
  const typeText = document.createElement("span");
  typeText.className = "shrink-0 text-[11px] font-medium text-muted-foreground";
  const divider = document.createElement("span");
  divider.className = "h-3.5 w-px shrink-0 bg-divider/70";
  const titleText = document.createElement("span");
  titleText.className = "min-w-0 truncate text-xs font-medium";
  openButton.append(iconContainer, typeText, divider, titleText);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md " +
    "text-muted-foreground/70 transition-colors hover:bg-muted " +
    "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 " +
    "focus-visible:ring-ring";
  removeButton.append(
    createComposerIcon(14, 1.8, ["M18 6l-12 12", "M6 6l12 12"]),
  );
  chip.append(openButton, removeButton);
  dom.append(chip);

  let currentNode = node;
  function localize(): void {
    const attachment = templateAttachmentNodeAttributes(currentNode);
    openButton.disabled = !templateEnabled(attachment.type);
    openButton.setAttribute(
      "aria-label",
      templateAttachmentPreviewLabel(attachment),
    );
    const removeLabel = templateAttachmentRemoveLabel(attachment);
    removeButton.setAttribute("aria-label", removeLabel);
    removeButton.title = removeLabel;
    typeText.textContent = templateAttachmentTypeLabel(attachment.type);
  }
  function render(nextNode: ProseMirrorNode): void {
    const attachment = templateAttachmentNodeAttributes(nextNode);
    localize();
    titleText.textContent = attachment.title;
    iconContainer.replaceChildren();
    if (attachment.previewImageUrl) {
      const image = document.createElement("img");
      image.src = attachment.previewImageUrl;
      image.alt = "";
      image.className = "h-full w-full object-cover";
      iconContainer.append(image);
    } else {
      const icon = createComposerIcon(12, 1.5, [
        "M4 4h16v16h-16z",
        "M8 8h8",
        "M8 12h8",
        "M8 16h5",
      ]);
      icon.setAttribute("class", "text-muted-foreground");
      iconContainer.append(icon);
    }
  }
  openButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  openButton.addEventListener("click", () => {
    openTemplate(templateAttachmentNodeAttributes(currentNode).category);
  });
  removeButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  removeButton.addEventListener("click", removeTemplate);
  localizedUi.add(localize);
  render(currentNode);

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    stopEvent(event) {
      return (
        event.target instanceof globalThis.Node && dom.contains(event.target)
      );
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      localizedUi.delete(localize);
    },
  };
}

/**
 * A template chip names the template and nothing else. Every text-to-video
 * parameter is owned by the run now and is set from the composer's own
 * settings chip, so there is no second zone to edit here.
 */
interface InlineTemplateNodeActions {
  readonly openTemplate: (category: string) => void;
  readonly templateEnabled: (type: ComposerTemplateAttachmentType) => boolean;
  /** Read per render so a Lab toggle applies to the next mounted composer. */
  readonly coverEnabled: () => boolean;
}

function createInlineTemplateNodeView(
  node: ProseMirrorNode,
  actions: InlineTemplateNodeActions,
  localizedUi: Set<() => void>,
): NodeView {
  const dom = document.createElement("span");
  dom.dataset.composerInlineTemplate = "";
  dom.className = INLINE_TEMPLATE_CHIP_CLASS;
  dom.contentEditable = "false";
  dom.style.outline = "none";
  dom.style.userSelect = "none";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = INLINE_TEMPLATE_NAME_ZONE_CLASS;
  // The template was chosen from a grid of covers, so under
  // ComposerTemplateChipCover the chip leads with that cover. 18px inside this
  // 28px chip keeps the cover at the proportion the block template-attachment
  // chip above uses: a 20px cover inside its 32px chip.
  const glyph = document.createElement("span");
  glyph.className =
    "flex size-[18px] shrink-0 items-center justify-center overflow-hidden " +
    "rounded-[3px]";
  const cover = document.createElement("img");
  cover.alt = "";
  cover.className = "h-full w-full object-cover";
  // Mirrors Lucide's SwatchBook, which the composer template picker button and
  // sent-message template chips also use. It stands in whenever the cover is
  // switched off or the template's catalog entry carries no cover image.
  const icon = createComposerIcon(13, 1.7, [
    "M11 17a4 4 0 0 1-8 0V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Z",
    "M16.7 13H19a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7",
    "M 7 17h.01",
    "m11 8 2.3-2.3a2.4 2.4 0 0 1 3.404.004L18.6 7.6a2.4 2.4 0 0 1 .026 3.434L9.9 19.8",
  ]);
  const title = document.createElement("span");
  title.className =
    "min-w-0 select-none truncate text-[13px] font-medium text-orange-600 " +
    "dark:text-orange-300";
  openButton.append(glyph, title);
  dom.append(openButton);

  let currentNode = node;
  function render(nextNode: ProseMirrorNode): void {
    const attachment = templateAttachmentNodeAttributes(nextNode);
    openButton.disabled = !actions.templateEnabled(attachment.type);
    title.textContent = attachment.title;
    // The node is rewritten in place when the picker changes the selection, so
    // the cover has to follow the new attributes rather than only the first.
    const coverUrl = actions.coverEnabled()
      ? attachment.previewImageUrl
      : undefined;
    if (coverUrl === undefined) {
      glyph.replaceChildren(icon);
    } else {
      cover.src = coverUrl;
      glyph.replaceChildren(cover);
    }
    openButton.setAttribute(
      "aria-label",
      templateAttachmentPreviewLabel(attachment),
    );
  }
  // The zone labels are localized, so a locale switch has to re-render the
  // chip rather than only refresh its labels.
  function localize(): void {
    render(currentNode);
  }
  openButton.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  openButton.addEventListener("click", () => {
    actions.openTemplate(
      templateAttachmentNodeAttributes(currentNode).category,
    );
  });
  localizedUi.add(localize);
  render(currentNode);

  return {
    dom,
    update(nextNode) {
      if (nextNode.type !== currentNode.type) {
        return false;
      }
      currentNode = nextNode;
      render(nextNode);
      return true;
    },
    selectNode() {
      dom.dataset.selected = "";
    },
    deselectNode() {
      delete dom.dataset.selected;
    },
    stopEvent(event) {
      return (
        event.target instanceof globalThis.Node && dom.contains(event.target)
      );
    },
    ignoreMutation() {
      return true;
    },
    destroy() {
      localizedUi.delete(localize);
    },
  };
}

function feedbackNoteContent(note: string): JSONContent[] {
  return note.split("\n").map((line) => {
    return line.length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" };
  });
}

function feedbackNoteFromNode(node: ProseMirrorNode): string {
  return nodeText(node);
}

function feedbackItemFromNode(node: ProseMirrorNode): FeedbackItem {
  const attributes = feedbackItemNodeAttributes(node);
  return {
    id: attributes.feedbackId,
    quote: attributes.quote,
    note: feedbackNoteFromNode(node),
    ...(attributes.eventId !== null &&
    attributes.rangeStart !== null &&
    attributes.rangeEnd !== null
      ? {
          eventId: attributes.eventId,
          range: {
            start: attributes.rangeStart,
            end: attributes.rangeEnd,
          },
        }
      : {}),
    ...(attributes.sourceType === "mail" &&
    attributes.sourceId !== null &&
    attributes.sourceStatus !== null
      ? {
          source: {
            type: attributes.sourceType,
            id: attributes.sourceId,
            status: attributes.sourceStatus,
            ...(attributes.sourceSentId !== null
              ? { sentId: attributes.sourceSentId }
              : {}),
          },
        }
      : {}),
  };
}

function feedbackItemNode(editor: Editor, item: FeedbackItem): ProseMirrorNode {
  return editor.schema.nodeFromJSON({
    type: FEEDBACK_ITEM_NODE_NAME,
    attrs: {
      feedbackId: item.id,
      quote: item.quote,
      showDivider: false,
      fill: false,
      eventId: item.eventId ?? null,
      rangeStart: item.range?.start ?? null,
      rangeEnd: item.range?.end ?? null,
      sourceType: item.source?.type ?? null,
      sourceId: item.source?.id ?? null,
      sourceStatus: item.source?.status ?? null,
      sourceSentId: item.source?.sentId ?? null,
    },
    content: feedbackNoteContent(item.note),
  });
}

function withFeedbackItemLayout(transaction: Transaction): Transaction {
  const feedbackNodes: {
    readonly node: ProseMirrorNode;
    readonly position: number;
  }[] = [];
  let position = 0;
  for (let index = 0; index < transaction.doc.childCount; index++) {
    const node = transaction.doc.child(index);
    if (node.type.name === FEEDBACK_ITEM_NODE_NAME) {
      feedbackNodes.push({ node, position });
    }
    position += node.nodeSize;
  }
  for (const [index, feedbackNode] of feedbackNodes.entries()) {
    const { node, position: nodePosition } = feedbackNode;
    const attributes = feedbackItemNodeAttributes(node);
    const showDivider = index > 0;
    const fill = index === feedbackNodes.length - 1;
    if (attributes.showDivider === showDivider && attributes.fill === fill) {
      continue;
    }
    transaction.setNodeMarkup(nodePosition, undefined, {
      ...attributes,
      showDivider,
      fill,
    });
  }
  return transaction;
}

function isEmptyComposerDocument(document: ProseMirrorNode): boolean {
  return (
    document.childCount === 1 &&
    document.firstChild?.type.name === "paragraph" &&
    document.firstChild.content.size === 0
  );
}

function insertFeedbackItem(editor: Editor, item: FeedbackItem): void {
  const node = feedbackItemNode(editor, item);
  const transaction = isEmptyComposerDocument(editor.state.doc)
    ? editor.state.tr.replaceWith(0, editor.state.doc.content.size, node)
    : editor.state.tr.insert(editor.state.doc.content.size, node);
  editor.view.dispatch(withFeedbackItemLayout(transaction).scrollIntoView());
  editor.commands.focus("end");
}

function removeFeedbackItem(editor: Editor, id: number): void {
  let itemPosition: number | null = null;
  let itemSize = 0;
  let position = 0;
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (
      node.type.name === FEEDBACK_ITEM_NODE_NAME &&
      feedbackItemNodeAttributes(node).feedbackId === id
    ) {
      itemPosition = position;
      itemSize = node.nodeSize;
      break;
    }
    position += node.nodeSize;
  }
  if (itemPosition === null) {
    return;
  }
  const transaction = editor.state.tr.delete(
    itemPosition,
    itemPosition + itemSize,
  );
  if (transaction.doc.childCount === 0) {
    transaction.insert(0, editor.schema.node("paragraph"));
  }
  editor.view.dispatch(withFeedbackItemLayout(transaction).scrollIntoView());
}

function feedbackItemsFromWorkflowComposer(
  editor: Editor,
): readonly FeedbackItem[] {
  const items: FeedbackItem[] = [];
  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (node.type.name !== FEEDBACK_ITEM_NODE_NAME) {
      continue;
    }
    items.push(feedbackItemFromNode(node));
  }
  return items;
}

interface LocatedTemplateAttachment {
  readonly node: ProseMirrorNode;
  readonly position: number;
}

function locateTemplateAttachment(
  document: ProseMirrorNode,
): LocatedTemplateAttachment | null {
  let position = 0;
  for (let index = 0; index < document.childCount; index++) {
    const node = document.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      return { node, position };
    }
    position += node.nodeSize;
  }
  return null;
}

function removeTemplateAttachmentNode(editor: Editor): void {
  const located = locateTemplateAttachment(editor.state.doc);
  if (!located) {
    return;
  }
  const transaction = editor.state.tr.delete(
    located.position,
    located.position + located.node.nodeSize,
  );
  if (transaction.doc.childCount === 0) {
    transaction.insert(0, editor.schema.node("paragraph"));
  }
  editor.view.dispatch(transaction.scrollIntoView());
}

function agentMentionInlineContent(value: string): JSONContent[] {
  return splitAgentMentionSegments(value).map((segment): JSONContent => {
    return segment.type === "text"
      ? { type: "text", text: segment.text }
      : {
          type: AGENT_MENTION_NODE_NAME,
          attrs: {
            agentId: segment.agentId,
            name: segment.name,
            avatarUrl: null,
          },
        };
  });
}

function composerInlineReferenceContent(line: string): JSONContent[] {
  const content: JSONContent[] = [];
  for (const segment of splitChatThreadMentionSegments(line)) {
    if (segment.type === "text") {
      content.push(...agentMentionInlineContent(segment.text));
      continue;
    }
    content.push({
      type: CHAT_THREAD_MENTION_NODE_NAME,
      attrs: { threadId: segment.threadId, title: segment.title },
    });
  }
  return content;
}

function valueToWorkflowComposerDoc(value: string): JSONContent {
  const content: JSONContent[] = value.split("\n").map((line) => {
    return line.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: composerInlineReferenceContent(line) };
  });
  return { type: "doc", content };
}

function composerLeafText(node: ProseMirrorNode): string {
  if (node.type.name === AGENT_MENTION_NODE_NAME) {
    return agentMentionText(node);
  }
  if (node.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
    return chatThreadMentionText(node);
  }
  if (node.type.name === INLINE_TEMPLATE_NODE_NAME) {
    const attachment = templateAttachmentNodeAttributes(node);
    return `Select ${attachment.title} ${attachment.type} template`;
  }
  return node.type.name === "hardBreak" ? "\n" : "";
}

function nodeText(
  node: ProseMirrorNode,
  to: number = node.content.size,
): string {
  return node.textBetween(0, to, "\n", composerLeafText);
}

function workflowComposerClipboardText(slice: Slice): string {
  return slice.content.textBetween(
    0,
    slice.content.size,
    "\n",
    composerLeafText,
  );
}

function workflowComposerDocToString(editor: Editor): string {
  const sections: string[] = [];
  let textBlocks: string[] = [];
  let feedbackItems: FeedbackItem[] = [];
  const flushTextBlocks = () => {
    const text = textBlocks.join("\n");
    if (text.trim().length > 0) {
      sections.push(text);
    }
    textBlocks = [];
  };
  const flushFeedbackItems = () => {
    if (feedbackItems.length > 0) {
      sections.push(formatFeedbackPrompt(feedbackItems));
    }
    feedbackItems = [];
  };

  for (let index = 0; index < editor.state.doc.childCount; index++) {
    const node = editor.state.doc.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      continue;
    }
    if (node.type.name === FEEDBACK_ITEM_NODE_NAME) {
      flushTextBlocks();
      feedbackItems.push(feedbackItemFromNode(node));
      continue;
    }
    flushFeedbackItems();
    textBlocks.push(nodeText(node));
  }
  flushTextBlocks();
  flushFeedbackItems();
  return sections.join("\n\n");
}

interface ActiveTextblock {
  readonly value: string;
  readonly caretIndex: number;
}

function activeTextblock(editor: Editor): ActiveTextblock | null {
  const { $head } = editor.state.selection;
  if (!$head.parent.isTextblock) {
    return null;
  }
  return {
    value: nodeText($head.parent),
    caretIndex: nodeText($head.parent, $head.parentOffset).length,
  };
}

function buildWorkflowDecorations(
  doc: ProseMirrorNode,
  workflowNames: readonly string[],
): DecorationSet {
  const pattern = workflowTokenPattern(workflowNames);
  if (!pattern) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const text = node.text;
    if (!node.isText || !text) {
      return;
    }
    for (const match of text.matchAll(pattern)) {
      const matchStart = pos + (match.index ?? 0);
      const workflowStart = match[0].lastIndexOf("/");
      const start = matchStart + workflowStart;
      decorations.push(
        Decoration.inline(start, matchStart + match[0].length, {
          class: WORKFLOW_HIGHLIGHT_CLASS,
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

const WorkflowHighlight = Extension.create<
  { workflowNames: readonly string[] },
  WorkflowHighlightStorage
>({
  name: "workflowHighlight",
  addOptions() {
    return { workflowNames: [] };
  },
  addStorage() {
    return { workflowNames: this.options.workflowNames };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey("workflowHighlight"),
        props: {
          decorations(state: EditorState) {
            return buildWorkflowDecorations(state.doc, storage.workflowNames);
          },
        },
      }),
    ];
  },
});

function createWorkflowComposerBaseExtensions() {
  return [
    Document,
    Dropcursor,
    Gapcursor,
    HardBreak,
    UndoRedo,
    Paragraph,
    Text,
  ];
}

function isWorkflowHighlightStorage(
  value: unknown,
): value is WorkflowHighlightStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "workflowNames"))
  );
}

function workflowHighlightStorage(editor: Editor): WorkflowHighlightStorage {
  const storage: unknown = Reflect.get(editor.storage, "workflowHighlight");
  if (!isWorkflowHighlightStorage(storage)) {
    throw new Error("Workflow highlight storage is unavailable");
  }
  return storage;
}

interface WorkflowComposerRuntime {
  update(editor: Editor): void;
  selectionUpdate(editor: Editor): void;
  focus(editor: Editor): void;
  blur(): void;
  openTemplate(intent: OpenComposerTemplatePickerIntent): void;
  removeTemplate(): void;
  replaceFeedbackItems(items: readonly FeedbackItem[]): void;
  removeFeedback(id: number): void;
  localizedUi: Set<() => void>;
  /** Read on every chip render so Lab updates apply without remounting. */
  templateChipCover: () => boolean;
  templateEnabled: (type: ComposerTemplateAttachmentType) => boolean;
}

function createTemplateAttachmentNode(
  runtime: WorkflowComposerRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: TEMPLATE_ATTACHMENT_NODE_NAME,
    group: "block",
    atom: true,
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
      return {
        templateType: { default: "presentation" },
        title: { default: "" },
        category: { default: "slides" },
        previewImageUrl: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-composer-template-attachment]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        { ...HTMLAttributes, "data-composer-template-attachment": "" },
      ];
    },
    addNodeView() {
      return ({ node }) => {
        return createTemplateAttachmentNodeView(
          node,
          (category) => {
            runtime.openTemplate({ kind: "edit-legacy", category });
          },
          () => {
            runtime.removeTemplate();
          },
          (type) => {
            return runtime.templateEnabled(type);
          },
          runtime.localizedUi,
        );
      };
    },
  });
}

function createInlineTemplateNode(
  runtime: WorkflowComposerRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: INLINE_TEMPLATE_NODE_NAME,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes() {
      return {
        templateType: { default: "presentation" },
        template: { default: null },
        title: { default: "" },
        category: { default: "slides" },
        previewImageUrl: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "span[data-composer-inline-template]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "span",
        { ...HTMLAttributes, "data-composer-inline-template": "" },
      ];
    },
    renderText({ node }) {
      const attachment = templateAttachmentNodeAttributes(node);
      return `Select ${attachment.title} ${attachment.type} template`;
    },
    addNodeView() {
      return ({ node, getPos }) => {
        const openTemplate = (category: string): void => {
          const position = getPos();
          if (typeof position !== "number") {
            return;
          }
          runtime.openTemplate({
            kind: "edit-selected",
            category,
            position,
          });
        };
        return createInlineTemplateNodeView(
          node,
          {
            openTemplate,
            templateEnabled: (type) => {
              return runtime.templateEnabled(type);
            },
            coverEnabled: () => {
              return runtime.templateChipCover();
            },
          },
          runtime.localizedUi,
        );
      };
    },
  });
}

function createFeedbackItemNode(
  runtime: WorkflowComposerRuntime,
): Node<undefined, unknown> {
  return Node.create({
    name: FEEDBACK_ITEM_NODE_NAME,
    group: "block",
    content: "paragraph+",
    defining: true,
    isolating: true,
    selectable: false,
    addAttributes() {
      return {
        feedbackId: { default: 0 },
        quote: { default: "" },
        showDivider: { default: false },
        fill: { default: false },
        eventId: { default: null },
        rangeStart: { default: null },
        rangeEnd: { default: null },
        sourceType: { default: null },
        sourceId: { default: null },
        sourceStatus: { default: null },
        sourceSentId: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: "div[data-feedback-item]" }];
    },
    renderHTML({ HTMLAttributes }) {
      return ["div", { ...HTMLAttributes, "data-feedback-item": "" }, 0];
    },
    addNodeView() {
      return ({ node }) => {
        return createFeedbackItemNodeView(node, runtime.localizedUi);
      };
    },
    addProseMirrorPlugins() {
      return [
        createFeedbackChromePlugin(runtime),
        createFeedbackTextSelectionPlugin(),
      ];
    },
  });
}

function createWorkflowEditor(
  runtime: WorkflowComposerRuntime,
  agentMentionAvatarRuntime: AgentMentionAvatarRuntime,
): Editor {
  return new Editor({
    element: null,
    extensions: [
      ...createWorkflowComposerBaseExtensions(),
      createTemplateAttachmentNode(runtime),
      createInlineTemplateNode(runtime),
      createFeedbackItemNode(runtime),
      createAgentMentionNode(
        COMPOSER_INLINE_REFERENCE_CLASS,
        agentMentionAvatarRuntime,
      ),
      ChatThreadMentionNode,
      WorkflowHighlight,
    ],
    content: valueToWorkflowComposerDoc(""),
    editorProps: {
      attributes: {
        "aria-label": i18n.t(($) => {
          return $.chat.composer.message;
        }),
        placeholder: composerPlaceholder(),
        tabindex: "0",
        class: EDITOR_CONTENT_CLASS,
      },
    },
    onUpdate: ({ editor }) => {
      runtime.update(editor);
    },
    onSelectionUpdate: ({ editor }) => {
      runtime.selectionUpdate(editor);
    },
    onFocus: ({ editor }) => {
      runtime.focus(editor);
    },
    onBlur: () => {
      runtime.blur();
    },
  });
}

function setWorkflowComposerDocument(
  editor: Editor,
  nextDocument: ProseMirrorNode,
): boolean {
  if (editor.state.doc.eq(nextDocument)) {
    return false;
  }
  editor.commands.setContent(nextDocument, { emitUpdate: false });
  return true;
}

function workflowComposerDocumentForValue(
  editor: Editor,
  value: string,
): ProseMirrorNode {
  const textDocument = editor.schema.nodeFromJSON(
    valueToWorkflowComposerDoc(value),
  );
  const templateAttachment = locateTemplateAttachment(editor.state.doc)?.node;
  if (!templateAttachment) {
    return textDocument;
  }
  const content = [templateAttachment];
  for (let index = 0; index < textDocument.childCount; index++) {
    content.push(textDocument.child(index));
  }
  return editor.schema.node("doc", undefined, content);
}

function workflowComposerDocumentForUserMessage(
  editor: Editor,
  value: Parameters<DraftInputSyncTarget["syncUserMessage"]>[0],
): ProseMirrorNode | null {
  const document = draftToEditorDoc(value);
  return document ? editor.schema.nodeFromJSON(document) : null;
}

function workflowComposerDocumentForDraft(
  editor: Editor,
  draft: {
    readonly input: string;
    readonly userMessage:
      | Parameters<DraftInputSyncTarget["syncUserMessage"]>[0]
      | null;
    readonly editorDocument: EditorDocumentSnapshot | null;
  },
): ProseMirrorNode {
  if (feedbackItemsFromWorkflowComposer(editor).length > 0) {
    return editor.state.doc;
  }
  const userMessageDocument = draft.userMessage
    ? workflowComposerDocumentForUserMessage(editor, draft.userMessage)
    : null;
  const restoredEditorDocument = draft.editorDocument
    ? editor.schema.nodeFromJSON(draft.editorDocument.toEditorDocument())
    : null;
  return (
    userMessageDocument ??
    restoredEditorDocument ??
    workflowComposerDocumentForValue(editor, draft.input)
  );
}

function configureMountedWorkflowEditor(editor: Editor): void {
  editor.setOptions({
    editorProps: {
      clipboardTextSerializer: workflowComposerClipboardText,
      attributes: {
        "aria-label": i18n.t(($) => {
          return $.chat.composer.message;
        }),
        placeholder: composerPlaceholder(),
        tabindex: "0",
        class: EDITOR_CONTENT_CLASS,
      },
    },
  });
}

function refreshMountedWorkflowEditorLocalization(editor: Editor): void {
  editor.setOptions({
    editorProps: {
      ...editor.options.editorProps,
      attributes: {
        ...editor.options.editorProps.attributes,
        "aria-label": i18n.t(($) => {
          return $.chat.composer.message;
        }),
        placeholder: composerPlaceholder(),
      },
    },
  });
}

function refreshWorkflowComposerUi(runtime: WorkflowComposerRuntime): void {
  for (const localize of runtime.localizedUi) {
    localize();
  }
}

function refreshWorkflowComposerLocalization(
  editor: Editor,
  runtime: WorkflowComposerRuntime,
): void {
  refreshMountedWorkflowEditorLocalization(editor);
  refreshWorkflowComposerUi(runtime);
  // The feedback chrome widgets carry their language in the decoration key;
  // an empty transaction makes the view re-read decorations in the new one.
  if (editor.isInitialized) {
    editor.view.dispatch(editor.state.tr);
  }
}

function resetMountedWorkflowRuntime(runtime: WorkflowComposerRuntime): void {
  runtime.update = () => {};
  runtime.selectionUpdate = () => {};
  runtime.focus = () => {};
  runtime.blur = () => {};
  runtime.openTemplate = () => {};
  runtime.removeTemplate = () => {};
  runtime.replaceFeedbackItems = () => {};
  runtime.removeFeedback = () => {};
  runtime.templateChipCover = () => {
    return false;
  };
  runtime.templateEnabled = (type) => {
    return type !== "brand-motion";
  };
}

function applyWorkflowNames(editor: Editor, names: readonly string[]): void {
  const storage = workflowHighlightStorage(editor);
  const unchanged =
    storage.workflowNames.length === names.length &&
    storage.workflowNames.every((name, index) => {
      return name === names[index];
    });
  if (unchanged) {
    return;
  }
  storage.workflowNames = names;
  if (editor.isInitialized) {
    editor.view.dispatch(editor.state.tr);
  }
}

function createSyncWorkflowNamesCommand(
  editor: Editor,
  agentId$: Computed<Promise<string | null>>,
  workflows$: Computed<Promise<readonly WorkflowSummary[]>>,
): WorkflowNamesSyncCommand {
  const resetWorkflowNamesSyncSignal$ = resetSignal();
  return command(
    async (
      { get, set },
      mountSignal: AbortSignal,
      signal: AbortSignal,
    ): Promise<void> => {
      if (mountSignal.aborted) {
        return;
      }
      signal.throwIfAborted();
      const syncSignal = set(
        resetWorkflowNamesSyncSignal$,
        mountSignal,
        signal,
      );
      const [agentId, workflows] = await Promise.all([
        get(agentId$),
        get(workflows$),
      ]);
      signal.throwIfAborted();
      if (syncSignal.aborted) {
        return;
      }
      const workflowNames = buildComposerSlashWorkflows({
        agentId,
        workflows,
      }).map((workflow) => {
        return workflow.name;
      });
      applyWorkflowNames(editor, workflowNames);
    },
  );
}

function createSyncAgentMentionAvatarsCommand(
  avatarRuntime: AgentMentionAvatarRuntime,
): AgentMentionAvatarsSyncCommand {
  return command(async ({ get }, signal: AbortSignal): Promise<void> => {
    const agents = await get(agents$);
    signal.throwIfAborted();
    avatarRuntime.setSwitches({
      neckSweater: get(avatarNeckSweaterEnabled$),
      framing: get(avatarFramingEnabled$),
    });
    avatarRuntime.replaceAgents(agents);
  });
}

function mountCompositionListeners(
  editor: Editor,
  compositionGate: CompositionGate,
  signal: AbortSignal,
): void {
  editor.view.dom.addEventListener(
    "compositionstart",
    compositionGate.compositionStart,
    { signal },
  );
  editor.view.dom.addEventListener(
    "compositionend",
    compositionGate.compositionEnd,
    { signal },
  );
}

const observeWorkflowComposerUi$ = command(
  (
    { set },
    editor: Editor,
    runtime: WorkflowComposerRuntime,
    signal: AbortSignal,
  ) => {
    const refreshLocalizedUi = () => {
      refreshWorkflowComposerLocalization(editor, runtime);
    };
    i18n.on("languageChanged", refreshLocalizedUi);
    signal.addEventListener("abort", () => {
      i18n.off("languageChanged", refreshLocalizedUi);
    });
    set(
      observeFeatureSwitchChanges$,
      () => {
        refreshWorkflowComposerUi(runtime);
      },
      signal,
    );
  },
);

interface MountEditorOptions {
  editor: Editor;
  draft: DraftSignals;
  runtime: WorkflowComposerRuntime;
  legacyTemplateAttachment: ReturnType<
    typeof createLegacyTemplateAttachmentControls
  >;
  templateSelection: ReturnType<typeof createTemplateSelectionSignals>;
  openTemplatePicker$: WorkflowComposerSignals["openTemplatePicker$"];
  caretIndex$: State<number>;
  editorFocusedState$: State<boolean>;
  selectedSuggestionIndexState$: State<number>;
  previewSuggestionIndexState$: State<number | null>;
  feedback: ComposerFeedbackModel;
  compositionGate: CompositionGate;
  syncWorkflowNames$: WorkflowNamesSyncCommand;
  syncAgentMentionAvatars$: AgentMentionAvatarsSyncCommand;
  autoFocus: boolean;
}

interface WorkflowComposerOptions {
  readonly autoFocus?: boolean;
}

function focusMountedEditorAtEnd(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)),
  );
  editor.view.focus();
  editor.commands.scrollIntoView();
}

interface MountedDraftInputSyncTargetOptions {
  editor: Editor;
  runtime: WorkflowComposerRuntime;
  setEditorDocument(snapshot: EditorDocumentSnapshot): void;
}

function createMountedDraftInputSyncTarget({
  editor,
  runtime,
  setEditorDocument,
}: MountedDraftInputSyncTargetOptions): DraftInputSyncTarget {
  const syncEditorDocument = () => {
    setEditorDocument(createEditorDocumentSnapshot(editor.state.doc));
  };
  return {
    syncInput(value) {
      if (workflowComposerDocToString(editor) === value) {
        return;
      }
      const changed = setWorkflowComposerDocument(
        editor,
        workflowComposerDocumentForValue(editor, value),
      );
      if (changed) {
        runtime.replaceFeedbackItems(feedbackItemsFromWorkflowComposer(editor));
        syncEditorDocument();
      }
    },
    syncUserMessage(value) {
      const document = workflowComposerDocumentForUserMessage(editor, value);
      if (!document) {
        return;
      }
      const changed = setWorkflowComposerDocument(editor, document);
      if (changed) {
        runtime.replaceFeedbackItems(feedbackItemsFromWorkflowComposer(editor));
      }
      syncEditorDocument();
    },
  };
}

function createMountEditorCommand({
  editor,
  draft,
  runtime,
  legacyTemplateAttachment,
  templateSelection,
  openTemplatePicker$,
  caretIndex$,
  editorFocusedState$,
  selectedSuggestionIndexState$,
  previewSuggestionIndexState$,
  feedback,
  compositionGate,
  syncWorkflowNames$,
  syncAgentMentionAvatars$,
  autoFocus,
}: MountEditorOptions) {
  return onRef(
    command(async ({ get, set }, element: HTMLElement, signal: AbortSignal) => {
      runtime.templateChipCover = () => {
        return get(featureSwitch$)[FeatureSwitchKey.ComposerTemplateChipCover];
      };
      runtime.templateEnabled = (type) => {
        return type !== "brand-motion" || get(brandMotionPreviewEnabled$);
      };
      runtime.update = (updatedEditor) => {
        set(legacyTemplateAttachment.sync$);
        set(templateSelection.sync$);
        runtime.replaceFeedbackItems(
          feedbackItemsFromWorkflowComposer(updatedEditor),
        );
        set(draft.setInput$, workflowComposerDocToString(updatedEditor));
        set(
          draft.setEditorDocument$,
          createEditorDocumentSnapshot(updatedEditor.state.doc),
        );
        set(selectedSuggestionIndexState$, 0);
        set(previewSuggestionIndexState$, null);
        set(caretIndex$, updatedEditor.state.selection.head);
        compositionGate.notifySettled();
        // Forward TipTap updates through the React-owned DOM boundary.
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      runtime.selectionUpdate = (updatedEditor) => {
        set(previewSuggestionIndexState$, null);
        set(caretIndex$, updatedEditor.state.selection.head);
      };
      runtime.focus = (focusedEditor) => {
        set(previewSuggestionIndexState$, null);
        set(editorFocusedState$, true);
        set(caretIndex$, focusedEditor.state.selection.head);
      };
      runtime.blur = () => {
        set(previewSuggestionIndexState$, null);
        set(editorFocusedState$, false);
      };
      runtime.replaceFeedbackItems = (items) => {
        set(feedback.replaceFromEditor$, items);
      };
      runtime.removeFeedback = (id) => {
        set(feedback.signals.remove$, id);
      };
      runtime.openTemplate = (intent) => {
        set(openTemplatePicker$, intent);
      };
      runtime.removeTemplate = () => {
        set(legacyTemplateAttachment.remove$);
      };
      configureMountedWorkflowEditor(editor);
      setWorkflowComposerDocument(
        editor,
        workflowComposerDocumentForDraft(editor, {
          input: get(draft.input$),
          userMessage: set(draft.takeRestoredUserMessage$),
          editorDocument: set(draft.readEditorDocument$),
        }),
      );
      set(
        draft.setEditorDocument$,
        createEditorDocumentSnapshot(editor.state.doc),
      );
      set(legacyTemplateAttachment.sync$);
      set(templateSelection.sync$);
      editor.mount(element);
      set(observeWorkflowComposerUi$, editor, runtime, signal);
      mountCompositionListeners(editor, compositionGate, signal);
      set(
        draft.setInputSyncTarget$,
        createMountedDraftInputSyncTarget({
          editor,
          runtime,
          setEditorDocument(snapshot) {
            set(draft.setEditorDocument$, snapshot);
            set(legacyTemplateAttachment.sync$);
            set(templateSelection.sync$);
          },
        }),
      );
      // Keep workflow decoration sync scoped to real editor mounts.
      const mountedWorkflowNamesSync = {
        command$: syncWorkflowNames$,
        mountSignal: signal,
      };
      set(registerMountedWorkflowNamesSync$, mountedWorkflowNamesSync);
      if (autoFocus && !isMobileTextInputDevice()) {
        focusMountedEditorAtEnd(editor);
      }
      signal.addEventListener("abort", () => {
        set(unregisterMountedWorkflowNamesSync$, mountedWorkflowNamesSync);
        compositionGate.cancel(signal.reason);
        resetMountedWorkflowRuntime(runtime);
        set(legacyTemplateAttachment.reset$);
        set(draft.setInputSyncTarget$, null);
        set(previewSuggestionIndexState$, null);
        set(editorFocusedState$, false);
        editor.unmount();
      });
      await Promise.all([
        set(syncWorkflowNames$, signal, signal),
        set(syncAgentMentionAvatars$, signal),
      ]);
    }),
  );
}

function createInsertWorkflowCommand(
  editor: Editor,
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
) {
  return command(({ get }, workflow: ComposerSlashWorkflow) => {
    const slashRange = get(activeSlashRange$);
    if (!slashRange) {
      return;
    }
    const textblock = activeTextblock(editor);
    if (!textblock) {
      return;
    }
    const head = editor.state.selection.head;
    const from = head - (slashRange.end - slashRange.start);
    const token = `/${workflow.name}`;
    const suffix = textblock.value.slice(slashRange.end).startsWith(" ")
      ? ""
      : " ";
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, [
        { type: "text", text: `${token}${suffix}` },
      ])
      .setTextSelection(from + token.length + suffix.length)
      .run();
  });
}

function createInsertAgentCommand(
  editor: Editor,
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
) {
  return command(({ get }, agent: ComposerAgentSuggestion) => {
    const range = get(activeRange$);
    if (!range) {
      return;
    }
    const textblock = activeTextblock(editor);
    if (!textblock) {
      return;
    }
    const head = editor.state.selection.head;
    const from = head - (range.end - range.start);
    const content: JSONContent[] = [
      {
        type: AGENT_MENTION_NODE_NAME,
        attrs: {
          agentId: agent.id,
          name: agent.name,
          avatarUrl: agent.avatarUrl,
        },
      },
    ];
    if (!textblock.value.slice(range.end).startsWith(" ")) {
      content.push({ type: "text", text: " " });
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, content)
      .setTextSelection(from + 2)
      .run();
  });
}

function createInsertChatThreadCommand(
  editor: Editor,
  activeRange$: Computed<ChatThreadSuggestionRange | null>,
) {
  return command(({ get }, chatThread: ComposerChatThreadSuggestion) => {
    const range = get(activeRange$);
    if (!range) {
      return;
    }
    const textblock = activeTextblock(editor);
    if (!textblock) {
      return;
    }
    const head = editor.state.selection.head;
    const from = head - (range.end - range.start);
    const content: JSONContent[] = [
      {
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: { threadId: chatThread.id, title: chatThread.title },
      },
    ];
    if (!textblock.value.slice(range.end).startsWith(" ")) {
      content.push({ type: "text", text: " " });
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from, to: head }, content)
      // The mention node occupies a single document position; place the
      // caret after the node and the following space.
      .setTextSelection(from + 2)
      .run();
  });
}

function createSuggestionInsertionCommands(
  editor: Editor,
  activeSlashRange$: Computed<SlashWorkflowRange | null>,
  activeMentionRange$: Computed<ChatThreadSuggestionRange | null>,
) {
  return {
    insertWorkflow$: createInsertWorkflowCommand(editor, activeSlashRange$),
    insertAgent$: createInsertAgentCommand(editor, activeMentionRange$),
    insertChatThread$: createInsertChatThreadCommand(
      editor,
      activeMentionRange$,
    ),
  };
}

function createInsertTextCommands(editor: Editor) {
  const readVoiceContext$ = command((): VoiceIoEditorContext => {
    const { doc, selection } = editor.state;
    const { from, to } = selection;
    const limit = VOICE_IO_TRANSCRIBE_MAX_EDITOR_CONTEXT_CHARS;
    const leafText = (node: ProseMirrorNode): string => {
      if (node.type.name === AGENT_MENTION_NODE_NAME) {
        const name: unknown = node.attrs.name;
        if (typeof name !== "string") {
          throw new Error("Agent mention name is invalid");
        }
        return `@${name}`;
      }
      if (node.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
        return `@${chatThreadMentionAttributes(node).title}`;
      }
      return node.type.name === "hardBreak" ? "\n" : "";
    };
    return {
      before: doc.textBetween(0, from, "\n", leafText).slice(-limit),
      selected: doc.textBetween(from, to, "\n", leafText).slice(0, limit),
      after: doc
        .textBetween(to, doc.content.size, "\n", leafText)
        .slice(0, limit),
    };
  });
  const insertText$ = command((_context, value: string) => {
    const { from, to } = editor.state.selection;
    const transaction = editor.state.tr.insertText(value, from, to);
    transaction.setSelection(
      TextSelection.create(transaction.doc, from + value.length),
    );
    editor.view.dispatch(transaction.scrollIntoView());
    editor.view.focus();
  });
  const insertPromptMarkdown$ = command((_context, value: string) => {
    const doc = editor.schema.nodeFromJSON(valueToWorkflowComposerDoc(value));
    const slice = Slice.maxOpen(doc.content, true);
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.replaceSelection(slice);
        return true;
      })
      .scrollIntoView()
      .run();
  });

  const selectText = (value: string): boolean => {
    const text = value.trim();
    if (!text) {
      return false;
    }

    let textRun = "";
    let textRunStart = -1;
    let textRunEnd = -1;
    let selection: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, position) => {
      if (selection || !node.isText || !node.text) {
        return;
      }
      if (position === textRunEnd) {
        textRun += node.text;
      } else {
        textRun = node.text;
        textRunStart = position;
      }
      textRunEnd = position + node.nodeSize;

      const matchIndex = textRun.indexOf(text);
      if (matchIndex !== -1) {
        selection = {
          from: textRunStart + matchIndex,
          to: textRunStart + matchIndex + text.length,
        };
      }
    });
    if (!selection) {
      return false;
    }

    editor.chain().focus().setTextSelection(selection).scrollIntoView().run();
    return true;
  };

  const appendText = (value: string) => {
    const text = value.trim();
    if (!text) {
      return;
    }
    editor.commands.focus("end");
    const textblock = activeTextblock(editor);
    const content = textblock?.value.trimEnd() ? `\n${text}` : text;
    editor.commands.insertContent(content);
  };

  const appendText$ = command((_context, value: string) => {
    appendText(value);
  });
  const selectOrAppendText$ = command((_context, value: string) => {
    if (!selectText(value)) {
      appendText(value);
    }
  });

  return {
    readVoiceContext$,
    insertText$,
    insertPromptMarkdown$,
    appendText$,
    selectOrAppendText$,
  };
}

function inlineTemplateNode(
  editor: Editor,
  request: GenerationTemplateRequest,
  attachment: ComposerTemplateAttachment,
): ProseMirrorNode {
  return editor.schema.nodeFromJSON({
    type: INLINE_TEMPLATE_NODE_NAME,
    attrs: {
      templateType: attachment.type,
      template: request,
      title: attachment.title,
      category: attachment.category,
      previewImageUrl: attachment.previewImageUrl ?? null,
    },
  });
}

function replaceLegacyTemplateAttachmentNode(
  editor: Editor,
  inlineTemplate: ProseMirrorNode,
): boolean {
  const located = locateTemplateAttachment(editor.state.doc);
  if (!located) {
    return false;
  }
  const transaction = editor.state.tr.delete(
    located.position,
    located.position + located.node.nodeSize,
  );
  const nextNode = transaction.doc.nodeAt(located.position);
  if (nextNode?.type.name === "paragraph") {
    transaction.insert(located.position + 1, inlineTemplate);
  } else {
    transaction.insert(
      located.position,
      editor.schema.nodeFromJSON({
        type: "paragraph",
        content: [inlineTemplate.toJSON()],
      }),
    );
  }
  editor.view.dispatch(transaction.scrollIntoView());
  return true;
}

function createInsertTemplateCommand(
  editor: Editor,
  draft: DraftSignals,
  legacyReplacementPending$: State<boolean>,
) {
  return command(
    (
      { get, set },
      request: GenerationTemplateRequest,
      attachment: ComposerTemplateAttachment,
    ) => {
      if (
        request.type === "brand-motion" &&
        !get(featureSwitch$)[FeatureSwitchKey.BrandMotion]
      ) {
        return;
      }
      const node = inlineTemplateNode(editor, request, attachment);
      const replaceLegacy = get(legacyReplacementPending$);
      set(legacyReplacementPending$, false);
      if (replaceLegacy) {
        set(draft.setGenerationTemplate$, undefined);
        if (replaceLegacyTemplateAttachmentNode(editor, node)) {
          return;
        }
      }
      const { selection } = editor.state;
      if (
        selection instanceof NodeSelection &&
        selection.node.type.name === INLINE_TEMPLATE_NODE_NAME
      ) {
        editor.view.dispatch(
          editor.state.tr
            .setNodeMarkup(selection.from, undefined, node.attrs)
            .scrollIntoView(),
        );
        return;
      }
      editor
        .chain()
        .focus()
        .insertContent(node.toJSON())
        .scrollIntoView()
        .run();
    },
  );
}

/**
 * Rewrites one inline template in place, addressed by position rather than by
 * the editor selection. setNodeMarkup maps a NodeSelection to a TextSelection,
 * so a selection-based update only works once; every later edit would fall
 * through to inserting another chip.
 */
function createPrepareTemplateInsertionCommand(editor: Editor) {
  return command(() => {
    const { selection } = editor.state;
    if (
      selection instanceof NodeSelection &&
      selection.node.type.name === INLINE_TEMPLATE_NODE_NAME
    ) {
      editor.commands.setTextSelection(selection.to);
    }
  });
}

function createReadSelectedTemplateCommand(editor: Editor) {
  return command(() => {
    const { selection } = editor.state;
    if (
      !(selection instanceof NodeSelection) ||
      selection.node.type.name !== INLINE_TEMPLATE_NODE_NAME
    ) {
      return undefined;
    }
    const parsed = generationTemplateRequestSchema.safeParse(
      selection.node.attrs.template,
    );
    return parsed.success ? parsed.data : undefined;
  });
}

function createTemplateCommands(
  editor: Editor,
  draft: DraftSignals,
  openTemplatePickerDialog$: OpenTemplatePickerDialogCommand,
) {
  const legacyReplacementPending$ = state(false);
  const readSelectedTemplate$ = createReadSelectedTemplateCommand(editor);
  const prepareTemplateInsertion$ =
    createPrepareTemplateInsertionCommand(editor);
  const openTemplatePicker$ = command(
    ({ get, set }, intent: OpenComposerTemplatePickerIntent): void => {
      if (
        intent.category === "brand-motion" &&
        !get(brandMotionPreviewEnabled$)
      ) {
        return;
      }
      set(legacyReplacementPending$, intent.kind === "edit-legacy");
      let referenceValue: GenerationTemplateRequest | null = null;
      if (intent.kind === "edit-selected") {
        editor.commands.setNodeSelection(intent.position);
        referenceValue = set(readSelectedTemplate$) ?? null;
      } else if (intent.kind === "edit-legacy") {
        referenceValue = get(draft.generationTemplate$) ?? null;
      }
      if (
        referenceValue?.type === "brand-motion" &&
        !get(brandMotionPreviewEnabled$)
      ) {
        return;
      }
      if (intent.kind === "insert") {
        set(prepareTemplateInsertion$);
      }
      set(openTemplatePickerDialog$, {
        category: intent.category,
        referenceValue,
      });
    },
  );
  return {
    insertTemplate$: createInsertTemplateCommand(
      editor,
      draft,
      legacyReplacementPending$,
    ),
    openTemplatePicker$,
  };
}

function createInsertUserMessageCommand(editor: Editor) {
  return command((_context, value: UserMessageDocument) => {
    const insertableParts = value.parts.filter((part) => {
      return (
        part.type === "text" ||
        part.type === "chat_thread" ||
        part.type === "agent" ||
        part.type === "feedback" ||
        part.type === "template"
      );
    });
    if (insertableParts.length === 0) {
      return;
    }
    const restored = messageDocumentToEditorDoc({
      version: 1,
      parts: insertableParts,
    });
    if (!restored?.content) {
      return;
    }

    let nextFeedbackId = feedbackItemsFromWorkflowComposer(editor).reduce(
      (nextId, item) => {
        return Math.max(nextId, item.id + 1);
      },
      1,
    );
    const content = restored.content.map((node) => {
      if (node.type !== FEEDBACK_ITEM_NODE_NAME) {
        return node;
      }
      const feedbackId = nextFeedbackId;
      nextFeedbackId += 1;
      return {
        ...node,
        attrs: {
          ...node.attrs,
          feedbackId,
        },
      };
    });

    editor
      .chain()
      .focus()
      .insertContent(content)
      .command(({ tr }) => {
        withFeedbackItemLayout(tr);
        return true;
      })
      .scrollIntoView()
      .run();
  });
}

function createWorkflowComposerRuntime(): WorkflowComposerRuntime {
  return {
    update(_editor: Editor): void {},
    selectionUpdate(_editor: Editor): void {},
    focus(_editor: Editor): void {},
    blur(): void {},
    openTemplate(_intent: OpenComposerTemplatePickerIntent): void {},
    removeTemplate(): void {},
    replaceFeedbackItems(_items: readonly FeedbackItem[]): void {},
    removeFeedback(_id: number): void {},
    localizedUi: new Set(),
    templateChipCover: () => {
      return false;
    },
    templateEnabled: (type) => {
      return type !== "brand-motion";
    },
  };
}

/** Keeps attachment blocks from drafts created before inline templates interactive. */
function createLegacyTemplateAttachmentControls(
  editor: Editor,
  draft: DraftSignals,
) {
  const activeState$ = state(false);
  const sync$ = command(({ set }) => {
    set(activeState$, locateTemplateAttachment(editor.state.doc) !== null);
  });
  const remove$ = command(({ set }) => {
    if (locateTemplateAttachment(editor.state.doc) === null) {
      return;
    }
    set(draft.setGenerationTemplate$, undefined);
    removeTemplateAttachmentNode(editor);
    set(activeState$, false);
  });
  const reset$ = command(({ set }) => {
    set(activeState$, false);
  });
  const active$ = computed((get) => {
    return get(activeState$);
  });
  return { active$, sync$, remove$, reset$ };
}

/** Track template nodes without publishing a new document on each keystroke. */
function createTemplateSelectionSignals(
  editor: Editor,
  draft: DraftSignals,
  legacyActive$: Computed<boolean>,
) {
  const nodes$ = state<readonly ProseMirrorNode[]>([]);
  const sync$ = command(({ get, set }) => {
    const nodes: ProseMirrorNode[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === INLINE_TEMPLATE_NODE_NAME) {
        nodes.push(node);
      }
    });
    const previous = get(nodes$);
    if (
      nodes.length !== previous.length ||
      nodes.some((node, index) => {
        return node !== previous[index];
      })
    ) {
      set(nodes$, nodes);
    }
  });
  const requests$ = computed((get) => {
    const requests = get(nodes$).flatMap((node) => {
      const parsed = generationTemplateRequestSchema.safeParse(
        node.attrs.template,
      );
      return parsed.success ? [parsed.data] : [];
    });
    const legacy = get(legacyActive$)
      ? get(draft.generationTemplate$)
      : undefined;
    return legacy ? [...requests, legacy] : requests;
  });
  return { requests$, sync$ };
}

function createActiveSuggestionRange<T>(
  editor: Editor,
  caretIndex$: State<number>,
  editorFocusedState$: State<boolean>,
  findRange: (value: string, caretIndex: number) => T | null,
): Computed<T | null> {
  return computed((get) => {
    const caretIndex = get(caretIndex$);
    if (caretIndex < 0 || !get(editorFocusedState$)) {
      return null;
    }
    const textblock = activeTextblock(editor);
    return textblock ? findRange(textblock.value, textblock.caretIndex) : null;
  });
}

function createTemplateSignals(
  editor: Editor,
  draft: DraftSignals,
  openDialog$: OpenTemplatePickerDialogCommand,
) {
  const commands = createTemplateCommands(editor, draft, openDialog$);
  const legacy = createLegacyTemplateAttachmentControls(editor, draft);
  const selection = createTemplateSelectionSignals(
    editor,
    draft,
    legacy.active$,
  );
  return { commands, legacy, selection };
}

export function createWorkflowComposerSignals<
  T extends AgentIdValue = Promise<string | null>,
>(
  draft: DraftSignals,
  openDialog$: OpenTemplatePickerDialogCommand,
  agentIdSource$: Computed<T> = currentChatAgentRecordId$ as Computed<T>,
  options: WorkflowComposerOptions = {},
  feedback: ComposerFeedbackModel = createComposerFeedbackModel(),
): WorkflowComposerSignals {
  const caretIndex$ = state(-1);
  const editorFocusedState$ = state(false);
  const selectedSuggestionIndexState$ = state(0);
  // A pointer preview is independent of keyboard selection. Null means the
  // preview follows the keyboard again, including when the menu reopens.
  const previewSuggestionIndexState$ = state<number | null>(null);
  const runtime = createWorkflowComposerRuntime();
  const agentMentionAvatarRuntime = createAgentMentionAvatarRuntime();
  const templatePreview = createTemplatePreviewRuntime();
  const compositionGate = createCompositionGate();
  const { agentId$, workflows$ } = createComposerAgentResources(agentIdSource$);

  const editor = createWorkflowEditor(runtime, agentMentionAvatarRuntime);
  connectComposerFeedback(feedback, editor);
  const syncWorkflowNames$ = createSyncWorkflowNamesCommand(
    editor,
    agentId$,
    workflows$,
  );
  const syncAgentMentionAvatars$ = createSyncAgentMentionAvatarsCommand(
    agentMentionAvatarRuntime,
  );
  const templates = createTemplateSignals(editor, draft, openDialog$);
  const selectedSuggestionIndex$ = computed((get) => {
    return get(selectedSuggestionIndexState$);
  });
  const activeSlashRange$ = createActiveSuggestionRange(
    editor,
    caretIndex$,
    editorFocusedState$,
    findActiveSlashWorkflowRange,
  );
  const activeChatThreadSuggestionRange$ = createActiveSuggestionRange(
    editor,
    caretIndex$,
    editorFocusedState$,
    findActiveChatThreadSuggestionRange,
  );
  const chatThreadSuggestions$ = createComposerChatThreadSuggestions(
    activeChatThreadSuggestionRange$,
    agentId$,
  );
  const setSelectedSuggestionIndex$ = command(({ set }, index: number) => {
    set(selectedSuggestionIndexState$, index);
    set(previewSuggestionIndexState$, null);
  });
  const previewSuggestionIndex$ = computed((get) => {
    return (
      get(previewSuggestionIndexState$) ?? get(selectedSuggestionIndexState$)
    );
  });
  const previewSuggestion$ = command(({ set }, index: number | null) => {
    set(previewSuggestionIndexState$, index);
  });
  const closeSuggestionMenu$ = command(({ set }) => {
    set(previewSuggestionIndexState$, null);
    set(caretIndex$, -1);
  });
  const focus$ = command(() => {
    editor.commands.focus("end");
  });
  const setContainerRef$ = createMountEditorCommand({
    editor,
    draft,
    runtime,
    legacyTemplateAttachment: templates.legacy,
    templateSelection: templates.selection,
    openTemplatePicker$: templates.commands.openTemplatePicker$,
    caretIndex$,
    editorFocusedState$,
    selectedSuggestionIndexState$,
    previewSuggestionIndexState$,
    feedback,
    compositionGate,
    syncWorkflowNames$,
    syncAgentMentionAvatars$,
    autoFocus: options.autoFocus ?? false,
  });
  const suggestionInsertionCommands = createSuggestionInsertionCommands(
    editor,
    activeSlashRange$,
    activeChatThreadSuggestionRange$,
  );
  const textCommands = createInsertTextCommands(editor);
  const insertUserMessage$ = createInsertUserMessageCommand(editor);
  const readInputForSubmission$ = createReadInputForSubmissionCommand(
    editor,
    compositionGate,
  );
  const hasInput$ = computed((get) => {
    return get(draft.hasInput$) || get(feedback.active$);
  });

  return {
    editor,
    templatePreview,
    setContainerRef$,
    focus$,
    hasInput$,
    hasTemplateAttachment$: templates.legacy.active$,
    templateRequests$: templates.selection.requests$,
    activeSlashRange$,
    activeChatThreadSuggestionRange$,
    chatThreadSuggestions$,
    agentId$,
    workflows$,
    reloadWorkflows$: reloadMountedComposerWorkflows$,
    selectedSuggestionIndex$,
    setSelectedSuggestionIndex$,
    previewSuggestionIndex$,
    previewSuggestion$,
    closeSuggestionMenu$,
    ...suggestionInsertionCommands,
    ...textCommands,
    ...templates.commands,
    insertUserMessage$,
    readInputForSubmission$,
    feedback: feedback.signals,
  };
}
