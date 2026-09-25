import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { eq, sql } from "drizzle-orm";

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
 * The caller has already read the thread's owner outside any transaction. The
 * statement runs on its own: the only lock it takes on `chat_threads` is the
 * foreign key's `FOR KEY SHARE` check, held for this one statement. A thread
 * deleted after that read fails the foreign key, and the caller reports it as
 * missing.
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
    await deleteChatThreadDraft(db, draft.chatThreadId);
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
      target: chatThreadDrafts.chatThreadId,
      set: {
        userId: draft.userId,
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
