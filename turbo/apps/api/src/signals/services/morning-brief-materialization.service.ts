import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  morningBriefNativeOccurrences,
  morningBriefNativeSchedules,
} from "@okouai/db/schema/morning-brief-native-schedule";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
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
  morningBriefNativeOwnerCompatibilitySql,
  morningBriefScheduleWhere,
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

/** Complete enrollment and materialize its actual installed choice in one local commit. */
export const completeAndMaterializeMorningBriefEnrollment$ = command(
  async (
    { set },
    owner: MorningBriefMemberIdentity,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      let [existing] = await tx
        .select()
        .from(morningBriefNativeSchedules)
        .where(morningBriefScheduleWhere(owner))
        .limit(1)
        .for("update");
      if (existing === undefined) {
        await tx.execute(morningBriefNativeOwnerCompatibilitySql(owner));
        [existing] = await tx
          .select()
          .from(morningBriefNativeSchedules)
          .where(morningBriefScheduleWhere(owner))
          .limit(1)
          .for("update");
      }
      const [enrollment] = await tx
        .select()
        .from(morningBriefEnrollments)
        .where(morningBriefEnrollmentWhere(owner))
        .limit(1)
        .for("update");
      if (enrollment === undefined) {
        return;
      }
      const at = nowDate();
      if (enrollment.state === "checking" || enrollment.state === "pending") {
        await tx
          .update(morningBriefEnrollments)
          .set({
            state: "completed",
            workflowId,
            lastError: null,
            updatedAt: at,
          })
          .where(morningBriefEnrollmentWhere(owner));
      } else if (
        enrollment.state !== "completed" ||
        enrollment.workflowId !== workflowId
      ) {
        return;
      }
      if (
        enrollment.membershipId === null ||
        existing?.membershipId === enrollment.membershipId
      ) {
        return;
      }
      const [observed] = parseRawRows(
        morningBriefMaterializationRow,
        await tx.execute(morningBriefMaterializationSql(owner)),
      );
      const values = morningBriefMaterializationValues({
        owner,
        membershipId: enrollment.membershipId,
        observed,
        existing,
        at,
      });
      if (values === undefined) {
        return;
      }
      if (existing === undefined) {
        await tx
          .insert(morningBriefNativeSchedules)
          .values(values)
          .onConflictDoNothing();
      } else {
        await tx
          .update(morningBriefNativeOccurrences)
          .set(revokeOldMembershipOccurrence(at))
          .where(
            and(
              eq(morningBriefNativeOccurrences.orgId, owner.orgId),
              eq(morningBriefNativeOccurrences.userId, owner.userId),
              eq(
                morningBriefNativeOccurrences.membershipId,
                existing.membershipId,
              ),
              isNull(morningBriefNativeOccurrences.settledAt),
            ),
          );
        if (
          observed?.automationId === undefined ||
          observed.automationId === null
        ) {
          throw new Error("Materialized Morning Brief has no automation");
        }
        await tx
          .update(workflowAutomations)
          .set({ nextRunAt: values.nextRunAt })
          .where(eq(workflowAutomations.id, observed.automationId));
        await tx
          .update(morningBriefNativeSchedules)
          .set(values)
          .where(
            and(
              morningBriefScheduleWhere(owner),
              eq(morningBriefNativeSchedules.ownerEpoch, existing.ownerEpoch),
              eq(
                morningBriefNativeSchedules.membershipId,
                existing.membershipId,
              ),
            ),
          );
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
