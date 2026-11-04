import type { ChatThreadEvent } from "@okouai/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type UnsequencedChatThreadEvent = WithoutSeqId<ChatThreadEvent>;

export type OptimisticChatThreadEvent = UnsequencedChatThreadEvent;

/** Placeholder fields default inside `registerOptimisticChatThreadEvent$`. */
type DefaultedEventField =
  | "title"
  | "selectedModel"
  | "serviceTier"
  | "computerUseHostId"
  | "cloudBrowserEnabled"
  | "createdAt";
type EventInput<T extends OptimisticChatThreadEvent> = T extends unknown
  ? Omit<T, DefaultedEventField> & Partial<Pick<T, DefaultedEventField>>
  : never;
export type OptimisticChatThreadEventInput =
  EventInput<OptimisticChatThreadEvent>;

export type CompatibleChatThreadEvent =
  ChatThreadEvent | UnsequencedChatThreadEvent;

export type ChatThreadEventView = CompatibleChatThreadEvent;
