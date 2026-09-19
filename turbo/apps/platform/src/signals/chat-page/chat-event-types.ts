import type { ChatEvent as PersistedChatEvent } from "@okouai/api-contracts/contracts/chat-threads";

type WithoutSeqId<T> = T extends unknown
  ? Omit<T, "seqId"> & { readonly seqId?: never }
  : never;

/**
 * The shape every optimistic event is created with: the page stamps the marker
 * up front so a projection can tell page-local events from persistent ones
 * without inspecting server-owned ordering.
 */
export type OptimisticChatEvent = WithoutSeqId<PersistedChatEvent> & {
  readonly optimistic: true;
};

/**
 * The shape projections read. Shared event-semantics helpers hand events back
 * under the contract type, which widens the marker away, so reading code must
 * accept its absence.
 */
export type ProjectedOptimisticChatEvent = WithoutSeqId<PersistedChatEvent> & {
  readonly optimistic?: true;
};

/** Persistent events never carry the marker: the server never sends it. */
type ProjectedPersistentChatEvent = PersistedChatEvent & {
  readonly optimistic?: false;
};

export type OptimisticUserMessageAssociation = "run" | "queue";

export type ChatEvent = (
  | ProjectedPersistentChatEvent
  | ProjectedOptimisticChatEvent
) & {
  readonly optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
};

export function isOptimisticChatEvent(
  event: ChatEvent,
): event is ChatEvent & ProjectedOptimisticChatEvent {
  return event.optimistic === true;
}

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
