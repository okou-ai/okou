import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { command } from "ccstate";
import { asc, eq, gt, isNull, lte, notExists, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";

/** Fixed chat thread lease; neither publication nor the picker renews it. */
export const CHAT_THREAD_LEASE_MS = 10_000;

/** Committed normal-publication receipt; it grants no input consumption authority. */
export interface PublishedChatThreadLease {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly claimId: string;
  readonly claimExpiresAt: Date;
  readonly queuedAt: Date;
}

/**
 * Pure enqueue plan for the input-owning command's atomic write. It executes
 * nothing and never receives or captures a database handle. queuedAt advances
 * even under a frozen/skewed clock; no live lease is touched.
 */
export function queuedChatThreadEnqueuePlan(args: {
  readonly chatThreadId: string;
  readonly orgId: string;
}) {
  const queuedAt = nowDate();
  return {
    values: { chatThreadId: args.chatThreadId, orgId: args.orgId, queuedAt },
    conflict: {
      target: queuedChatThreads.chatThreadId,
      set: {
        queuedAt: sql`greatest(${sql.param(queuedAt, queuedChatThreads.queuedAt)}, ${queuedChatThreads.queuedAt} + interval '1 millisecond')`,
      },
    },
  };
}

/** Normal publication arbitrates acquisition in its existing single queue write. */
export function queuedChatThreadPublicationPlan(args: {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly claimId: string;
}) {
  const queue = queuedChatThreadEnqueuePlan(args);
  const at = queue.values.queuedAt;
  const expiresAt = new Date(at.getTime() + CHAT_THREAD_LEASE_MS);
  // This is statement-snapshot eligibility. The picker reobserves active Runs
  // in its existing preparation query after publication has committed.
  const idle = notExists(
    new QueryBuilder()
      .select({ runId: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(eq(activeAgentRuns.chatThreadId, args.chatThreadId)),
  );
  const available = sql`${eq(queuedChatThreads.orgId, args.orgId)}
    AND (${isNull(queuedChatThreads.claimExpiresAt)} OR ${lte(queuedChatThreads.claimExpiresAt, at)})
    AND EXCLUDED.claim_id IS NOT NULL`;
  const token = sql`${sql.param(args.claimId, queuedChatThreads.claimId)}::uuid`;
  const expiry = sql`${sql.param(expiresAt, queuedChatThreads.claimExpiresAt)}::timestamp`;
  return {
    values: {
      ...queue.values,
      claimId: sql`CASE WHEN ${idle} THEN ${token} ELSE NULL END`,
      claimExpiresAt: sql`CASE WHEN ${idle} THEN ${expiry} ELSE NULL END`,
    },
    conflict: {
      target: queue.conflict.target,
      set: {
        ...queue.conflict.set,
        claimId: sql`CASE WHEN ${available} THEN EXCLUDED.claim_id ELSE ${queuedChatThreads.claimId} END`,
        claimExpiresAt: sql`CASE WHEN ${available} THEN EXCLUDED.claim_expires_at ELSE ${queuedChatThreads.claimExpiresAt} END`,
      },
    },
  };
}

/** Organizations with queued threads, by org-id keyset, for the cron pass. */
export const listQueuedChatThreadOrgIds$ = command(
  async (
    { get },
    args: { readonly after?: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const rows = await get(db$)
      .selectDistinct({ orgId: queuedChatThreads.orgId })
      .from(queuedChatThreads)
      .where(
        args.after === undefined
          ? undefined
          : gt(queuedChatThreads.orgId, args.after),
      )
      .orderBy(asc(queuedChatThreads.orgId))
      .limit(args.limit);
    signal.throwIfAborted();
    return rows.map(({ orgId }) => {
      return orgId;
    });
  },
);
