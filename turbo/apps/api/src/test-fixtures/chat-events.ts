import {
  chatEventAppendResultSchema,
  chatEventCommandResultSchema,
} from "../signals/services/chat-event-append.service";
import { randomUUID } from "node:crypto";
import type { ChatEventPayload } from "@okouai/db/jsonb-contracts/chat-event";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { pgTextDecoder } from "../lib/db-structured-result";
import { billingRunAttributionWrite } from "../signals/services/managed-usage-attribution";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { Pool } from "pg";
import { closeDbPool, db } from "../lib/db";
import { parseRawRows } from "../lib/db-raw-rows";
import type { Tx } from "../lib/db-types";
import { nowDate } from "../lib/time";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../signals/services/built-in-model-key-fixture";
import { canonicalChatEventUserMessage } from "../signals/services/canonical-chat-event-read.service";
import { visibleChatEventCondition } from "../signals/services/chat-event-shared.service";
import {
  chatInputPromptDispatchCondition,
  runOwnedChatEventForRunCondition,
} from "../signals/services/chat-event-type.service";
import {
  chatEventInsertSql,
  chatEventReplacementInsertSql,
  requireChatEventReplacementTarget,
  chatEventReplacementTargetSql,
  chatEventReplacementTargetSchema,
  chatEventsInsertSql,
} from "../signals/services/chat-event.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";
import { createDeferredPromise, settleIncludingAbort } from "../signals/utils";

/**
 * BDD-scoped built-in model key prefixes. Fixture acquisition below only
 * accepts keys carrying one of these prefixes.
 */
const BDD_BUILT_IN_MODEL_KEY_PREFIXES = [
  "built-in-key-bdd-fake-",
  "built-in-key-bdd-dev-seed-",
] as const;
const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const blockedByPidRowSchema = z.object({ blocked: z.boolean() });
const blockedQueryRowSchema = z.object({ query: z.string() });

type ChatThreadBlockedStatementKind =
  | "select_for_key_share"
  | "select_for_update"
  | "update"
  | "other";

