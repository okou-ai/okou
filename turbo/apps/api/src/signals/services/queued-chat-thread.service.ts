import { randomUUID } from "node:crypto";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";

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

/** Record that the thread has pending input; an existing row keeps its age. */
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
    .onConflictDoNothing({ target: queuedChatThreads.chatThreadId });
}

/** Resolve the owning organization of a thread for its queue row. */
export async function chatThreadOrgId(
  db: ReadDb,
  chatThreadId: string,
): Promise<string | null> {
  const [thread] = await db
    .select({ orgId: agents.orgId })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  return thread?.orgId ?? null;
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

/**
 * Oldest queued threads whose lease is free or expired, optionally within one
 * organization. Busy threads are filtered by the pick itself.
 */
export async function listPickableQueuedChatThreads(
  db: ReadDb,
  args: { readonly orgId?: string; readonly limit: number },
): Promise<readonly string[]> {
  const rows = await db
    .select({ chatThreadId: queuedChatThreads.chatThreadId })
    .from(queuedChatThreads)
    .where(
      and(
        args.orgId === undefined
          ? undefined
          : eq(queuedChatThreads.orgId, args.orgId),
        leaseFree(nowDate()),
      ),
    )
    .orderBy(asc(queuedChatThreads.queuedAt))
    .limit(args.limit);
  return rows.map(({ chatThreadId }) => {
    return chatThreadId;
  });
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
