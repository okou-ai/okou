import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

export type OptimisticChatEvent = WithoutSeqId<PersistedChatEvent>;

export type OptimisticUserMessageAssociation = "run" | "queue";

export type ChatEvent = (PersistedChatEvent | OptimisticChatEvent) & {
  readonly optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
};

export type ChatInputEvent = Extract<
  ChatEvent,
  {
    eventType:
      | "input.prompt"
      | "input.automation"
      | "input.goal"
      | "input.rejected";
  }
>;
