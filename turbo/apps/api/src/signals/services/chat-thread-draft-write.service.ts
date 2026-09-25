import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { eq, sql } from "drizzle-orm";

import type { ApiDb, Tx } from "../../lib/db-types";

export interface ChatThreadDraftWrite {
  readonly chatThreadId: string;
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
}

/**
 * Upserts the thread's `chat_thread_drafts` row for one draft write.
 *
 * This function performs no ownership check of its own: the caller runs it in
 * the same transaction as its owned-row legacy `UPDATE` and rolls both back
 * when that `UPDATE` matches nothing. The row it writes is deleted with the
 * thread by the table's `ON DELETE CASCADE`.
 *
 * A clear writes null draft values into a retained row instead of deleting it.
 * `persistAgentDraft` deletes its row on clear and that is safe there, because
 * `agent_drafts` is already the only store for an Agent composer draft. Here a
 * missing row is what the later read cutover will treat as "fall back to
 * `chat_threads`", so deleting on clear would hand a user back the draft they
 * had just cleared.
 *
 * `updated_at` uses the database clock so the stored value always belongs to
 * the transaction that wrote it, and `created_at` keeps the default from the
 * first write that touched the thread.
 *
 * Draft PATCH keeps its child-before-parent write order. Send-coupled clears
 * use the separate existing-row-only helper below after acquiring an
 * authorized parent FOR UPDATE lock before any weaker row lock.
 */
export async function persistChatThreadDraftRow(
  tx: Tx,
  draft: ChatThreadDraftWrite,
): Promise<void> {
  await tx
    .insert(chatThreadDrafts)
    .values({
      chatThreadId: draft.chatThreadId,
      draftUserMessage: draft.draftUserMessage,
      draftAttachments: draft.draftAttachments,
    })
    .onConflictDoUpdate({
      target: chatThreadDrafts.chatThreadId,
      set: {
        draftUserMessage: draft.draftUserMessage,
        draftAttachments: draft.draftAttachments,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Clear a child row only after the caller's authorized parent UPDATE matched.
 * Send transactions must never use the PATCH upsert above. A missing child is
 * a normal no-op; retaining an existing row and its created_at prevents a
 * later legacy fallback from reviving it.
 */
export async function clearExistingChatThreadDraftRow(
  tx: ApiDb | Tx,
  chatThreadId: string,
): Promise<void> {
  await tx
    .update(chatThreadDrafts)
    .set({
      draftUserMessage: null,
      draftAttachments: null,
      updatedAt: sql`now()`,
    })
    .where(eq(chatThreadDrafts.chatThreadId, chatThreadId));
}
