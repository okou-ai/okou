import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  generationTemplateRequestSchema,
  userMessageDocumentSchema,
  userMessageInputDocumentSchema,
  type FeedbackNotePart,
  type GenerationTemplateRequest,
  type ImageAnnotation,
  type PersistedAttachment,
  type UserMessageDocument,
  type UserMessageInputDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";

import { i18n } from "../../i18n/index.ts";
import type { RestorableAttachment } from "./chat-draft.ts";
import { formatFeedbackPrompt, type FeedbackSource } from "./chat-feedback.ts";
import { serializeChatThreadMention } from "./chat-thread-suggestion-domain.ts";
import { avatarTemplateSelection } from "./avatar-template-selection.ts";
import { generationTemplateKind } from "@okouai/core/generation-template-kind";
import {
  serializeAgentMention,
  splitAgentMentionSegments,
} from "./composer-agent-suggestion-domain.ts";

export const AGENT_MENTION_NODE_NAME = "agentMention";
export const CHAT_THREAD_MENTION_NODE_NAME = "chatThreadMention";
export const TEMPLATE_ATTACHMENT_NODE_NAME = "templateAttachment";
export const INLINE_TEMPLATE_NODE_NAME = "inlineTemplate";
const FEEDBACK_ITEM_NODE_NAME = "feedbackItem";

export type MessageDocumentAttachment = PersistedAttachment & {
  readonly annotatedFileId?: string;
  readonly annotations?: ImageAnnotation;
};

export interface EditorDocumentContext {
  readonly selectedTemplate?: GenerationTemplateRequest;
  readonly attachments?: readonly MessageDocumentAttachment[];
}

export interface EditorDocumentSnapshot {
  readonly toEditorDocument: () => JSONContent;
  readonly toMessageDocument: (
    context?: EditorDocumentContext,
  ) => UserMessageInputDocument | null;
  readonly toDraft: (
    context?: EditorDocumentContext,
  ) => EditorDraftDocument | null;
}

export interface EditorDraftDocument {
  readonly userMessage: UserMessageInputDocument;
}

export function shouldUseUserMessage(
  document: UserMessageDocument | null | undefined,
): document is UserMessageDocument {
  return document !== null && document !== undefined;
}

interface TextMessageTemplateSnapshot {
  readonly titleSnapshot: string;
  readonly template: GenerationTemplateRequest;
}

