import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type OptimisticChatEvent = WithoutSeqId<PersistedChatEvent>;

export type OptimisticUserMessageAssociation = "run" | "queue";

export type ChatEvent = (PersistedChatEvent | OptimisticChatEvent) & {
  readonly contextType?: ChatEventRow["contextType"];
  readonly optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
};

export type ChatInputEvent = Extract<
  ChatEvent,
  {
    eventType: "input.prompt" | "input.automation" | "input.rejected";
  }
>;
