import { randomUUID } from "node:crypto";

import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type SelectedTransaction,
  type TransactionBarrier,
} from "./account-erasure-subject";

/** Outside the user/org sequence every production writer allocates. */
const HELD_EVENT_SEQ_ID = 2_000_000_000;

/**
 * Infrastructure exception: `chat_threads.agent_id` is nullable and the draft
 * writer accepts an owned thread without an Agent, but every current thread
 * creation API requires one, so that legal shape cannot be produced through a
 * production endpoint. This only moves the nullable parent reference; it writes
 * no content and deletes nothing.
 */
export async function setChatThreadAgentFixture(args: {
  readonly chatThreadId: string;
  readonly agentId: string | null;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ agentId: args.agentId })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread Agent reference to move");
  }
}

/**
 * The persisted title state of one thread, including `updated_at`.
 *
 * Read-only fixture exception: the generated-title writer sets `title`,
 * `renamed_at` and `updated_at` in one statement, and `updated_at` is the only
 * one of the three that no chat-thread read contract returns — the metadata
 * response omits it and the snapshot projection that carries it is served from
 * a compacted row this workflow never produces. Asserting that a denied or
 * rolled back title leaves the timestamp alone therefore needs this read, and
 * a read-only fixture is a far narrower exception than publishing a timestamp
 * endpoint for a test. It writes nothing.
 */
export async function readChatThreadTitleStateFixture(
  chatThreadId: string,
): Promise<{
  readonly title: string | null;
  readonly renamedAt: string | null;
  readonly updatedAt: string;
}> {
  const [thread] = await db()
    .select({
      title: chatThreads.title,
      renamedAt: chatThreads.renamedAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    throw new Error("Expected the chat thread row to exist");
  }
  return {
    title: thread.title,
    renamedAt: thread.renamedAt?.toISOString() ?? null,
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/**
 * Holds one uncommitted `chat_thread_events` row carrying a key the next
 * sidebar append will supply: either the event id a route accepts from its
 * caller, or the `(user_id, org_id, seq_id)` slot the durable sequence is about
 * to hand out. `appendChatThreadEvent` inserts with `ON CONFLICT DO NOTHING`
 * targeting the primary key, so both conflicts make its speculative insertion
 * wait on this open transaction and the append fails on its own bounded budget
 * at its **last** statement — after the title, pin or selection UPDATE and
 * after the durable sequence reservation. That is the only place a real failure
 * can prove those two earlier writes roll back with it.
 *
 * The sequence form exists for a writer that generates its own event id, such
 * as the background generated-title workflow: there is no caller-supplied id to
 * collide with, and `chat_thread_events_user_org_seq_unique` is the only other
 * key that reaches the same wait.
 *
 * Infrastructure exception: a concurrent uncommitted insert of a specific event
 * id or sequence slot cannot be produced through any API. It writes no title or
 * draft and is always rolled back by `release`.
 */
export async function holdChatThreadEventIdFixture(args: {
  readonly eventId?: string;
  readonly seqId?: number;
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly release: () => void; readonly done: Promise<void> }> {
  const started = createDeferredPromise<void>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = (async () => {
    const result = await settleIncludingAbort(
      db().transaction(async (tx) => {
        await tx.insert(chatThreadEvents).values({
          id: args.eventId ?? randomUUID(),
          userId: args.userId,
          orgId: args.orgId,
          seqId: args.seqId ?? HELD_EVENT_SEQ_ID,
          chatThreadId: args.chatThreadId,
          kind: "renamed",
          title: "held rename event",
        });
        started.resolve();
        await released.promise;
        // Roll the holder back so the id never becomes a durable event.
        throw new HeldChatThreadEventRollback();
      }),
    );
    if (!result.ok && !(result.error instanceof HeldChatThreadEventRollback)) {
      throw result.error;
    }
  })();
  await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve();
      }
    },
    done,
  };
}

class HeldChatThreadEventRollback extends Error {}

/** The fenced transaction's first statement: the unlocked, content-free
 * identity resolution. It is the only thread-bound read that left-joins Agents,
 * which is what keeps a nullable parent resolvable.
 */
function isContentIdentityRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads" left join "agents"') &&
    text.includes('where "chat_threads"."id" =') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function isContentLock(queryArgs: unknown[], table: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes(`from "${table}"`) &&
    text.includes("for key share")
  );
}

