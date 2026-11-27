import {
  pgTextDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { activePlatformScheduleOwnerQuery } from "./platform-schedule-activity.service";
import { nowDate } from "../../lib/time";
import {
  proactiveTasks,
  type ProactiveTask,
} from "@okouai/api-contracts/contracts/proactive";
import { proactiveOccurrences } from "@okouai/db/schema/proactive-schedule";
import { command, computed, type Computed } from "ccstate";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { boolean, date, object, enum as zEnum } from "zod";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import {
  MORNING_BRIEF_INSTRUCTION,
  PROACTIVE_SUGGESTIONS_INSTRUCTION,
} from "./proactive-task-instructions";
import { PROACTIVE_LEARNING_INSTRUCTION } from "./proactive-nightly-instructions";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

export const PROACTIVE_SELECTED_MODEL = "okou/proactive";
export const proactiveInstructions = Object.freeze({
  "morning-brief": MORNING_BRIEF_INSTRUCTION,
  suggestions: PROACTIVE_SUGGESTIONS_INSTRUCTION,
  learning: PROACTIVE_LEARNING_INSTRUCTION,
} satisfies Record<ProactiveTask, string>);
const inputSchema = object({
  scheduledAt: date(),
  task: zEnum(proactiveTasks),
  suggestionsEnabled: boolean(),
  cardDeliveryEnabled: boolean(),
});
interface ProactiveIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly id: string;
}

/** Prepare and commit use the same ownership predicate. The committing read locks the observed schedule. */
export function proactiveInputSql(
  identity: ProactiveIdentity,
  commit?: {
    readonly suggestionsEnabled: boolean;
    readonly cardDeliveryEnabled: boolean;
  },
) {
  const suggestions = sql`coalesce(m.proactive_suggestions_enabled,false)`;
  return sql`SELECT o.task,o.scheduled_at,${suggestions} AS "suggestionsEnabled",coalesce(f.suggestions,true) AS "cardDeliveryEnabled"
    FROM proactive_occurrences o JOIN proactive_schedules s USING (org_id,user_id,task)
    JOIN chat_threads t ON t.id=o.chat_thread_id AND t.org_id=o.org_id AND t.user_id=o.user_id AND t.hidden
    JOIN org_members_cache member ON member.org_id=o.org_id AND member.user_id=o.user_id
    LEFT JOIN org_members_metadata m ON m.org_id=o.org_id AND m.user_id=o.user_id
    LEFT JOIN feed_preferences f ON f.org_id=o.org_id AND f.user_id=o.user_id
    WHERE o.id=${identity.id}::uuid AND o.org_id=${identity.orgId} AND o.user_id=${identity.userId}
      AND o.chat_thread_id=${identity.chatThreadId}::uuid AND s.chat_thread_id=o.chat_thread_id
      AND o.settled_at IS NULL AND o.run_id IS NULL AND o.preference_revision=s.preference_revision
      AND s.enabled AND s.intended_enabled AND (o.task='morning-brief' OR ${suggestions})
      AND EXISTS (${activePlatformScheduleOwnerQuery(identity, nowDate())})
      ${commit ? sql`AND ${suggestions}=${commit.suggestionsEnabled} AND coalesce(f.suggestions,true)=${commit.cardDeliveryEnabled} FOR UPDATE OF s,o` : sql.empty()}`;
}

export function createProactiveInput(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (
      event?.contextType !== "proactive" ||
      event.eventType !== "input.prompt" ||
      event.contextId !== event.id
    ) {
      return null;
    }
    const [input] = await get(db$)
      .select({
        scheduledAt: sql`source.scheduled_at`.mapWith(
          proactiveOccurrences.scheduledAt,
        ),
        task: sql`source.task`.mapWith(pgTextDecoder),
        suggestionsEnabled: sql`source."suggestionsEnabled"`.mapWith(
          pgBooleanDecoder,
        ),
        cardDeliveryEnabled: sql`source."cardDeliveryEnabled"`.mapWith(
          pgBooleanDecoder,
        ),
      })
      .from(
        sql`(${proactiveInputSql({ ...bootstrap, id: event.id })}) AS source`,
      );
    return input ? inputSchema.parse(input) : null;
  });
}

export const proactiveRunReceipt$ = command(
  async (
    { get },
    owner: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ) => {
    const [row] = await get(db$)
      .select({
        id: proactiveOccurrences.id,
        task: proactiveOccurrences.task,
        suggestionsEnabled: proactiveOccurrences.suggestionsEnabled,
        cardDeliveryEnabled: proactiveOccurrences.cardDeliveryEnabled,
      })
      .from(proactiveOccurrences)
      .where(
        and(
          eq(proactiveOccurrences.runId, owner.runId),
          eq(proactiveOccurrences.orgId, owner.orgId),
          eq(proactiveOccurrences.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
    return row ?? null;
  },
);

export function morningBriefReceiptSql(
  runId: SQL,
  orgId: string,
  userId: string,
) {
  return sql`EXISTS (SELECT 1 FROM proactive_occurrences receipt WHERE receipt.run_id=${runId} AND receipt.org_id=${orgId} AND receipt.user_id=${userId} AND receipt.task='morning-brief')`;
}
