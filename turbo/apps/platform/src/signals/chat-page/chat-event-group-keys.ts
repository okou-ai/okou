import type { ChatEventGroup, EnrichedChatEvent } from "./chat-event.ts";
import {
  type RunWorkFolding,
  runWorkSectionForGroup,
} from "./run-work-folding.ts";

// The server replaces an input when a run claims it or steer delivers it, so
// event ids are not stable enough to identify a rendered turn. A user turn
// keeps the identity of its first input's replacement chain, and the assistant
// turn that answers it derives its identity from that user turn. Neither
// remounts when the input is replaced or when the reply's first event arrives.
// An assistant turn without a visible user turn before it, because its input
// is folded into a run group or lies outside the render window, keeps its work
// section's identity while new results replace the section's anchor.

/** The render identity of an event, stable across input replacements. */
export function chatEventRenderKey(event: EnrichedChatEvent): string {
  return event.inputOriginId ?? event.id;
}

// Every user group is created with its first input.
function userTurnKey(group: ChatEventGroup): string {
  return chatEventRenderKey(group.events[0]!);
}

/** The identity of the assistant turn answering a user turn. */
export function replyTurnKey(userTurn: ChatEventGroup | undefined): string {
  return `${userTurn === undefined ? "thread" : userTurnKey(userTurn)}:reply`;
}

/** Render identities for groups, in order. */
export function chatEventGroupKeys(
  groups: readonly ChatEventGroup[],
  runWorkFolding: RunWorkFolding | null,
): string[] {
  let previous: ChatEventGroup | undefined;
  return groups.map((group) => {
    const key =
      group.role === "user"
        ? userTurnKey(group)
        : previous?.role === "user"
          ? replyTurnKey(previous)
          : (runWorkSectionForGroup(runWorkFolding, group)?.key ??
            group.beginEventId);
    previous = group;
    return key;
  });
}
