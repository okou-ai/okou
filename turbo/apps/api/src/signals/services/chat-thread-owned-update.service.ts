import { command } from "ccstate";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";

type ChatThreadEventFields = Omit<
  Parameters<typeof chatThreadEventInsertSql>[0],
  "userId" | "orgId" | "chatThreadId" | "agentId"
>;

/** A repeated owned UPDATE still appends the client's event so it can settle. */
export const updateOwnedChatThreadWithEvent$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly threadId: string;
      readonly set: Partial<typeof chatThreads.$inferInsert>;
      readonly where?: SQL;
      readonly event: ChatThreadEventFields;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const database = set(writeDb$);
    const [thread] = await database
      .update(chatThreads)
      .set(args.set)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
          chatThreadOrganizationCondition(args.orgId),
          isNotNull(chatThreads.agentId),
          args.where,
        ),
      )
      .returning({
        id: chatThreads.id,
        agentId: chatThreads.agentId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
      });
    signal.throwIfAborted();
    if (!thread?.agentId) {
      return false;
    }
    await database.execute(
      chatThreadEventInsertSql({
        ...args.event,
        ...(args.event.kind === "computer_use_host_updated"
          ? { cloudBrowserEnabled: thread.cloudBrowserEnabled }
          : {}),
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
      }),
    );
    signal.throwIfAborted();
    return true;
  },
);
