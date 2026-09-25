import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import type { LinkLayoutSegment } from "@okouai/api-contracts/contracts/link-layout";

export type ChatEventUserMessage = UserMessageDocument;

export interface ChatEventUsageProviderBreakdown {
  readonly provider: string;
  readonly credits: number;
}

export interface ChatEventUsageKindBreakdown {
  readonly kind: string;
  readonly credits: number;
  readonly providers: readonly ChatEventUsageProviderBreakdown[];
}

export interface ChatEventUsagePayload {
  readonly version: 1;
  readonly totalCredits: number;
  readonly settledAt: string;
  readonly breakdown: readonly ChatEventUsageKindBreakdown[];
}

/** Canonical payload envelope for one chat event. */
export interface ChatEventPayload {
  readonly content?: string;
  readonly userMessage?: ChatEventUserMessage;
  readonly thinking?: string;
  readonly error?: string;
  readonly usage?: ChatEventUsagePayload;
}

export interface ChatEventAttachFileMetadata {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly objectKey: string;
  /** Persisted link-layout marker of the uploaded object. */
  readonly publicBrand: LinkLayoutSegment;
}

export type ChatEventAttachFileMetadataList = ChatEventAttachFileMetadata[];
