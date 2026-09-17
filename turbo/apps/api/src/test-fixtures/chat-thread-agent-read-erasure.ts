import { randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { createDeferredPromise } from "../signals/utils";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
  type TransactionBarrier,
} from "./account-erasure-subject";

const agentLockPidRowSchema = z.object({ pid: z.number() });

/**
 * Infrastructure exception: a terminal run event is appended by a claimed
 * Runner's completion callback, and driving hundreds of real Runner round trips
 * would replace the concurrency this suite measures with fixture latency. The
 * threads themselves are always created through the production endpoint; this
 * appends exactly the immutable terminal row that makes each of them unread,
 * and it writes nothing else.
 */
export async function appendTerminalChatEventsFixture(args: {
  readonly threadIds: readonly string[];
}): Promise<void> {
  if (args.threadIds.length === 0) {
    return;
  }
  const threadIds = [...args.threadIds];
  const lastSeqIds = await db()
    .select({
      chatThreadId: chatEvents.chatThreadId,
      lastSeqId: max(chatEvents.seqId),
    })
    .from(chatEvents)
    .where(inArray(chatEvents.chatThreadId, threadIds))
    .groupBy(chatEvents.chatThreadId);
  const nextSeqId = new Map(
    lastSeqIds.map((row) => {
      return [row.chatThreadId, (row.lastSeqId ?? 0) + 1];
    }),
  );
  const inserted = await db()
    .insert(chatEvents)
    .values(
      threadIds.map((chatThreadId) => {
        return {
          chatThreadId,
          // Attribution only, and terminal uniqueness is keyed on it.
          runId: randomUUID(),
          eventType: "run.completed" as const,
          seqId: nextSeqId.get(chatThreadId) ?? 1,
        };
      }),
    )
    .returning({ id: chatEvents.id });
  if (inserted.length !== threadIds.length) {
    throw new Error("Expected one terminal event per seeded chat thread");
  }
}

/** Every persisted read cursor of one thread set, as a size-independent
 * snapshot a test can compare before and after a denied or failed write. */
export async function readChatThreadCursorsFixture(
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  if (threadIds.length === 0) {
    return new Map();
  }
  const rows = await db()
    .select({ id: chatThreads.id, lastReadAt: chatThreads.lastReadAt })
    .from(chatThreads)
    .where(inArray(chatThreads.id, [...threadIds]));
  return new Map(
    rows.map((row) => {
      return [row.id, row.lastReadAt?.toISOString() ?? null];
    }),
  );
}

/**
 * Holds one Agent row exclusively, the lock a transfer or deletion would take.
 * Product APIs never expose this boundary, and the fixture changes no column:
 * it exists so a test can prove that a real blocked identity lock stays a
 * database failure instead of being reported as closure or as success.
 */
export async function holdAgentRowLockFixture(args: {
  readonly agentId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly release: () => void; readonly done: Promise<void> }> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .for("update")
      .limit(1);
    if (!agent) {
      throw new Error("Expected the Agent row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      agentLockPidRowSchema,
    );
    if (!pidRows[0]) {
      throw new Error("Expected the Agent lock holder pid");
    }
    started.resolve(pidRows[0].pid);
    await released.promise;
  });
  await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
  };
}

/** The fenced transaction's first statement: the unlocked, content-free Agent
 * identity resolution. The later identity lock reads the same table by primary
 * key, so the selected columns are what tell them apart. */
function isAgentIdentityRead(queryArgs: unknown[], agentId: string): boolean {
  const text = barrierQueryText(queryArgs);
  return (
    text.startsWith('select "id", "owner", "org_id" from "agents"') &&
    barrierQueryBinds(queryArgs, agentId)
  );
}

/**
 * Where the paused transaction stops. `identity` precedes subject admission,
 * `agent-lock` sits between the unlocked identity read and the retained
 * identity lock, `update` precedes the single bulk statement, `update-result`
 * holds that statement's own result after PostgreSQL has executed it, and
 * `commit` retains every barrier with every matched cursor already written.
 *
 * `update-result` uses the shared barrier's `pauseAfter` mode, so it is the only
 * stop between the completed bulk write and the helper's last in-transaction
 * cancellation check: an operation cancelled there has every matched row
 * written and no `COMMIT` sent. A stop at `commit` is already past that check,
 * where cancelling loses a race rather than rolling anything back.
 */
type ChatThreadAgentReadBarrierStop =
  | "identity"
  | "agent-lock"
  | "update"
  | "update-result"
  | "commit";

function reachedBarrierStop(
  stop: ChatThreadAgentReadBarrierStop,
  queryArgs: unknown[],
  identityRead: boolean,
): boolean {
  const text = barrierQueryText(queryArgs);
  if (stop === "identity") {
    return identityRead;
  }
  if (stop === "agent-lock") {
    return text.includes('from "agents"') && text.includes("for key share");
  }
  if (stop === "update" || stop === "update-result") {
    return text.startsWith('with "updated_threads"');
  }
  return text === "commit";
}

/** Pauses the bulk read-cursor transaction opened for one Agent. See
 * {@link withDatabaseTransactionBarrierFixture} for the mechanism and the
 * infrastructure exception it documents.
 */
export async function withChatThreadAgentReadBarrierFixture<T>(
  args: {
    readonly agentId: string;
    readonly stopAt: ChatThreadAgentReadBarrierStop;
    readonly work: (barrier: TransactionBarrier) => Promise<T>;
  },
  signal: AbortSignal,
): Promise<T> {
  return await withDatabaseTransactionBarrierFixture(
    {
      select: (queryArgs) => {
        return isAgentIdentityRead(queryArgs, args.agentId);
      },
      stopAt: (queryArgs, selectingStatement) => {
        return reachedBarrierStop(args.stopAt, queryArgs, selectingStatement);
      },
      pauseAfter: args.stopAt === "update-result",
      work: args.work,
    },
    signal,
  );
}
