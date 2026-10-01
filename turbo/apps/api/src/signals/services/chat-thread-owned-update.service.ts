import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";

type ChatThreadEventFields = Omit<
  Parameters<typeof chatThreadEventInsertSql>[0],
  "userId" | "orgId" | "chatThreadId" | "agentId"
>;

interface UpdatedChatThread {
  readonly id: string;
  readonly agentId: string;
  readonly cloudBrowserEnabled: boolean;
}

/** One conditional single-row UPDATE of the caller's thread, then its sidebar
 * event as a separate statement. False when no owned thread matched. A repeated
 * request still appends an event so optimistic client events settle.
 */
export async function updateOwnedChatThreadWithEvent(
  writeDb: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly set: Partial<typeof chatThreads.$inferInsert>;
    readonly where?: SQL;
    readonly event: (thread: UpdatedChatThread) => ChatThreadEventFields;
  },
): Promise<boolean> {
  const [thread] = await writeDb
    .update(chatThreads)
    .set(args.set)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
        chatThreadOrganizationCondition(writeDb, args.orgId),
        isNotNull(chatThreads.agentId),
        args.where,
      ),
    )
    .returning({
      id: chatThreads.id,
      agentId: chatThreads.agentId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    });
  if (!thread?.agentId) {
    return false;
  }
  const updated = { ...thread, agentId: thread.agentId };
  await writeDb.execute(
    chatThreadEventInsertSql({
      ...args.event(updated),
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: updated.id,
      agentId: updated.agentId,
    }),
  );
  return true;
}