async function pendingTelegramEventContext(eventId: string) {
  const [row] = await db()
    .select({
      contextId: chatTelegramContext.id,
    })
    .from(chatEvents)
    .innerJoin(
      chatTelegramContext,
      and(
        eq(chatTelegramContext.id, chatEvents.contextId),
        eq(chatTelegramContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, eventId),
        eq(chatEvents.contextType, "telegram"),
        isNull(chatEvents.runId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Expected pending Telegram launch context");
  }
  return row;
}

export async function setTelegramThinkingMessageIdFixture(
  eventId: string,
  thinkingMessageId: string,
): Promise<void> {
  const event = await pendingTelegramEventContext(eventId);
  await db()
    .update(chatTelegramContext)
    .set({ thinkingMessageId })
    .where(eq(chatTelegramContext.id, event.contextId));
}

/**
 * Chat events live in a database shared by every parallel test worker, so a
 * prompt lookup must be scoped to the caller's own user. Matching on prompt
 * text alone reads whichever worker's row happens to be there.
 */
async function findOwnedChatEventByPrompt(args: {
  readonly userId: string;
  readonly prompt: string;
  readonly filter: SQL | undefined;
}): Promise<{ readonly eventId: string } | null> {
  const rows = await db()
    .select({
      eventId: chatEvents.id,
      userMessage: canonicalChatEventUserMessage(),
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .where(and(eq(chatThreads.userId, args.userId), args.filter));
  const row = rows.find((candidate) => {
    return candidate.userMessage?.parts.some((part) => {
      return part.type === "text" && part.text === args.prompt;
    });
  });
  return row ?? null;
}

export async function findPendingChatEventByPromptFixture(args: {
  readonly userId: string;
  readonly prompt: string;
}): Promise<{ readonly eventId: string } | null> {
  return await findOwnedChatEventByPrompt({
    userId: args.userId,
    prompt: args.prompt,
    filter: isNull(chatEvents.runId),
  });
}

/** Inserts a pending Slack event, then removes the context its claim requires. */
export async function insertQueuedSlackMissingContextFixture(args: {
  readonly threadId: string;
  readonly content: string;
}): Promise<string> {
  return await db().transaction(async (tx) => {
    const event =
      parseRawRows(
        chatEventCommandResultSchema,
        await tx.execute(
          chatEventInsertSql({
            chatThreadId: args.threadId,
            eventType: "input.prompt",
            userMessage: createUserMessageDocument({ text: args.content }),
            runId: null,
            slackContext: {
              channelId: "C_MONITOR_FAILURE",
              messageTs: "1.000001",
              botUserId: "U_MONITOR_FAILURE_BOT",
              conversationContext: "",
              messageText: args.content,
              messageFiles: [],
              messageAssets: [],
              mentionDisplayNames: {},
              senderDisplayName: "Queue Monitor Fixture",
              senderUserId: "U_MONITOR_FAILURE",
              channelType: "channel",
              threadTs: "1.000001",
              routeThreadTs: null,
            },
          }),
        ),
      )[0] ?? null;
    if (!event) {
      throw new Error("Failed to insert queued Slack fixture");
    }
    await tx.delete(chatSlackContext).where(eq(chatSlackContext.id, event.id));
    return event.id;
  });
}

export async function replayPendingChatInputQueueEventFixture(args: {
  readonly eventId: string;
  readonly replacementId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [event] = await tx
      .select({
        chatThreadId: chatEvents.chatThreadId,
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .limit(1);
    if (!event?.userMessage) {
      throw new Error("Expected one pending chat input queue event");
    }
    const replacement =
      parseRawRows(
        chatEventCommandResultSchema,
        await tx.execute(
          chatEventReplacementInsertSql(
            requireChatEventReplacementTarget(
              parseRawRows(
                chatEventReplacementTargetSchema,
                await tx.execute(chatEventReplacementTargetSql(args.eventId)),
              ),
            ),
            {
              id: args.replacementId,
              chatThreadId: event.chatThreadId,
              eventType: "input.prompt",
              userMessage: event.userMessage,
              runId: null,
            },
          ),
        ),
      )[0] ?? null;
    if (!replacement) {
      throw new Error("Expected the pending queue event replay to insert");
    }
  });
}

/**
 * Move one exact automation event into historical state without waiting for real
 * time to pass. A string preserves PostgreSQL precision beyond JavaScript
 * milliseconds. Product APIs cannot construct an already-stale queue item.
 */
export async function setWorkflowQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date | string;
}): Promise<void> {
  const createdAt =
    typeof args.createdAt === "string"
      ? sql`CAST(${args.createdAt} AS timestamp)`
      : args.createdAt;
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.automation"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one workflow queue event to become historical");
  }
}

/**
 * Move one exact queued web message into historical state without waiting for
 * real time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setQueuedUserMessageCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one queued user message to become historical");
  }
}

/**
 * Complete one claimed run without dispatching its terminal callbacks. This
 * reproduces the missed-callback state that the stale queue sweep recovers.
 */
export async function completeRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const completedAt = nowDate();
  await db().transaction(async (tx) => {
    const updated = await tx
      .update(agentRuns)
      .set({ status: "completed", completedAt })
      .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
      .returning({ id: agentRuns.id });
    if (updated.length !== 1) {
      throw new Error("Expected one running run to complete without callbacks");
    }
    // Completion releases the thread's active run row with the transition.
    await tx
      .delete(activeAgentRuns)
      .where(eq(activeAgentRuns.runId, args.runId));
  });
}

/**
 * Mark one claimed run timed out without completing its terminal side effects.
 * This isolates the interval where cleanup has recorded uncertainty but the
 * Runner has not yet reported process exit and teardown through `/complete`.
 */
export async function timeoutRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({
      status: "timeout",
      completedAt: nowDate(),
      error: "Run timed out (no heartbeat)",
    })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to time out without callbacks");
  }
}

/**
 * Product APIs cannot pause a completed SQL response or physically remove an
 * event at that boundary. Preserve the real selected rows, delete only the
 * owned event before returning them, and leave other threads' queries alone.
 */
