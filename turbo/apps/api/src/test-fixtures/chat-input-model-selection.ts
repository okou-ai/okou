import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";

/**
 * Rewrite a queued input's recorded model selection, standing in for an input
 * enqueued before its model was retired.
 */
export async function setQueuedInputModelSelectionFixture(
  eventId: string,
  modelSelection: ChatInputModelSelection,
): Promise<void> {
  const [updated] = await db()
    .update(chatEvents)
    .set({ modelSelection })
    .where(eq(chatEvents.id, eventId))
    .returning({ id: chatEvents.id });
  if (!updated) {
    throw new Error("Expected a queued chat input to rewrite");
  }
}
