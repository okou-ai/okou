import {
  morningBriefEnrollments,
  morningBriefRollout,
} from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

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

export const loadMorningBriefEnrollment$ = command(
  async (
    { set },
    identity: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(morningBriefEnrollments)
      .where(morningBriefEnrollmentWhere(identity))
      .limit(1);
    signal.throwIfAborted();
    return row;
  },
);

export const recordMorningBriefMembership$ = command(
  async (
    { set },
    args: MorningBriefMemberIdentity & {
      readonly membershipId: string;
      readonly createdAt: Date;
      /** A live qualification must retain the automatic attempt's retry lease. */
      readonly preserveRetrySchedule?: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [rollout] = await db
      .select()
      .from(morningBriefRollout)
      .where(eq(morningBriefRollout.name, "morning-brief"))
      .limit(1);
    signal.throwIfAborted();
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
    signal.throwIfAborted();
  },
);

export const recordMorningBriefChoice$ = command(
  async (
    { set },
    identity: MorningBriefMemberIdentity,
    enabled: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
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
    signal.throwIfAborted();
  },
);
