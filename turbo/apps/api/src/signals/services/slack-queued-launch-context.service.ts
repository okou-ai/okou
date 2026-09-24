import { z } from "zod";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { isSlackDirectMessageSessionThreadTs } from "./slack-chat-ingress.service";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, isNull, or } from "drizzle-orm";

import { buildSlackSystemPrompt } from "../../lib/slack-webhook-context";
import type { Db } from "../external/db";
import {
  type QueuedLaunchContextArgs,
  warnMissingQueuedLaunchEnrichment,
} from "./queued-launch-enrichment.service";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export interface SlackQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly publicBrand: PublicBrand;
  readonly slackDelivery: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly userInfoExtras?: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
}

type SlackLaunchContextRow = Pick<
  typeof chatSlackContext.$inferSelect,
  | "channelId"
  | "botUserId"
  | "conversationContext"
  | "messageText"
  | "messageFiles"
  | "messageAssets"
  | "mentionDisplayNames"
  | "senderDisplayName"
  | "senderUserId"
  | "channelType"
  | "threadTs"
  | "routeThreadTs"
> & { readonly publicBrand: PublicBrand };

function requiredSlackLaunchContext(row: SlackLaunchContextRow | undefined) {
  if (
    !row ||
    row.channelId === null ||
    row.botUserId === null ||
    row.channelType === null ||
    row.threadTs === null
  ) {
    return null;
  }
  return {
    ...row,
    enrichmentMissing:
      row.conversationContext === null ||
      row.messageText === null ||
      row.messageFiles === null ||
      row.messageAssets === null ||
      row.mentionDisplayNames === null,
    channelId: row.channelId,
    botUserId: row.botUserId,
    conversationContext: row.conversationContext ?? "",
    messageText: row.messageText,
    messageFiles: row.messageFiles ?? [],
    messageAssets: row.messageAssets ?? [],
    mentionDisplayNames: row.mentionDisplayNames ?? {},
    channelType: row.channelType,
    threadTs: row.threadTs,
  };
}

