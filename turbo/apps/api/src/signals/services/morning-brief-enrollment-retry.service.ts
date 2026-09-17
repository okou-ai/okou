import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { and, eq, inArray, lte } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  morningBriefEnrollmentWhere,
  type MorningBriefMemberIdentity,
} from "./morning-brief-enrollment-data.service";

type Enrollment = typeof morningBriefEnrollments.$inferSelect;

const RETRY_DELAY_MS = 60_000;
const CLAIM_LEASE_MS = 5 * RETRY_DELAY_MS;

export async function prepareMorningBriefEnrollment(
  db: Db,
  identity: MorningBriefMemberIdentity,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .insert(morningBriefEnrollments)
    .values({
      ...identity,
      state: "checking",
      availableAt: currentTime,
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoNothing();
}

/** Local deferrals remain durable without spending the external retry budget. */
export async function deferMorningBriefPrerequisite(
  db: Db,
  enrollment: Enrollment,
  lastError: string | null,
): Promise<void> {
  const currentTime = nowDate();
  await db
    .update(morningBriefEnrollments)
    .set({
      availableAt: new Date(currentTime.getTime() + RETRY_DELAY_MS),
      lastError,
      updatedAt: currentTime,
    })
    .where(
      and(
        morningBriefEnrollmentWhere(enrollment),
        eq(morningBriefEnrollments.state, enrollment.state),
        eq(morningBriefEnrollments.attemptCount, enrollment.attemptCount),
        eq(morningBriefEnrollments.availableAt, enrollment.availableAt),
        lte(morningBriefEnrollments.availableAt, currentTime),
      ),
    );
}

/** Inline callers and workers claim while holding the same member lock. */
export async function claimMorningBriefEnrollment(
  db: Db,
  enrollment: Enrollment,
): Promise<Enrollment | undefined> {
  const currentTime = nowDate();
  if (
    enrollment.attemptCount > 0 &&
    enrollment.availableAt.getTime() > currentTime.getTime()
  ) {
    return undefined;
  }
  const [claimed] = await db
    .update(morningBriefEnrollments)
    .set({
      availableAt: new Date(currentTime.getTime() + CLAIM_LEASE_MS),
      attemptCount: enrollment.attemptCount + 1,
      updatedAt: currentTime,
    })
    .where(
      and(
        morningBriefEnrollmentWhere(enrollment),
        eq(morningBriefEnrollments.state, enrollment.state),
        eq(morningBriefEnrollments.attemptCount, enrollment.attemptCount),
        eq(morningBriefEnrollments.availableAt, enrollment.availableAt),
      ),
    )
    .returning();
  return claimed;
}

/** A newer webhook or choice invalidates the claim instead of being overwritten. */
export async function finishMorningBriefEnrollmentAttempt(
  db: Db,
  claim: Enrollment,
  lastError: string | null,
  localDeferral: boolean,
): Promise<void> {
  const currentTime = nowDate();
  const delay = localDeferral
    ? RETRY_DELAY_MS
    : Math.min(
        15 * RETRY_DELAY_MS,
        RETRY_DELAY_MS * 2 ** Math.min(claim.attemptCount - 1, 4),
      );
  await db
    .update(morningBriefEnrollments)
    .set({
      lastError,
      attemptCount: localDeferral ? 0 : claim.attemptCount,
      availableAt: new Date(currentTime.getTime() + delay),
      updatedAt: currentTime,
    })
    .where(
      and(
        morningBriefEnrollmentWhere(claim),
        eq(morningBriefEnrollments.attemptCount, claim.attemptCount),
        eq(morningBriefEnrollments.availableAt, claim.availableAt),
        inArray(morningBriefEnrollments.state, [
          "checking",
          "pending",
          "departed",
        ]),
      ),
    );
}