function appendTextPart(parts: UserMessagePart[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = parts.at(-1);
  if (previous?.type === "text") {
    parts[parts.length - 1] = {
      type: "text",
      text: previous.text + text,
    };
    return;
  }
  parts.push({ type: "text", text });
}

function chatThreadPart(
  node: ProseMirrorNode,
): Extract<UserMessagePart, { type: "chat_thread" }> | null {
  const threadId: unknown = node.attrs.threadId;
  const title: unknown = node.attrs.title;
  if (typeof threadId !== "string" || typeof title !== "string") {
    return null;
  }
  return {
    type: "chat_thread",
    threadId,
    titleSnapshot: title,
  };
}

function agentPart(
  node: ProseMirrorNode,
): Extract<UserMessagePart, { type: "agent" }> | null {
  const agentId: unknown = node.attrs.agentId;
  const name: unknown = node.attrs.name;
  if (typeof agentId !== "string" || typeof name !== "string") {
    return null;
  }
  return {
    type: "agent",
    agentId,
    nameSnapshot: name,
  };
}

function selectedTemplatePart(
  node: ProseMirrorNode,
  selectedTemplate: GenerationTemplateRequest | undefined,
): UserMessagePart | null {
  const templateType: unknown = node.attrs.templateType;
  const title: unknown = node.attrs.title;
  if (
    selectedTemplate === undefined ||
    templateType !== templateAttachmentType(selectedTemplate) ||
    typeof title !== "string"
  ) {
    return null;
  }
  return {
    type: "template",
    titleSnapshot: title,
    template: selectedTemplate,
  };
}

function inlineTemplatePart(
  node: ProseMirrorNode,
): Extract<UserMessagePart, { type: "template" }> | null {
  const title: unknown = node.attrs.title;
  const parsedTemplate = generationTemplateRequestSchema.safeParse(
    node.attrs.template,
  );
  if (typeof title !== "string" || !parsedTemplate.success) {
    return null;
  }
  return {
    type: "template",
    titleSnapshot: title,
    template: parsedTemplate.data,
  };
}

function appendParagraphParts(
  paragraph: ProseMirrorNode,
  parts: UserMessagePart[],
): boolean {
  for (let index = 0; index < paragraph.childCount; index++) {
    const node = paragraph.child(index);
    if (node.isText) {
      if (typeof node.text !== "string") {
        return false;
      }
      appendTextPart(parts, node.text);
      continue;
    }
    if (node.type.name === "hardBreak") {
      appendTextPart(parts, "\n");
      continue;
    }
    if (node.type.name === AGENT_MENTION_NODE_NAME) {
      const part = agentPart(node);
      if (!part) {
        return false;
      }
      parts.push(part);
      continue;
    }
    if (node.type.name === CHAT_THREAD_MENTION_NODE_NAME) {
      const part = chatThreadPart(node);
      if (!part) {
        return false;
      }
      parts.push(part);
      continue;
    }
    if (node.type.name === INLINE_TEMPLATE_NODE_NAME) {
      const part = inlineTemplatePart(node);
      if (!part) {
        return false;
      }
      parts.push(part);
      continue;
    }
    return false;
  }
  return true;
}

function appendFileParts(
  parts: UserMessagePart[],
  attachments: readonly MessageDocumentAttachment[],
): void {
  for (const attachment of attachments) {
    parts.push({
      type: "file",
      fileId: attachment.id,
      filenameSnapshot: attachment.filename,
      contentType: attachment.contentType,
      ...(attachment.annotatedFileId
        ? { annotatedFileId: attachment.annotatedFileId }
        : {}),
      ...(attachment.annotations
        ? { annotations: attachment.annotations }
        : {}),
    });
  }
}

function feedbackSource(
  node: ProseMirrorNode,
): FeedbackSource | null | undefined {
  const sourceType: unknown = node.attrs.sourceType;
  const sourceId: unknown = node.attrs.sourceId;
  const sourceStatus: unknown = node.attrs.sourceStatus;
  const sourceSentId: unknown = node.attrs.sourceSentId;
  if (
    sourceType === null &&
    sourceId === null &&
    sourceStatus === null &&
    sourceSentId === null
  ) {
    return undefined;
  }
  if (
    sourceType !== "mail" ||
    typeof sourceId !== "string" ||
    (sourceStatus !== "draft" && sourceStatus !== "sent") ||
    (sourceSentId !== null && typeof sourceSentId !== "string")
  ) {
    return null;
  }
  return {
    type: sourceType,
    id: sourceId,
    status: sourceStatus,
    ...(typeof sourceSentId === "string" ? { sentId: sourceSentId } : {}),
  };
}

interface FeedbackLocation {
  readonly eventId: string;
  readonly range: {
    readonly start: number;
    readonly end: number;
  };
}

function feedbackLocation(
  node: ProseMirrorNode,
): FeedbackLocation | null | undefined {
  const eventId: unknown = node.attrs.eventId;
  const rangeStart: unknown = node.attrs.rangeStart;
  const rangeEnd: unknown = node.attrs.rangeEnd;
  if (eventId === null && rangeStart === null && rangeEnd === null) {
    return undefined;
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
    return null;
  }
  return { eventId, range: { start: rangeStart, end: rangeEnd } };
}

function feedbackPart(node: ProseMirrorNode): UserMessagePart | null {
  const quote: unknown = node.attrs.quote;
  const source = feedbackSource(node);
  const location = feedbackLocation(node);
  if (typeof quote !== "string" || source === null || location === null) {
    return null;
  }
  const note: UserMessagePart[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const paragraph = node.child(index);
    if (paragraph.type.name !== "paragraph") {
      return null;
    }
    if (index > 0) {
      appendTextPart(note, "\n");
    }
    if (!appendParagraphParts(paragraph, note)) {
      return null;
    }
  }
  if (
    !note.every((part): part is FeedbackNotePart => {
      return (
        part.type === "text" ||
        part.type === "chat_thread" ||
        part.type === "agent" ||
        part.type === "template"
      );
    })
  ) {
    return null;
  }
  return {
    type: "feedback",
    quote,
    note,
    ...location,
    ...(source ? { source } : {}),
  };
}

function selectedTemplateNodeCount(document: ProseMirrorNode): number | null {
  let count = 0;
  for (let index = 0; index < document.childCount; index++) {
    const nodeName = document.child(index).type.name;
    if (nodeName === "paragraph" || nodeName === FEEDBACK_ITEM_NODE_NAME) {
      continue;
    }
    if (nodeName !== TEMPLATE_ATTACHMENT_NODE_NAME) {
      return null;
    }
    count += 1;
  }
  return count <= 1 ? count : null;
}

function appendFeedbackGroup(
  document: ProseMirrorNode,
  startIndex: number,
  parts: UserMessagePart[],
): { readonly nextIndex: number; readonly emitted: boolean } | null {
  const feedbackParts: UserMessagePart[] = [];
  let index = startIndex;
  while (index < document.childCount) {
    const node = document.child(index);
    if (node.type.name !== FEEDBACK_ITEM_NODE_NAME) {
      break;
    }
    const part = feedbackPart(node);
    if (!part || part.type !== "feedback") {
      return null;
    }
    feedbackParts.push(part);
    index += 1;
  }
  parts.push(...feedbackParts);
  return { nextIndex: index, emitted: feedbackParts.length > 0 };
}

function completedEditorDraft(
  parts: readonly UserMessagePart[],
): EditorDraftDocument | null {
  if (parts.length === 0) {
    return null;
  }
  const parsed = userMessageInputDocumentSchema.safeParse({
    version: 1,
    parts,
  });
  return parsed.success ? { userMessage: parsed.data } : null;
}

function editorDocToDraftDocument(
  document: ProseMirrorNode,
  context: EditorDocumentContext = {},
): EditorDraftDocument | null {
  if (document.type.name !== "doc") {
    return null;
  }

  const parts: UserMessagePart[] = [];
  const attachments = context.attachments ?? [];
  let filesAppended = false;
  const documentTemplateCount = selectedTemplateNodeCount(document);
  if (documentTemplateCount === null) {
    return null;
  }

  let previousPromptSection: "paragraph" | "feedback" | null = null;
  for (let index = 0; index < document.childCount; index++) {
    const node = document.child(index);
    if (node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) {
      const part = selectedTemplatePart(node, context.selectedTemplate);
      if (!part) {
        return null;
      }
      parts.push(part);
      continue;
    }
    if (!filesAppended) {
      appendFileParts(parts, attachments);
      filesAppended = true;
    }
    if (node.type.name === FEEDBACK_ITEM_NODE_NAME) {
      const feedbackGroup = appendFeedbackGroup(document, index, parts);
      if (feedbackGroup === null) {
        return null;
      }
      index = feedbackGroup.nextIndex - 1;
      if (feedbackGroup.emitted) {
        previousPromptSection = "feedback";
      }
      continue;
    }
    if (previousPromptSection === "paragraph") {
      appendTextPart(parts, "\n");
    }
    if (!appendParagraphParts(node, parts)) {
      return null;
    }
    previousPromptSection = "paragraph";
  }
  if (!filesAppended) {
    appendFileParts(parts, attachments);
  }
  if (documentTemplateCount === 0 && context.selectedTemplate !== undefined) {
    return null;
  }

  return completedEditorDraft(parts);
}

/**
 * Converts the current composer snapshot into its editor-independent business
 * document. External files are normalized after the leading template chip and
 * before the text body, matching their current composer presentation order.
 */
export function editorDocToMessageDocument(
  document: ProseMirrorNode,
  context: EditorDocumentContext = {},
): UserMessageInputDocument | null {
  return editorDocToDraftDocument(document, context)?.userMessage ?? null;
}

/**
 * Freezes the immutable ProseMirror document selected for one submission while
 * allowing external attachment ids to be supplied after upload/model filtering
 * settles. The returned value never crosses an API or persistence boundary.
 */
export function createEditorDocumentSnapshot(
  document: ProseMirrorNode,
  additionalInfo?: string,
): EditorDocumentSnapshot {
  return Object.freeze({
    toEditorDocument() {
      return document.toJSON();
    },
    toMessageDocument(
      context: EditorDocumentContext = {},
    ): UserMessageInputDocument | null {
      const message = editorDocToMessageDocument(document, context);
      return message && additionalInfo
        ? {
            ...message,
            parts: [
              { type: "additional_info", text: additionalInfo },
              ...message.parts,
            ],
          }
        : message;
    },
    toDraft(context: EditorDocumentContext = {}) {
      return editorDocToDraftDocument(document, context);
    },
  });
}

/** Creates the business document for sends that do not originate in Tiptap. */
export function textToMessageDocument(
  text: string,
  template?: TextMessageTemplateSnapshot,
  attachments: readonly MessageDocumentAttachment[] = [],
): UserMessageInputDocument | null {
  const parts: UserMessagePart[] = [];
  if (template) {
    parts.push({
      type: "template",
      titleSnapshot: template.titleSnapshot,
      template: template.template,
    });
  }
  appendFileParts(parts, attachments);
  appendTextPart(parts, text);
  const parsed = userMessageInputDocumentSchema.safeParse({
    version: 1,
    parts,
  });
  return parsed.success ? parsed.data : null;
}

function templateAttachmentType(template: GenerationTemplateRequest): string {
  return avatarTemplateSelection(template) ? "avatar" : template.type;
}

function templateCategory(template: GenerationTemplateRequest): string {
  const kind = generationTemplateKind(template);
  return kind === "presentation" ? "slides" : kind;
}

function templatePreviewImageUrl(
  template: GenerationTemplateRequest,
): string | null {
  if (template.type === "presentation") {
    return template.selection.previewUrl ?? null;
  }
  return avatarTemplateSelection(template)?.previewUrl ?? null;
}

function templateNode(part: Extract<UserMessagePart, { type: "template" }>) {
  return {
    type: INLINE_TEMPLATE_NODE_NAME,
    attrs: {
      templateType: templateAttachmentType(part.template),
      template: part.template,
      title: part.titleSnapshot,
      category: templateCategory(part.template),
      previewImageUrl: templatePreviewImageUrl(part.template),
    },
  } satisfies JSONContent;
}

function agentMentionNode(part: Extract<UserMessagePart, { type: "agent" }>) {
  return {
    type: AGENT_MENTION_NODE_NAME,
    attrs: {
      agentId: part.agentId,
      name: part.nameSnapshot,
      avatarUrl: null,
    },
  } satisfies JSONContent;
}

function agentMentionInlineContent(line: string): JSONContent[] {
  return splitAgentMentionSegments(line).map((segment): JSONContent => {
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

function feedbackNoteToPrompt(note: readonly FeedbackNotePart[]): string {
  return note
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "chat_thread") {
        return serializeChatThreadMention(part.threadId, part.titleSnapshot);
      }
      if (part.type === "agent") {
        return serializeAgentMention(part.agentId, part.nameSnapshot);
      }
      return `Select ${part.titleSnapshot} ${part.template.type} template`;
    })
    .join("");
}

function feedbackNoteContent(note: readonly FeedbackNotePart[]): JSONContent[] {
  const content: JSONContent[] = [];
  let paragraphContent: JSONContent[] = [];
  let trailingParagraph = false;
  const flushParagraph = () => {
    content.push(
      paragraphContent.length > 0
        ? { type: "paragraph", content: paragraphContent }
        : { type: "paragraph" },
    );
    paragraphContent = [];
    trailingParagraph = false;
  };

  for (const part of note) {
    if (part.type === "template") {
      paragraphContent.push(templateNode(part));
      trailingParagraph = false;
      continue;
    }
    if (part.type === "chat_thread") {
      paragraphContent.push({
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: {
          threadId: part.threadId,
          title: part.titleSnapshot,
        },
      });
      trailingParagraph = false;
      continue;
    }
    if (part.type === "agent") {
      paragraphContent.push(agentMentionNode(part));
      trailingParagraph = false;
      continue;
    }
    const lines = part.text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.length > 0) {
        paragraphContent.push(...agentMentionInlineContent(line));
        trailingParagraph = false;
      }
      if (index < lines.length - 1) {
        flushParagraph();
        trailingParagraph = true;
      }
    }
  }

  if (paragraphContent.length > 0 || trailingParagraph) {
    flushParagraph();
  }
  return content.length > 0 ? content : [{ type: "paragraph" }];
}

