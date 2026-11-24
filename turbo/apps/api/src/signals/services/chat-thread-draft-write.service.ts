import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import type { SuggestionPreset } from "@okouai/api-contracts/validators/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { and, eq, inArray, sql } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { repairUserMessageText } from "./chat-user-message.service";

interface ChatThreadDraftWrite {
  readonly legacyMemberDraft?: boolean;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly draftUserMessage: UserMessageInputDocument | null;
  readonly suggestionPreset?: SuggestionPreset;
  readonly draftAttachments: ChatThreadDraftAttachments | null;
}

export const persistChatThreadDraft$ = command(
  async (
    { set },
    draft: ChatThreadDraftWrite,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const scopedThread = and(
      eq(chatThreads.id, draft.chatThreadId),
      draft.legacyMemberDraft
        ? undefined
        : eq(chatThreads.userId, draft.userId),
      chatThreadOrganizationPredicate(draft.orgId),
    );
    if (draft.draftUserMessage === null) {
      // Clearing an already empty draft succeeds as long as the parent exists.
      const parent = db
        .$with("draft_parent")
        .as(
          db
            .select({ id: chatThreads.id })
            .from(chatThreads)
            .where(scopedThread),
        );
      const cleared = db.$with("cleared_draft").as(
        db
          .delete(chatThreadDrafts)
          .where(
            and(
              eq(chatThreadDrafts.userId, draft.userId),
              inArray(
                chatThreadDrafts.chatThreadId,
                db.select({ id: parent.id }).from(parent),
              ),
            ),
          )
          .returning({ id: chatThreadDrafts.chatThreadId }),
      );
      const rows = await db
        .with(parent, cleared)
        .select({ id: parent.id })
        .from(parent);
      signal.throwIfAborted();
      return rows.length > 0;
    }
    const document = repairUserMessageText(draft.draftUserMessage);
    const draftUserMessage: ChatThreadDraftUserMessage = draft.suggestionPreset
      ? {
          version: 1,
          parts: [
            ...document.parts,
            { type: "suggestion_preset", preset: draft.suggestionPreset },
          ],
        }
      : document;
    const rows = await db
      .insert(chatThreadDrafts)
      .select(
        db
          .select({
            chatThreadId: chatThreads.id,
            userId: sql`${draft.userId}::text`
              .mapWith(chatThreadDrafts.userId)
              .as("user_id"),
            draftUserMessage:
              sql`${sql.param(draftUserMessage, chatThreadDrafts.draftUserMessage)}::jsonb`
                .mapWith(chatThreadDrafts.draftUserMessage)
                .as("draft_user_message"),
            draftAttachments:
              sql`${sql.param(draft.draftAttachments, chatThreadDrafts.draftAttachments)}::jsonb`
                .mapWith(chatThreadDrafts.draftAttachments)
                .as("draft_attachments"),
            createdAt: sql`now()`
              .mapWith(chatThreadDrafts.createdAt)
              .as("created_at"),
            updatedAt: sql`now()`
              .mapWith(chatThreadDrafts.updatedAt)
              .as("updated_at"),
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
      })
      .returning({ id: chatThreadDrafts.chatThreadId });
    signal.throwIfAborted();
    return rows.length > 0;
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
