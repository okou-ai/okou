import { command } from "ccstate";
import { and, desc, eq, isNull } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import {
  chatEmailContext,
  emailChannelMessages,
  emailChatThreadRoutes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

export interface EmailRunSource {
  readonly chatThreadId: string;
  readonly userLinkId: string;
  readonly emailAddress: string;
  readonly routeId: string;
  readonly subject: string;
  readonly messageId: string;
  readonly references: readonly string[];
}

export const emailRunSource$ = command(
  async (
    { get, set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ) => {
    const [destination] = await get(db$)
      .select({
        chatThreadId: chatEmailContext.chatThreadId,
        userLinkId: emailUserLinks.id,
        emailAddress: emailUserLinks.emailAddress,
        routeId: emailChatThreadRoutes.id,
        subject: emailChannelMessages.subject,
        messageId: emailChannelMessages.messageId,
        references: emailChannelMessages.references,
      })
      .from(agentRuns)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          eq(chatEvents.contextType, "email"),
        ),
      )
      .innerJoin(
        chatEmailContext,
        and(
          eq(chatEmailContext.id, chatEvents.contextId),
          eq(chatEmailContext.chatThreadId, agentRuns.chatThreadId),
        ),
      )
      .innerJoin(
        emailChannelMessages,
        eq(emailChannelMessages.id, chatEmailContext.emailMessageId),
      )
      .innerJoin(
        emailChatThreadRoutes,
        and(
          eq(emailChatThreadRoutes.id, emailChannelMessages.routeId),
          eq(emailChatThreadRoutes.chatThreadId, agentRuns.chatThreadId),
        ),
      )
      .innerJoin(
        emailUserLinks,
        and(
          eq(emailUserLinks.id, chatEmailContext.userLinkId),
          eq(emailUserLinks.id, emailChatThreadRoutes.userLinkId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          eq(emailUserLinks.userId, args.userId),
          eq(emailUserLinks.orgId, args.orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      )
      .orderBy(desc(chatEvents.seqId))
      .limit(1);
    signal.throwIfAborted();
    if (!destination) {
      return null;
    }
    const user = await findClerkUser(get(clerk$), args.userId, signal);
    signal.throwIfAborted();
    if (!user || user.banned) {
      return null;
    }
    const role = await set(
      getMemberRoleAndUpdateCache$,
      args.orgId,
      args.userId,
      signal,
    );
    signal.throwIfAborted();
    return role.kind === "member" ? destination : null;
  },
);