async function loadSlackLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      channelId: chatSlackContext.channelId,
      botUserId: chatSlackContext.botUserId,
      conversationContext: chatSlackContext.conversationContext,
      messageText: chatSlackContext.messageText,
      messageFiles: chatSlackContext.messageFiles,
      messageAssets: chatSlackContext.messageAssets,
      mentionDisplayNames: chatSlackContext.mentionDisplayNames,
      senderDisplayName: chatSlackContext.senderDisplayName,
      senderUserId: chatSlackContext.senderUserId,
      channelType: chatSlackContext.channelType,
      threadTs: chatSlackContext.threadTs,
      routeThreadTs: chatSlackContext.routeThreadTs,
      publicBrand: chatSlackContext.publicBrand,
    })
    .from(chatEvents)
    .innerJoin(
      chatSlackContext,
      and(
        eq(chatSlackContext.id, chatEvents.contextId),
        eq(chatSlackContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      slackChatThreadRoutes,
      and(
        eq(slackChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(slackChatThreadRoutes.channelId, chatSlackContext.channelId),
        or(
          and(
            isNull(chatSlackContext.routeThreadTs),
            eq(slackChatThreadRoutes.threadTs, chatSlackContext.threadTs),
          ),
          eq(slackChatThreadRoutes.threadTs, chatSlackContext.routeThreadTs),
        ),
        eq(slackChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
        eq(slackOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgInstallations,
      and(
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
        eq(slackOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "slack"),
      ),
    )
    .limit(1);
  return requiredSlackLaunchContext(row);
}

const slackIngressRoutingSchema = z.object({
  team_id: z.string(),
  event: z.object({
    channel: z.string(),
    user: z.string(),
    text: z.string(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    channel_type: z.string().optional(),
  }),
});

function preserveSlackMentionIdentities(
  canonicalPrompt: string,
  originalMessageText: string,
): string {
  const originalText = originalMessageText.trim();
  if (!/<@\w+>/.test(originalText)) {
    return canonicalPrompt;
  }
  // Normalize only explicit ID-bearing display mentions, then compare all
  // original literal text. Incidental "(U123)" labels cannot prove identity.
  // Keep raw <@ID> mentions intact, including mixed resolved/unresolved names.
  const normalizedPrompt = canonicalPrompt.replace(
    /(?<!<)@[^@\r\n]*? \((\w+)\)/g,
    "<@$1>",
  );
  if (
    canonicalPrompt === originalText ||
    canonicalPrompt.endsWith(`\n\n${originalText}`) ||
    normalizedPrompt === originalText ||
    normalizedPrompt.endsWith(`\n\n${originalText}`)
  ) {
    return canonicalPrompt;
  }
  // Older canonical inputs stored display names without IDs. Keep their
  // canonical text/files and recover exact mention positions from the scoped
  // original message; same-named Slack users cannot be disambiguated by name.
  // Remove after old writers/rollback targets and their retained queued inputs
  // have drained, independently of split-write activation.
  return `${canonicalPrompt}\n\n[Original Slack message with user IDs]\n${originalMessageText}`;
}

async function loadSlackRouteLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<SlackQueuedLaunchMaterial | null> {
  const [route] = await db
    .select({
      channelId: slackChatThreadRoutes.channelId,
      routeThreadTs: slackChatThreadRoutes.threadTs,
      publicBrand: slackChatIngress.publicBrand,
      payload: slackChatIngress.payload,
      slackUserId: slackOrgConnections.slackUserId,
      workspaceId: slackOrgInstallations.slackWorkspaceId,
    })
    .from(chatEvents)
    .innerJoin(slackChatIngress, eq(slackChatIngress.id, chatEvents.contextId))
    .innerJoin(
      slackChatThreadRoutes,
      and(
        eq(slackChatThreadRoutes.id, slackChatIngress.routeId),
        eq(slackChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(slackChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgConnections,
      and(
        eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
        eq(slackOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      slackOrgInstallations,
      and(
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
        eq(slackOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "slack"),
      ),
    )
    .limit(1);
  if (!route) {
    return null;
  }
  const payload = slackIngressRoutingSchema.parse(
    JSON.parse(route.payload) as unknown,
  );
  const event = payload.event;
  const threadTs = event.thread_ts ?? event.ts;
  const directSession =
    event.channel_type === "im" &&
    !event.thread_ts &&
    isSlackDirectMessageSessionThreadTs(route.routeThreadTs);
  if (
    payload.team_id !== route.workspaceId ||
    event.user !== route.slackUserId ||
    event.channel !== route.channelId ||
    (!directSession && threadTs !== route.routeThreadTs)
  ) {
    return null;
  }
  warnMissingQueuedLaunchEnrichment("slack", args);
  return {
    prompt: preserveSlackMentionIdentities(
      args.userMessageProjection.agentPrompt,
      event.text,
    ),
    appendSystemPrompt: "",
    publicBrand: route.publicBrand,
    slackDelivery: {
      channelId: route.channelId,
      threadTs,
      ...(threadTs === route.routeThreadTs
        ? {}
        : { routeThreadTs: route.routeThreadTs }),
    },
    userInfoExtras: { slackUserId: route.slackUserId },
  };
}

export async function loadSlackQueuedLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<SlackQueuedLaunchMaterial | null> {
  const context = await loadSlackLaunchContext(db, args);
  if (!context) {
    return loadSlackRouteLaunchMaterial(db, args);
  }
  if (context.enrichmentMissing) {
    warnMissingQueuedLaunchEnrichment("slack", args);
  }

  // A retained context can still authorize delivery without optional original
  // text. Recover historical mention IDs from scoped ingress when available;
  // its absence cannot invalidate this context's independently checked route.
  const prompt =
    context.messageText === null
      ? ((await loadSlackRouteLaunchMaterial(db, args))?.prompt ??
        args.userMessageProjection.agentPrompt)
      : preserveSlackMentionIdentities(
          args.userMessageProjection.agentPrompt,
          context.messageText,
        );

  return {
    prompt,
    appendSystemPrompt: context.enrichmentMissing
      ? ""
      : buildSlackSystemPrompt({
          botUserId: context.botUserId,
          channelId: context.channelId,
          channelType: context.channelType,
          threadTs: context.threadTs,
          integrationNote: resolveIntegrationNotePrompt({
            triggerSource: "slack",
            featureSwitchContext: args.featureSwitchContext,
          }),
          executionContext: context.conversationContext,
        }),
    publicBrand: context.publicBrand,
    slackDelivery: {
      channelId: context.channelId,
      threadTs: context.threadTs,
      ...(context.routeThreadTs
        ? { routeThreadTs: context.routeThreadTs }
        : {}),
    },
    userInfoExtras:
      context.senderDisplayName || context.senderUserId
        ? {
            ...(context.senderDisplayName
              ? { slackDisplayName: context.senderDisplayName }
              : {}),
            ...(context.senderUserId
              ? { slackUserId: context.senderUserId }
              : {}),
          }
        : undefined,
  };
}
