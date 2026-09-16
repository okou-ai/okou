import { randomUUID } from "node:crypto";

import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatEventSearchMessages,
  chatEventSearchMessageWatermarks,
} from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { chatSearchIndexText } from "../lib/chat-search-bigram";
import { nowDate } from "../lib/time";
import {
  insertChatEvent,
  replaceChatEvent,
} from "../signals/services/chat-event.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";

interface ChatEventSearchProjectionRowsFixture {
  readonly indexedSeqId: number | null;
  readonly messages: readonly {
    readonly seqId: number;
    readonly runId: string | null;
    readonly role: "user" | "assistant";
    readonly text: string;
  }[];
}

interface ChatEventSearchProjectionFixture extends ChatEventSearchProjectionRowsFixture {
  readonly lastChatEventSeqId: number;
}

function chatEventSearchMessageFixture(args: {
  readonly chatThreadId: string;
  readonly seqId: number;
  readonly text: string;
}) {
  return {
    chatThreadId: args.chatThreadId,
    seqId: args.seqId,
    runId: null,
    userId: `test-user-${args.chatThreadId}`,
    orgId: `test-org-${args.chatThreadId}`,
    agentId: null,
    role: "user" as const,
    createdAt: nowDate(),
    text: args.text,
    textBigram: chatSearchIndexText(args.text),
  };
}

export async function insertOrphanedChatEventSearchProjectionFixture(args: {
  readonly chatThreadId: string;
  readonly text: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.insert(chatEventSearchMessages).values(
      chatEventSearchMessageFixture({
        chatThreadId: args.chatThreadId,
        seqId: 1,
        text: args.text,
      }),
    );
    await tx.insert(chatEventSearchMessageWatermarks).values({
      chatThreadId: args.chatThreadId,
      indexedSeqId: 1,
    });
  });
}

/**
 * Performs the projector's message-then-watermark write order in one real
 * transaction so cleanup tests can place both operations around a row lock.
 */
export async function writeChatEventSearchProjectionFixture(args: {
  readonly chatThreadId: string;
  readonly text: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.insert(chatEventSearchMessages).values(
      chatEventSearchMessageFixture({
        chatThreadId: args.chatThreadId,
        seqId: 2,
        text: args.text,
      }),
    );
    await tx
      .insert(chatEventSearchMessageWatermarks)
      .values({
        chatThreadId: args.chatThreadId,
        indexedSeqId: 2,
      })
      .onConflictDoUpdate({
        target: chatEventSearchMessageWatermarks.chatThreadId,
        set: {
          indexedSeqId: sql`GREATEST(${chatEventSearchMessageWatermarks.indexedSeqId}, EXCLUDED.indexed_seq_id)`,
        },
      });
  });
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

export async function removeChatEventSearchProjectionRowsFixture(
  chatThreadId: string,
): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .delete(chatEventSearchMessageWatermarks)
      .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId));
    await tx
      .delete(chatEventSearchMessages)
      .where(eq(chatEventSearchMessages.chatThreadId, chatThreadId));
  });
}

export async function readChatEventSearchProjectionRowsFixture(
  chatThreadId: string,
): Promise<ChatEventSearchProjectionRowsFixture> {
  const [watermark] = await db()
    .select({ indexedSeqId: chatEventSearchMessageWatermarks.indexedSeqId })
    .from(chatEventSearchMessageWatermarks)
    .where(eq(chatEventSearchMessageWatermarks.chatThreadId, chatThreadId))
    .limit(1);
  const messages = await db()
    .select({
      seqId: chatEventSearchMessages.seqId,
      runId: chatEventSearchMessages.runId,
      role: chatEventSearchMessages.role,
      text: chatEventSearchMessages.text,
    })
    .from(chatEventSearchMessages)
    .where(eq(chatEventSearchMessages.chatThreadId, chatThreadId))
    .orderBy(asc(chatEventSearchMessages.seqId));
  return {
    indexedSeqId: watermark?.indexedSeqId ?? null,
    messages,
  };
}

export async function readChatEventSearchProjectionFixture(
  chatThreadId: string,
): Promise<ChatEventSearchProjectionFixture> {
  const [thread] = await db()
    .select({ lastChatEventSeqId: chatThreads.lastChatEventSeqId })
    .from(chatThreads)
    .where(eq(chatThreads.id, chatThreadId))
    .limit(1);
  if (!thread) {
    throw new Error("Expected chat search projection fixture thread");
  }
  const projection =
    await readChatEventSearchProjectionRowsFixture(chatThreadId);
  return {
    lastChatEventSeqId: thread.lastChatEventSeqId,
    ...projection,
  };
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
 * Changes source-thread ownership and agent metadata after projection so a
 * reader test can prove those fields are not reloaded from chat_threads.
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
