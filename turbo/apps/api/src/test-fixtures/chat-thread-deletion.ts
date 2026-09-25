import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

/**
 * Deletes the thread root without running route side effects. Production APIs
 * cannot pause after the durable delete but before browser cleanup, so this
 * fixture constructs that crash window for reconciler coverage.
 */
export async function deleteChatThreadRootFixture(
  chatThreadId: string,
): Promise<void> {
  await db().delete(chatThreads).where(eq(chatThreads.id, chatThreadId));
}
