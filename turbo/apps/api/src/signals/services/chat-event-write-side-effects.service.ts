import { and, eq } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { Db } from "../external/db";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import { clearExistingChatThreadDraftRow } from "./chat-thread-draft-write.service";
import { settleIncludingAbort } from "../utils";
import { logger } from "../../lib/log";

const L = logger("ChatEventWrite");

/** The event already committed; an auxiliary failure must not reject that send. */
export async function attemptChatEventSideEffect(
  operation: string,
  chatThreadId: string,
  work: () => Promise<unknown>,
): Promise<void> {
  const startedAt = performance.now();
  const result = await settleIncludingAbort(work());
  const timing = {
    operation,
    chatThreadId,
    durationMs: performance.now() - startedAt,
  };
  if (result.ok) {
    L.debug("Chat event auxiliary write completed", timing);
    if (timing.durationMs >= 250) {
      L.warn("Chat event auxiliary write exceeded 250 ms", timing);
    }
  } else {
    L.error("Chat event auxiliary write failed", {
      ...timing,
      error: result.error,
    });
  }
}

export async function clearThreadDraftIndependently(
  db: Db,
  params: {
    readonly threadId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<void> {
  await attemptChatEventSideEffect(
    "clear_legacy_draft",
    params.threadId,
    async () => {
      await db
        .update(chatThreads)
        .set({ draftUserMessage: null, draftAttachments: null })
        .where(
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.userId, params.userId),
            chatThreadOrganizationCondition(db, params.orgId),
          ),
        );
    },
  );
  await attemptChatEventSideEffect(
    "clear_child_draft",
    params.threadId,
    async () => {
      const [thread] = await db
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, params.threadId),
            eq(chatThreads.userId, params.userId),
            chatThreadOrganizationCondition(db, params.orgId),
          ),
        )
        .limit(1);
      if (thread) {
        await clearExistingChatThreadDraftRow(db, thread.id);
      }
    },
  );
}
