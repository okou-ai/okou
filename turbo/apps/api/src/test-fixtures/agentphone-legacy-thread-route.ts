import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";

/**
 * Before Release 7, a user's integration preference could route a conversation
 * to a non-default agent. Current APIs cannot create that historical route. The
 * thread and its prior run are created through chat/runner APIs; this fixture
 * supplies only the retired producer's route after its key migration.
 */
export async function bindLegacyAgentPhoneThreadFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly conversationId?: string;
}): Promise<void> {
  const database = db();
  const [link] = await database
    .select({ id: agentphoneUserLinks.id })
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.orgId, args.orgId),
        eq(agentphoneUserLinks.userId, args.userId),
      ),
    )
    .limit(1);
  if (!link) {
    throw new Error("Expected a linked AgentPhone identity");
  }
  await database.insert(agentphoneChatThreadRoutes).values({
    agentphoneUserLinkId: link.id,
    rootMessageId: args.conversationId
      ? `group:${args.conversationId}`
      : "direct-message:main",
    conversationId: args.conversationId,
    chatThreadId: args.chatThreadId,
  });
}