export async function withChatEventDeletedAfterReadFixture<T>(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly whileResponseHeld: () => Promise<void>;
  readonly work: () => Promise<T>;
}): Promise<T> {
  await closeDbPool();
  const original = Pool.prototype.query;
  let held = false;
  Pool.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const result: unknown = Reflect.apply(target, receiver, queryArgs);
      const query = z.object({ text: z.string() }).safeParse(queryArgs[0]);
      const values = z.array(z.unknown()).safeParse(queryArgs[1]);
      if (
        held ||
        !(result instanceof Promise) ||
        !query.success ||
        !values.success ||
        !isSharedThreadHotSnapshotRead(
          normalizeBlockedQuery(query.data.text),
        ) ||
        !values.data.includes(args.threadId) ||
        !values.data.includes(args.eventId)
      ) {
        return result;
      }
      held = true;
      return (async () => {
        const response: unknown = await result;
        z.object({ rows: z.array(z.unknown()).length(1) }).parse(response);
        await args.whileResponseHeld();
        const deleted = await db()
          .delete(chatEvents)
          .where(
            and(
              eq(chatEvents.chatThreadId, args.threadId),
              eq(chatEvents.id, args.eventId),
            ),
          )
          .returning({ id: chatEvents.id });
        if (deleted.length !== 1) {
          throw new Error("Expected one chat event to be physically deleted");
        }
        return response;
      })();
    },
  });
  const run = async () => {
    const result = await args.work();
    if (!held) {
      throw new Error("Expected the selected hot chat-event response barrier");
    }
    return result;
  };
  const [result] = await Promise.allSettled([run()]);
  // Instrumentation binds the pool query method. Close the instrumented pool
  // before restoring the prototype so the next request cannot reuse the hold.
  const [closed] = await Promise.allSettled([closeDbPool()]);
  Pool.prototype.query = original;
  if (result.status === "rejected") {
    throw result.reason;
  }
  if (closed.status === "rejected") {
    throw closed.reason;
  }
  return result.value;
}

async function transitiveBlockedWaiterCount(
  holderPid: number,
): Promise<number> {
  const rows = parseRawRows(
    waiterCountRowSchema,
    await db().execute(sql`
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
    `),
  );
  return rows[0]?.waiterCount ?? 0;
}