function formattedFeedbackParts(
  parts: readonly Extract<UserMessagePart, { type: "feedback" }>[],
  agentRunSourceTitle: string | undefined,
): string {
  return formatFeedbackPrompt(
    parts.map((part) => {
      return {
        quote: part.quote,
        note: feedbackNoteToPrompt(part.note),
        ...(part.source ? { source: part.source } : {}),
      };
    }),
    agentRunSourceTitle,
  );
}

function agentRunSourceTitle(
  parts: readonly UserMessagePart[],
): string | undefined {
  return parts.find((part) => {
    return part.type === "source" && part.kind === "agent";
  })?.titleSnapshot;
}

interface RestoredEditorState {
  readonly content: JSONContent[];
  paragraphContent: JSONContent[];
  trailingParagraph: boolean;
}

function flushRestoredParagraph(state: RestoredEditorState): void {
  state.content.push(
    state.paragraphContent.length > 0
      ? { type: "paragraph", content: state.paragraphContent }
      : { type: "paragraph" },
  );
  state.paragraphContent = [];
  state.trailingParagraph = false;
}

function flushPendingRestoredParagraph(state: RestoredEditorState): void {
  if (state.paragraphContent.length > 0 || state.trailingParagraph) {
    flushRestoredParagraph(state);
  }
}

