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

export function isGoalContinuationInput(
  event: ChatEvent,
): event is ChatInputEvent {
  return (
    (event.eventType === "input.prompt" || event.eventType === "input.goal") &&
    event.userMessage.parts.some((part) => {
      return part.type === "goal";
    })
  );
}
