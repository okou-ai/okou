import {
  annotatedImageFilename,
  type ChatThreadServiceTier,
  type FeedbackNotePart,
  type GenerationTemplateRequest,
  type UserMessageDocument,
  type UserMessageInputDocument,
  type UserMessageInputPart,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  isChatUserMessageEventType,
  type ChatEventType,
} from "@okouai/api-contracts/contracts/chat-events";
import { generationTemplateKind } from "@okouai/core/generation-template-kind";

interface UserMessageProjection {
  readonly agentPrompt: string;
  readonly displayText: string;
  readonly primaryTemplate: GenerationTemplateRequest | undefined;
  readonly templates: readonly GenerationTemplateRequest[];
  readonly hasTextContent: boolean;
}

interface UserMessageFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
}

type UserMessageFilePart = Extract<UserMessagePart, { readonly type: "file" }>;

function userMessageFileParts(
  document: UserMessageDocument,
): readonly UserMessageFilePart[] {
  return document.parts.filter((part): part is UserMessageFilePart => {
    return part.type === "file";
  });
}

type UserMessageNonContentPart = Extract<
  UserMessageInputPart,
  { readonly type: "source" | "automation" | "goal" }
>;

export interface ChatAgentRunSourceAnnotation {
  readonly runId: string;
  readonly threadId: string;
  readonly agentId: string;
  readonly titleSnapshot: string;
}

export function agentRunSourceTitleSnapshot(title: string | null): string {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle || normalizedTitle.toLowerCase() === "now") {
    return "New thread";
  }
  return normalizedTitle;
}

function chatAgentRunSourceHref(
  source: Pick<ChatAgentRunSourceAnnotation, "runId" | "threadId">,
): string {
  return `/chats/${source.threadId}#run-${source.runId}`;
}

/**
 * Recover the provenance a send route wrote into the persisted document. The
 * annotation is the only place a claimed queue item still carries its source
 * run, because the queue head is read back as a document, not as a send body.
 */
export function agentRunSourceAnnotation(
  document: UserMessageDocument,
): ChatAgentRunSourceAnnotation | null {
  for (const part of document.parts) {
    if (part.type === "source" && part.kind === "agent") {
      return {
        runId: part.runId,
        threadId: part.threadId,
        agentId: part.agentId,
        titleSnapshot: part.titleSnapshot,
      };
    }
  }
  return null;
}

export function hasAgentRunSourceAnnotation(
  document: UserMessageDocument,
): boolean {
  return agentRunSourceAnnotation(document) !== null;
}

/** Replace client-owned annotations with authoritative agent-run provenance. */
export function withAgentRunSourceAnnotation(
  document: UserMessageInputDocument,
  source: ChatAgentRunSourceAnnotation,
): UserMessageInputDocument;
export function withAgentRunSourceAnnotation(
  document: UserMessageDocument,
  source: ChatAgentRunSourceAnnotation,
): UserMessageDocument;
export function withAgentRunSourceAnnotation(
  document: UserMessageDocument,
  source: ChatAgentRunSourceAnnotation,
): UserMessageDocument {
  const contentParts = document.parts.filter((part) => {
    return (
      part.type !== "source" &&
      part.type !== "automation" &&
      part.type !== "goal"
    );
  });
  return {
    version: 1,
    parts: [
      ...contentParts,
      {
        type: "source",
        kind: "agent",
        runId: source.runId,
        threadId: source.threadId,
        agentId: source.agentId,
        titleSnapshot: source.titleSnapshot,
        href: chatAgentRunSourceHref(source),
      },
    ],
  };
}