function appendRestoredText(state: RestoredEditorState, text: string): void {
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length > 0) {
      state.paragraphContent.push(...agentMentionInlineContent(line));
      state.trailingParagraph = false;
    }
    if (index < lines.length - 1) {
      flushRestoredParagraph(state);
      state.trailingParagraph = true;
    }
  }
}

function restoredEditorDoc(userMessage: UserMessageDocument): JSONContent {
  const state: RestoredEditorState = {
    content: [],
    paragraphContent: [],
    trailingParagraph: false,
  };
  let feedbackIndex = 0;
  const parts = userMessage?.parts ?? [];
  const feedbackCount = parts.filter((part) => {
    return part.type === "feedback";
  }).length;

  for (const part of parts) {
    if (part.type === "text") {
      appendRestoredText(state, part.text);
      continue;
    }
    if (part.type === "chat_thread") {
      state.paragraphContent.push({
        type: CHAT_THREAD_MENTION_NODE_NAME,
        attrs: {
          threadId: part.threadId,
          title: part.titleSnapshot,
        },
      });
      state.trailingParagraph = false;
      continue;
    }
    if (part.type === "agent") {
      state.paragraphContent.push(agentMentionNode(part));
      state.trailingParagraph = false;
      continue;
    }
    if (part.type === "feedback") {
      flushPendingRestoredParagraph(state);
      state.content.push({
        type: FEEDBACK_ITEM_NODE_NAME,
        attrs: {
          feedbackId: feedbackIndex + 1,
          quote: part.quote,
          showDivider: feedbackIndex > 0,
          fill: feedbackIndex === feedbackCount - 1,
          ...(part.eventId !== undefined && part.range !== undefined
            ? {
                eventId: part.eventId,
                rangeStart: part.range.start,
                rangeEnd: part.range.end,
              }
            : {}),
          ...(part.source
            ? {
                sourceType: part.source.type,
                sourceId: part.source.id,
                sourceStatus: part.source.status,
                sourceSentId: part.source.sentId ?? null,
              }
            : {}),
        },
        content: feedbackNoteContent(part.note),
      });
      feedbackIndex += 1;
      continue;
    }
    if (part.type === "template") {
      state.paragraphContent.push(templateNode(part));
      state.trailingParagraph = false;
    }
  }

  flushPendingRestoredParagraph(state);
  if (state.content.length === 0) {
    state.content.push({ type: "paragraph" });
  }
  return { type: "doc", content: state.content };
}