function normalizeBlockedQuery(query: string): string {
  return query.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function isSharedThreadHotSnapshotRead(query: string): boolean {
  return (
    query.startsWith("select ") &&
    query.includes(' from "chat_events" ') &&
    query.endsWith('order by "chat_events"."seq_id" asc')
  );
}

async function firstDirectBlockedStatementKind(
  holderPid: number,
): Promise<ChatThreadBlockedStatementKind | null> {
  const rows = parseRawRows(
    blockedQueryRowSchema,
    await db().execute(sql`
      SELECT activity.query AS "query"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
      ORDER BY activity.query_start, activity.pid
      LIMIT 1
    `),
  );
  const query = rows[0] ? normalizeBlockedQuery(rows[0].query) : undefined;
  if (!query) {
    return null;
  }
  if (
    query.startsWith("select") &&
    query.includes('from "chat_threads"') &&
    query.includes("for key share")
  ) {
    return "select_for_key_share";
  }
  if (
    query.startsWith("select") &&
    query.includes('from "chat_threads"') &&
    query.includes("for update")
  ) {
    return "select_for_update";
  }
  if (query.startsWith('update "chat_threads"')) {
    return "update";
  }
  return "other";
}

/**
 * Waiters blocked by this holder whose own statement is a `FOR KEY SHARE` lock
 * on the held thread. A plain waiter count also includes ordinary writers with
 * no lock timeout of their own, which can still be queued behind the holder
 * when a fenced writer has already given up, so a test that needs to observe
 * exactly that writer block and then stop waiting counts only these.
 */
async function blockedKeyShareWaiterCount(holderPid: number): Promise<number> {
  const rows = parseRawRows(
    blockedQueryRowSchema,
    await db().execute(sql`
      SELECT activity.query AS "query"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `),
  );
  return rows.filter((row) => {
    const query = normalizeBlockedQuery(row.query);
    return (
      query !== undefined &&
      query.startsWith("select") &&
      query.includes('from "chat_threads"') &&
      query.includes("for key share")
    );
  }).length;
}

/**
 * Holds one thread row so route tests can observe the first product statement
 * that requires a write-oriented lock. Product APIs cannot pause at this
 * boundary, and the fixture does not change the held row.
 *
 * `update` is the default and conflicts with every write-oriented lock,
 * including the fenced writer's first `FOR KEY SHARE`. `no key update` is the
 * lock an ordinary row `UPDATE` takes: it is compatible with `FOR KEY SHARE`,
 * so a fenced writer passes its identity lock and blocks later, at its own
 * `UPDATE` of the held row. That is the shape the production 55P03 records in
 * #36173 show, and it is the only way a test can reach a writer's statements
 * after the identity lock and still fail the thread-row write.
 */
export async function holdChatThreadRowLockFixture(args: {
  readonly threadId: string;
  readonly mode?: "update" | "no key update";
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blockedKeyShareWaiterCount: () => Promise<number>;
  readonly firstBlockedStatementKind: () => Promise<ChatThreadBlockedStatementKind | null>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .for(args.mode ?? "update")
      .limit(1);
    if (!thread) {
      throw new Error("Expected the chat thread row");
    }
    const pidRows = parseRawRows(
      databasePidRowSchema,
      await tx.execute(sql`
        SELECT pg_backend_pid() AS "pid"
      `),
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat thread lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const settledStarted = settleIncludingAbort(started.promise);
  const settledDone = settleIncludingAbort(done);
  const first = await Promise.race([
    (async () => {
      return { kind: "started" as const, result: await settledStarted };
    })(),
    (async () => {
      return { kind: "done" as const, result: await settledDone };
    })(),
  ]);
  if (first.kind === "done") {
    if (!first.result.ok) {
      throw first.result.error;
    }
    throw new Error("Chat thread row lock holder completed before readiness");
  }
  if (!first.result.ok) {
    const result = await settledDone;
    if (!result.ok && !Object.is(result.error, first.result.error)) {
      throw new AggregateError(
        [first.result.error, result.error],
        "Chat thread row lock holder setup and transaction failed",
      );
    }
    throw first.result.error;
  }
  const holderPid = first.result.value;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
    blockedKeyShareWaiterCount: async () => {
      return await blockedKeyShareWaiterCount(holderPid);
    },
    firstBlockedStatementKind: async () => {
      return await firstDirectBlockedStatementKind(holderPid);
    },
  };
}

/**
 * Deletes one test-owned thread and pauses before commit. Product APIs cannot
 * pause after DELETE has locked the parent but before the transaction commits,
 * so this fixture exposes that exact projection/deletion concurrency boundary.
 */
export async function holdChatThreadDeleteTransactionFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly firstBlockedStatementKind: () => Promise<ChatThreadBlockedStatementKind | null>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const deleted = await tx
      .delete(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .returning({ id: chatThreads.id });
    if (deleted.length !== 1) {
      throw new Error("Expected one chat thread to delete");
    }
    const pidRows = parseRawRows(
      databasePidRowSchema,
      await tx.execute(sql`
        SELECT pg_backend_pid() AS "pid"
      `),
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat thread delete holder pid");
    }
    started.resolve(holderPid);
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
    firstBlockedStatementKind: async () => {
      return await firstDirectBlockedStatementKind(holderPid);
    },
  };
}

async function pidIsDirectlyBlockedBy(
  waiterPid: number,
  holderPid: number,
): Promise<boolean> {
  const rows = parseRawRows(
    blockedByPidRowSchema,
    await db().execute(sql`
      SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS "blocked"
    `),
  );
  return rows[0]?.blocked ?? false;
}

/**
 * Acquires bdd-scoped ownership of the platform-managed built-in model key
 * pool for one vendor.
 *
 * Why product APIs cannot construct this state: built_in_model_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * BDD_BUILT_IN_MODEL_KEY_PREFIXES prefix. The shared fixture service atomically
 * arbitrates the vendor-unique row and prevents one test owner from deleting
 * another owner's key.
 */
export async function acquireBddBuiltInModelKey(args: {
  readonly fixtureId: string;
  readonly vendor: string;
  readonly apiKey: string;
}): Promise<string> {
  const scoped = BDD_BUILT_IN_MODEL_KEY_PREFIXES.some((prefix) => {
    return args.apiKey.length > prefix.length && args.apiKey.startsWith(prefix);
  });
  if (!scoped) {
    throw new Error(
      `acquireBddBuiltInModelKey: api key must start with one of ${BDD_BUILT_IN_MODEL_KEY_PREFIXES.join(", ")}`,
    );
  }
  const [acquired] = await acquireBuiltInModelKeyFixture(db(), args.fixtureId, [
    {
      vendor: args.vendor,
      apiKey: args.apiKey,
    },
  ]);
  if (!acquired) {
    throw new Error(`Expected built-in model key for vendor: ${args.vendor}`);
  }
  return acquired.apiKey;
}

/** Releases only this bdd fixture's ownership of its vendor key. */
export async function releaseBddBuiltInModelKey(args: {
  readonly fixtureId: string;
}): Promise<void> {
  await releaseBuiltInModelKeyFixture(db(), args.fixtureId);
}

/**
 * Inserts one event through the production sequence writer, then holds its
 * transaction open. No product endpoint can pause between INSERT and COMMIT,
 * so this fixture is the narrow timing boundary for sequence serialization.
 */
export async function holdChatEventInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly event: { readonly id: string; readonly seqId: number };
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blocks: (waiterPid: number) => Promise<boolean>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: { readonly id: string; readonly seqId: number };
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = parseRawRows(
      databasePidRowSchema,
      await tx.execute(sql`
        SELECT pg_backend_pid() AS "pid"
      `),
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message insert holder pid");
    }
    const event =
      parseRawRows(
        chatEventCommandResultSchema,
        await tx.execute(
          chatEventInsertSql({
            chatThreadId: args.threadId,
            eventType: "output.message",
            content: args.content,
            runId: null,
          }),
        ),
      )[0] ?? null;
    if (!event) {
      throw new Error("Expected the held chat-message insert");
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
    blocks: async (waiterPid) => {
      return await pidIsDirectlyBlockedBy(waiterPid, pid);
    },
  };
}

