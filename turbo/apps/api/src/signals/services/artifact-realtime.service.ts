import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { db$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";

export const publishArtifactsChangedForRun$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<void> => {
    const db = get(db$);
    const [fileThread] = await db
      .select({
        chatThreadId: chatThreads.id,
        userId: chatThreads.userId,
      })
      .from(runUploadedFiles)
      .innerJoin(chatThreads, eq(runUploadedFiles.chatThreadId, chatThreads.id))
      .where(eq(runUploadedFiles.runId, runId))
      .limit(1);
    signal.throwIfAborted();

    if (fileThread) {
      await publishUserSignal(
        [fileThread.userId],
        `chatThreadArtifactsChanged:${fileThread.chatThreadId}`,
      );
      signal.throwIfAborted();
      return;
    }

    const [messageThread] = await db
      .select({
        chatThreadId: chatEvents.chatThreadId,
        userId: chatThreads.userId,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatEvents.chatThreadId, chatThreads.id))
      .where(runOwnedChatEventForRunCondition({ runId }))
      .limit(1);
    signal.throwIfAborted();

    if (messageThread) {
      await publishUserSignal(
        [messageThread.userId],
        `chatThreadArtifactsChanged:${messageThread.chatThreadId}`,
      );
      signal.throwIfAborted();
    }
  },
);