/**
 * Restores the editor-owned portion of a business document. File parts stay in
 * the existing external attachment state and therefore do not become Tiptap
 * nodes. Newlines are canonically restored as paragraph boundaries.
 */
export function messageDocumentToEditorDoc(value: unknown): JSONContent | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  return parsed.success ? restoredEditorDoc(parsed.data) : null;
}

/** Restores only the persisted user message portion of a composer draft. */
export function draftToEditorDoc(userMessage: unknown): JSONContent | null {
  const parsedUserMessage = userMessageDocumentSchema.safeParse(userMessage);
  return parsedUserMessage.success
    ? restoredEditorDoc(parsedUserMessage.data)
    : null;
}

/** Serializes the business document to the same plain prompt representation. */
export function messageDocumentToPrompt(value: unknown): string | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const blocks: string[] = [];
  let inlineText = "";
  let feedbackParts: Extract<UserMessagePart, { type: "feedback" }>[] = [];
  const sourceTitle = agentRunSourceTitle(parsed.data.parts);
  const flushInlineText = () => {
    if (inlineText.length > 0) {
      blocks.push(inlineText);
      inlineText = "";
    }
  };
  const flushFeedback = () => {
    if (feedbackParts.length > 0) {
      blocks.push(formattedFeedbackParts(feedbackParts, sourceTitle));
      feedbackParts = [];
    }
  };

  for (const part of parsed.data.parts) {
    if (part.type === "feedback") {
      flushInlineText();
      feedbackParts.push(part);
      continue;
    }
    flushFeedback();
    if (part.type === "text") {
      inlineText += part.text;
    } else if (part.type === "chat_thread") {
      inlineText += serializeChatThreadMention(
        part.threadId,
        part.titleSnapshot,
      );
    } else if (part.type === "agent") {
      inlineText += serializeAgentMention(part.agentId, part.nameSnapshot);
    } else if (part.type === "template") {
      inlineText += `Select ${part.titleSnapshot} ${part.template.type} template`;
    }
  }
  flushFeedback();
  flushInlineText();
  return blocks.join("\n\n");
}

