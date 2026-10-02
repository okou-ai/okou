import { randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { chatSearchIndexText } from "../lib/chat-search-bigram";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../signals/services/chat-event.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";

export async function insertSearchableMessageBatchFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly keyword: string;
  readonly count: number;
  readonly startAt: Date;
  readonly startSeqId?: number;
}): Promise<void> {
  await db()
    .insert(chatEventSearchMessages)
    .values(
      Array.from({ length: args.count }, (_, index) => {
        const text = `${args.keyword} ${index}`;
        return {
          chatThreadId: args.chatThreadId,
          seqId: (args.startSeqId ?? 1) + index,
          runId: null,
          userId: args.userId,
          orgId: args.orgId,
          agentId: args.agentId,
          role: "user" as const,
          createdAt: new Date(args.startAt.getTime() + index * 1000),
          text,
          textBigram: chatSearchIndexText(text),
        };
      }),
    );
}

/**
 * Removes canonical parents while leaving their derived search rows behind.
 * The product deletion path removes both under one lock and the projector now
 * conflicts with it, so this is the only way to reconstruct the orphans left by
 * rows written before that fence or by an older producer.
 */
export async function removeChatSearchParentThreadsFixture(
  chatThreadIds: readonly string[],
): Promise<void> {
  const deleted = await db()
    .delete(chatThreads)
    .where(inArray(chatThreads.id, [...chatThreadIds]))
    .returning({ id: chatThreads.id });
  if (deleted.length !== chatThreadIds.length) {
    throw new Error("Expected every chat search parent thread to be removed");
  }
}

export async function insertChatSearchProjectionCoverageFixture(args: {
  readonly chatThreadId: string;
  readonly promptText: string;
  readonly assistantText: string;
  readonly errorText: string;
  readonly terminalText: string;
}): Promise<{
  readonly prompt: { readonly id: string; readonly seqId: number };
  readonly assistant: { readonly id: string; readonly seqId: number };
  readonly assistantRunId: string;
}> {
  const assistantRunId = randomUUID();
  const messages = await db().transaction(async (tx) => {
    const prompt = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.prompt",
      contextType: "web",
      userMessage: createUserMessageDocument({ text: args.promptText }),
      runId: null,
    });
    const assistant = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.message",
      content: args.assistantText,
      runId: assistantRunId,
    });
    if (!prompt || !assistant) {
      throw new Error("Expected chat search coverage messages");
    }
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.message",
      content: "   ",
      runId: randomUUID(),
    });
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "output.error",
      content: args.errorText,
      error: args.errorText,
      runId: randomUUID(),
    });
    await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "run.completed",
      content: args.terminalText,
      runId: randomUUID(),
    });
    return { prompt, assistant };
  });
  return { ...messages, assistantRunId };
}

/**
 * Simulates retention after the durable projection has caught up. Product APIs
 * cannot delete append-only source events, so the fixture removes only rows
 * owned by the test's unique threads while preserving the search projection.
 */
export async function removeChatSearchSourceEventsFixture(
  chatThreadIds: readonly string[],
): Promise<number> {
  const removed = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .delete(chatEvents)
      .where(inArray(chatEvents.chatThreadId, [...chatThreadIds]))
      .returning({ id: chatEvents.id });
  });
  return removed.length;
}

/**
 * Moves one thread to another user and Agent. No production writer updates
 * either column, so this models the change a future ownership transfer would
 * persist: a reader test proves the stored labels are not reloaded from
 * chat_threads, and a projector test proves authority is re-derived instead.
 */
export async function updateChatSearchSourceThreadFixture(args: {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({
      userId: args.userId,
      agentId: args.agentId,
    })
    .where(eq(chatThreads.id, args.chatThreadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat search source thread to update");
  }
}

export async function renameChatSearchAgentFixture(args: {
  readonly agentId: string;
  readonly name: string;
}): Promise<void> {
  const updated = await db()
    .update(agents)
    .set({ name: args.name })
    .where(eq(agents.id, args.agentId))
    .returning({ id: agents.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat search agent to rename");
  }
}

/**
 * Timestamp precision infrastructure: public event writes use server time and
 * cannot choose PostgreSQL microseconds, and the live JS projector normalizes
 * dates to milliseconds. Historical SQL-produced projection rows can retain six
 * digits. Set one already-projected event's stored timestamps to prove MCP reads
 * and paginates that database precision without depending on a specific writer.
 */
export async function setChatSearchEventTimestampPrecisionFixture(args: {
  readonly eventId: string;
  readonly createdAt: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const [event] = await tx
      .update(chatEvents)
      .set({ createdAt: sql`${args.createdAt}::timestamp` })
      .where(eq(chatEvents.id, args.eventId))
      .returning({
        threadId: chatEvents.chatThreadId,
        seqId: chatEvents.seqId,
      });
    if (!event) {
      throw new Error("Expected one owned event timestamp to change");
    }
    const changed = await tx
      .update(chatEventSearchMessages)
      .set({ createdAt: sql`${args.createdAt}::timestamp` })
      .where(
        and(
          eq(chatEventSearchMessages.chatThreadId, event.threadId),
          eq(chatEventSearchMessages.seqId, event.seqId),
        ),
      )
      .returning({ seqId: chatEventSearchMessages.seqId });
    if (changed.length !== 1) {
      throw new Error("Expected one owned projection timestamp to change");
    }
  });
}

export async function insertSearchablePromptFixture(args: {
  readonly chatThreadId: string;
  readonly text: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const inserted = await db().transaction(async (tx) => {
    return await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.prompt",
      contextType: "web",
      userMessage: createUserMessageDocument({ text: args.text }),
      runId: null,
    });
  });
  if (!inserted) {
    throw new Error("Expected searchable prompt fixture event");
  }
  return inserted;
}

export async function rejectSearchablePromptFixture(args: {
  readonly chatThreadId: string;
  readonly eventId: string;
  readonly text: string;
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const inserted = await db().transaction(async (tx) => {
    return await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({ text: args.text }),
      runId: null,
      error: "Rejected by the chat search projection fixture",
    });
  });
  if (!inserted) {
    throw new Error("Expected rejected searchable prompt fixture event");
  }
  return inserted;
}
