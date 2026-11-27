import { chatEvents } from "@okouai/db/schema/chat-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { and, eq, isNull, ne, notExists, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { queuedThreadInputCondition } from "./chat-queued-event.service";
import { pendingLaunchUpdateSql } from "./pending-launch-sql";

export interface PendingLaunchClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
  readonly queuedAt: Date;
  readonly proactive?: {
    readonly id: string;
    readonly userId: string;
    readonly cardDeliveryEnabled: boolean;
    readonly suggestionsEnabled: boolean;
  };
  readonly automationQueueEventId: string | null;
}

/**
 * Delete the queue row atomically when this launch consumes the thread's last
 * queued input and no concurrent enqueue has advanced `queuedAt`.
 */
export function pendingLaunchEmptyQueueDeleteSql(
  claim: PendingLaunchClaim,
  claimedEventId: string,
  prerequisite?: SQL,
) {
  const remainingInput = new QueryBuilder()
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        queuedThreadInputCondition(claim.chatThreadId),
        ne(chatEvents.id, claimedEventId),
      ),
    );
  return sql`DELETE FROM ${queuedChatThreads}
    WHERE ${and(
      eq(queuedChatThreads.orgId, claim.orgId),
      eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
      eq(queuedChatThreads.claimId, claim.claimId),
      eq(queuedChatThreads.queuedAt, claim.queuedAt),
      notExists(remainingInput),
      prerequisite,
    )}
    RETURNING ${queuedChatThreads.chatThreadId}`;
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
