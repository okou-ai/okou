import { randomUUID } from "node:crypto";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "../lib/db";
import { nowDate } from "../lib/time";
import { reserveFixtureChatEventSequence } from "./chat-event-sequences";

/**
 * Public Agent deletion cascades the thread, so only a persisted-state fixture
 * can represent an existing queued thread whose nullable agent was lost.
 */
export async function clearQueuedChatThreadAgentFixture(
  chatThreadId: string,
): Promise<void> {
  const rows = await db()
    .update(chatThreads)
    .set({ agentId: null })
    .where(eq(chatThreads.id, chatThreadId))
    .returning({ id: chatThreads.id });
  if (rows.length !== 1) {
    throw new Error("Expected one queued thread to lose its agent");
  }
}

/**
 * Current writers always attach automation routing. Preserve an ingress-created
 * input's immutable history while representing older inconsistent routing with
 * a new replacement row. The prompt assembler sees this automation head but
 * cannot load it as a prompt and returns not-ready.
 */
export async function appendUnroutableAutomationInputFixture(
  eventId: string,
): Promise<string> {
  return await db().transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, eventId),
          eq(chatEvents.eventType, "input.automation"),
          isNull(chatEvents.runId),
        ),
      );
    if (!source) {
      throw new Error("Expected one pending automation input");
    }
    const id = randomUUID();
    await tx.insert(chatEvents).values({
      id,
      chatThreadId: source.chatThreadId,
      eventType: "input.automation",
      contextType: "web",
      contextId: null,
      payload: source.payload,
      runId: null,
      revokesEventId: source.id,
      seqId: await reserveFixtureChatEventSequence(tx, source.chatThreadId, 1),
      createdAt: new Date(
        Math.max(nowDate().getTime(), source.createdAt.getTime() + 1),
      ),
    });
    return id;
  });
}
