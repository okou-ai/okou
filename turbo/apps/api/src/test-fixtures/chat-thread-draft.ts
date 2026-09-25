import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";

/** One thread's `chat_thread_drafts` row, or `null` when the table has never
 * been written for that thread.
 *
 * A cleared draft is a retained row whose two draft values are null, which is
 * a different state from an absent row and the whole reason the writer does not
 * delete on clear. Both states must therefore be distinguishable here.
 */
export interface StoredChatThreadDraftRow {
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The persisted child draft row for one test-owned thread.
 *
 * Read-only fixture exception: during this compatibility phase every draft
 * reader still serves `chat_threads`, so no API returns the child row and no
 * API can distinguish a cleared row from a missing one. The dual write's whole
 * contract is about that table, so it cannot be asserted through HTTP at all
 * until the read cutover ships. This writes nothing and deletes nothing.
 */
export async function readStoredChatThreadDraftRowFixture(
  chatThreadId: string,
): Promise<StoredChatThreadDraftRow | null> {
  const [draft] = await db()
    .select({
      draftUserMessage: chatThreadDrafts.draftUserMessage,
      draftAttachments: chatThreadDrafts.draftAttachments,
      createdAt: chatThreadDrafts.createdAt,
      updatedAt: chatThreadDrafts.updatedAt,
    })
    .from(chatThreadDrafts)
    .where(eq(chatThreadDrafts.chatThreadId, chatThreadId))
    .limit(1);
  if (!draft) {
    return null;
  }
  return {
    draftUserMessage: draft.draftUserMessage ?? null,
    draftAttachments: draft.draftAttachments ?? null,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

/** Simulate a pre-bridge API writer, which can leave legacy draft content but
 * no child row. Only test-owned threads may be passed. */
export async function setLegacyChatThreadDraftFixture(args: {
  readonly chatThreadId: string;
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ draftUserMessage: args.draftUserMessage, draftAttachments: null })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one test-owned chat thread to update");
  }
}

/**
 * Holds an existing child draft row without touching the parent, so a send's
 * weak draft clear blocks on it and can be cancelled after the event commit.
 *
 * Infrastructure exception: no API can pause while holding this row lock. The
 * holder writes nothing and always rolls back.
 */
export async function holdChatThreadDraftRowFixture(args: {
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly cancelBlockedQueries: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [row] = await tx
      .select({ chatThreadId: chatThreadDrafts.chatThreadId })
      .from(chatThreadDrafts)
      .where(eq(chatThreadDrafts.chatThreadId, args.chatThreadId))
      .for("update");
    if (!row) {
      throw new Error("Expected a child draft row to lock");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      z.object({ pid: z.number() }),
    );
    const pid = pidRows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the draft row lock holder pid");
    }
    started.resolve(pid);
    await released.promise;
  });
  const holderPid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const [row] = await executeRawRows(
        db(),
        sql`
          SELECT count(*)::int AS "waiterCount"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        z.object({ waiterCount: z.number() }),
      );
      return row?.waiterCount ?? 0;
    },
    cancelBlockedQueries: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT pg_cancel_backend(activity.pid) AS "cancelled"
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        z.object({ cancelled: z.boolean() }),
      );
      return rows.filter((row) => {
        return row.cancelled;
      }).length;
    },
  };
}
