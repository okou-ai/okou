import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { command } from "ccstate";
import { and, asc, inArray, lte } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishMorningBriefChangedSafely } from "../external/realtime";
import { settle } from "../utils";
import {
  loadMorningBriefEnrollment,
  type MorningBriefMemberIdentity,
  morningBriefEnrollmentWhere,
} from "./morning-brief-enrollment-data.service";
import { ensureMorningBriefDefaultEnabled$ } from "./morning-brief-preference.service";

const log = logger("MorningBriefEnrollment");
/** Shared enrollment admission owns the lease and backoff for every entry point. */
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
      const result = await settle(
        set(
          ensureMorningBriefDefaultEnabled$,
          { orgId: row.orgId, member: { userId: row.userId, role: "member" } },
          signal,
        ),
        signal,
      );
      if (
        result.ok &&
        result.value.outcome === "skipped" &&
        result.value.reason === "retry-deferred"
      ) {
        continue;
      }
      attempted++;
      const currentEnrollment = await loadMorningBriefEnrollment(db, identity);
      signal.throwIfAborted();
      const lastError = !result.ok
        ? String(result.error)
        : result.value.outcome === "failed"
          ? result.value.message
          : null;
      if (
        currentEnrollment?.state !== row.state ||
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
