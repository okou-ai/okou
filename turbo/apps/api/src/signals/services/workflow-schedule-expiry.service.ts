import { workflowAutomations } from "@okouai/db/schema/workflow";
import { workflowScheduleSkips } from "@okouai/db/schema/workflow-schedule-skip";
import { and, eq, sql } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";

import { calculateNextRun } from "./time-automation";

import { SCHEDULE_GRACE_MS, scheduleExpired } from "./schedule-expiry-policy";

import { pgTextDecoder } from "../../lib/db-structured-result";

type Automation = typeof workflowAutomations.$inferSelect;

function stillExpired(
  current: Automation | undefined,
  initial: Pick<
    Automation,
    "orgId" | "ownerUserId" | "workflowId" | "officialBlueprintKey"
  >,
  args: { readonly anchor: Date; readonly at: Date },
): current is Automation {
  return (
    current !== undefined &&
    current.enabled &&
    current.kind === "schedule" &&
    (current.scheduleType === "cron" ||
      current.scheduleType === "loop" ||
      current.scheduleType === "once") &&
    current.nextRunAt?.getTime() === args.anchor.getTime() &&
    scheduleExpired(args.anchor, args.at) &&
    current.orgId === initial.orgId &&
    current.ownerUserId === initial.ownerUserId &&
    current.workflowId === initial.workflowId &&
    current.officialBlueprintKey === initial.officialBlueprintKey
  );
}

/** Existence probes stay bounded; no whole pending queue is materialized. */
function workflowScheduleAlreadyClaimedSql(current: Automation, anchor: Date) {
  return sql`(EXISTS (
    SELECT 1 FROM morning_brief_schedule_claims
    WHERE automation_id = ${current.id}::uuid AND scheduled_anchor_at = ${anchor}
  ) OR EXISTS (
    SELECT 1 FROM workflow_user_automation_threads binding
    JOIN chat_events event ON event.chat_thread_id = binding.chat_thread_id
    JOIN chat_automation_context context ON context.id = event.context_id
    WHERE binding.org_id = ${current.orgId} AND binding.user_id = ${current.ownerUserId}
      AND binding.workflow_id = ${current.workflowId}::uuid
      AND event.event_type = 'input.automation' AND event.run_id IS NULL
      AND event.context_type = 'automation' AND context.automation_id = ${current.id}::uuid
      AND NOT EXISTS (SELECT 1 FROM chat_events revoked WHERE revoked.revokes_event_id = event.id)
  ) OR EXISTS (SELECT 1 FROM morning_brief_schedule_claims
    WHERE automation_id = ${current.id}::uuid AND settlement = 'unsettled'))`;
}

function futureAfterSkip(current: Automation, at: Date): Date | null {
  if (current.scheduleType === "cron" && current.cronExpression) {
    return calculateNextRun(current.cronExpression, current.timezone, at);
  }
  if (current.scheduleType === "loop" && current.intervalSeconds !== null) {
    return new Date(at.getTime() + current.intervalSeconds * 1000);
  }
  return null;
}

function expiredScheduleValues(
  current: Automation,
  nextRunAt: Date | null,
  at: Date,
) {
  return {
    nextRunAt,
    ...(current.scheduleType === "once" ? { enabled: false } : {}),
    deferredAnchorAt: null,
    deferredUntil: null,
    deferredReason: null,
    updatedAt: at,
  };
}

interface ExpiredScheduleInput {
  readonly automationId: string;
  readonly anchor: Date;
  readonly at: Date;
}

/**
 * Settle only the old, unclaimed occurrence. No Run, failure or queue event is
 * created; the next recurring obligation is strictly in the future.
 */
export const skipExpiredWorkflowSchedule$ = command(
  async (
    { set },
    args: ExpiredScheduleInput,
    signal: AbortSignal,
  ): Promise<"skipped" | "moved" | "held"> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0343; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [initial] = await tx
        .select({
          id: workflowAutomations.id,
          orgId: workflowAutomations.orgId,
          ownerUserId: workflowAutomations.ownerUserId,
          workflowId: workflowAutomations.workflowId,
          officialBlueprintKey: workflowAutomations.officialBlueprintKey,
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .limit(1);
      if (!initial) {
        return "moved";
      }
      const [snapshot] = await tx
        .select({
          row: workflowAutomations,
          version: sql`${workflowAutomations}.xmin::text`.mapWith(
            pgTextDecoder,
          ),
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .limit(1);
      const current = snapshot?.row;
      if (!stillExpired(current, initial, args) || !snapshot) {
        return "moved";
      }
      const [pending] = await tx
        .select({
          held: workflowScheduleAlreadyClaimedSql(current, args.anchor).mapWith(
            workflowAutomations.enabled,
          ),
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, current.id))
        .limit(1);
      if (pending?.held) {
        return "held";
      }
      const nextRunAt = futureAfterSkip(current, args.at);
      if (
        current.scheduleType !== "once" &&
        (nextRunAt === null || nextRunAt.getTime() <= args.at.getTime())
      ) {
        return "held";
      }
      const [applied] = await tx
        .update(workflowAutomations)
        .set(expiredScheduleValues(current, nextRunAt, args.at))
        .where(
          and(
            eq(workflowAutomations.id, current.id),
            sql`${workflowAutomations}.xmin::text = ${snapshot.version}`,
            sql`NOT ${workflowScheduleAlreadyClaimedSql(current, args.anchor)}`,
          ),
        )
        .returning({ id: workflowAutomations.id });
      if (!applied) {
        return "moved";
      }
      await tx
        .insert(workflowScheduleSkips)
        .values({
          automationId: current.id,
          scheduledAnchorAt: args.anchor,
          skippedAt: args.at,
        })
        .onConflictDoNothing();
      signal.throwIfAborted();
      return "skipped" as const;
    });
    signal.throwIfAborted();
    return result;
  },
);

/** Bounded, anchor-scoped retry for an unclaimable but not-yet-expired slot. */
export const deferWorkflowSchedule$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly anchor: Date;
      readonly at: Date;
      readonly reason: "not_fireable" | "unavailable" | "held";
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const expiryAt = args.anchor.getTime() + SCHEDULE_GRACE_MS;
    const retryAt = new Date(
      expiryAt < args.at.getTime()
        ? args.at.getTime() + 60_000
        : Math.min(args.at.getTime() + 60_000, expiryAt),
    );
    await db
      .update(workflowAutomations)
      .set({
        deferredAnchorAt: args.anchor,
        deferredUntil: retryAt,
        deferredReason: args.reason,
      })
      .where(
        and(
          eq(workflowAutomations.id, args.automationId),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.nextRunAt, args.anchor),
        ),
      );
    signal?.throwIfAborted();
  },
);
