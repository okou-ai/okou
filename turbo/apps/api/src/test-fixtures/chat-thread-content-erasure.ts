import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
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
 * Holds one uncommitted `chat_thread_events` row carrying the id a rename will
 * supply. `appendChatThreadEvent` inserts with `ON CONFLICT DO NOTHING`, whose
 * speculative insertion must wait on this open transaction, so the rename fails
 * on its own bounded budget at its **last** statement — after the title UPDATE
 * and after the durable sequence reservation. That is the only place a real
 * failure can prove those two earlier writes roll back with it.
 *
 * Infrastructure exception: a concurrent uncommitted insert of a specific event
 * id cannot be produced through any API. It writes no title or draft and is
 * always rolled back by `release`.
 */
export async function holdChatThreadEventIdFixture(args: {
  readonly eventId: string;
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
          id: args.eventId,
          userId: args.userId,
          orgId: args.orgId,
          seqId: HELD_EVENT_SEQ_ID,
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

/**
 * Where the paused transaction stops. `identity` precedes subject admission,
 * `agent-lock` and `thread-lock` sit between the unlocked identity read and the
 * matching identity lock, and `commit` retains every barrier with the title or
 * draft already written. A thread without an Agent issues no `agent-lock`.
 */
type ChatThreadContentBarrierStop =
  | "identity"
  | "agent-lock"
  | "thread-lock"
  | "commit";

function reachedBarrierStop(
  stop: ChatThreadContentBarrierStop,
  queryArgs: unknown[],
  identityRead: boolean,
): boolean {
  if (stop === "identity") {
    return identityRead;
  }
  if (stop === "agent-lock") {
    return isContentLock(queryArgs, "agents");
  }
  if (stop === "thread-lock") {
    return isContentLock(queryArgs, "chat_threads");
  }
  return barrierQueryText(queryArgs) === "commit";
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
      stopAt: (queryArgs, selectingStatement) => {
        return reachedBarrierStop(args.stopAt, queryArgs, selectingStatement);
      },
      work: args.work,
    },
    signal,
  );
}
