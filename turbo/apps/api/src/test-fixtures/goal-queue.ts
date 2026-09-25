import { reserveFixtureChatEventSequence } from "./chat-event-sequences";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { randomUUID } from "node:crypto";
import { seedLiteralGoalArchive } from "./goal-retirement";
import { insertChatEvent } from "../signals/services/chat-event.service";
import { createStore } from "ccstate";
import { and, eq, desc, sql } from "drizzle-orm";

import { db } from "../lib/db";
import type { Tx } from "../lib/db-types";
import { dispatchFailedRunCallbacks } from "../signals/services/agent-run-callback.service";
import { lockChatQueueThread } from "../signals/services/chat-event-queue.service";
import { drainChatThreadQueueForThread$ } from "../signals/services/chat-thread-queue-drain.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";

interface GoalQueueAdmissionFixtureArgs {
  readonly threadId: string;
  readonly goalId: string;
  readonly objectiveBrief: string;
}

/** Seed an old input: production no longer admits Goal events. */
export async function admitGoalQueueEventFixture(
  args: GoalQueueAdmissionFixtureArgs,
): Promise<
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" }
> {
  return await db().transaction(async (tx) => {
    await lockChatQueueThread(tx, args.threadId);
    const [pending] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      );
    if (pending) {
      return { kind: "coalesced" };
    }
    const event = await appendHistoricalGoalEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "input.goal",
      content: null,
      contextType: "goal",
      runId: null,
      runGroupId: args.goalId,
      userMessage: createUserMessageDocument({
        text: null,
        nonContentPart: { type: "goal", goalBrief: args.objectiveBrief },
      }),
    });
    if (!event) {
      throw new Error("Expected an old Goal input fixture");
    }
    return { kind: "inserted", eventId: event.id };
  });
}

/** Seed a retained literal archive and return its inert historical context ID. */
export async function seedGoalForRunFixture(
  runId: string,
  objective: string,
  status: "active" | "paused" | "blocked" | "complete" = "active",
): Promise<{ id: string; chatThreadId: string; objectiveBrief: string }> {
  const [run] = await db()
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: agentRuns.chatThreadId,
      agentId: chatThreads.agentId,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(eq(agentRuns.id, runId));
  const chatThreadId = run?.chatThreadId;
  const agentId = run?.agentId;
  if (!run || !chatThreadId || !agentId) {
    throw new Error(
      "Expected an owned thread run for the historical Goal fixture",
    );
  }
  const id = await seedLiteralGoalArchive(chatThreadId, objective, status);
  return { id, chatThreadId, objectiveBrief: objective };
}

/** Restore actual legacy provenance independently of the current Goal writer. */
export async function setLegacyGoalRunOriginFixture(
  runId: string,
  goalId: string,
  triggerSource: "goal" | "chat" = "goal",
): Promise<void> {
  await db().transaction(async (tx) => {
    const [run] = await tx
      .update(agentRuns)
      .set({ triggerSource })
      .where(eq(agentRuns.id, runId))
      .returning({ threadId: agentRuns.chatThreadId });
    if (!run?.threadId) {
      throw new Error("Expected an owned historical run");
    }
    const output = await insertChatEvent(tx, {
      chatThreadId: run.threadId,
      runId,
      eventType: "output.message",
      content: "Retained Goal run output",
    });
    if (!output) {
      throw new Error("Expected retained Goal output");
    }
    // Current writers never emit Goal context; restore the historical pointer.
    await tx
      .update(chatEvents)
      .set({ contextType: "goal", contextId: goalId })
      .where(eq(chatEvents.id, output.id));
  });
}

/** Read queue source event ids and admitted goal-run ids for route assertions. */
export async function readGoalQueueStateFixture(threadId: string): Promise<{
  readonly eventIds: readonly string[];
  readonly runIds: readonly string[];
}> {
  const [events, runs] = await Promise.all([
    db()
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, threadId),
          eq(chatEvents.eventType, "input.goal"),
        ),
      ),
    db()
      .select({
        id: agentRuns.id,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, threadId),
          eq(agentRuns.triggerSource, "goal"),
        ),
      ),
  ]);
  return {
    eventIds: events.map((event) => {
      return event.id;
    }),
    runIds: runs.map((run) => {
      return run.id;
    }),
  };
}

