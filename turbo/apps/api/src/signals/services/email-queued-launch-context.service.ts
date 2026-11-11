import { command, computed, type Computed } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import {
  chatEmailContext,
  emailChannelMessages,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { db$ } from "../external/db";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import type { EmailDeliveryTarget } from "./email-chat-callback-payload";
import { buildEmailPrompt } from "./email-prompt";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export const loadEmailQueuedLaunchMaterial$ = command(
  async (
    { get },
    args: {
      readonly eventId: string;
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
  ) => {
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.EmailIntegration,
        args.featureSwitchContext,
      )
    ) {
      return null;
    }
    const [row] = await get(db$)
      .select({
        messageText: chatEmailContext.messageText,
        emailMessageId: chatEmailContext.emailMessageId,
        userLinkId: emailUserLinks.id,
        agentId: agents.id,
        emailAddress: emailUserLinks.emailAddress,
        subject: emailChannelMessages.subject,
        messageId: emailChannelMessages.messageId,
        inReplyTo: emailChannelMessages.inReplyTo,
        references: emailChannelMessages.references,
        chatThreadId: chatEmailContext.chatThreadId,
      })
      .from(chatEvents)
      .innerJoin(
        chatEmailContext,
        and(
          eq(chatEmailContext.id, chatEvents.contextId),
          eq(chatEmailContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        emailChannelMessages,
        eq(emailChannelMessages.id, chatEmailContext.emailMessageId),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatEvents.chatThreadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .innerJoin(
        emailUserLinks,
        and(
          eq(emailUserLinks.id, chatEmailContext.userLinkId),
          eq(emailUserLinks.userId, args.userId),
          eq(emailUserLinks.orgId, args.orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "email"),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      prompt: row.messageText,
      emailSource: {
        emailAddress: row.emailAddress,
        messageId: row.messageId,
        messageText: row.messageText,
      },
      appendSystemPrompt: buildEmailPrompt(
        row,
        resolveIntegrationNotePrompt({
          triggerSource: "email",
          featureSwitchContext: args.featureSwitchContext,
        }),
      ),
      emailDelivery: {
        emailMessageId: row.emailMessageId,
        userLinkId: row.userLinkId,
        agentId: row.agentId,
      } satisfies EmailDeliveryTarget,
      userInfoExtras: {},
    };
  },
);

export function createEmailThreadContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "email") {
      return null;
    }
    if (!event.contextId) {
      throw new Error("Email input is missing its canonical context identity");
    }
    const db = get(db$);
    const [row] = await db
      .select({
        messageText: chatEmailContext.messageText,
        emailMessageId: chatEmailContext.emailMessageId,
        userLinkId: emailUserLinks.id,
        agentId: agents.id,
        emailAddress: emailUserLinks.emailAddress,
        subject: emailChannelMessages.subject,
        messageId: emailChannelMessages.messageId,
        inReplyTo: emailChannelMessages.inReplyTo,
        references: emailChannelMessages.references,
        chatThreadId: chatEmailContext.chatThreadId,
      })
      .from(chatEmailContext)
      .innerJoin(
        emailUserLinks,
        and(
          eq(emailUserLinks.id, chatEmailContext.userLinkId),
          eq(emailUserLinks.userId, event.userId),
          eq(emailUserLinks.orgId, orgId),
          isNull(emailUserLinks.disconnectedAt),
        ),
      )
      .innerJoin(
        emailChannelMessages,
        eq(emailChannelMessages.id, chatEmailContext.emailMessageId),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatEmailContext.chatThreadId),
          eq(chatThreads.userId, event.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, orgId)),
      )
      .where(
        and(
          eq(chatEmailContext.id, event.contextId),
          eq(chatEmailContext.chatThreadId, event.chatThreadId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}
