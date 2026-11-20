import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { and, eq, exists, sql } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { repairUserMessageText } from "./chat-user-message.service";

interface ChatThreadDraftWrite {
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly draftUserMessage: ChatThreadDraftUserMessage | null;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
}

export const persistChatThreadDraft$ = command(
  async (
    { set },
    draft: ChatThreadDraftWrite,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const scopedThread = and(
      eq(chatThreads.id, draft.chatThreadId),
      chatThreadOrganizationPredicate(draft.orgId),
    );
    if (draft.draftUserMessage === null) {
      await db
        .delete(chatThreadDrafts)
        .where(
          and(
            eq(chatThreadDrafts.chatThreadId, draft.chatThreadId),
            eq(chatThreadDrafts.userId, draft.userId),
            exists(
              db
                .select({ id: chatThreads.id })
                .from(chatThreads)
                .where(scopedThread),
            ),
          ),
        );
      signal.throwIfAborted();
      return;
    }
    const draftUserMessage = repairUserMessageText(draft.draftUserMessage);
    await db
      .insert(chatThreadDrafts)
      .select(
        db
          .select({
            chatThreadId: chatThreads.id,
            userId: sql`${draft.userId}::text`.as("user_id"),
            draftUserMessage:
              sql`${sql.param(draftUserMessage, chatThreadDrafts.draftUserMessage)}::jsonb`.as(
                "draft_user_message",
              ),
            draftAttachments:
              sql`${sql.param(draft.draftAttachments, chatThreadDrafts.draftAttachments)}::jsonb`.as(
                "draft_attachments",
              ),
            createdAt: sql`now()`.as("created_at"),
            updatedAt: sql`now()`.as("updated_at"),
          })
          .from(chatThreads)
          .where(scopedThread),
      )
      .onConflictDoUpdate({
        target: [chatThreadDrafts.chatThreadId, chatThreadDrafts.userId],
        set: {
          draftUserMessage,
          draftAttachments: draft.draftAttachments,
          updatedAt: sql`now()`,
        },
      });
    signal.throwIfAborted();
  },
);

/** Removes a thread's saved draft; a thread without one is a no-op. */
export const deleteChatThreadDraft$ = command(
  async ({ set }, chatThreadId: string, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await set(writeDb$)
      .delete(chatThreadDrafts)
      .where(eq(chatThreadDrafts.chatThreadId, chatThreadId));
    signal.throwIfAborted();
  },
);
