import {
  morningBriefEnrollments,
  morningBriefRollout,
} from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";

export interface MorningBriefMemberIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export function morningBriefEnrollmentWhere(
  identity: MorningBriefMemberIdentity,
) {
  return and(
    eq(morningBriefEnrollments.orgId, identity.orgId),
    eq(morningBriefEnrollments.userId, identity.userId),
  );
}

export async function loadMorningBriefEnrollment(
  db: Pick<ReadonlyDb, "select">,
  identity: MorningBriefMemberIdentity,
) {
  const [row] = await db
    .select()
    .from(morningBriefEnrollments)
    .where(morningBriefEnrollmentWhere(identity))
    .limit(1);
  return row;
}

export async function recordMorningBriefMembership(
  db: Db,
  args: MorningBriefMemberIdentity & {
    readonly membershipId: string;
    readonly createdAt: Date;
    /** A live qualification must retain the automatic attempt's retry lease. */
    readonly preserveRetrySchedule?: boolean;
  },
): Promise<void> {
  const [rollout] = await db
    .select()
    .from(morningBriefRollout)
    .where(eq(morningBriefRollout.name, "morning-brief"))
    .limit(1);
  if (!rollout) {
    throw new Error("Morning Brief rollout boundary is missing");
  }
  const eligible = args.createdAt >= rollout.activatedAt;
  const currentTime = nowDate();
  await db
    .insert(morningBriefEnrollments)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      membershipId: args.membershipId,
      sourceCreatedAt: args.createdAt,
      state: eligible ? "pending" : "ineligible",
      availableAt: currentTime,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [morningBriefEnrollments.orgId, morningBriefEnrollments.userId],
      set: {
        membershipId: args.membershipId,
        sourceCreatedAt: args.createdAt,
        state: eligible ? "pending" : "ineligible",
        ...(args.preserveRetrySchedule
          ? {}
          : { availableAt: currentTime, attemptCount: 0, lastError: null }),
        updatedAt: currentTime,
      },
      setWhere: or(
        eq(morningBriefEnrollments.state, "checking"),
        and(
          eq(morningBriefEnrollments.state, "departed"),
          or(
            isNull(morningBriefEnrollments.membershipId),
            ne(morningBriefEnrollments.membershipId, args.membershipId),
          ),
        ),
      ),
    });
}

export async function recordMorningBriefChoice(
  db: Db | Tx,
  identity: MorningBriefMemberIdentity,
  enabled: boolean,
): Promise<void> {
  const currentTime = nowDate();
  const state = enabled ? "pending" : "cancelled";
  await db
    .insert(morningBriefEnrollments)
    .values({
      ...identity,
      state,
      availableAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [morningBriefEnrollments.orgId, morningBriefEnrollments.userId],
      set: {
        state,
        availableAt: currentTime,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

/** Completion is what binds the enrollment to the installation it owns. */
export async function completeMorningBriefEnrollment(
  db: Db,
  identity: MorningBriefMemberIdentity,
  workflowId: string,
): Promise<void> {
  await db
    .update(morningBriefEnrollments)
    .set({
      state: "completed",
      workflowId,
      lastError: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        morningBriefEnrollmentWhere(identity),
        inArray(morningBriefEnrollments.state, ["checking", "pending"]),
      ),
    );
}
