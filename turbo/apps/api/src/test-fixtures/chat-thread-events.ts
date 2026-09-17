import { randomUUID } from "node:crypto";

import {
  chatThreadEventSequences,
  chatThreadEvents,
} from "@okouai/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import { appendChatThreadEvent } from "../signals/services/chat-thread-event.service";
import { createDeferredPromise } from "../signals/utils";

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });

interface ChatThreadEventFixtureArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
  readonly title: string;
  readonly createdAt?: Date;
}

interface PersistedChatThreadEventFixture {
  readonly id: string;
  readonly seqId: number;
}

async function transitiveBlockedWaiterCount(
  holderPid: number,
): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      WITH RECURSIVE blocked("pid") AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))

        UNION

        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT ${count()}::int AS "waiterCount"
      FROM blocked
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

/**
 * Appends an event through the production writer and pauses before commit.
 * Product endpoints cannot expose this boundary, so the fixture makes the
 * sequence-row lock observable to the concurrency regression test.
 */
export async function holdChatThreadEventInsertTransactionFixture(
  args: ChatThreadEventFixtureArgs & { readonly signal: AbortSignal },
): Promise<{
  readonly event: PersistedChatThreadEventFixture;
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: PersistedChatThreadEventFixture;
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const eventId = randomUUID();
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-thread event insert holder pid");
    }
    await appendChatThreadEvent(tx, {
      eventId,
      kind: "renamed",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: args.chatThreadId,
      agentId: args.agentId,
      title: args.title,
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
    });
    const [event] = await tx
      .select({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId })
      .from(chatThreadEvents)
      .where(eq(chatThreadEvents.id, eventId))
      .limit(1);
    if (!event) {
      throw new Error("Expected the held chat-thread event insert");
    }
    started.resolve({ pid: holderPid, event });
    await released.promise;
  });
  const { pid, event } = await started.promise;

  return {
    event,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(pid);
    },
  };
}

/** Appends one event with sequence reservation and persistence in one commit. */
export async function insertChatThreadEventTransactionFixture(
  args: ChatThreadEventFixtureArgs,
): Promise<PersistedChatThreadEventFixture> {
  const eventId = randomUUID();
  const event = await db().transaction(async (tx) => {
    await appendChatThreadEvent(tx, {
      eventId,
      kind: "renamed",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: args.chatThreadId,
      agentId: args.agentId,
      title: args.title,
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
    });
    const [persisted] = await tx
      .select({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId })
      .from(chatThreadEvents)
      .where(eq(chatThreadEvents.id, eventId))
      .limit(1);
    return persisted;
  });
  if (!event) {
    throw new Error("Expected the chat-thread event insert");
  }
  return event;
}

/**
 * Inserts the canonical null-Agent form retained from an already-deleted
 * Agent. The production lifecycle writer always has a live Agent at append
 * time, so retention coverage needs this narrow persisted-state fixture.
 */
export async function insertCanonicalOrphanChatThreadEventFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly createdAt: Date;
}): Promise<PersistedChatThreadEventFixture> {
  const eventId = randomUUID();
  const event = await db().transaction(async (tx) => {
    const [sequence] = await tx
      .insert(chatThreadEventSequences)
      .values({
        userId: args.userId,
        orgId: args.orgId,
        lastSeqId: 1,
      })
      .onConflictDoUpdate({
        target: [
          chatThreadEventSequences.userId,
          chatThreadEventSequences.orgId,
        ],
        set: {
          lastSeqId: sql`${chatThreadEventSequences.lastSeqId} + 1`,
        },
      })
      .returning({ seqId: chatThreadEventSequences.lastSeqId });
    if (!sequence) {
      throw new Error("Unable to reserve orphan chat-thread event seq_id");
    }
    const [persisted] = await tx
      .insert(chatThreadEvents)
      .values({
        id: eventId,
        userId: args.userId,
        orgId: args.orgId,
        seqId: sequence.seqId,
        chatThreadId: args.chatThreadId,
        kind: "deleted",
        agentId: null,
        createdAt: args.createdAt,
      })
      .returning({ id: chatThreadEvents.id, seqId: chatThreadEvents.seqId });
    return persisted;
  });
  if (!event) {
    throw new Error("Expected the canonical orphan chat-thread event");
  }
  return event;
}

/** Seeds an authoritative snapshot boundary for retention-route scenarios. */
export async function setChatThreadSnapshotBoundaryFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly latestEventId: string;
  readonly latestEventSeqId: number;
  readonly updatedAt: Date;
}): Promise<void> {
  await db()
    .insert(chatThreadSnapshots)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      latestEventId: args.latestEventId,
      latestEventSeqId: args.latestEventSeqId,
      chatThreads: [],
      createdAt: args.updatedAt,
      updatedAt: args.updatedAt,
    })
    .onConflictDoUpdate({
      target: [chatThreadSnapshots.userId, chatThreadSnapshots.orgId],
      set: {
        latestEventId: args.latestEventId,
        latestEventSeqId: args.latestEventSeqId,
        chatThreads: [],
        updatedAt: args.updatedAt,
      },
    });
}

/** Reads exact physical lifecycle rows, including rows hidden by the reader. */
export async function readChatThreadEventIdsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly eventIds: readonly string[];
}): Promise<readonly string[]> {
  if (args.eventIds.length === 0) {
    return [];
  }
  const rows = await db()
    .select({ id: chatThreadEvents.id })
    .from(chatThreadEvents)
    .where(
      and(
        eq(chatThreadEvents.userId, args.userId),
        eq(chatThreadEvents.orgId, args.orgId),
        inArray(chatThreadEvents.id, args.eventIds),
      ),
    )
    .orderBy(asc(chatThreadEvents.seqId));
  return rows.map((row) => {
    return row.id;
  });
}

/**
 * Removes an exact snapshot-boundary row to model a markerless cursor without
 * waiting for the retention window. No production endpoint exposes physical
 * lifecycle-row deletion, so the route regression test owns this fixture.
 */
export async function deleteChatThreadEventMarkerFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly eventId: string;
  readonly seqId: number;
}): Promise<void> {
  const deleted = await db()
    .delete(chatThreadEvents)
    .where(
      and(
        eq(chatThreadEvents.userId, args.userId),
        eq(chatThreadEvents.orgId, args.orgId),
        eq(chatThreadEvents.id, args.eventId),
        eq(chatThreadEvents.seqId, args.seqId),
      ),
    )
    .returning({ id: chatThreadEvents.id });
  if (deleted.length !== 1) {
    throw new Error("Expected one chat-thread snapshot marker to be deleted");
  }
}

/**
 * Pins a thread's video model without a write endpoint. Lets the snapshot
 * compaction test prove the column survives the hand-written jsonb projection,
 * which a null-valued thread cannot show.
 */
export async function setChatThreadVideoModelFixture(
  chatThreadId: string,
  selectedVideoModel: string,
): Promise<void> {
  await db()
    .update(chatThreads)
    .set({ selectedVideoModel })
    .where(eq(chatThreads.id, chatThreadId));
}
