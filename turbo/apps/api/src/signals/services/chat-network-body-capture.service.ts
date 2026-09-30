import { chatNetworkBodyCaptures } from "@okouai/db/schema/chat-network-body-capture";
import type { Tx } from "../../lib/db-types";

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
