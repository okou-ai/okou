import { and, eq, isNotNull } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { runOwnedChatEventForRunCondition } from "./chat-event-type.service";

export async function publishArtifactsChangedForRun(
  writeDb: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [runThread] = await writeDb
    .select({
      chatThreadId: agentRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(agentRuns.chatThreadId, chatThreads.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  signal.throwIfAborted();

  if (runThread?.chatThreadId) {
    await publishUserSignal(
      [runThread.userId],
      `chatThreadArtifactsChanged:${runThread.chatThreadId}`,
    );
    signal.throwIfAborted();
    return;
  }

  const [messageThread] = await writeDb
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
}