/** Replace any prior run-model annotation with the model persisted for the run. */
export function withRunModelAnnotation(
  document: UserMessageDocument,
  selectedModel: string,
  serviceTier?: ChatThreadServiceTier,
): UserMessageDocument {
  return {
    version: 1,
    parts: [
      ...document.parts.filter((part) => {
        return part.type !== "model";
      }),
      {
        type: "model",
        selectedModel,
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
    ],
  };
}

export function requiredUserMessageForEvent(
  eventType: ChatEventType,
  document: UserMessageDocument | null,
): UserMessageDocument | null {
  if (!isChatUserMessageEventType(eventType)) {
    return null;
  }
  if (document === null) {
    throw new Error(`${eventType} chat event is missing userMessage`);
  }
  return document;
}

function maybeCreateUserMessageDocument(args: {
  readonly text: string | null;
  readonly files?: readonly UserMessageFile[];
  readonly nonContentPart?: UserMessageNonContentPart;
}): UserMessageInputDocument | null {
  const parts: UserMessageInputPart[] = (args.files ?? []).map((file) => {
    return {
      type: "file",
      fileId: file.id,
      filenameSnapshot: file.filename,
      contentType: file.contentType,
    };
  });
  if (args.text !== null && args.text.length > 0) {
    parts.push({ type: "text", text: args.text });
  }
  if (args.nonContentPart) {
    parts.push(args.nonContentPart);
  }
  return parts.length > 0 ? { version: 1, parts } : null;
}

export function createUserMessageDocument(args: {
  readonly text: string | null;
  readonly files?: readonly UserMessageFile[];
  readonly nonContentPart?: UserMessageNonContentPart;
}): UserMessageInputDocument {
  const document = maybeCreateUserMessageDocument(args);
  if (!document) {
    throw new Error("User message must contain at least one part");
  }
  return document;
}

function serializeChatThreadMention(threadId: string, title: string): string {
  const escapedTitle = title.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedTitle}](/chats/${threadId})`;
}

function serializeAgentMention(agentId: string, name: string): string {
  const escapedName = name.replace(/[\\[\]]/g, String.raw`\$&`);
  return `[${escapedName}](/agents/${agentId}/chat)`;
}

function serializeFeedbackNote(
  parts: readonly FeedbackNotePart[],
  serializeTemplate: (
    part: Extract<FeedbackNotePart, { type: "template" }>,
  ) => string,
): string {
  return parts
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
      return serializeTemplate(part);
    })
    .join("");
}

function webFilePrompt(part: {
  readonly fileId: string;
  readonly filenameSnapshot: string;
  readonly contentType: string;
}): string {
  return `[Web file] ${part.filenameSnapshot} (${part.contentType})\n   [ID] ${part.fileId}`;
}

interface UserMessagePhysicalFile {
  readonly fileId: string;
  readonly filenameSnapshot: string;
  readonly contentType: string;
}

export function userMessagePhysicalFiles(
  document: UserMessageDocument,
): readonly UserMessagePhysicalFile[] {
  return userMessageFileParts(document).flatMap((part) => {
    const original: UserMessagePhysicalFile = {
      fileId: part.fileId,
      filenameSnapshot: part.filenameSnapshot,
      contentType: part.contentType,
    };
    if (!part.annotatedFileId || !part.annotations) {
      return [original];
    }
    return [
      {
        fileId: part.annotatedFileId,
        filenameSnapshot: annotatedImageFilename(part.filenameSnapshot),
        contentType: "image/png",
      },
      original,
    ];
  });
}

function userMessageFilePrompt(part: UserMessageFilePart): string {
  if (!part.annotatedFileId || !part.annotations) {
    return webFilePrompt(part);
  }
  const annotatedFile = webFilePrompt({
    fileId: part.annotatedFileId,
    filenameSnapshot: annotatedImageFilename(part.filenameSnapshot),
    contentType: "image/png",
  });
  return `${annotatedFile}\n\n[Image annotations]\n${JSON.stringify(part)}`;
}

function inlineGenerationTemplatePrompt(
  part: {
    readonly titleSnapshot: string;
    readonly template: GenerationTemplateRequest;
  },
  referenceNumber: number,
): string {
  return `[Template #${referenceNumber}: ${part.titleSnapshot} (${generationTemplateKind(part.template)})]`;
}

function formatFeedbackParts(
  parts: readonly Extract<UserMessagePart, { type: "feedback" }>[],
  serializeTemplate: (
    part: Extract<FeedbackNotePart, { type: "template" }>,
  ) => string,
): string {
  const firstMailSource = parts[0]?.source;
  const commonMailSource =
    firstMailSource !== undefined &&
    parts.every((part) => {
      return (
        part.source?.type === "mail" &&
        part.source.id === firstMailSource.id &&
        part.source.status === firstMailSource.status &&
        part.source.sentId === firstMailSource.sentId
      );
    })
      ? firstMailSource
      : null;
  const hasSourceContext = parts.some((part) => {
    return part.source !== undefined;
  });
  const entries = parts.map((part) => {
    return {
      part,
      note: serializeFeedbackNote(part.note, serializeTemplate).trim(),
    };
  });
  const hasQuoteOnlyPart = entries.some((entry) => {
    return entry.note.length === 0;
  });
  const mailSourceLabel = (
    source: NonNullable<
      Extract<UserMessagePart, { type: "feedback" }>["source"]
    >,
  ) => {
    return source.status === "draft"
      ? `an email draft (mail draft ID: ${source.id})`
      : `a sent email (mail ID: ${source.id}${source.sentId ? `, sent ID: ${source.sentId}` : ""})`;
  };
  const blocks = entries.map(({ part, note }) => {
    const quoted = part.quote
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    const source =
      commonMailSource === null && part.source?.type === "mail"
        ? `Source: ${mailSourceLabel(part.source)}\n\n`
        : "";
    return note.length === 0
      ? `${source}${quoted}`
      : `${source}${quoted}\n\n${note}`;
  });
  const intro = hasQuoteOnlyPart
    ? `The user referenced ${parts.length} parts of your reply:`
    : commonMailSource
      ? parts.length === 1
        ? `Feedback on this part of ${mailSourceLabel(commonMailSource)}:`
        : `Feedback on ${parts.length} parts of ${mailSourceLabel(commonMailSource)}:`
      : hasSourceContext
        ? `Feedback on ${parts.length} selected ${parts.length === 1 ? "passage" : "passages"}:`
        : parts.length === 1
          ? "Feedback on this part of your reply:"
          : `Feedback on ${parts.length} parts of your reply:`;
  return `${intro}\n\n${blocks.join("\n\n---\n\n")}`;
}

