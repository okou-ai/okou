import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { pendingLaunchUpdateSql } from "./pending-launch-sql";

export interface PendingLaunchClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
  readonly automationQueueEventId: string | null;
}

/** Release only the captured queue token; rowCount is the fence result. */
export function pendingLaunchClaimFenceSql(
  claim: PendingLaunchClaim,
  prerequisite?: SQL,
) {
  return pendingLaunchUpdateSql(
    queuedChatThreads,
    { claimId: null, claimExpiresAt: null },
    and(
      eq(queuedChatThreads.orgId, claim.orgId),
      eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
      eq(queuedChatThreads.claimId, claim.claimId),
      prerequisite,
    ),
    ["chatThreadId"],
  );
}

/** Bind the first committed Run to the Morning Brief claim for this event. */
export function pendingLaunchMorningBriefBindingSql(
  queueEventId: string,
  runId: string,
  prerequisite: SQL,
) {
  return sql`UPDATE ${morningBriefScheduleClaims}
      SET run_id = ${runId}::uuid, queue_disposition = 'claimed',
        updated_at = ${sql.param(nowDate(), morningBriefScheduleClaims.updatedAt)}
      WHERE ${eq(morningBriefScheduleClaims.queueEventId, queueEventId)}
        AND ${isNull(morningBriefScheduleClaims.runId)}
        AND ${prerequisite} RETURNING run_id`;
}
