import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  morningBriefEnrollmentWhere,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";
import {
  morningBriefMaterializationRow,
  morningBriefMaterializationSql,
  morningBriefMaterializationValues,
} from "./morning-brief-materialization-plan";
import {
  MorningBriefSnapshotChanged,
  morningBriefNativeRowVersionCondition,
  morningBriefScheduleWhere,
  readMorningBriefNativeScheduleForWrite,
  withFreshMorningBriefSnapshot,
  type MorningBriefNativeScheduleSnapshot,
} from "./morning-brief-native-schedule.service";

function revokeOldMembershipOccurrence(at: Date) {
  return {
    state: "settled" as const,
    outcome: "revoked" as const,
    settledAt: at,
    leaseToken: null,
    leaseExpiresAt: null,
    deferredUntil: null,
    deliveryPending: false,
    updatedAt: at,
  };
}

/**
 * Complete enrollment and materialize its actual installed choice in one local commit.
 *
 * No row is locked. The native row (or, while absent, the unchanged owner key)
 * and the enrollment are read with their row versions; the native write is a
 * conditional UPDATE on its version and the enrollment write is the final
 * conditional UPDATE on the version this decision was made from. A concurrent
 * commit to either rolls the attempt back and it recomputes from fresh state.
 */
export const completeAndMaterializeMorningBriefEnrollment$ = command(
  async (
    { set },
    owner: MorningBriefMemberIdentity,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    await withFreshMorningBriefSnapshot(() => {
      return db.transaction(async (tx) => {
        await attemptMaterialization(tx, owner, workflowId);
        signal.throwIfAborted();
      });
    }, signal);
    signal.throwIfAborted();
  },
);

async function attemptMaterialization(
  tx: Tx,
  owner: MorningBriefMemberIdentity,
  workflowId: string,
): Promise<void> {
  const snapshot = await readMorningBriefNativeScheduleForWrite(tx, owner);
  const [read] = await tx
    .select({
      enrollment: morningBriefEnrollments,
      rowVersion: sql`${morningBriefEnrollments}.xmin::text`.mapWith(
        pgTextDecoder,
      ),
    })
    .from(morningBriefEnrollments)
    .where(morningBriefEnrollmentWhere(owner))
    .limit(1);
  if (read === undefined) {
    return;
  }
  const { enrollment } = read;
  const completes =
    enrollment.state === "checking" || enrollment.state === "pending";
  if (
    !completes &&
    (enrollment.state !== "completed" || enrollment.workflowId !== workflowId)
  ) {
    return;
  }
  const at = nowDate();
  const materializes = await materializeNativeSchedule(tx, {
    owner,
    membershipId: enrollment.membershipId,
    snapshot,
    at,
  });
  if (!completes && !materializes) {
    return;
  }
  // The enrollment this decision was made from must still be current. This is
  // the attempt's final write, after the native row, per the documented order.
  const [gated] = await tx
    .update(morningBriefEnrollments)
    .set(
      completes
        ? { state: "completed", workflowId, lastError: null, updatedAt: at }
        : { updatedAt: sql`${morningBriefEnrollments.updatedAt}` },
    )
    .where(
      and(
        morningBriefEnrollmentWhere(owner),
        sql`${morningBriefEnrollments}.xmin::text = ${read.rowVersion}`,
      ),
    )
    .returning({ userId: morningBriefEnrollments.userId });
  if (gated === undefined) {
    throw new MorningBriefSnapshotChanged();
  }
}

/** Write the native row for a new membership; returns whether it wrote. */
async function materializeNativeSchedule(
  tx: Tx,
  args: {
    readonly owner: MorningBriefMemberIdentity;
    readonly membershipId: string | null;
    readonly snapshot: MorningBriefNativeScheduleSnapshot | undefined;
    readonly at: Date;
  },
): Promise<boolean> {
  const { owner, snapshot, at } = args;
  const existing = snapshot?.row;
  if (
    args.membershipId === null ||
    existing?.membershipId === args.membershipId
  ) {
    return false;
  }
  const [observed] = parseRawRows(
    morningBriefMaterializationRow,
    await tx.execute(morningBriefMaterializationSql(owner)),
  );
  const values = morningBriefMaterializationValues({
    owner,
    membershipId: args.membershipId,
    observed,
    existing,
    at,
  });
  if (values === undefined) {
    return false;
  }
  if (snapshot === undefined || existing === undefined) {
    // Absent: the owner key taken by the read admits one first row.
    await tx
      .insert(morningBriefNativeSchedules)
      .values(values)
      .onConflictDoNothing();
    return true;
  }
  if (observed?.automationId === undefined || observed.automationId === null) {
    throw new Error("Materialized Morning Brief has no automation");
  }
  const [applied] = await tx
    .update(morningBriefNativeSchedules)
    .set(values)
    .where(
      and(
        morningBriefScheduleWhere(owner),
        eq(morningBriefNativeSchedules.ownerEpoch, existing.ownerEpoch),
        morningBriefNativeRowVersionCondition(snapshot.rowVersion),
      ),
    )
    .returning({ ownerEpoch: morningBriefNativeSchedules.ownerEpoch });
  if (applied === undefined) {
    throw new MorningBriefSnapshotChanged();
  }
  await tx
    .update(workflowAutomations)
    .set({ nextRunAt: values.nextRunAt })
    .where(eq(workflowAutomations.id, observed.automationId));
  await tx
    .update(morningBriefNativeOccurrences)
    .set(revokeOldMembershipOccurrence(at))
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
        eq(morningBriefNativeOccurrences.membershipId, existing.membershipId),
        isNull(morningBriefNativeOccurrences.settledAt),
      ),
    );
  return true;
}
