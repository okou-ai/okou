import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefNativeSchedules } from "@okouai/db/schema/morning-brief-native-schedule";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { workflowScheduleSkips } from "@okouai/db/schema/workflow-schedule-skip";
import { and, eq, sql } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { calculateNextRun } from "./time-automation";
import {
  morningBriefNativeOwnerCompatibilitySql,
  morningBriefScheduleWhere,
  morningBriefLegacyWriterAuthorityFromRow,
  type MorningBriefLegacyWriterAuthority,
} from "./morning-brief-native-schedule.service";
import { settleLegacyMorningBriefSql } from "./morning-brief-legacy-settlement-sql";
import { SCHEDULE_GRACE_MS, scheduleExpired } from "./schedule-expiry-policy";

type Automation = typeof workflowAutomations.$inferSelect;
type Authority = Exclude<MorningBriefLegacyWriterAuthority, { kind: "stale" }>;

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
function workflowScheduleAlreadyClaimedSql(
  current: Automation,
  anchor: Date,
  authority: Authority,
) {
  const nativePending =
    authority.kind === "selected"
      ? sql`OR EXISTS (
    SELECT 1 FROM morning_brief_schedule_claims
    WHERE automation_id = ${current.id}::uuid AND settlement = 'unsettled'
  ) OR EXISTS (
    SELECT 1 FROM morning_brief_native_occurrences
    WHERE org_id = ${current.orgId} AND user_id = ${current.ownerUserId}
      AND owner_epoch = ${authority.row.ownerEpoch} AND settled_at IS NULL
  )`
      : sql.empty();
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
  ) ${nativePending})`;
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

function successorAfterExpiry(
  current: Automation,
  authority: Authority,
  args: { readonly anchor: Date; readonly at: Date },
): { readonly nextRunAt: Date | null; readonly mirrorNative: boolean } | null {
  if (authority.kind === "selected" && authority.row.phase === "legacy") {
    const durable = authority.row.nextRunAt;
    if (
      !authority.row.enabled ||
      authority.row.scheduleOwner !== "legacy" ||
      durable === null
    ) {
      return null;
    }
    if (durable.getTime() !== args.anchor.getTime()) {
      // A claimed or differently overdue durable slot needs reconciliation.
      if (durable.getTime() <= args.at.getTime()) {
        return null;
      }
      // The due legacy row is a stale mirror. Preserve the durable future slot
      // instead of overwriting it with a successor computed from stale config.
      return { nextRunAt: durable, mirrorNative: false };
    }
  }
  const nextRunAt = futureAfterSkip(current, args.at);
  if (
    current.scheduleType !== "once" &&
    (nextRunAt === null || nextRunAt.getTime() <= args.at.getTime())
  ) {
    return null;
  }
  return { nextRunAt, mirrorNative: true };
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

function scheduleExpiryLineage(
  initial: Pick<Automation, "orgId" | "ownerUserId" | "workflowId" | "id">,
) {
  return {
    orgId: initial.orgId,
    userId: initial.ownerUserId,
    workflowId: initial.workflowId,
    automationId: initial.id,
  };
}

/**
 * Settle only the old, unclaimed occurrence. No Run, failure or queue event is
 * created; the next recurring obligation is strictly in the future. Lock the
 * native owner before the legacy row, as all Morning Brief writers do.
 */
export const skipExpiredWorkflowSchedule$ = command(
  async (
    { set },
    args: ExpiredScheduleInput,
    signal: AbortSignal,
  ): Promise<"skipped" | "moved" | "held"> => {
    const db = set(writeDb$);
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
      const lineage = scheduleExpiryLineage(initial);
      let authority: MorningBriefLegacyWriterAuthority = {
        kind: "ordinary",
        fence: { kind: "ordinary" },
      };
      if (
        initial.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
      ) {
        let [native] = await tx
          .select()
          .from(morningBriefNativeSchedules)
          .where(morningBriefScheduleWhere(lineage))
          .limit(1)
          .for("update");
        if (!native) {
          await tx.execute(morningBriefNativeOwnerCompatibilitySql(lineage));
          [native] = await tx
            .select()
            .from(morningBriefNativeSchedules)
            .where(morningBriefScheduleWhere(lineage))
            .limit(1)
            .for("update");
        }
        authority = morningBriefLegacyWriterAuthorityFromRow(native, lineage);
      }
      if (authority.kind === "stale") {
        return "held";
      }
      const [current] = await tx
        .select()
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, args.automationId))
        .for("update")
        .limit(1);
      if (!stillExpired(current, initial, args)) {
        return "moved";
      }
      const [pending] = await tx
        .select({
          held: workflowScheduleAlreadyClaimedSql(
            current,
            args.anchor,
            authority,
          ).mapWith(workflowAutomations.enabled),
        })
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, current.id))
        .limit(1);
      if (pending?.held) {
        return "held";
      }
      const successor = successorAfterExpiry(current, authority, args);
      if (!successor) {
        return "held";
      }
      const nextLegacyRunAt =
        authority.kind === "selected" && authority.row.phase !== "legacy"
          ? null
          : successor.nextRunAt;
      if (
        successor.mirrorNative &&
        authority.kind === "selected" &&
        authority.row.phase === "legacy"
      ) {
        const { rowCount } = await tx.execute(
          settleLegacyMorningBriefSql(lineage, authority.row, {
            enabled: current.scheduleType !== "once",
            cronExpression: current.cronExpression,
            timezone: current.timezone,
            nextRunAt: successor.nextRunAt,
            at: args.at,
          }),
        );
        if (rowCount !== 1) {
          throw new Error("Morning Brief settlement authority changed");
        }
      }
      const [updated] = await tx
        .update(workflowAutomations)
        .set(expiredScheduleValues(current, nextLegacyRunAt, args.at))
        .where(
          and(
            eq(workflowAutomations.id, current.id),
            eq(workflowAutomations.nextRunAt, args.anchor),
          ),
        )
        .returning({ id: workflowAutomations.id });
      if (!updated) {
        throw new Error("Expired schedule anchor moved while locked");
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
      return "skipped";
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
