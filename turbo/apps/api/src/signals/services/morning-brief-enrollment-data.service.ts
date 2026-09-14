import {
  morningBriefEnrollments,
  morningBriefRollout,
} from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq, inArray } from "drizzle-orm";
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
  db: ReadonlyDb,
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
        availableAt: currentTime,
        updatedAt: currentTime,
      },
      setWhere: inArray(morningBriefEnrollments.state, [
        "checking",
        "departed",
      ]),
    });
}

export async function recordMorningBriefChoice(
  db: Db,
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

export async function completeMorningBriefEnrollment(
  db: Db,
  identity: MorningBriefMemberIdentity,
): Promise<void> {
  await db
    .update(morningBriefEnrollments)
    .set({ state: "completed", lastError: null, updatedAt: nowDate() })
    .where(
      and(
        morningBriefEnrollmentWhere(identity),
        inArray(morningBriefEnrollments.state, ["checking", "pending"]),
      ),
    );
}