/**
 * Appends an explicit output event with a nullable compatibility payload owned
 * by a different ChatEvent leaf. Product writers intentionally
 * cannot create this divergent rollout shape; the fixture proves readers use
 * `event_type` as the semantic discriminator instead of legacy payload shape.
 */
export async function insertOutputEventWithConflictingLegacyPayloadFixture(args: {
  readonly threadId: string;
  readonly runId?: string;
  readonly content: string;
  readonly createdAt?: Date;
  readonly legacyPayload: "run.completed" | "usage.recorded";
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    const identity = {
      chatThreadId: args.threadId,
      eventType: "output.message" as const,
      content: args.content,
      runId: args.runId ?? null,
      createdAt: args.createdAt,
    };
    const lifecyclePayloadEvent = {
      ...identity,
      runLifecycleEvent: "completed",
    };
    const usagePayloadEvent = {
      ...identity,
      usagePayload: {
        version: 1 as const,
        totalCredits: 0,
        settledAt: (args.createdAt ?? nowDate()).toISOString(),
        breakdown: [],
      },
    };
    const inserted =
      args.legacyPayload === "run.completed"
        ? (parseRawRows(
            chatEventCommandResultSchema,
            await tx.execute(chatEventInsertSql(lifecyclePayloadEvent)),
          )[0] ?? null)
        : (parseRawRows(
            chatEventCommandResultSchema,
            await tx.execute(chatEventInsertSql(usagePayloadEvent)),
          )[0] ?? null);
    if (!inserted) {
      throw new Error("Expected the conflicting legacy-payload event insert");
    }
    return inserted;
  });
  return event;
}

interface CanonicalChatEventStorageRow {
  readonly id: string;
  readonly eventType: string;
  readonly payload: ChatEventPayload | null;
  readonly runId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly revokesEventId: string | null;
}

interface CanonicalChatEventWriteFixture {
  readonly eventIds: readonly string[];
  readonly single: {
    readonly inputRejectedId: string;
    readonly outputErrorId: string;
    readonly interruptId: string;
    readonly interruptTargetRunId: string;
  };
  readonly batch: {
    readonly runFailedId: string;
    readonly usageId: string;
  };
  readonly replacement: {
    readonly targetId: string;
    readonly replacementId: string;
  };
}