/** Serializes the business document into a compact human-readable label. */
export function messageDocumentToDisplayText(value: unknown): string | null {
  const parsed = userMessageDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const blocks: string[] = [];
  let inlineText = "";
  let feedbackParts: Extract<UserMessagePart, { type: "feedback" }>[] = [];
  const sourceTitle = agentRunSourceTitle(parsed.data.parts);
  const flushInlineText = () => {
    if (inlineText.length > 0) {
      blocks.push(inlineText);
      inlineText = "";
    }
  };
  const flushFeedback = () => {
    if (feedbackParts.length > 0) {
      blocks.push(formattedFeedbackParts(feedbackParts, sourceTitle));
      feedbackParts = [];
    }
  };

  for (const part of parsed.data.parts) {
    if (part.type === "feedback") {
      flushInlineText();
      feedbackParts.push(part);
      continue;
    }
    flushFeedback();
    if (part.type === "text") {
      inlineText += part.text;
      continue;
    }
    if (part.type === "chat_thread") {
      inlineText += i18n.t(
        ($) => {
          return $.chat.messageDocument.chatThread;
        },
        { title: part.titleSnapshot },
      );
      continue;
    }
    if (part.type === "agent") {
      inlineText += i18n.t(
        ($) => {
          return $.chat.messageDocument.agent;
        },
        { name: part.nameSnapshot },
      );
      continue;
    }
    if (
      part.type === "source" ||
      part.type === "automation" ||
      part.type === "goal" ||
      part.type === "model" ||
      part.type === "additional_info"
    ) {
      continue;
    }
    if (part.type === "template") {
      const templateLabel = i18n.t(
        ($) => {
          return $.chat.messageDocument.template;
        },
        { title: part.titleSnapshot },
      );
      inlineText += templateLabel;
      continue;
    }

    flushInlineText();
    blocks.push(
      i18n.t(
        ($) => {
          return $.chat.messageDocument.file;
        },
        { filename: part.filenameSnapshot },
      ),
    );
  }
  flushFeedback();
  flushInlineText();
  return blocks.join("\n\n");
}

export interface RestoredDraftState {
  readonly content: string;
  readonly userMessage: UserMessageDocument | null;
  readonly attachments: RestorableAttachment[];
}

/** Restorable composer attachments for the file parts a draft document still references. */
export function userMessageDraftAttachments(
  document: UserMessageDocument,
  attachments: readonly PersistedAttachment[],
): RestorableAttachment[] {
  const attachmentById = new Map(
    attachments.map((attachment) => {
      return [attachment.id, attachment] as const;
    }),
  );
  return document.parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const attachment = attachmentById.get(part.fileId);
    return attachment
      ? [
          {
            ...attachment,
            ...(part.annotatedFileId
              ? { annotatedFileId: part.annotatedFileId }
              : {}),
            ...(part.annotations ? { annotations: part.annotations } : {}),
          },
        ]
      : [];
  });
}