/** The first statement shared B1 admission issues, before any advisory lock and
 * before its closure lookup. Pausing here leaves the identity already resolved
 * and admission not yet begun. */
function isErasureAdmissionStart(queryArgs: unknown[]): boolean {
  return barrierQueryText(queryArgs).includes("erasure_isolation_probe");
}

/** The generated-title gate's own bounded prior-round read. Only that workflow
 * reads this thread's events inside a fenced transaction, so it identifies the
 * capture rather than any other reader of the same thread. */
function isTitleContextRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_events"') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

/** The read-cursor `UPDATE` both mark-read and mark-unread issue as the last
 * statement of their write, after the retained identity locks. */
function isReadCursorUpdate(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("update") &&
    text.includes('"chat_threads" set "last_read_at"') &&
    barrierQueryBinds(queryArgs, chatThreadId)
  );
}

function tookIdentityLock(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return statement.includes("for key share");
  });
}

/**
 * Where the paused transaction stops. `identity` precedes subject admission and
 * `admission` sits between the resolved identity and B1's first statement, both
 * of which the read-only initiation gate and the writer reach. `title-context`
 * is the generated-title gate's own prior-round read. `agent-lock` and
 * `thread-lock` sit between the unlocked identity read and the matching
 * identity lock, and `commit` retains every barrier with the title, draft or
 * read cursor already written. A thread without an Agent issues no
 * `agent-lock`.
 *
 * `commit` additionally requires that the transaction already took an identity
 * lock. The read-only gate commits first and never locks, so without that the
 * barrier would pause the gate's commit instead of the writer's.
 *
 * `cursor-update` is the only stop that pauses **after** its statement: the
 * read-cursor `UPDATE` has run and is still uncommitted, which is the boundary
 * between the real mutation and the writer's own post-write cancellation check,
 * and therefore the last point at which a rollback is still guaranteed. Pausing
 * at `commit` is already past that check, so a cancellation arriving there
 * races a `COMMIT` that still succeeds.
 */
type ChatThreadContentBarrierStop =
  | "identity"
  | "admission"
  | "title-context"
  | "agent-lock"
  | "thread-lock"
  | "cursor-update"
  | "commit";

function reachedBarrierStop(
  stop: ChatThreadContentBarrierStop,
  queryArgs: unknown[],
  identityRead: boolean,
  chatThreadId: string,
  transaction: SelectedTransaction,
): boolean {
  if (stop === "identity") {
    return identityRead;
  }
  if (stop === "admission") {
    return isErasureAdmissionStart(queryArgs);
  }
  if (stop === "title-context") {
    return isTitleContextRead(queryArgs, chatThreadId);
  }
  if (stop === "agent-lock") {
    return isContentLock(queryArgs, "agents");
  }
  if (stop === "thread-lock") {
    return isContentLock(queryArgs, "chat_threads");
  }
  if (stop === "cursor-update") {
    return isReadCursorUpdate(queryArgs, chatThreadId);
  }
  return (
    barrierQueryText(queryArgs) === "commit" && tookIdentityLock(transaction)
  );
}

/** Pauses the draft or rename transaction opened for one thread. See
 * {@link withDatabaseTransactionBarrierFixture} for the mechanism and the
 * infrastructure exception it documents.
 */
export async function withChatThreadContentBarrierFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly stopAt: ChatThreadContentBarrierStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, selectingStatement, transaction) => {
        return reachedBarrierStop(
          args.stopAt,
          queryArgs,
          selectingStatement,
          args.chatThreadId,
          transaction,
        );
      },
      pauseAfter: args.stopAt === "cursor-update",
      work: args.work,
    },
    signal,
  );
}
