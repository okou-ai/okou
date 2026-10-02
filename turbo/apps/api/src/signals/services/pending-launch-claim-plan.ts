import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import type { ThreadRunContext } from "./thread-claim-run.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { pendingLaunchUpdateSql } from "./pending-launch-sql";

export interface PendingLaunchClaim {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly claimId: string;
  readonly producer: ThreadRunContext["producerBinding"];
}

/** Release only the captured queue token; rowCount is the fence result. */
export function pendingLaunchClaimFenceSql(claim: PendingLaunchClaim) {
  return pendingLaunchUpdateSql(
    queuedChatThreads,
    { claimId: null, claimExpiresAt: null },
    and(
      eq(queuedChatThreads.orgId, claim.orgId),
      eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
      eq(queuedChatThreads.claimId, claim.claimId),
    ),
  );
}

export function requirePendingLaunchClaimFence(rowCount: number | null) {
  if (rowCount !== 1) {
    throw new Error("Chat thread claim was lost before the pending commit");
  }
}

/** Producer SQL only. Do not weaken the Morning Brief first binding predicate. */
export function pendingLaunchClaimProducerStatements(
  producer: PendingLaunchClaim["producer"],
  runId: string,
) {
  if (producer?.kind === "automation") {
    return [
      sql`UPDATE ${morningBriefScheduleClaims}
      SET run_id = ${runId}::uuid, queue_disposition = 'claimed',
        updated_at = ${sql.param(nowDate(), morningBriefScheduleClaims.updatedAt)}
      WHERE ${eq(morningBriefScheduleClaims.queueEventId, producer.queueEventId)}
        AND ${isNull(morningBriefScheduleClaims.runId)}`,
    ];
  }
  if (producer?.kind === "reassign-agent") {
    return [
      sql`UPDATE ${chatThreads} SET agent_id = ${producer.agentId}::uuid
        WHERE ${eq(chatThreads.id, producer.threadId)}
          AND ${eq(chatThreads.userId, producer.userId)}
          AND ${eq(chatThreads.agentId, producer.expectedAgentId)}`,
      chatThreadEventInsertSql({
        kind: "sort_touched",
        chatThreadId: producer.threadId,
        userId: producer.userId,
        orgId: producer.orgId,
        agentId: producer.agentId,
        reassignedAgentId: producer.agentId,
      }),
    ];
  }
  return [];
}
