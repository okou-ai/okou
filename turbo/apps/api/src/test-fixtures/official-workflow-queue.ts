import { randomUUID } from "node:crypto";

import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { eq, sql } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import { revokeChatEvent } from "../signals/services/chat-event.service";

export async function readOfficialWorkflowQueueInputFixture(eventId: string) {
  const [row] = await db()
    .select()
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId));
  if (!row || row.eventType !== "input.prompt" || row.runId !== null) {
    throw new Error("Expected an immutable runless Official queue source");
  }
  return row;
}

/**
 * Production writers cannot produce historical-brand, canonical or corrupt
 * queue encodings. Append a test-owned persisted input and revoke the original;
 * never update an immutable event or relax its storage constraints.
 */
export async function appendOfficialWorkflowQueueInputFixture(args: {
  readonly eventId: string;
  readonly contextId: string;
  readonly contextType: NonNullable<
    (typeof chatEvents.$inferSelect)["contextType"]
  >;
  readonly claim: readonly string[] | null;
  readonly userMessage: UserMessageDocument;
}) {
  const source = await readOfficialWorkflowQueueInputFixture(args.eventId);
  return await db().transaction(async (tx) => {
    const revoked = await revokeChatEvent(tx, source.id, {
      chatThreadId: source.chatThreadId,
      eventType: "control.revoke",
    });
    if (!revoked) {
      throw new Error("Official queue fixture source was already revoked");
    }
    const [thread] = await tx
      .update(chatThreads)
      .set({ lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + 1` })
      .where(eq(chatThreads.id, source.chatThreadId))
      .returning({ seqId: chatThreads.lastChatEventSeqId });
    if (!thread) {
      throw new Error("Official queue fixture thread is missing");
    }
    const [row] = await tx
      .insert(chatEvents)
      .values({
        id: randomUUID(),
        chatThreadId: source.chatThreadId,
        eventType: "input.prompt",
        contextType: args.contextType,
        contextId: args.contextId,
        requiredOfficialWorkflowIds: args.claim,
        payload: { userMessage: args.userMessage },
        seqId: thread.seqId,
        createdAt: new Date(
          Math.max(nowDate().getTime(), revoked.createdAt.getTime() + 1),
        ),
      })
      .returning();
    if (!row) {
      throw new Error("Official queue fixture was not inserted");
    }
    return row;
  });
}
