import type { ChatThreadEvent } from "@okouai/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type UnsequencedChatThreadEvent = WithoutSeqId<ChatThreadEvent>;

export type OptimisticChatThreadEvent = UnsequencedChatThreadEvent;

/** Placeholder fields default inside `registerOptimisticChatThreadEvent$`. */
export type OptimisticChatThreadEventInput = Pick<
  OptimisticChatThreadEvent,
  "id" | "kind" | "chatThreadId" | "agentId"
> &
  Partial<OptimisticChatThreadEvent>;

export type CompatibleChatThreadEvent =
  ChatThreadEvent | UnsequencedChatThreadEvent;

export type ChatThreadEventView = CompatibleChatThreadEvent;