/** Run the same shared scheduler that follows production goal admission. */
export async function drainChatThreadQueueFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly queueItemCreatedBefore?: Date;
}): Promise<void> {
  await createStore().set(
    drainChatThreadQueueForThread$,
    {
      chatThreadId: args.threadId,
      dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      queueItemCreatedBefore: args.queueItemCreatedBefore,
    },
    args.signal,
  );
}

/** Move one goal trigger before a stale-sweep cutoff. */
export async function setGoalQueueEventCreatedAtFixture(args: {
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
          eq(chatEvents.eventType, "input.goal"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one goal queue event to become historical");
  }
}

/** Retain a close marker beside captured input without invoking a queue drain. */
export async function pauseGoalQueueTargetFixture(
  goalId: string,
): Promise<void> {
  const [event] = await db()
    .select({ threadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(eq(chatEvents.contextId, goalId));
  if (!event) {
    throw new Error("Expected historical Goal input");
  }
  await db().transaction(async (tx) => {
    await appendHistoricalGoalEvent(tx, {
      chatThreadId: event.threadId,
      eventType: "goal.close",
    });
  });
}

/** Seed retained Goal input beside supported automation input for queue tests. */
export async function createActiveGoalQueueEventFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly objective: string;
  readonly objectiveBrief: string;
}): Promise<{ readonly goalId: string; readonly eventId: string }> {
  const goal = { id: randomUUID() };
  const admission = await admitGoalQueueEventFixture({
    threadId: args.threadId,
    goalId: goal.id,
    objectiveBrief: args.objectiveBrief,
  });
  if (admission.kind !== "inserted") {
    throw new Error("Expected the goal fixture event to be inserted");
  }
  return { goalId: goal.id, eventId: admission.eventId };
}

async function appendHistoricalGoalEvent(
  tx: Tx,
  event: {
    readonly chatThreadId: string;
    readonly eventType: "goal.open" | "goal.close" | "input.goal";
    readonly content?: string | null;
    readonly runId?: string | null;
    readonly contextType?: "goal";
    readonly runGroupId?: string;
    readonly userMessage?: ReturnType<typeof createUserMessageDocument>;
  },
) {
  const thread = {
    seqId: await reserveFixtureChatEventSequence(tx, event.chatThreadId, 1),
  };
  if (!thread) {
    throw new Error("Missing historical fixture thread");
  }
  const [row] = await tx
    .insert(chatEvents)
    .values({
      chatThreadId: event.chatThreadId,
      eventType: event.eventType,
      runId: event.runId,
      contextType: event.contextType,
      contextId: event.runGroupId,
      payload: event.userMessage
        ? { userMessage: event.userMessage }
        : event.content === null || event.content === undefined
          ? null
          : { content: event.content },
      seqId: thread.seqId,
    })
    .returning({ id: chatEvents.id });
  return row;
}

export async function setHistoricalGoalStatusFixture(
  runId: string,
  status: "active" | "paused" | "blocked" | "complete",
): Promise<void> {
  const [run] = await db()
    .select({ threadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  if (!run?.threadId) {
    throw new Error("Missing historical fixture run");
  }
  await seedLiteralGoalArchive(
    run.threadId,
    "Retained historical status",
    status,
  );
}

/** Read inert archived status, never a current lifecycle record. */
export async function historicalGoalStatusFixture(
  runId: string,
): Promise<string | undefined> {
  const rows = await db()
    .select({ payload: chatEvents.payload })
    .from(chatEvents)
    .innerJoin(agentRuns, eq(agentRuns.chatThreadId, chatEvents.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, runId),
        eq(chatEvents.eventType, "output.message"),
        sql`${chatEvents.payload}->>'content' LIKE 'Okou Goal retired.%'`,
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(1);
  const content = rows[0]?.payload?.content;
  return typeof content === "string"
    ? /Original recorded status: (active|paused|blocked|complete)\n/u.exec(
        content,
      )?.[1]
    : undefined;
}
