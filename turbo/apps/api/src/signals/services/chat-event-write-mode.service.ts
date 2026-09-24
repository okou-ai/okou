import { chatEventWriteControl } from "@okouai/db/schema/chat-event-write-control";
import { eq } from "drizzle-orm";
import type { ApiDb } from "../../lib/db-types";

export interface ChatEventWriteOptions {
  /** Capture once at an operation boundary and pass through dependent writes. */
  readonly splitWrites: boolean;
}

/** The expansion migration seeds the singleton before API promotion. */
export async function isSplitChatEventWriteEnabled(
  db: Pick<ApiDb, "select">,
): Promise<boolean> {
  const [control] = await db
    .select({ activatedAt: chatEventWriteControl.activatedAt })
    .from(chatEventWriteControl)
    .where(eq(chatEventWriteControl.id, "global"));
  if (!control) {
    throw new Error("Chat event write control singleton is missing");
  }
  return control.activatedAt !== null;
}
