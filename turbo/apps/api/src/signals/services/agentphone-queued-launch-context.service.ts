import { db$ } from "../external/db";
import { whatsappUserLinks } from "@okouai/db/schema/whatsapp";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, exists, ne, or } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { command, computed } from "ccstate";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import { buildAgentPhonePrompt } from "./agentphone-prompt";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export interface AgentPhoneQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly agentphoneDelivery: AgentPhoneDeliveryTarget;
  readonly userInfoExtras: {
    readonly agentphoneHandle: string;
  };
}

type AgentPhoneLaunchContextRow = Pick<
  typeof chatAgentphoneContext.$inferSelect,
  | "messageText"
  | "threadContext"
  | "messageId"
  | "rootMessageId"
  | "conversationId"
  | "groupId"
  | "channel"
  | "isGroup"
  | "phoneHandle"
  | "fromNumber"
  | "toNumber"
  | "userLinkId"
  | "agentphoneAgentId"
> & {};

function requiredAgentPhoneLaunchContext(
  row: AgentPhoneLaunchContextRow | undefined,
) {
  if (
    !row ||
    row.messageText === null ||
    row.threadContext === null ||
    row.messageId === null ||
    row.rootMessageId === null ||
    row.channel === null ||
    row.isGroup === null ||
    row.phoneHandle === null ||
    row.fromNumber === null ||
    row.toNumber === null ||
    row.userLinkId === null ||
    row.agentphoneAgentId === null
  ) {
    return null;
  }
  return {
    ...row,
    messageText: row.messageText,
    threadContext: row.threadContext,
    messageId: row.messageId,
    rootMessageId: row.rootMessageId,
    channel: row.channel,
    isGroup: row.isGroup,
    phoneHandle: row.phoneHandle,
    fromNumber: row.fromNumber,
    toNumber: row.toNumber,
    userLinkId: row.userLinkId,
    agentphoneAgentId: row.agentphoneAgentId,
  };
}

interface AgentPhoneLaunchSource {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly contextId?: string;
}

export type AgentPhoneThreadContext = ReturnType<
  typeof requiredAgentPhoneLaunchContext
>;

export function createAgentPhoneLaunchContext(args: AgentPhoneLaunchSource) {
  return computed(async (get): Promise<AgentPhoneThreadContext> => {
    const db = get(db$);
    const [row] = await db
      .select({
        messageText: chatAgentphoneContext.messageText,
        threadContext: chatAgentphoneContext.threadContext,
        messageId: chatAgentphoneContext.messageId,
        rootMessageId: chatAgentphoneContext.rootMessageId,
        conversationId: chatAgentphoneContext.conversationId,
        groupId: chatAgentphoneContext.groupId,
        channel: chatAgentphoneContext.channel,
        isGroup: chatAgentphoneContext.isGroup,
        phoneHandle: chatAgentphoneContext.phoneHandle,
        fromNumber: chatAgentphoneContext.fromNumber,
        toNumber: chatAgentphoneContext.toNumber,
        userLinkId: chatAgentphoneContext.userLinkId,
        agentphoneAgentId: chatAgentphoneContext.agentphoneAgentId,
      })
      .from(chatEvents)
      .innerJoin(
        chatAgentphoneContext,
        and(
          eq(chatAgentphoneContext.id, chatEvents.contextId),
          eq(chatAgentphoneContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatEvents.chatThreadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.orgId, args.orgId),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "agentphone"),
          args.contextId === undefined
            ? undefined
            : eq(chatAgentphoneContext.id, args.contextId),
          or(
            and(
              ne(chatAgentphoneContext.channel, "whatsapp"),
              exists(
                db
                  .select({ id: agentphoneUserLinks.id })
                  .from(agentphoneUserLinks)
                  .where(
                    and(
                      eq(
                        agentphoneUserLinks.id,
                        chatAgentphoneContext.userLinkId,
                      ),
                      eq(agentphoneUserLinks.userId, args.userId),
                      eq(agentphoneUserLinks.orgId, args.orgId),
                    ),
                  ),
              ),
            ),
            and(
              eq(chatAgentphoneContext.channel, "whatsapp"),
              exists(
                db
                  .select({ id: whatsappUserLinks.id })
                  .from(whatsappUserLinks)
                  .where(
                    and(
                      eq(
                        whatsappUserLinks.id,
                        chatAgentphoneContext.userLinkId,
                      ),
                      eq(whatsappUserLinks.userId, args.userId),
                      eq(whatsappUserLinks.orgId, args.orgId),
                    ),
                  ),
              ),
            ),
          ),
        ),
      )
      .limit(1);
    return requiredAgentPhoneLaunchContext(row);
  });
}

function agentphoneDeliveryFromContext(
  context: NonNullable<AgentPhoneThreadContext>,
) {
  return agentphoneDeliveryTargetSchema.parse({
    messageId: context.messageId,
    conversationId: context.conversationId,
    ...(context.isGroup ? { groupId: context.groupId } : {}),
    channel: context.channel,
    isGroup: context.isGroup,
    rootMessageId: context.rootMessageId,
    phoneHandle: context.phoneHandle,
    fromNumber: context.fromNumber,
    toNumber: context.toNumber,
    userLinkId: context.userLinkId,
    agentphoneAgentId: context.agentphoneAgentId,
  });
}

export function createAgentPhoneQueuedDelivery(args: AgentPhoneLaunchSource) {
  const context$ = createAgentPhoneLaunchContext(args);
  return computed(async (get) => {
    const context = await get(context$);
    return context ? agentphoneDeliveryFromContext(context) : null;
  });
}

export const loadAgentPhoneQueuedLaunchMaterial$ = command(
  async (
    { get },
    args: AgentPhoneLaunchSource & {
      readonly featureSwitchContext: FeatureSwitchContext;
    },
  ): Promise<AgentPhoneQueuedLaunchMaterial | null> => {
    const context = await get(createAgentPhoneLaunchContext(args));
    if (!context) {
      return null;
    }
    return {
      prompt: context.messageText,
      appendSystemPrompt: agentphoneSystemPromptFromContext(
        context,
        args.featureSwitchContext,
      ),
      agentphoneDelivery: agentphoneDeliveryFromContext(context),
      userInfoExtras: { agentphoneHandle: context.phoneHandle },
    };
  },
);

export function agentphoneSystemPromptFromContext(
  context: NonNullable<AgentPhoneThreadContext>,
  featureSwitchContext: FeatureSwitchContext,
) {
  return buildAgentPhonePrompt(
    {
      sharedNumber: optionalEnv("AGENTPHONE_PHONE_NUMBER") ?? "",
      phoneHandle: context.phoneHandle,
      conversationId: context.conversationId,
      groupId: context.groupId,
      channel: context.channel,
      isGroup: context.isGroup,
      messageId: context.messageId,
      agentphoneAgentId: context.agentphoneAgentId,
    },
    resolveIntegrationNotePrompt({
      triggerSource: "agentphone",
      agentPhoneChannel: context.channel,
      featureSwitchContext,
    }),
    context.threadContext,
  );
}
