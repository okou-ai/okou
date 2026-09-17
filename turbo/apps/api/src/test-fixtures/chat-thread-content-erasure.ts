import { chatThreadEvents } from "@okouai/db/schema/chat-thread-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq, sql, type SQL } from "drizzle-orm";

import type { Tx } from "../lib/db-types";
import { db } from "../lib/db";
import { isLockNotAvailable } from "../lib/pg-errors";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarriersFixture,
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

function tookIdentityLock(transaction: SelectedTransaction): boolean {
  return transaction.statements.some((statement) => {
    return statement.includes("for key share");
  });
}

/** The route's own business-row lock, taken after the retained identity locks.
 * `FOR NO KEY UPDATE` is the mode the settings writer takes on the thread row;
 * pausing before it leaves the transaction holding both retained `FOR KEY
 * SHARE` locks with no lock or statement timer running. */
function isContentRowLock(queryArgs: unknown[]): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('from "chat_threads"') &&
    text.includes("for no key update")
  );
}

/** The route's own thread mutation, the last statement before its sidebar
 * events. Pausing here keeps every earlier write, including a savepointed
 * model-policy repair, inside the still-open transaction. */
function isContentRowUpdate(queryArgs: unknown[]): boolean {
  return barrierQueryText(queryArgs).startsWith('update "chat_threads"');
}

/**
 * Where the paused transaction stops. `identity` precedes subject admission and
 * `admission` sits between the resolved identity and B1's first statement, both
 * of which the read-only initiation gate and the writer reach. `title-context`
 * is the generated-title gate's own prior-round read. `agent-lock` and
 * `thread-lock` sit between the unlocked identity read and the matching
 * identity lock, and `commit` retains every barrier with the title or draft
 * already written. A thread without an Agent issues no `agent-lock`.
 *
 * `content-lock` and `content-update` are the route's own row lock and row
 * write under the retained identity locks.
 *
 * `commit` additionally requires that the transaction already took an identity
 * lock. The read-only gate commits first and never locks, so without that the
 * barrier would pause the gate's commit instead of the writer's.
 */
type ChatThreadContentBarrierStop =
  | "identity"
  | "admission"
  | "title-context"
  | "agent-lock"
  | "thread-lock"
  | "content-lock"
  | "content-update"
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
  if (stop === "content-lock") {
    return isContentRowLock(queryArgs);
  }
  if (stop === "content-update") {
    return isContentRowUpdate(queryArgs);
  }
  return (
    barrierQueryText(queryArgs) === "commit" && tookIdentityLock(transaction)
  );
}

/** Pauses the draft or rename transaction opened for one thread. See
 * {@link withChatThreadContentBarriersFixture} for the mechanism and the
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
  return await withChatThreadContentBarriersFixture(
    {
      chatThreadId: args.chatThreadId,
      stopAt: [args.stopAt],
      work: async ([barrier]) => {
        if (!barrier) {
          throw new Error("Expected one chat-thread content barrier");
        }
        return await args.work(barrier);
      },
    },
    signal,
  );
}

/**
 * Pauses several fenced content transactions on the **same** thread, one per
 * entry in `stopAt` and in the order they open. Every content route opens its
 * transaction with the same identity read, so the thread id alone cannot tell
 * two writers apart; the shared barrier binds each stop to the connection that
 * issued that read. Start one request, await its barrier, then start the next,
 * and each index is that exact HTTP request's transaction.
 */
export async function withChatThreadContentBarriersFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly stopAt: readonly ChatThreadContentBarrierStop[];
    readonly work: (barriers: readonly TransactionBarrier[]) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarriersFixture(
    {
      transactions: args.stopAt.length,
      select: (queryArgs) => {
        return isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs, selectingStatement, transaction, index) => {
        const stop = args.stopAt[index];
        return (
          stop !== undefined &&
          reachedBarrierStop(
            stop,
            queryArgs,
            selectingStatement,
            args.chatThreadId,
            transaction,
          )
        );
      },
      work: args.work,
    },
    signal,
  );
}

/**
 * Probes the two candidate modes for the settings writer's own row lock from a
 * separate transaction that already holds the same retained `FOR KEY SHARE` the
 * admission helper takes, using `NOWAIT` so a conflict is reported immediately
 * instead of waiting out a production budget.
 *
 * Infrastructure exception: no API exposes row-lock modes, and a retained
 * `FOR KEY SHARE` held by another live writer is exactly the state the shipped
 * `FOR NO KEY UPDATE` was chosen for. The probe only takes locks, writes
 * nothing and always rolls back.
 */
export async function probeChatThreadRowLockModesFixture(args: {
  readonly chatThreadId: string;
}): Promise<{
  readonly forUpdate: "granted" | "conflicted";
  readonly forNoKeyUpdate: "granted" | "conflicted";
}> {
  const probe = async (
    tx: Tx,
    lock: SQL,
  ): Promise<"granted" | "conflicted"> => {
    const attempt = await settleIncludingAbort(
      tx.transaction(async (nested) => {
        await nested.execute(lock);
      }),
    );
    if (attempt.ok) {
      return "granted";
    }
    if (isLockNotAvailable(attempt.error)) {
      return "conflicted";
    }
    throw attempt.error;
  };
  const result = await settleIncludingAbort(
    db().transaction(async (tx) => {
      await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(eq(chatThreads.id, args.chatThreadId))
        .for("key share");
      const forUpdate = await probe(
        tx,
        sql`SELECT id FROM chat_threads WHERE id = ${args.chatThreadId} FOR UPDATE NOWAIT`,
      );
      const forNoKeyUpdate = await probe(
        tx,
        sql`SELECT id FROM chat_threads WHERE id = ${args.chatThreadId} FOR NO KEY UPDATE NOWAIT`,
      );
      throw new ChatThreadRowLockProbeRollback(forUpdate, forNoKeyUpdate);
    }),
  );
  if (result.ok || !(result.error instanceof ChatThreadRowLockProbeRollback)) {
    throw result.ok
      ? new Error("Expected the row-lock probe to roll back")
      : result.error;
  }
  return {
    forUpdate: result.error.forUpdate,
    forNoKeyUpdate: result.error.forNoKeyUpdate,
  };
}

class ChatThreadRowLockProbeRollback extends Error {
  constructor(
    readonly forUpdate: "granted" | "conflicted",
    readonly forNoKeyUpdate: "granted" | "conflicted",
  ) {
    super("Chat thread row lock probe rolled back");
  }
}