/**
 * Projects one validated business document into the server-owned runtime
 * representations. Inline template markers stay in authoritative `parts`
 * order, while their selections are also returned for this run's shared
 * template context.
 */
export function projectUserMessage(
  document: UserMessageDocument,
): UserMessageProjection {
  const additionalInfo: string[] = [];
  const promptBlocks: string[] = [];
  const displayBlocks: string[] = [];
  let inlinePrompt = "";
  let inlineDisplayText = "";
  let feedbackParts: Extract<UserMessagePart, { type: "feedback" }>[] = [];
  let primaryTemplate: GenerationTemplateRequest | undefined;
  const templates: GenerationTemplateRequest[] = [];
  let hasTextContent = false;

  const registerInlineTemplate = (part: {
    readonly titleSnapshot: string;
    readonly template: GenerationTemplateRequest;
  }): string => {
    templates.push(part.template);
    primaryTemplate ??= part.template;
    return inlineGenerationTemplatePrompt(part, templates.length);
  };
  const flushInlinePrompt = () => {
    if (inlinePrompt.length > 0) {
      promptBlocks.push(inlinePrompt);
      inlinePrompt = "";
    }
    if (inlineDisplayText.length > 0) {
      displayBlocks.push(inlineDisplayText);
      inlineDisplayText = "";
    }
  };
  const flushFeedback = () => {
    if (feedbackParts.length === 0) {
      return;
    }
    const formatted = formatFeedbackParts(
      feedbackParts,
      registerInlineTemplate,
    );
    promptBlocks.push(formatted);
    displayBlocks.push(formatted);
    feedbackParts = [];
  };

  for (const part of document.parts) {
    if (part.type === "additional_info") {
      additionalInfo.push(part.text);
      continue;
    }
    if (part.type === "feedback") {
      flushInlinePrompt();
      feedbackParts.push(part);
      hasTextContent = true;
      continue;
    }
    flushFeedback();
    if (part.type === "text") {
      inlinePrompt += part.text;
      inlineDisplayText += part.text;
      hasTextContent ||= part.text.trim().length > 0;
      continue;
    }
    if (part.type === "chat_thread") {
      const serialized = serializeChatThreadMention(
        part.threadId,
        part.titleSnapshot,
      );
      inlinePrompt += serialized;
      inlineDisplayText += `[Chat thread: ${part.titleSnapshot}]`;
      hasTextContent = true;
      continue;
    }
    if (part.type === "agent") {
      inlinePrompt += serializeAgentMention(part.agentId, part.nameSnapshot);
      inlineDisplayText += `[Agent: ${part.nameSnapshot}]`;
      hasTextContent = true;
      continue;
    }
    if (part.type === "file") {
      flushInlinePrompt();
      promptBlocks.push(userMessageFilePrompt(part));
      displayBlocks.push(`[File: ${part.filenameSnapshot}]`);
      continue;
    }
    if (
      part.type === "source" ||
      part.type === "automation" ||
      part.type === "goal" ||
      part.type === "model"
    ) {
      continue;
    }
    inlinePrompt += registerInlineTemplate(part);
    inlineDisplayText += `[Template: ${part.titleSnapshot}]`;
  }
  flushFeedback();
  flushInlinePrompt();

  return {
    agentPrompt: [...additionalInfo, ...promptBlocks].join("\n\n"),
    displayText: displayBlocks.join("\n\n"),
    primaryTemplate,
    templates,
    hasTextContent,
  };
}

/**
 * Project a user message into static public text. User-visible snapshots are
 * retained while internal IDs, source links, and mail identifiers are omitted.
 */
export function projectUserMessageForPublicShare(
  document: UserMessageDocument,
): string {
  const sanitizedDocument: UserMessageDocument = {
    version: 1,
    parts: document.parts.map((part): UserMessagePart => {
      if (part.type !== "feedback") {
        return part;
      }
      return {
        type: "feedback",
        quote: part.quote,
        note: part.note.map((notePart): FeedbackNotePart => {
          if (notePart.type === "text") {
            return notePart;
          }
          if (notePart.type === "chat_thread") {
            return {
              type: "text",
              text: `[Chat thread: ${notePart.titleSnapshot}]`,
            };
          }
          if (notePart.type === "agent") {
            return {
              type: "text",
              text: `[Agent: ${notePart.nameSnapshot}]`,
            };
          }
          return {
            type: "text",
            text: `[Template: ${notePart.titleSnapshot}]`,
          };
        }),
      };
    }),
  };
  const displayText = projectUserMessage(sanitizedDocument).displayText.trim();
  if (displayText.length > 0) {
    return displayText;
  }
  const automation = document.parts.find((part) => {
    return part.type === "automation";
  });
  if (!automation || automation.type !== "automation") {
    return "";
  }
  const brief = automation.automationBrief?.trim();
  return brief && brief.length > 0 ? brief : automation.workflowName.trim();
}
