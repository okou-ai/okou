import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  and,
  eq,
  isNotNull,
  isNull,
  not,
  notExists,
  or,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  chatEventTypeIn,
  runOwnedChatEventCondition,
} from "./chat-event-type.service";
import { canonicalChatEventError } from "./canonical-chat-event-read.service";

const revoker = alias(chatEvents, "revoker");

export function visibleChatEventCondition(): SQL | undefined {
  return visibleChatEventPredicate();
}

export function visibleChatEventPredicate(): SQL | undefined {
  const isUserInputEvent = chatEventTypeIn([
    "input.prompt",
    "input.automation",
    "input.rejected",
    "control.interrupt",
    "control.revoke",
  ]);
  const hasRunOwner = and(
    isNotNull(chatEvents.runId),
    runOwnedChatEventCondition(),
  );
  return and(
    notExists(
      new QueryBuilder()
        .select({ id: revoker.id })
        .from(revoker)
        .where(eq(revoker.revokesEventId, chatEvents.id)),
    ),
    or(
      not(isUserInputEvent),
      hasRunOwner,
      isNull(chatEvents.revokesEventId),
      isNotNull(canonicalChatEventError()),
    ),
    not(chatEventTypeIn(["control.interrupt"])),
  );
}
