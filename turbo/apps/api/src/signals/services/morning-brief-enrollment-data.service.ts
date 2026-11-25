import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq, sql } from "drizzle-orm";
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

export const recordMorningBriefChoice$ = command(
  async (
    { set },
    identity: MorningBriefMemberIdentity,
    enabled: boolean,
    observedWorkflowId: string | null,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const currentTime = nowDate();
    const state = enabled ? "pending" : "cancelled";
    const [recorded] = await db
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
        // The atomic installer assigns a fresh workflow ID when it claims this row.
        // If it won the row lock, the user's choice belongs on that schedule.
        setWhere: sql`${morningBriefEnrollments.workflowId} IS NOT DISTINCT FROM ${observedWorkflowId}::uuid`,
      })
      .returning({ userId: morningBriefEnrollments.userId });
    signal.throwIfAborted();
    return recorded !== undefined;
  },
);
