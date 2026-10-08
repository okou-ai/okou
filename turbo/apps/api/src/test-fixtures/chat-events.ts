import {
  chatEventAppendResultSchema,
  chatEventCommandResultSchema,
} from "../signals/services/chat-event-append.service";
import { randomUUID } from "node:crypto";
import type { ChatEventPayload } from "@okouai/db/jsonb-contracts/chat-event";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { pgTextDecoder } from "../lib/db-structured-result";
import { billingRunAttributionWrite } from "../signals/services/managed-usage-attribution";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { and, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db";
import { parseRawRows } from "../lib/db-raw-rows";
import type { Tx } from "../lib/db-types";
import { nowDate } from "../lib/time";

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

const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const blockedQueryRowSchema = z.object({ query: z.string() });

type ChatThreadBlockedStatementKind =
  "select_for_key_share" | "select_for_update" | "update" | "other";

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
