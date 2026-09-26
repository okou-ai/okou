import { randomUUID } from "node:crypto";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";

/**
 * A pick lease is only a duplicate-work guard. It expires on its own, so a
 * picker that stops mid-launch leaves the thread pickable again after it.
 */
const QUEUED_CHAT_THREAD_CLAIM_TTL_MS = 60 * 1000;

type ReadDb = Pick<Db, "select">;

function leaseFree(at: Date) {
  return or(
    isNull(queuedChatThreads.claimExpiresAt),
    lte(queuedChatThreads.claimExpiresAt, at),
  );
}

/**
 * Record that the thread has pending input; an existing row keeps its age.
 * New input also clears any lease: a picker that read the queue as empty
 * before this input committed then deletes or releases zero rows, the row
 * survives, and the enqueuer's own pick can take the lease.
 */
export async function markChatThreadQueued(
  db: Db,
  args: { readonly chatThreadId: string; readonly orgId: string },
): Promise<void> {
  await db
    .insert(queuedChatThreads)
    .values({
      chatThreadId: args.chatThreadId,
      orgId: args.orgId,
      queuedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: queuedChatThreads.chatThreadId,
      set: { claimId: null, claimExpiresAt: null },
    });
}

export interface QueuedChatThreadClaim {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly claimId: string;
}

/** Compare-and-set the pick lease; null when the row is absent or leased. */
export async function claimQueuedChatThread(
  db: Db,
  chatThreadId: string,
): Promise<QueuedChatThreadClaim | null> {
  const claimId = randomUUID();
  const at = nowDate();
  const [claimed] = await db
    .update(queuedChatThreads)
    .set({
      claimId,
      claimExpiresAt: new Date(at.getTime() + QUEUED_CHAT_THREAD_CLAIM_TTL_MS),
    })
    .where(and(eq(queuedChatThreads.chatThreadId, chatThreadId), leaseFree(at)))
    .returning({ orgId: queuedChatThreads.orgId });
  return claimed ? { chatThreadId, orgId: claimed.orgId, claimId } : null;
}

/** Release a lease this picker still owns; the thread stays queued. */
export async function releaseQueuedChatThreadClaim(
  db: Db,
  claim: QueuedChatThreadClaim,
): Promise<void> {
  await db
    .update(queuedChatThreads)
    .set({ claimId: null, claimExpiresAt: null })
    .where(
      and(
        eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
        eq(queuedChatThreads.claimId, claim.claimId),
      ),
    );
}

/** Remove the row of a thread whose queue this picker found empty. */
export async function deleteQueuedChatThread(
  db: Db,
  claim: QueuedChatThreadClaim,
): Promise<void> {
  await db
    .delete(queuedChatThreads)
    .where(
      and(
        eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
        eq(queuedChatThreads.claimId, claim.claimId),
      ),
    );
}

/** Keyset position in the (queued_at, chat_thread_id) order. */
export interface QueuedChatThreadCursor {
  readonly queuedAt: Date;
  readonly chatThreadId: string;
}

/**
 * Oldest queued threads whose lease is free or expired, optionally within one
 * organization, strictly after a keyset cursor. Busy threads are filtered by
 * the pick itself.
 */
export async function listPickableQueuedChatThreads(
  db: ReadDb,
  args: {
    readonly orgId?: string;
    readonly after?: QueuedChatThreadCursor;
    readonly limit: number;
  },
): Promise<readonly QueuedChatThreadCursor[]> {
  return await db
    .select({
      queuedAt: queuedChatThreads.queuedAt,
      chatThreadId: queuedChatThreads.chatThreadId,
    })
    .from(queuedChatThreads)
    .where(
      and(
        args.orgId === undefined
          ? undefined
          : eq(queuedChatThreads.orgId, args.orgId),
        args.after === undefined
          ? undefined
          : or(
              gt(queuedChatThreads.queuedAt, args.after.queuedAt),
              and(
                eq(queuedChatThreads.queuedAt, args.after.queuedAt),
                gt(queuedChatThreads.chatThreadId, args.after.chatThreadId),
              ),
            ),
        leaseFree(nowDate()),
      ),
    )
    .orderBy(
      asc(queuedChatThreads.queuedAt),
      asc(queuedChatThreads.chatThreadId),
    )
    .limit(args.limit);
}

/** Whether the thread's active-run slot is taken. */
export async function chatThreadHasActiveRun(
  db: ReadDb,
  chatThreadId: string,
): Promise<boolean> {
  const [active] = await db
    .select({ runId: activeAgentRuns.runId })
    .from(activeAgentRuns)
    .where(eq(activeAgentRuns.chatThreadId, chatThreadId))
    .limit(1);
  return active !== undefined;
}
