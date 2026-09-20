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
 * Infrastructure exception: no production writer moves a thread between users,
 * but `user_id` is not a key column. This mutation proves the shared helper's
 * KEY SHARE permits the move and the creation-local SHARE re-read detects it
 * before a downstream run can be pinned.
 */
export async function setChatThreadUserFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({ userId: args.userId })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread user to move");
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
 * Stored metadata for one test-owned thread, without B1 admission or row locks.
 *
 * Read-only fixture exception: the production metadata GET now correctly denies
 * a closed canonical subject and takes the thread's first UPDATE lock, so it
 * cannot observe rollback state while a tested writer deliberately retains that
 * row. Those states are impossible to inspect through production HTTP. Erasure
 * suites use this fixture only at those closed or held-writer boundaries, keep
 * real route assertions everywhere the route is reachable, and continue to use
 * production APIs for setup, mutation, event, sequence and publication checks.
 */
export async function readStoredChatThreadMetadataFixture(
  chatThreadId: string,
): Promise<{
  readonly id: string;
  readonly userId: string;
  readonly agentId: string | null;
  readonly title: string | null;
  readonly selectedModel: string | null;
  readonly modelSettings: unknown;
  readonly codexServiceTier: string | null;
  readonly pinnedAt: string | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
  readonly renamedAt: string | null;
  readonly updatedAt: string;
}> {
  const [thread] = await db()
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      modelSettings: chatThreads.modelSettings,
      codexServiceTier: chatThreads.codexServiceTier,
      pinnedAt: chatThreads.pinnedAt,
      computerUseHostId: chatThreads.computerUseHostId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
      selectedVideoModel: chatThreads.selectedVideoModel,
      selectedImageModel: chatThreads.selectedImageModel,
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
    ...thread,
    pinnedAt: thread.pinnedAt?.toISOString() ?? null,
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
    (text.includes("for key share") || text.includes("for update"))
  );
}

/** The complete single-thread metadata projection, after retained identity. */
function isMetadataProjectionRead(
  queryArgs: unknown[],
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("select") &&
    text.includes('"model_settings"') &&
    text.includes('"computer_use_host_id"') &&
    text.includes('"selected_video_model"') &&
    text.includes('"selected_image_model"') &&
    !text.includes(" join ") &&
    barrierQueryBinds(queryArgs, chatThreadId)
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

/**
 * The pin `UPDATE` the image or video model route issues after the retained
 * identity locks and before it reserves a sidebar sequence and appends its
 * event. Each route sets exactly one of the two columns first, so the column
 * name identifies which endpoint is paused even though both write the same
 * table for the same thread.
 */
function isGenerationModelPinUpdate(
  queryArgs: unknown[],
  column: "selected_image_model" | "selected_video_model",
  chatThreadId: string,
): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith("update") &&
    text.includes(`"chat_threads" set "${column}"`) &&
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
 * `metadata-read`, `cursor-update`, `image-model-update` and
 * `video-model-update` are the stops that pause **after** their statement. For
 * metadata this retains the projected result before the helper's final abort
 * check. For writers, the mutation has run and is still uncommitted, which is
 * the boundary between the real mutation and the writer's own post-write
 * cancellation check, and therefore the last point at which a rollback is
 * still guaranteed. Pausing at `commit` is already past that check, so a
 * cancellation arriving there races a `COMMIT` that still succeeds.
 */
type ChatThreadContentBarrierStop =
  | "identity"
  | "admission"
  | "title-context"
  | "agent-lock"
  | "thread-lock"
  | "metadata-read"
  | "cursor-update"
  | "image-model-update"
  | "video-model-update"
  | "commit";

function pausesAfterStatement(stop: ChatThreadContentBarrierStop): boolean {
  return (
    stop === "metadata-read" ||
    stop === "cursor-update" ||
    stop === "image-model-update" ||
    stop === "video-model-update"
  );
}

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
  if (stop === "metadata-read") {
    return isMetadataProjectionRead(queryArgs, chatThreadId);
  }
  if (stop === "cursor-update") {
    return isReadCursorUpdate(queryArgs, chatThreadId);
  }
  if (stop === "image-model-update") {
    return isGenerationModelPinUpdate(
      queryArgs,
      "selected_image_model",
      chatThreadId,
    );
  }
  if (stop === "video-model-update") {
    return isGenerationModelPinUpdate(
      queryArgs,
      "selected_video_model",
      chatThreadId,
    );
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
      pauseAfter: pausesAfterStatement(args.stopAt),
      work: args.work,
    },
    signal,
  );
}

interface ChatThreadMetadataSqlControlBarrier extends TransactionBarrier {
  /** Complete SQL control statements grouped by whole transaction attempt. */
  readonly attempts: () => readonly (readonly string[])[];
}

/**
 * Captures one metadata request's real node-postgres transaction controls.
 * Setup is complete before this fixture is entered and its callback starts only
 * that request, so BEGIN is an unambiguous candidate. A retrying identity may
 * ROLLBACK and begin again; every whole attempt is retained and the final
 * COMMIT is paused only long enough for the test to inspect exact SQL counts.
 */
export async function withChatThreadMetadataSqlControlFixture<T>(
  work: (barrier: ChatThreadMetadataSqlControlBarrier) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const attempts: string[][] = [];
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return barrierQueryText(queryArgs).startsWith("begin");
      },
      stopAt: (queryArgs, _selectingStatement, transaction) => {
        const text = barrierQueryText(queryArgs);
        if (text === "rollback") {
          attempts.push([...transaction.statements, text]);
          return false;
        }
        if (text === "commit") {
          attempts.push([...transaction.statements, text]);
          return true;
        }
        return false;
      },
      work: async (barrier) => {
        return await work({
          ...barrier,
          attempts: () => {
            return attempts;
          },
        });
      },
    },
    signal,
  );
}

/**
 * Pauses the first metadata attempt before its Agent lock while observing each
 * real transaction on its own driver client. A test can move canonical identity
 * there, then account for the failed attempt's ROLLBACK and the bounded retry's
 * final COMMIT without counting the infrastructure mutation transaction.
 */
export async function withChatThreadMetadataRetrySqlControlFixture<T>(
  args: {
    readonly chatThreadId: string;
    readonly work: (barrier: ChatThreadMetadataSqlControlBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  const active = new Map<unknown, string[]>();
  const targetClients = new Set<unknown>();
  const attempts: string[][] = [];
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isContentIdentityRead(queryArgs, args.chatThreadId);
      },
      stopAt: (queryArgs) => {
        return isContentLock(queryArgs, "agents");
      },
      observe: (queryArgs, receiver) => {
        const text = barrierQueryText(queryArgs);
        if (text.startsWith("begin")) {
          active.set(receiver, []);
        }
        const transaction = active.get(receiver);
        if (!transaction) {
          return;
        }
        transaction.push(text);
        if (isContentIdentityRead(queryArgs, args.chatThreadId)) {
          targetClients.add(receiver);
        }
        if (text === "commit" || text === "rollback") {
          if (targetClients.has(receiver)) {
            attempts.push([...transaction]);
          }
          active.delete(receiver);
          targetClients.delete(receiver);
        }
      },
      work: async (barrier) => {
        return await args.work({
          ...barrier,
          attempts: () => {
            return attempts;
          },
        });
      },
    },
    signal,
  );
}
