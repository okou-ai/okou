import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq } from "drizzle-orm";
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
