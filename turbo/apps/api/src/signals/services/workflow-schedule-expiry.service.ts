import { MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { morningBriefNativeOccurrences } from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { workflowScheduleSkips } from "@okouai/db/schema/workflow-schedule-skip";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import { calculateNextRun } from "./time-automation";
import {
  lockMorningBriefLegacyWriterAuthority,
  settleSelectedLegacyMorningBriefObligation,
} from "./morning-brief-native-schedule.service";
import { pendingTickForAutomation } from "./workflow-chat-event-queue.service";
import { SCHEDULE_GRACE_MS, scheduleExpired } from "./schedule-expiry-policy";

type Automation = typeof workflowAutomations.$inferSelect;
type Authority = Exclude<
  Awaited<ReturnType<typeof lockMorningBriefLegacyWriterAuthority>>,
  { kind: "stale" }
>;

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

async function isAlreadyClaimed(
  tx: Tx,
  current: Automation,
  anchor: Date,
  authority: Authority,
): Promise<boolean> {
  const [claim] = await tx
    .select({ id: morningBriefScheduleClaims.id })
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(morningBriefScheduleClaims.automationId, current.id),
        eq(morningBriefScheduleClaims.scheduledAnchorAt, anchor),
      ),
    )
    .limit(1);
  if (claim || (await pendingTickForAutomation(tx, current.id))) {
    return true;
  }
  if (authority.kind !== "selected") {
    return false;
  }
  const [unsettledLegacy] = await tx
    .select({ id: morningBriefScheduleClaims.id })
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(morningBriefScheduleClaims.automationId, current.id),
        eq(morningBriefScheduleClaims.settlement, "unsettled"),
      ),
    )
    .limit(1);
  const [unsettledNative] = await tx
    .select({ scheduledFor: morningBriefNativeOccurrences.scheduledFor })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, current.orgId),
        eq(morningBriefNativeOccurrences.userId, current.ownerUserId),
        eq(morningBriefNativeOccurrences.ownerEpoch, authority.row.ownerEpoch),
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    )
    .limit(1);
  return unsettledLegacy !== undefined || unsettledNative !== undefined;
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

/**
 * Settle only the old, unclaimed occurrence. No Run, failure or queue event is
 * created; the next recurring obligation is strictly in the future. Lock the
 * native owner before the legacy row, as all Morning Brief writers do.
 */
export async function skipExpiredWorkflowSchedule(
  db: Db,
  args: {
    readonly automationId: string;
    readonly anchor: Date;
    readonly at: Date;
  },
): Promise<"skipped" | "moved" | "held"> {
  return await db.transaction(async (tx) => {
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

    const lineage = {
      orgId: initial.orgId,
      userId: initial.ownerUserId,
      workflowId: initial.workflowId,
      automationId: initial.id,
    };
    const authority =
      initial.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
        ? await lockMorningBriefLegacyWriterAuthority(tx, lineage)
        : ({ kind: "ordinary", fence: { kind: "ordinary" } } as const);
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
    // Claimed, queued and running work is never settled by the expiry rule.
    if (await isAlreadyClaimed(tx, current, args.anchor, authority)) {
      return "held";
    }

    const nextRunAt = futureAfterSkip(current, args.at);
    if (
      current.scheduleType !== "once" &&
      (nextRunAt === null || nextRunAt.getTime() <= args.at.getTime())
    ) {
      return "held";
    }
    const nextLegacyRunAt =
      authority.kind === "selected" && authority.row.phase !== "legacy"
        ? null
        : nextRunAt;
    if (authority.kind === "selected" && authority.row.phase === "legacy") {
      await settleSelectedLegacyMorningBriefObligation(tx, lineage, authority, {
        enabled: current.scheduleType !== "once",
        cronExpression: current.cronExpression,
        timezone: current.timezone,
        nextRunAt,
        at: args.at,
      });
    }
    const [updated] = await tx
      .update(workflowAutomations)
      .set({
        nextRunAt: nextLegacyRunAt,
        ...(current.scheduleType === "once" ? { enabled: false } : {}),
        deferredAnchorAt: null,
        deferredUntil: null,
        deferredReason: null,
        updatedAt: args.at,
      })
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
    return "skipped";
  });
}

/** Bounded, anchor-scoped retry for an unclaimable but not-yet-expired slot. */
export async function deferWorkflowSchedule(
  db: Db,
  args: {
    readonly automationId: string;
    readonly anchor: Date;
    readonly at: Date;
    readonly reason: "not_fireable" | "unavailable" | "held";
  },
): Promise<void> {
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
}
