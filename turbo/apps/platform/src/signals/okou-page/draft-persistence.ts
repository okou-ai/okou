import type {
  GenerationTemplateRequest,
  ImageAnnotation,
  PersistedAttachment,
  UserMessageInputDocument,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  textToMessageDocument,
  restoredMessageToDraftDocument,
  type EditorDocumentSnapshot,
} from "./user-message-document-codec.ts";

interface DraftAttachmentSnapshot extends PersistedAttachment {
  readonly annotatedFileId?: string;
  readonly annotations?: ImageAnnotation;
}

export interface DraftPersistencePayload {
  readonly userMessage: UserMessageInputDocument | null;
  readonly attachments: PersistedAttachment[] | null;
}

interface DraftPersistenceSource {
  readonly input: string;
  readonly editorDocument: EditorDocumentSnapshot | null;
  readonly restoredUserMessage: UserMessageDocument | null;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: readonly DraftAttachmentSnapshot[];
}

export function buildDraftPersistencePayload(
  source: DraftPersistenceSource,
): DraftPersistencePayload {
  const content = source.input.trim() || null;
  const attachments: PersistedAttachment[] | null =
    source.attachments.length > 0
      ? source.attachments.map((attachment) => {
          return {
            id: attachment.id,
            url: attachment.url,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
          };
        })
      : null;
  const hasFallbackUserMessageDraft =
    content !== null ||
    source.generationTemplate !== undefined ||
    attachments !== null;

  let userMessage: UserMessageInputDocument | null = null;
  if (source.editorDocument) {
    const serialized = source.editorDocument.toDraft({
      selectedTemplate: source.generationTemplate,
      attachments: source.attachments,
    });
    if (!serialized && hasFallbackUserMessageDraft) {
      throw new Error("Failed to serialize composer draft");
    }
    if (serialized) {
      userMessage = serialized.userMessage;
    }
  } else if (source.restoredUserMessage) {
    userMessage = restoredMessageToDraftDocument(
      source.restoredUserMessage,
      source.attachments,
    );
    if (!userMessage && hasFallbackUserMessageDraft) {
      throw new Error("Failed to serialize restored composer draft");
    }
  } else if (hasFallbackUserMessageDraft) {
    userMessage = textToMessageDocument(
      source.input,
      undefined,
      source.attachments,
    );
    if (!userMessage) {
      throw new Error("Failed to serialize user-message draft");
    }
  }

  return { userMessage, attachments };
}
