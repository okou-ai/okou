import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";

interface ChatThreadDraftWrite {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
}

/**
 * Saves or clears one thread's composer draft in a single statement.
 *
 * The row is keyed by the thread and the caller, so the statement touches no
 * other table and takes no lock on the thread row.
 *
 * A cleared draft deletes the row, the same shape as `agent_drafts`. No reader
 * falls back to the retired `chat_threads` columns, so absence means "no
 * draft".
 */
export async function persistChatThreadDraft(
  db: Db,
  draft: ChatThreadDraftWrite,
): Promise<void> {
  if (draft.draftUserMessage === null) {
    await db
      .delete(chatThreadDrafts)
      .where(
        and(
          eq(chatThreadDrafts.chatThreadId, draft.chatThreadId),
          eq(chatThreadDrafts.userId, draft.userId),
        ),
      );
    return;
  }
  await db
    .insert(chatThreadDrafts)
    .values({
      chatThreadId: draft.chatThreadId,
      userId: draft.userId,
      draftUserMessage: draft.draftUserMessage,
      draftAttachments: draft.draftAttachments,
    })
    .onConflictDoUpdate({
      target: [chatThreadDrafts.chatThreadId, chatThreadDrafts.userId],
      set: {
        draftUserMessage: draft.draftUserMessage,
        draftAttachments: draft.draftAttachments,
        updatedAt: sql`now()`,
      },
    });
}

/** Removes a thread's saved draft; a thread without one is a no-op. */
export async function deleteChatThreadDraft(
  db: Db,
  chatThreadId: string,
): Promise<void> {
  await db
    .delete(chatThreadDrafts)
    .where(eq(chatThreadDrafts.chatThreadId, chatThreadId));
}
