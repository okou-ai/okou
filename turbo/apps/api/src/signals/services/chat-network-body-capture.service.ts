import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import { eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";

/** Record that the run for this chat input captures network bodies. */
export async function recordChatNetworkBodyCapture(
  tx: Tx,
  args: { readonly chatEventId: string; readonly chatThreadId: string },
): Promise<void> {
  await tx
    .insert(chatNetworkBodyCaptures)
    .values(args)
    .onConflictDoNothing({ target: chatNetworkBodyCaptures.chatEventId });
}

/** Whether the send of this chat input asked its run to capture bodies. */
export async function chatNetworkBodyCaptureRequested(
  db: Pick<Db, "select">,
  chatEventId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ chatEventId: chatNetworkBodyCaptures.chatEventId })
    .from(chatNetworkBodyCaptures)
    .where(eq(chatNetworkBodyCaptures.chatEventId, chatEventId))
    .limit(1);
  return row !== undefined;
}