async function insertCanonicalSingleWrites(
  tx: Tx,
  threadId: string,
  single: CanonicalChatEventWriteFixture["single"],
): Promise<void> {
  const inputUserMessage = createUserMessageDocument({
    text: "rejected canonical input",
  });
  parseRawRows(
    chatEventCommandResultSchema,
    await tx.execute(
      chatEventInsertSql({
        id: single.inputRejectedId,
        chatThreadId: threadId,
        eventType: "input.rejected",
        contextType: "web",
        userMessage: inputUserMessage,
        runId: null,
        error: "input rejected",
      }),
    ),
  );
  parseRawRows(
    chatEventCommandResultSchema,
    await tx.execute(
      chatEventInsertSql({
        id: single.outputErrorId,
        chatThreadId: threadId,
        eventType: "output.error",
        content: "output failed",
        error: "output error",
        runId: randomUUID(),
      }),
    ),
  );
  parseRawRows(
    chatEventCommandResultSchema,
    await tx.execute(
      chatEventInsertSql({
        id: single.interruptId,
        chatThreadId: threadId,
        eventType: "control.interrupt",
        interruptsRunId: single.interruptTargetRunId,
      }),
    ),
  );
}

async function insertCanonicalBatchWrites(
  tx: Tx,
  threadId: string,
  batch: CanonicalChatEventWriteFixture["batch"],
): Promise<void> {
  parseRawRows(
    chatEventAppendResultSchema,
    await tx.execute(
      chatEventsInsertSql([
        {
          id: batch.runFailedId,
          chatThreadId: threadId,
          eventType: "run.failed",
          content: "run failed",
          error: "runner error",
          failureReason: "future_reason",
          runId: randomUUID(),
        },
        {
          id: batch.usageId,
          chatThreadId: threadId,
          eventType: "usage.recorded",
          runId: randomUUID(),
          usagePayload: {
            version: 1,
            totalCredits: 9,
            settledAt: "2026-08-10T00:00:00.000Z",
            breakdown: [
              {
                kind: "model",
                credits: 9,
                providers: [{ provider: "test", credits: 9 }],
              },
            ],
          },
        },
      ]),
    ),
  );
}

async function insertCanonicalReplacementWrite(
  tx: Tx,
  threadId: string,
  replacement: CanonicalChatEventWriteFixture["replacement"],
): Promise<void> {
  const userMessage = createUserMessageDocument({
    text: "replacement canonical input",
  });
  parseRawRows(
    chatEventCommandResultSchema,
    await tx.execute(
      chatEventInsertSql({
        id: replacement.targetId,
        chatThreadId: threadId,
        eventType: "input.prompt",
        contextType: "web",
        userMessage,
        runId: null,
      }),
    ),
  );
  parseRawRows(
    chatEventCommandResultSchema,
    await tx.execute(
      chatEventReplacementInsertSql(
        requireChatEventReplacementTarget(
          parseRawRows(
            chatEventReplacementTargetSchema,
            await tx.execute(
              chatEventReplacementTargetSql(replacement.targetId),
            ),
          ),
        ),
        {
          id: replacement.replacementId,
          chatThreadId: threadId,
          eventType: "input.rejected",
          userMessage,
          runId: null,
          error: "replacement rejected",
        },
      ),
    ),
  );
}

/** Exercise the three production canonical persistence paths. */
export async function insertCanonicalChatEventWritesFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<CanonicalChatEventWriteFixture> {
  const interruptTargetSessionId = randomUUID();
  const single = {
    inputRejectedId: randomUUID(),
    outputErrorId: randomUUID(),
    interruptId: randomUUID(),
    interruptTargetRunId: randomUUID(),
  };
  const batch = {
    runFailedId: randomUUID(),
    usageId: randomUUID(),
  };
  const replacement = {
    targetId: randomUUID(),
    replacementId: randomUUID(),
  };
  await db().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: interruptTargetSessionId,
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.agentId,
    });
    const [run] = await tx
      .insert(agentRuns)
      .values({
        id: single.interruptTargetRunId,
        userId: args.userId,
        orgId: args.orgId,
        sessionId: interruptTargetSessionId,
        status: "queued",
        prompt: "canonical interrupt target",
      })
      .returning({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
        triggerSource: agentRuns.triggerSource,
        threadId: agentRuns.chatThreadId,
      });
    if (!run) {
      throw new Error("Expected canonical interrupt target run insertion");
    }
    const capture = billingRunAttributionWrite(run);
    await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoNothing();
    await insertCanonicalSingleWrites(tx, args.threadId, single);
    await insertCanonicalBatchWrites(tx, args.threadId, batch);
    await insertCanonicalReplacementWrite(tx, args.threadId, replacement);
  });

  return {
    eventIds: [
      single.inputRejectedId,
      single.outputErrorId,
      single.interruptId,
      batch.runFailedId,
      batch.usageId,
      replacement.targetId,
      replacement.replacementId,
    ],
    single,
    batch,
    replacement,
  };
}

