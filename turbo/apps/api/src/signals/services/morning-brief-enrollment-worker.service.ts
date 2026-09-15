import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { command } from "ccstate";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishMorningBriefChangedSafely } from "../external/realtime";
import { settle } from "../utils";
import {
  type MorningBriefMemberIdentity,
  morningBriefEnrollmentWhere,
} from "./morning-brief-enrollment-data.service";
import { ensureMorningBriefDefaultEnabled$ } from "./morning-brief-preference.service";

const log = logger("MorningBriefEnrollment");
const RETRY_DELAY_MS = 60_000;
const CLAIM_LEASE_MS = 5 * 60_000;

/** A claimed pending row becomes available again even if its request dies. */
const executeMorningBriefEnrollmentScope$ = command(
  async (
    { set },
    identity: MorningBriefMemberIdentity | undefined,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const rows = await db
      .select()
      .from(morningBriefEnrollments)
      .where(
        and(
          inArray(morningBriefEnrollments.state, ["checking", "pending"]),
          lte(morningBriefEnrollments.availableAt, currentTime),
          identity ? morningBriefEnrollmentWhere(identity) : undefined,
        ),
      )
      .orderBy(asc(morningBriefEnrollments.availableAt))
      .limit(20);
    signal.throwIfAborted();
    let attempted = 0;
    for (const row of rows) {
      signal.throwIfAborted();
      const identity = { orgId: row.orgId, userId: row.userId };
      const leaseExpiresAt = new Date(currentTime.getTime() + CLAIM_LEASE_MS);
      const [claimed] = await db
        .update(morningBriefEnrollments)
        .set({
          availableAt: leaseExpiresAt,
          attemptCount: row.attemptCount + 1,
          updatedAt: currentTime,
        })
        .where(
          and(
            morningBriefEnrollmentWhere(identity),
            inArray(morningBriefEnrollments.state, ["checking", "pending"]),
            eq(morningBriefEnrollments.attemptCount, row.attemptCount),
            lte(morningBriefEnrollments.availableAt, currentTime),
          ),
        )
        .returning({ userId: morningBriefEnrollments.userId });
      signal.throwIfAborted();
      if (!claimed) {
        continue;
      }
      attempted++;
      const result = await settle(
        set(
          ensureMorningBriefDefaultEnabled$,
          { orgId: row.orgId, member: { userId: row.userId, role: "member" } },
          signal,
        ),
        signal,
      );
      const lastError = !result.ok
        ? String(result.error)
        : result.value.outcome === "failed"
          ? result.value.message
          : null;
      const availableAt = new Date(
        nowDate().getTime() +
          Math.min(
            15 * RETRY_DELAY_MS,
            RETRY_DELAY_MS * 2 ** Math.min(row.attemptCount, 4),
          ),
      );
      await db
        .update(morningBriefEnrollments)
        .set({ lastError, availableAt, updatedAt: nowDate() })
        .where(
          and(
            morningBriefEnrollmentWhere(identity),
            eq(morningBriefEnrollments.availableAt, leaseExpiresAt),
            inArray(morningBriefEnrollments.state, ["checking", "pending"]),
          ),
        );
      signal.throwIfAborted();
      if (
        row.attemptCount === 0 ||
        lastError !== row.lastError ||
        (result.ok && result.value.outcome === "installed")
      ) {
        const details = {
          ...identity,
          outcome: result.ok ? result.value : "failed",
          lastError,
        };
        if (lastError) {
          log.warn("Morning Brief enrollment will retry", details);
        } else {
          log.info("Morning Brief enrollment changed", details);
        }
        await publishMorningBriefChangedSafely(identity);
        signal.throwIfAborted();
      }
    }
    return attempted;
  },
);

export const executeMorningBriefEnrollmentWork$ = command(
  async ({ set }, signal: AbortSignal) => {
    return await set(executeMorningBriefEnrollmentScope$, undefined, signal);
  },
);

/** The test harness drives the same worker with an explicitly owned member. */
export const executeMorningBriefEnrollmentForMember$ = command(
  async (
    { set },
    identity: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ) => {
    return await set(executeMorningBriefEnrollmentScope$, identity, signal);
  },
);
