import type { ConditionalComposerDraft } from "@okouai/api-contracts/contracts/composer-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { chatThreadDrafts } from "@okouai/db/schema/chat-thread-draft";
import { command } from "ccstate";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

function matchesDraft(
  columns: { draftUserMessage: AnyPgColumn; draftAttachments: AnyPgColumn },
  expected: ConditionalComposerDraft["expected"],
) {
  return and(
    expected.draftUserMessage === null
      ? isNull(columns.draftUserMessage)
      : eq(columns.draftUserMessage, expected.draftUserMessage),
    expected.draftAttachments === null
      ? isNull(columns.draftAttachments)
      : eq(columns.draftAttachments, expected.draftAttachments),
  );
}

function expectsAbsent({ expected }: ConditionalComposerDraft): boolean {
  return (
    expected.draftUserMessage === null && expected.draftAttachments === null
  );
}

export const replaceAgentDraft$ = command(
  async (
    { set },
    scope: { userId: string; orgId: string; agentId: string },
    replacement: ConditionalComposerDraft,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const key = and(
      eq(agentDrafts.userId, scope.userId),
      eq(agentDrafts.orgId, scope.orgId),
      eq(agentDrafts.agentId, scope.agentId),
    );
    const expected = matchesDraft(agentDrafts, replacement.expected);
    const document = replacement.draft.draftUserMessage;
    if (document === null) {
      // An empty-to-empty request only confirms the primary value. It must not
      // delete content written by a competing client after that observation.
      if (expectsAbsent(replacement)) {
        const divergent = await db
          .select({ userId: agentDrafts.userId })
          .from(agentDrafts)
          .where(
            and(
              key,
              or(
                isNotNull(agentDrafts.draftUserMessage),
                isNotNull(agentDrafts.draftAttachments),
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        return divergent.length === 0;
      }
      const removed = await db
        .delete(agentDrafts)
        .where(and(key, expected))
        .returning({ userId: agentDrafts.userId });
      signal.throwIfAborted();
      return removed.length > 0;
    }
    const value = {
      draftUserMessage: document,
      draftAttachments: replacement.draft.draftAttachments,
      updatedAt: nowDate(),
    };
    if (expectsAbsent(replacement)) {
      const inserted = await db
        .insert(agentDrafts)
        .values({ ...scope, ...value })
        .onConflictDoUpdate({
          target: [agentDrafts.userId, agentDrafts.orgId, agentDrafts.agentId],
          set: value,
          setWhere: expected,
        })
        .returning({ userId: agentDrafts.userId });
      signal.throwIfAborted();
      return inserted.length > 0;
    }
    // UPDATE, not upsert: deletion of a previously observed nonempty draft is
    // a conflict, never permission to resurrect it.
    const updated = await db
      .update(agentDrafts)
      .set(value)
      .where(and(key, expected))
      .returning({ userId: agentDrafts.userId });
    signal.throwIfAborted();
    return updated.length > 0;
  },
);

export const replaceThreadDraft$ = command(
  async (
    { set },
    scope: { userId: string; threadId: string },
    replacement: ConditionalComposerDraft,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const key = and(
      eq(chatThreadDrafts.userId, scope.userId),
      eq(chatThreadDrafts.chatThreadId, scope.threadId),
    );
    const expected = matchesDraft(chatThreadDrafts, replacement.expected);
    const document = replacement.draft.draftUserMessage;
    if (document === null) {
      if (expectsAbsent(replacement)) {
        const divergent = await db
          .select({ userId: chatThreadDrafts.userId })
          .from(chatThreadDrafts)
          .where(key)
          .limit(1);
        signal.throwIfAborted();
        return divergent.length === 0;
      }
      const removed = await db
        .delete(chatThreadDrafts)
        .where(and(key, expected))
        .returning({ userId: chatThreadDrafts.userId });
      signal.throwIfAborted();
      return removed.length > 0;
    }
    const value = {
      draftUserMessage: document,
      draftAttachments: replacement.draft.draftAttachments,
      updatedAt: sql`now()`,
    };
    if (expectsAbsent(replacement)) {
      const inserted = await db
        .insert(chatThreadDrafts)
        .values({
          chatThreadId: scope.threadId,
          userId: scope.userId,
          ...value,
        })
        // Every stored thread draft has a non-null document. Any existing row
        // therefore conflicts with the expected absent value.
        .onConflictDoNothing({
          target: [chatThreadDrafts.chatThreadId, chatThreadDrafts.userId],
        })
        .returning({ userId: chatThreadDrafts.userId });
      signal.throwIfAborted();
      return inserted.length > 0;
    }
    const updated = await db
      .update(chatThreadDrafts)
      .set(value)
      .where(and(key, expected))
      .returning({ userId: chatThreadDrafts.userId });
    signal.throwIfAborted();
    return updated.length > 0;
  },
);
