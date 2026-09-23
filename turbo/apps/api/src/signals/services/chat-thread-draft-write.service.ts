import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";

export interface ChatThreadDraftWrite {
  readonly chatThreadId: string;
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
}

/**
 * Upserts the thread's `chat_thread_drafts` row for one admitted draft write.
 *
 * The caller must already be inside {@link withChatThreadContentWrite}, which
 * has resolved the thread's canonical identity, admitted its erasure subjects
 * and taken the thread's `FOR KEY SHARE` lock. This function therefore performs
 * no ownership check of its own: the thread id it is given is the one the fence
 * revalidated, and the row it writes is deleted with the thread by the
 * table's `ON DELETE CASCADE`.
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
 * The draft `PATCH` is the only writer here during this phase. The message-send
 * paths in `chat-events.command.ts` still clear the legacy columns alone: they
 * update the thread row first, to authorize the send and reserve its event
 * sequence in one statement, so adding a child write after it would take the
 * two row locks in the opposite order from this one and deadlock against a
 * concurrent draft save. Converting them belongs with the read cutover, which
 * is the point at which a stale child row would become visible.
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