export async function readCanonicalChatEventStorageFixture(
  eventIds: readonly string[],
): Promise<readonly CanonicalChatEventStorageRow[]> {
  return await db()
    .select({
      id: chatEvents.id,
      eventType: chatEvents.eventType,
      payload: chatEvents.payload,
      failureReason: chatEvents.failureReason,
      runId: chatEvents.runId,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      revokesEventId: chatEvents.revokesEventId,
    })
    .from(chatEvents)
    .where(inArray(chatEvents.id, [...eventIds]));
}

export async function isVisibleChatEventFixture(
  eventId: string,
): Promise<boolean> {
  const database = db();
  const [event] = await database
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(and(eq(chatEvents.id, eventId), visibleChatEventCondition()))
    .limit(1);
  return event !== undefined;
}

/**
 * Usage-ledger rows have no production read endpoint. This test-only fixture is
 * the narrow external-behavior exception needed to prove exactly-once billing
 * without exposing internal billing records through a new product API.
 */
export async function readRunUsageEventsFixture(runId: string): Promise<
  readonly {
    readonly provider: string;
    readonly category: string;
    readonly quantity: number;
    readonly status: string;
    readonly creditsCharged: number | null;
    readonly billingError: string | null;
  }[]
> {
  return await db()
    .select({
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
      billingError: usageEvent.billingError,
    })
    .from(usageEvent)
    .where(eq(usageEvent.runId, runId))
    .orderBy(usageEvent.category);
}

/**
 * Exercise the production predicates shared by artifact catalog/realtime,
 * thread/Google Drive, and Feishu/AgentPhone/Teams/Telegram dispatch readers.
 */
export async function readCanonicalRunIdCollisionSafetyFixture(args: {
  readonly chatThreadId: string;
  readonly interruptEventId: string;
  readonly runId: string;
}): Promise<{
  readonly artifactLookupMatchedInterrupt: boolean;
  readonly feishuDispatchMatchedInterrupt: boolean;
  readonly rawRunIdCollisionExists: boolean;
  readonly threadScopedArtifactLookupMatchedInterrupt: boolean;
  readonly threadScopedDispatchMatchedInterrupt: boolean;
}> {
  const database = db();
  const [
    rawRunIdCollision,
    artifactLookup,
    threadScopedArtifactLookup,
    feishuDispatch,
    threadScopedDispatch,
  ] = await Promise.all([
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          eq(chatEvents.runId, args.runId),
        ),
      )
      .limit(1),
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          runOwnedChatEventForRunCondition({ runId: args.runId }),
        ),
      )
      .limit(1),
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          runOwnedChatEventForRunCondition({
            runId: args.runId,
            chatThreadId: args.chatThreadId,
          }),
        ),
      )
      .limit(1),
    database
      .select({ runId: agentRuns.id })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        chatInputPromptDispatchCondition({ eventId: args.interruptEventId }),
      )
      .limit(1),
    database
      .select({ runId: agentRuns.id })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        chatInputPromptDispatchCondition({
          eventId: args.interruptEventId,
          chatThreadId: args.chatThreadId,
        }),
      )
      .limit(1),
  ]);
  return {
    rawRunIdCollisionExists: rawRunIdCollision.length > 0,
    artifactLookupMatchedInterrupt: artifactLookup.length > 0,
    threadScopedArtifactLookupMatchedInterrupt:
      threadScopedArtifactLookup.length > 0,
    feishuDispatchMatchedInterrupt: feishuDispatch.length > 0,
    threadScopedDispatchMatchedInterrupt: threadScopedDispatch.length > 0,
  };
}
