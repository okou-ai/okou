import { chatEventWriteControl } from "@okouai/db/schema/chat-event-write-control";
import { eq } from "drizzle-orm";
import type { ApiDb } from "../../lib/db-types";

export interface ChatEventWriteOptions {
  /** Capture once at an operation boundary and pass through dependent writes. */
  readonly splitWrites: boolean;
}

/** Missing control data is legacy mode; activation is an irreversible DB decision. */
export async function isSplitChatEventWriteEnabled(
  db: Pick<ApiDb, "select">,
): Promise<boolean> {
  const [control] = await db
    .select({ activatedAt: chatEventWriteControl.activatedAt })
    .from(chatEventWriteControl)
    .where(eq(chatEventWriteControl.id, "global"));
  return control?.activatedAt !== null && control?.activatedAt !== undefined;
}
