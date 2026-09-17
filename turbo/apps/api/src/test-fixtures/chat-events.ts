import { createHash, randomUUID } from "node:crypto";

import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ChatEventPayload } from "@okouai/db/jsonb-contracts/chat-event";
import type { ChatFeishuMessageFiles } from "@okouai/db/jsonb-contracts/chat-feishu-context";
import type {
  ChatSlackMentionDisplayNames,
  ChatSlackMessageAssets,
  ChatSlackMessageFiles,
} from "@okouai/db/jsonb-contracts/chat-slack-context";
import type { ChatTeamsMessageFiles } from "@okouai/db/jsonb-contracts/chat-teams-context";
import type { JsonObject } from "@okouai/db/jsonb-contracts/shared";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { blobs } from "@okouai/db/schema/blob";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { conversations } from "@okouai/db/schema/conversation";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgEvents } from "@okouai/db/schema/feishu-org-event";
import { githubChatThreadRoutes } from "@okouai/db/schema/github-chat-thread-route";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { runOutputMaterializations } from "@okouai/db/schema/run-output-materialization";
import { runOutputMemoryCitations } from "@okouai/db/schema/run-output-memory-citation";
import { usageEvent } from "@okouai/db/schema/usage-event";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";
import { Pool } from "pg";

import { closeDbPool, db } from "../lib/db";
import { executeRawRows } from "../lib/db-raw-rows";
import type { Tx } from "../lib/db-types";
import { nowDate } from "../lib/time";
import {
  acquireBuiltInModelKeyFixture,
  releaseBuiltInModelKeyFixture,
} from "../signals/services/built-in-model-key-fixture";
import { canonicalChatEventUserMessage } from "../signals/services/canonical-chat-event-read.service";
import { createChatEventSourcePart } from "../signals/services/chat-event-annotation.service";
import { visibleChatEventCondition } from "../signals/services/chat-event-shared.service";
import {
  chatInputPromptDispatchCondition,
  runOwnedChatEventForRunCondition,
} from "../signals/services/chat-event-type.service";
import {
  insertChatEvent,
  insertChatEvents,
  replaceChatEvent,
} from "../signals/services/chat-event.service";
import { createUserMessageDocument } from "../signals/services/chat-user-message.service";
import { buildFeishuChatOpenUrl } from "../signals/services/feishu-config";
import { createDeferredPromise, onRejection } from "../signals/utils";

/**
 * BDD-scoped built-in model key prefixes. Fixture acquisition below only
 * accepts keys carrying one of these prefixes.
 */
const BDD_BUILT_IN_MODEL_KEY_PREFIXES = [
  "built-in-key-bdd-fake-",
  "built-in-key-bdd-dev-seed-",
] as const;
const databasePidRowSchema = z.object({ pid: z.int() });
const waiterCountRowSchema = z.object({ waiterCount: z.int() });
const blockedByPidRowSchema = z.object({ blocked: z.boolean() });
const blockedQueryRowSchema = z.object({ query: z.string() });

type ChatThreadBlockedStatementKind =
  | "select_for_key_share"
  | "select_for_update"
  | "update"
  | "other";

interface ChatEventContextFixture {
  readonly id: string;
  readonly revokesEventId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly automationId: string | null;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly automationEventType: string | null;
  readonly automationEventPayload: JsonObject | null;
  readonly automationPublicBrand: PublicBrand | null;
  readonly slackChannelId: string | null;
  readonly slackMessageTs: string | null;
  readonly slackBotUserId: string | null;
  readonly slackPublicBrand: PublicBrand | null;
  readonly slackConversationContext: string | null;
  readonly slackMessageText: string | null;
  readonly slackMessageFiles: ChatSlackMessageFiles | null;
  readonly slackMessageAssets: ChatSlackMessageAssets | null;
  readonly slackMentionDisplayNames: ChatSlackMentionDisplayNames | null;
  readonly slackSenderDisplayName: string | null;
  readonly slackSenderUserId: string | null;
  readonly slackChannelType: "channel" | "dm" | "group_dm" | null;
  readonly slackThreadTs: string | null;
  readonly slackRouteThreadTs: string | null;
  readonly feishuConversationHistory: string | null;
  readonly feishuPublicBrand: PublicBrand | null;
  readonly feishuMessageText: string | null;
  readonly feishuMessageFiles: ChatFeishuMessageFiles | null;
  readonly feishuChatType: "group" | "p2p" | "topic_group" | null;
  readonly feishuChatId: string | null;
  readonly feishuMessageId: string | null;
  readonly feishuThreadId: string | null;
  readonly feishuReplyInThread: boolean | null;
  readonly feishuReactionId: string | null;
  readonly feishuSenderOpenId: string | null;
  readonly feishuConnectionId: string | null;
  readonly feishuInstallationId: string | null;
  readonly teamsTenantId: string | null;
  readonly teamsTeamId: string | null;
  readonly teamsChannelId: string | null;
  readonly teamsConversationId: string | null;
  readonly teamsConversationType: string | null;
  readonly teamsActivityId: string | null;
  readonly teamsThreadContext: string | null;
  readonly teamsMessageText: string | null;
  readonly teamsMessageFiles: ChatTeamsMessageFiles | null;
  readonly teamsTenantName: string | null;
  readonly teamsTeamName: string | null;
  readonly teamsThreadId: string | null;
  readonly teamsServiceUrl: string | null;
  readonly teamsAppId: string | null;
  readonly teamsPublicBrand: PublicBrand | null;
  readonly teamsSenderUserId: string | null;
  readonly teamsSenderDisplayName: string | null;
  readonly teamsSenderPrincipalName: string | null;
  readonly teamsConnectionId: string | null;
  readonly agentphoneChatThreadId: string | null;
  readonly agentphoneMessageText: string | null;
  readonly agentphoneThreadContext: string | null;
  readonly agentphoneMessageId: string | null;
  readonly agentphoneRootMessageId: string | null;
  readonly agentphoneConversationId: string | null;
  readonly agentphoneChannel: "imessage" | "sms" | "mms" | null;
  readonly agentphoneIsGroup: boolean | null;
  readonly agentphonePhoneHandle: string | null;
  readonly agentphoneFromNumber: string | null;
  readonly agentphoneToNumber: string | null;
  readonly agentphoneUserLinkId: string | null;
  readonly agentphoneAgentId: string | null;
  readonly telegramChatId: string | null;
  readonly telegramMessageId: string | null;
  readonly telegramMessageThreadId: number | null;
  readonly telegramMessageText: string | null;
  readonly telegramThreadContext: string | null;
  readonly telegramRootMessageId: string | null;
  readonly telegramThinkingMessageId: string | null;
  readonly telegramPublicBrand: PublicBrand | null;
  readonly telegramUserLinkId: string | null;
  readonly telegramUserLinkKind: "custom" | "official" | null;
  readonly telegramChatType: string | null;
  readonly telegramSenderUserId: string | null;
  readonly telegramSenderDisplayName: string | null;
  readonly telegramSenderUsername: string | null;
  readonly telegramSenderLanguage: string | null;
  readonly githubRepo: string | null;
  readonly githubSubjectNumber: number | null;
  readonly githubSubjectKind: "issue" | "pull_request" | null;
  readonly githubTriggerCommentId: string | null;
  readonly githubIssueContext: string | null;
  readonly githubMessageText: string | null;
  readonly githubTriggerReactionId: string | null;
  readonly githubTriggerCommentBody: string | null;
}

export async function readChatEventContextFixture(
  eventId: string,
): Promise<ChatEventContextFixture | null> {
  const contextId = sql`COALESCE(${chatEvents.contextId}, ${chatEvents.id})`;
  const [event] = await db()
    .select({
      id: chatEvents.id,
      revokesEventId: chatEvents.revokesEventId,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      automationId: chatAutomationContext.automationId,
      triggerBrief: chatAutomationContext.triggerBrief,
      workflowName: chatAutomationContext.workflowName,
      automationEventType: chatAutomationContext.eventType,
      automationEventPayload: chatAutomationContext.eventPayload,
      automationPublicBrand: chatAutomationContext.publicBrand,
      slackChannelId: chatSlackContext.channelId,
      slackMessageTs: chatSlackContext.messageTs,
      slackBotUserId: chatSlackContext.botUserId,
      slackPublicBrand: chatSlackContext.publicBrand,
      slackConversationContext: chatSlackContext.conversationContext,
      slackMessageText: chatSlackContext.messageText,
      slackMessageFiles: chatSlackContext.messageFiles,
      slackMessageAssets: chatSlackContext.messageAssets,
      slackMentionDisplayNames: chatSlackContext.mentionDisplayNames,
      slackSenderDisplayName: chatSlackContext.senderDisplayName,
      slackSenderUserId: chatSlackContext.senderUserId,
      slackChannelType: chatSlackContext.channelType,
      slackThreadTs: chatSlackContext.threadTs,
      slackRouteThreadTs: chatSlackContext.routeThreadTs,
      feishuConversationHistory: chatFeishuContext.conversationHistory,
      feishuPublicBrand: chatFeishuContext.publicBrand,
      feishuMessageText: chatFeishuContext.messageText,
      feishuMessageFiles: chatFeishuContext.messageFiles,
      feishuChatType: chatFeishuContext.chatType,
      feishuChatId: chatFeishuContext.chatId,
      feishuMessageId: chatFeishuContext.messageId,
      feishuThreadId: chatFeishuContext.threadId,
      feishuReplyInThread: chatFeishuContext.replyInThread,
      feishuReactionId: chatFeishuContext.reactionId,
      feishuSenderOpenId: chatFeishuContext.senderOpenId,
      feishuConnectionId: chatFeishuContext.connectionId,
      feishuInstallationId: chatFeishuContext.installationId,
      teamsTenantId: chatTeamsContext.tenantId,
      teamsTeamId: chatTeamsContext.teamId,
      teamsChannelId: chatTeamsContext.channelId,
      teamsConversationId: chatTeamsContext.conversationId,
      teamsConversationType: chatTeamsContext.conversationType,
      teamsActivityId: chatTeamsContext.activityId,
      teamsThreadContext: chatTeamsContext.threadContext,
      teamsMessageText: chatTeamsContext.messageText,
      teamsMessageFiles: chatTeamsContext.messageFiles,
      teamsTenantName: chatTeamsContext.tenantName,
      teamsTeamName: chatTeamsContext.teamName,
      teamsThreadId: chatTeamsContext.threadId,
      teamsServiceUrl: chatTeamsContext.serviceUrl,
      teamsAppId: chatTeamsContext.teamsAppId,
      teamsPublicBrand: chatTeamsContext.publicBrand,
      teamsSenderUserId: chatTeamsContext.senderUserId,
      teamsSenderDisplayName: chatTeamsContext.senderDisplayName,
      teamsSenderPrincipalName: chatTeamsContext.senderPrincipalName,
      teamsConnectionId: chatTeamsContext.connectionId,
      agentphoneChatThreadId: chatAgentphoneContext.chatThreadId,
      agentphoneMessageText: chatAgentphoneContext.messageText,
      agentphoneThreadContext: chatAgentphoneContext.threadContext,
      agentphoneMessageId: chatAgentphoneContext.messageId,
      agentphoneRootMessageId: chatAgentphoneContext.rootMessageId,
      agentphoneConversationId: chatAgentphoneContext.conversationId,
      agentphoneChannel: chatAgentphoneContext.channel,
      agentphoneIsGroup: chatAgentphoneContext.isGroup,
      agentphonePhoneHandle: chatAgentphoneContext.phoneHandle,
      agentphoneFromNumber: chatAgentphoneContext.fromNumber,
      agentphoneToNumber: chatAgentphoneContext.toNumber,
      agentphoneUserLinkId: chatAgentphoneContext.userLinkId,
      agentphoneAgentId: chatAgentphoneContext.agentphoneAgentId,
      telegramChatId: chatTelegramContext.chatId,
      telegramMessageId: chatTelegramContext.messageId,
      telegramMessageThreadId: chatTelegramContext.messageThreadId,
      telegramMessageText: chatTelegramContext.messageText,
      telegramThreadContext: chatTelegramContext.threadContext,
      telegramRootMessageId: chatTelegramContext.rootMessageId,
      telegramThinkingMessageId: chatTelegramContext.thinkingMessageId,
      telegramPublicBrand: chatTelegramContext.publicBrand,
      telegramUserLinkId: chatTelegramContext.userLinkId,
      telegramUserLinkKind: chatTelegramContext.userLinkKind,
      telegramChatType: chatTelegramContext.chatType,
      telegramSenderUserId: chatTelegramContext.senderUserId,
      telegramSenderDisplayName: chatTelegramContext.senderDisplayName,
      telegramSenderUsername: chatTelegramContext.senderUsername,
      telegramSenderLanguage: chatTelegramContext.senderLanguage,
      githubRepo: chatGithubContext.repo,
      githubSubjectNumber: chatGithubContext.subjectNumber,
      githubSubjectKind: chatGithubContext.subjectKind,
      githubTriggerCommentId: chatGithubContext.triggerCommentId,
      githubIssueContext: chatGithubContext.issueContext,
      githubMessageText: chatGithubContext.messageText,
      githubTriggerReactionId: chatGithubContext.triggerReactionId,
      githubTriggerCommentBody: chatGithubContext.triggerCommentBody,
    })
    .from(chatEvents)
    .leftJoin(chatAutomationContext, eq(chatAutomationContext.id, contextId))
    .leftJoin(chatSlackContext, eq(chatSlackContext.id, contextId))
    .leftJoin(chatFeishuContext, eq(chatFeishuContext.id, contextId))
    .leftJoin(chatTeamsContext, eq(chatTeamsContext.id, contextId))
    .leftJoin(chatAgentphoneContext, eq(chatAgentphoneContext.id, contextId))
    .leftJoin(chatTelegramContext, eq(chatTelegramContext.id, contextId))
    .leftJoin(chatGithubContext, eq(chatGithubContext.id, contextId))
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

const annotationProjectionInputs = [
  {
    text: "slack linked",
    messagePermalink: "https://vm0.slack.com/archives/C123/p1753257600000100",
    context: {
      slackContext: {
        channelId: "C123",
        messageTs: "1753257600.000100",
        botUserId: "U_BOT123",
        publicBrand: "vm0",
        conversationContext: "",
        messageText: "slack linked",
        messageFiles: [],
        messageAssets: [],
        mentionDisplayNames: {},
        senderDisplayName: "Slack User",
        senderUserId: "U123",
        channelType: "channel",
        threadTs: "1753257600.000100",
        routeThreadTs: null,
      },
    },
  },
  {
    text: "feishu linked",
    context: {
      feishuContext: {
        conversationHistory: "",
        publicBrand: "vm0",
        messageText: "feishu linked",
        messageFiles: [],
        chatType: "p2p",
        chatId: "oc_123",
        messageId: "om_123",
        threadId: "om_123",
        replyInThread: false,
        reactionId: null,
        senderOpenId: "ou_123",
        connectionId: "00000000-0000-4000-8000-000000000001",
        installationId: "00000000-0000-4000-8000-000000000002",
      },
    },
  },
  {
    text: "teams channel linked",
    context: {
      teamsContext: {
        tenantId: "tenant-1",
        teamId: "team-1",
        channelId: "19:channel@thread.tacv2",
        conversationId: "19:conversation@thread.tacv2",
        conversationType: "channel",
        activityId: "activity-1",
        threadContext: "",
        messageText: "teams channel linked",
        messageFiles: [],
        tenantName: "Tenant One",
        teamName: "Team One",
        threadId: "activity-1",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-1",
        publicBrand: "vm0",
        senderUserId: "29:user-1",
        senderDisplayName: "Ada Lovelace",
        senderPrincipalName: "ada@example.com",
        connectionId: "00000000-0000-4000-8000-000000000003",
      },
    },
  },
  {
    text: "teams personal unlinked",
    context: {
      teamsContext: {
        tenantId: "tenant-1",
        teamId: null,
        channelId: null,
        conversationId: "a:personal-conversation",
        conversationType: "personal",
        activityId: "activity-dm",
        threadContext: "",
        messageText: "teams personal unlinked",
        messageFiles: [],
        tenantName: "Tenant One",
        teamName: null,
        threadId: "direct-message:agent-1:default",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-1",
        publicBrand: "vm0",
        senderUserId: "29:user-1",
        senderDisplayName: null,
        senderPrincipalName: null,
        connectionId: "00000000-0000-4000-8000-000000000003",
      },
    },
  },
  {
    text: "telegram supergroup linked",
    context: {
      telegramContext: {
        chatId: "-1001234567890",
        messageId: "42",
        messageThreadId: 7,
        messageText: "telegram supergroup linked",
        threadContext: "",
        rootMessageId: null,
        thinkingMessageId: null,
        publicBrand: "vm0",
        userLinkId: "00000000-0000-4000-8000-000000000004",
        userLinkKind: "custom",
        chatType: "supergroup",
        senderUserId: "123456789",
        senderDisplayName: "Telegram User",
        senderUsername: "@telegram_user",
        senderLanguage: "en",
      },
    },
  },
  {
    text: "telegram dm unlinked",
    context: {
      telegramContext: {
        chatId: "123456789",
        messageId: "43",
        messageThreadId: null,
        messageText: "telegram dm unlinked",
        threadContext: "",
        rootMessageId: "dm",
        thinkingMessageId: null,
        publicBrand: "vm0",
        userLinkId: "00000000-0000-4000-8000-000000000005",
        userLinkKind: "official",
        chatType: "private",
        senderUserId: "123456789",
        senderDisplayName: null,
        senderUsername: null,
        senderLanguage: null,
      },
    },
  },
  {
    text: "telegram group unlinked",
    context: {
      telegramContext: {
        chatId: "-123456789",
        messageId: "44",
        messageThreadId: null,
        messageText: "telegram group unlinked",
        threadContext: "",
        rootMessageId: null,
        thinkingMessageId: null,
        publicBrand: "vm0",
        userLinkId: "00000000-0000-4000-8000-000000000006",
        userLinkKind: "custom",
        chatType: "group",
        senderUserId: null,
        senderDisplayName: null,
        senderUsername: null,
        senderLanguage: null,
      },
    },
  },
  {
    text: "github issue comment linked",
    context: {
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_218,
        subjectKind: "issue",
        triggerCommentId: "123456",
        issueContext: "",
        messageText: "github issue comment linked",
        triggerReactionId: null,
        triggerCommentBody: null,
        publicBrand: "vm0",
      },
    },
  },
  {
    text: "github pull request linked",
    context: {
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_219,
        subjectKind: "pull_request",
        triggerCommentId: null,
        issueContext: "",
        messageText: "github pull request linked",
        triggerReactionId: null,
        triggerCommentBody: null,
        publicBrand: "vm0",
      },
    },
  },
] as const;

function annotationProjectionSourcePart(
  input: (typeof annotationProjectionInputs)[number],
) {
  if ("messagePermalink" in input) {
    return createChatEventSourcePart({
      kind: "slack",
      messagePermalink: input.messagePermalink,
    });
  }
  if ("feishuContext" in input.context) {
    return createChatEventSourcePart({
      kind: "feishu",
      chatOpenUrl: buildFeishuChatOpenUrl(input.context.feishuContext.chatId),
    });
  }
  if ("teamsContext" in input.context) {
    return createChatEventSourcePart({
      kind: "teams",
      tenantId: input.context.teamsContext.tenantId,
      channelId: input.context.teamsContext.channelId,
      activityId: input.context.teamsContext.activityId,
      conversationId: input.context.teamsContext.conversationId,
      conversationType: input.context.teamsContext.conversationType,
      botId: null,
    });
  }
  if ("telegramContext" in input.context) {
    return createChatEventSourcePart({
      kind: "telegram",
      chatId: input.context.telegramContext.chatId,
      messageId: input.context.telegramContext.messageId,
      isDm: input.context.telegramContext.chatType === "private",
      botUsername: null,
    });
  }
  return createChatEventSourcePart({
    kind: "github",
    repo: input.context.githubContext.repo,
    subjectNumber: input.context.githubContext.subjectNumber,
    subjectKind: input.context.githubContext.subjectKind,
    triggerCommentId: input.context.githubContext.triggerCommentId,
  });
}

export async function seedChatEventAnnotationProjectionFixture(
  chatThreadId: string,
): Promise<{
  readonly claimedPendingId: string;
  readonly rejectedPendingId: string;
}> {
  const claimedPendingId = randomUUID();
  const rejectedPendingId = randomUUID();
  await db().transaction(async (tx) => {
    for (const input of annotationProjectionInputs) {
      await insertChatEvent(tx, {
        chatThreadId,
        eventType: "input.prompt",
        userMessage: createUserMessageDocument({
          text: input.text,
          nonContentPart: annotationProjectionSourcePart(input),
        }),
        runId: null,
        ...input.context,
      });
    }

    await insertChatEvent(tx, {
      id: claimedPendingId,
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "claimed annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "github",
          repo: "vm0-ai/vm0",
          subjectNumber: 24_218,
          subjectKind: "issue",
          triggerCommentId: "654321",
        }),
      }),
      runId: null,
      githubContext: {
        repo: "vm0-ai/vm0",
        subjectNumber: 24_218,
        subjectKind: "issue",
        triggerCommentId: "654321",
        issueContext: "",
        messageText: "claimed annotation",
        triggerReactionId: null,
        triggerCommentBody: null,
        publicBrand: "vm0",
      },
    });
    await replaceChatEvent(tx, claimedPendingId, {
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "claimed annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "github",
          repo: "vm0-ai/vm0",
          subjectNumber: 24_218,
          subjectKind: "issue",
          triggerCommentId: "654321",
        }),
      }),
      runId: randomUUID(),
    });

    await insertChatEvent(tx, {
      id: rejectedPendingId,
      chatThreadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: "rejected annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "teams",
          tenantId: "tenant-2",
          channelId: "19:reject@thread.tacv2",
          activityId: "activity-rejected",
          conversationId: null,
          conversationType: "channel",
          botId: null,
        }),
      }),
      runId: null,
      teamsContext: {
        tenantId: "tenant-2",
        teamId: "team-2",
        channelId: "19:reject@thread.tacv2",
        conversationId: "19:reject-conversation@thread.tacv2",
        conversationType: "channel",
        activityId: "activity-rejected",
        threadContext: "",
        messageText: "rejected annotation",
        messageFiles: [],
        tenantName: "Tenant Two",
        teamName: "Team Two",
        threadId: "activity-rejected",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        teamsAppId: "teams-app-2",
        publicBrand: "vm0",
        senderUserId: "29:user-2",
        senderDisplayName: "Grace Hopper",
        senderPrincipalName: "grace@example.com",
        connectionId: "00000000-0000-4000-8000-000000000004",
      },
    });
    await replaceChatEvent(tx, rejectedPendingId, {
      chatThreadId,
      eventType: "input.rejected",
      userMessage: createUserMessageDocument({
        text: "rejected annotation",
        nonContentPart: createChatEventSourcePart({
          kind: "teams",
          tenantId: "tenant-2",
          channelId: "19:reject@thread.tacv2",
          activityId: "activity-rejected",
          conversationId: null,
          conversationType: "channel",
          botId: null,
        }),
      }),
      runId: null,
      error: "rejected for annotation coverage",
    });
  });
  return { claimedPendingId, rejectedPendingId };
}

async function pendingTelegramEventContext(eventId: string) {
  const [row] = await db()
    .select({
      contextId: chatTelegramContext.id,
    })
    .from(chatEvents)
    .innerJoin(
      chatTelegramContext,
      and(
        eq(chatTelegramContext.id, chatEvents.contextId),
        eq(chatTelegramContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, eventId),
        eq(chatEvents.contextType, "telegram"),
        isNull(chatEvents.runId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Expected pending Telegram launch context");
  }
  return row;
}

export async function setTelegramThinkingMessageIdFixture(
  eventId: string,
  thinkingMessageId: string,
): Promise<void> {
  const event = await pendingTelegramEventContext(eventId);
  await db()
    .update(chatTelegramContext)
    .set({ thinkingMessageId })
    .where(eq(chatTelegramContext.id, event.contextId));
}

export async function clearTelegramPublicBrandFixture(
  eventId: string,
): Promise<void> {
  const event = await pendingTelegramEventContext(eventId);
  await db()
    .update(chatTelegramContext)
    .set({ publicBrand: null })
    .where(eq(chatTelegramContext.id, event.contextId));
}

interface AgentphoneChatEventByPromptFixture {
  readonly eventId: string;
}

interface TelegramChatEventByPromptFixture {
  readonly eventId: string;
}

interface FeishuChatEventByPromptFixture {
  readonly eventId: string;
}

/**
 * Chat events live in a database shared by every parallel test worker, so a
 * prompt lookup must be scoped to the caller's own user. Matching on prompt
 * text alone reads whichever worker's row happens to be there.
 */
async function findOwnedChatEventByPrompt(args: {
  readonly userId: string;
  readonly prompt: string;
  readonly filter: SQL | undefined;
}): Promise<{ readonly eventId: string } | null> {
  const rows = await db()
    .select({
      eventId: chatEvents.id,
      userMessage: canonicalChatEventUserMessage(),
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .where(and(eq(chatThreads.userId, args.userId), args.filter));
  const row = rows.find((candidate) => {
    return candidate.userMessage?.parts.some((part) => {
      return part.type === "text" && part.text === args.prompt;
    });
  });
  return row ?? null;
}

export async function findTelegramChatEventByPromptFixture(args: {
  readonly userId: string;
  readonly prompt: string;
}): Promise<TelegramChatEventByPromptFixture | null> {
  return await findOwnedChatEventByPrompt({
    userId: args.userId,
    prompt: args.prompt,
    filter: and(
      eq(chatEvents.eventType, "input.prompt"),
      eq(chatEvents.contextType, "telegram"),
    ),
  });
}

export async function findFeishuChatEventByPromptFixture(args: {
  readonly userId: string;
  readonly prompt: string;
}): Promise<FeishuChatEventByPromptFixture | null> {
  return await findOwnedChatEventByPrompt({
    userId: args.userId,
    prompt: args.prompt,
    filter: and(
      eq(chatEvents.eventType, "input.prompt"),
      eq(chatEvents.contextType, "feishu"),
    ),
  });
}

/**
 * Simulates the previous API writing a verified Feishu event after the
 * additive public_brand migration but before that writer knew the new column.
 * The current webhook route can then retry the same provider event and exercise
 * the real new-reader compatibility path.
 */
export async function seedLegacyFeishuIngressFixture(args: {
  readonly installationId: string;
  readonly eventId: string;
  readonly payload: string;
  readonly createdAt?: Date;
}): Promise<void> {
  const createdAt = args.createdAt ?? nowDate();
  await db().transaction(async (tx) => {
    await tx.insert(feishuOrgEvents).values({
      installationId: args.installationId,
      eventId: args.eventId,
      receivedAt: createdAt,
    });
    await tx.insert(feishuChatIngress).values({
      installationId: args.installationId,
      eventId: args.eventId,
      payload: args.payload,
      publicBrand: null,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    });
  });
}

export async function findAgentphoneChatEventByPromptFixture(args: {
  readonly userId: string;
  readonly prompt: string;
}): Promise<AgentphoneChatEventByPromptFixture | null> {
  return await findOwnedChatEventByPrompt({
    userId: args.userId,
    prompt: args.prompt,
    filter: and(
      eq(chatEvents.eventType, "input.prompt"),
      eq(chatEvents.contextType, "agentphone"),
    ),
  });
}

export async function findPendingChatEventByPromptFixture(args: {
  readonly userId: string;
  readonly prompt: string;
}): Promise<{ readonly eventId: string } | null> {
  return await findOwnedChatEventByPrompt({
    userId: args.userId,
    prompt: args.prompt,
    filter: isNull(chatEvents.runId),
  });
}

/** Inserts a pending Slack event, then removes the context its claim requires. */
export async function insertQueuedSlackMissingContextFixture(args: {
  readonly threadId: string;
  readonly content: string;
}): Promise<string> {
  return await db().transaction(async (tx) => {
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({ text: args.content }),
      runId: null,
      slackContext: {
        channelId: "C_MONITOR_FAILURE",
        messageTs: "1.000001",
        botUserId: "U_MONITOR_FAILURE_BOT",
        publicBrand: "vm0",
        conversationContext: "",
        messageText: args.content,
        messageFiles: [],
        messageAssets: [],
        mentionDisplayNames: {},
        senderDisplayName: "Queue Monitor Fixture",
        senderUserId: "U_MONITOR_FAILURE",
        channelType: "channel",
        threadTs: "1.000001",
        routeThreadTs: null,
      },
    });
    if (!event) {
      throw new Error("Failed to insert queued Slack fixture");
    }
    await tx.delete(chatSlackContext).where(eq(chatSlackContext.id, event.id));
    return event.id;
  });
}

export async function replayPendingChatInputQueueEventFixture(args: {
  readonly eventId: string;
  readonly replacementId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [event] = await tx
      .select({
        chatThreadId: chatEvents.chatThreadId,
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .limit(1);
    if (!event?.userMessage) {
      throw new Error("Expected one pending chat input queue event");
    }
    const replacement = await replaceChatEvent(tx, args.eventId, {
      id: args.replacementId,
      chatThreadId: event.chatThreadId,
      eventType: "input.prompt",
      userMessage: event.userMessage,
      runId: null,
    });
    if (!replacement) {
      throw new Error("Expected the pending queue event replay to insert");
    }
  });
}

/**
 * Move one exact automation event into historical state without waiting for real
 * time to pass. A string preserves PostgreSQL precision beyond JavaScript
 * milliseconds. Product APIs cannot construct an already-stale queue item.
 */
export async function setWorkflowQueueEventCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date | string;
}): Promise<void> {
  const createdAt =
    typeof args.createdAt === "string"
      ? sql`CAST(${args.createdAt} AS timestamp)`
      : args.createdAt;
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.automation"),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one workflow queue event to become historical");
  }
}

/**
 * Move one exact queued web message into historical state without waiting for
 * real time to pass. Product APIs cannot construct an already-stale queue item.
 */
export async function setQueuedUserMessageCreatedAtFixture(args: {
  readonly eventId: string;
  readonly createdAt: Date;
}): Promise<void> {
  const updated = await db().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    return await tx
      .update(chatEvents)
      .set({ createdAt: args.createdAt })
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .returning({ id: chatEvents.id });
  });
  if (updated.length !== 1) {
    throw new Error("Expected one queued user message to become historical");
  }
}

/**
 * Complete one claimed run without dispatching its terminal callbacks. This
 * reproduces the missed-callback state that the stale queue sweep recovers.
 */
export async function completeRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const completedAt = nowDate();
  const updated = await db()
    .update(agentRuns)
    .set({ status: "completed", completedAt })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to complete without callbacks");
  }
}

/**
 * Mark one claimed run timed out without completing its terminal side effects.
 * This isolates the interval where cleanup has recorded uncertainty but the
 * Runner has not yet reported process exit and teardown through `/complete`.
 */
export async function timeoutRunWithoutCallbacksFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(agentRuns)
    .set({
      status: "timeout",
      completedAt: nowDate(),
      error: "Run timed out (no heartbeat)",
    })
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  if (updated.length !== 1) {
    throw new Error("Expected one running run to time out without callbacks");
  }
}

/** Holds one unique run row so route tests can order lifecycle competitors. */
export async function holdAgentRunRowLockFixture(args: {
  readonly statusOnRelease?: "running";
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .for("update")
      .limit(1);
    if (!run) {
      throw new Error("Expected the agent run row to lock");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the agent run row lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
    if (args.statusOnRelease === "running") {
      await tx
        .update(agentRuns)
        .set({ status: "running", startedAt: nowDate() })
        .where(eq(agentRuns.id, args.runId));
    }
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: () => {
      return transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Product APIs cannot pause a completed SQL response or physically remove an
 * event at that boundary. Preserve the real selected rows, delete only the
 * owned event before returning them, and leave other threads' queries alone.
 */
export async function withChatEventDeletedAfterReadFixture<T>(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly whileResponseHeld: () => Promise<void>;
  readonly work: () => Promise<T>;
}): Promise<T> {
  await closeDbPool();
  const original = Pool.prototype.query;
  let held = false;
  Pool.prototype.query = new Proxy(original, {
    apply(target, receiver: unknown, queryArgs: unknown[]): unknown {
      const result: unknown = Reflect.apply(target, receiver, queryArgs);
      const query = z.object({ text: z.string() }).safeParse(queryArgs[0]);
      const values = z.array(z.unknown()).safeParse(queryArgs[1]);
      if (
        held ||
        !(result instanceof Promise) ||
        !query.success ||
        !values.success ||
        !isSharedThreadHotSnapshotRead(
          normalizeBlockedQuery(query.data.text),
        ) ||
        !values.data.includes(args.threadId) ||
        !values.data.includes(args.eventId)
      ) {
        return result;
      }
      held = true;
      return (async () => {
        const response: unknown = await result;
        z.object({ rows: z.array(z.unknown()).length(1) }).parse(response);
        await args.whileResponseHeld();
        const deleted = await db()
          .delete(chatEvents)
          .where(
            and(
              eq(chatEvents.chatThreadId, args.threadId),
              eq(chatEvents.id, args.eventId),
            ),
          )
          .returning({ id: chatEvents.id });
        if (deleted.length !== 1) {
          throw new Error("Expected one chat event to be physically deleted");
        }
        return response;
      })();
    },
  });
  const run = async () => {
    const result = await args.work();
    if (!held) {
      throw new Error("Expected the selected hot chat-event response barrier");
    }
    return result;
  };
  const [result] = await Promise.allSettled([run()]);
  // Instrumentation binds the pool query method. Close the instrumented pool
  // before restoring the prototype so the next request cannot reuse the hold.
  const [closed] = await Promise.allSettled([closeDbPool()]);
  Pool.prototype.query = original;
  if (result.status === "rejected") {
    throw result.reason;
  }
  if (closed.status === "rejected") {
    throw closed.reason;
  }
  return result.value;
}

/**
 * Reproduces a crash after the canonical chat callback was acknowledged but
 * before its detached terminal processing became durable. Product APIs cannot
 * delete append-only events, so this fixture removes only the exact cancelled
 * lifecycle row after verifying that the chat callback is already delivered.
 */
export async function removeAcknowledgedCancellationLifecycleFixture(args: {
  readonly runId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [callback] = await tx
      .select({ status: agentRunCallbacks.status })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, args.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
        ),
      )
      .limit(1);
    if (callback?.status !== "delivered") {
      throw new Error("Expected an acknowledged canonical chat callback");
    }

    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const removed = await tx
      .delete(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, args.runId),
          eq(chatEvents.eventType, "run.cancelled"),
        ),
      )
      .returning({ id: chatEvents.id });
    if (removed.length !== 1) {
      throw new Error("Expected one cancelled lifecycle event");
    }
  });
}

/** Reproduce a pending chat callback persisted before publicBrand existed. */
export async function removeChatCallbackPublicBrandFixture(
  runId: string,
): Promise<void> {
  const [callback] = await db()
    .select({
      id: agentRunCallbacks.id,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, runId),
        eq(agentRunCallbacks.internalKind, "chat"),
        eq(agentRunCallbacks.status, "pending"),
      ),
    )
    .limit(1);
  if (
    !callback ||
    typeof callback.payload !== "object" ||
    callback.payload === null ||
    Array.isArray(callback.payload) ||
    !Object.hasOwn(callback.payload, "publicBrand")
  ) {
    throw new Error("Expected one branded pending canonical chat callback");
  }

  const legacyPayload: Record<string, unknown> = { ...callback.payload };
  delete legacyPayload.publicBrand;
  const callbacks = await db()
    .update(agentRunCallbacks)
    .set({ payload: legacyPayload })
    .where(eq(agentRunCallbacks.id, callback.id))
    .returning({ id: agentRunCallbacks.id });
  if (callbacks.length !== 1) {
    throw new Error("Expected one pending canonical chat callback");
  }
}

/** Attach GitHub delivery metadata that is normally persisted by GitHub ingress. */
export async function setChatCallbackGitHubDeliveryFixture(args: {
  readonly runId: string;
  readonly remoteInstallationId: string;
  readonly repo: string;
  readonly subjectNumber: number;
  readonly subjectKind: "issue" | "pull_request";
  readonly agentId: string;
}): Promise<void> {
  await db().transaction(async (tx) => {
    const [run] = await tx
      .select({
        chatThreadId: agentRuns.chatThreadId,
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, args.runId))
      .limit(1);
    if (!run?.chatThreadId) {
      throw new Error("Expected one thread-bound chat run");
    }
    const [installation] = await tx
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.installationId, args.remoteInstallationId),
          eq(githubInstallations.orgId, run.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    if (!installation) {
      throw new Error("Expected one active GitHub installation");
    }
    const [callback] = await tx
      .select({
        id: agentRunCallbacks.id,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, args.runId),
          eq(agentRunCallbacks.internalKind, "chat"),
          eq(agentRunCallbacks.status, "pending"),
        ),
      )
      .limit(1);
    if (
      !callback ||
      typeof callback.payload !== "object" ||
      callback.payload === null ||
      Array.isArray(callback.payload)
    ) {
      throw new Error("Expected one pending canonical chat callback");
    }

    await tx.insert(githubChatThreadRoutes).values({
      installationId: installation.id,
      repo: args.repo,
      subjectNumber: args.subjectNumber,
      userId: run.userId,
      chatThreadId: run.chatThreadId,
    });
    const [updatedRun] = await tx
      .update(agentRuns)
      .set({ triggerSource: "github" })
      .where(eq(agentRuns.id, args.runId))
      .returning({ id: agentRuns.id });
    if (!updatedRun) {
      throw new Error("Expected one GitHub-triggered chat run");
    }
    const callbacks = await tx
      .update(agentRunCallbacks)
      .set({
        payload: {
          ...callback.payload,
          githubDelivery: {
            installationId: installation.id,
            repo: args.repo,
            subjectNumber: args.subjectNumber,
            subjectKind: args.subjectKind,
            agentId: args.agentId,
          },
        },
      })
      .where(eq(agentRunCallbacks.id, callback.id))
      .returning({ id: agentRunCallbacks.id });
    if (callbacks.length !== 1) {
      throw new Error("Expected one pending canonical chat callback");
    }
  });
}

/**
 * Persist a GitHub-owned queue item through the same canonical event/context
 * tables used by ingress. The production GitHub chat producer is external to
 * this API, so BDD tests use this fixture to exercise the API drain boundary.
 */
export async function enqueueGitHubChatEventFixture(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly remoteInstallationId: string;
  readonly repo: string;
  readonly subjectNumber: number;
  readonly subjectKind: "issue" | "pull_request";
  readonly messageText: string;
  readonly issueContext?: string;
  readonly publicBrand: PublicBrand;
}): Promise<string> {
  return await db().transaction(async (tx) => {
    const [installation] = await tx
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.installationId, args.remoteInstallationId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);
    if (!installation) {
      throw new Error("Expected one active GitHub installation");
    }

    await tx.insert(githubChatThreadRoutes).values({
      installationId: installation.id,
      repo: args.repo,
      subjectNumber: args.subjectNumber,
      userId: args.userId,
      chatThreadId: args.threadId,
    });
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage: createUserMessageDocument({
        text: args.messageText,
        nonContentPart: createChatEventSourcePart({
          kind: "github",
          repo: args.repo,
          subjectNumber: args.subjectNumber,
          subjectKind: args.subjectKind,
          triggerCommentId: null,
        }),
      }),
      runId: null,
      githubContext: {
        repo: args.repo,
        subjectNumber: args.subjectNumber,
        subjectKind: args.subjectKind,
        triggerCommentId: null,
        issueContext: args.issueContext ?? "GitHub BDD issue context",
        messageText: args.messageText,
        triggerReactionId: null,
        triggerCommentBody: null,
        publicBrand: args.publicBrand,
      },
    });
    if (!event) {
      throw new Error("Expected one pending GitHub chat event");
    }
    return event.id;
  });
}

/** Persist provider identity states that cannot be recreated after rollout. */
export async function setGitHubInstallationAppIdentityFixture(args: {
  readonly remoteInstallationId: string;
  readonly appId: string | null;
  readonly appSlug: string | null;
}): Promise<void> {
  const installations = await db()
    .update(githubInstallations)
    .set({ appId: args.appId, appSlug: args.appSlug })
    .where(eq(githubInstallations.installationId, args.remoteInstallationId))
    .returning({ id: githubInstallations.id });
  if (installations.length !== 1) {
    throw new Error("Expected one GitHub installation identity to update");
  }
}

async function transitiveBlockedWaiterCount(
  holderPid: number,
): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      WITH RECURSIVE blocked("pid") AS (
        SELECT activity.pid
        FROM pg_stat_activity AS activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))

        UNION

        SELECT activity.pid
        FROM pg_stat_activity AS activity
        INNER JOIN blocked AS blocker
          ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT ${count()}::int AS "waiterCount"
      FROM blocked
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

async function directBlockedWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${count()}::int AS "waiterCount"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    waiterCountRowSchema,
  );
  return rows[0]?.waiterCount ?? 0;
}

function normalizeBlockedQuery(query: string): string {
  return query.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function isSharedThreadHotSnapshotRead(query: string): boolean {
  return (
    query.startsWith("select ") &&
    query.includes(' from "chat_events" ') &&
    query.endsWith('order by "chat_events"."seq_id" asc')
  );
}

/**
 * Holds the derived search watermark so route tests can deterministically
 * order a projector and orphan cleanup at their shared discoverability anchor.
 * Product APIs cannot pause while holding this projection-internal row lock.
 */
export async function holdChatEventSearchWatermarkRowLockFixture(args: {
  readonly chatThreadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [watermark] = await tx
      .select({
        chatThreadId: chatEventSearchMessageWatermarks.chatThreadId,
      })
      .from(chatEventSearchMessageWatermarks)
      .where(
        eq(chatEventSearchMessageWatermarks.chatThreadId, args.chatThreadId),
      )
      .for("update")
      .limit(1);
    if (!watermark) {
      throw new Error("Expected the chat search watermark row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat search watermark lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

async function firstDirectBlockedStatementKind(
  holderPid: number,
): Promise<ChatThreadBlockedStatementKind | null> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT activity.query AS "query"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
      ORDER BY activity.query_start, activity.pid
      LIMIT 1
    `,
    blockedQueryRowSchema,
  );
  const query = rows[0] ? normalizeBlockedQuery(rows[0].query) : undefined;
  if (!query) {
    return null;
  }
  if (
    query.startsWith("select") &&
    query.includes('from "chat_threads"') &&
    query.includes("for key share")
  ) {
    return "select_for_key_share";
  }
  if (
    query.startsWith("select") &&
    query.includes('from "chat_threads"') &&
    query.includes("for update")
  ) {
    return "select_for_update";
  }
  if (query.startsWith('update "chat_threads"')) {
    return "update";
  }
  return "other";
}

/**
 * Waiters blocked by this holder whose own statement is a `FOR KEY SHARE` lock
 * on the held thread. A plain waiter count also includes ordinary writers with
 * no lock timeout of their own, which can still be queued behind the holder
 * when a fenced writer has already given up, so a test that needs to observe
 * exactly that writer block and then stop waiting counts only these.
 */
async function blockedKeyShareWaiterCount(holderPid: number): Promise<number> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT activity.query AS "query"
      FROM pg_stat_activity AS activity
      WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
    `,
    blockedQueryRowSchema,
  );
  return rows.filter((row) => {
    const query = normalizeBlockedQuery(row.query);
    return (
      query !== undefined &&
      query.startsWith("select") &&
      query.includes('from "chat_threads"') &&
      query.includes("for key share")
    );
  }).length;
}

/**
 * Holds one thread row so route tests can observe the first product statement
 * that requires a write-oriented lock. Product APIs cannot pause at this
 * boundary, and the fixture does not change the held row.
 */
export async function holdChatThreadRowLockFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blockedKeyShareWaiterCount: () => Promise<number>;
  readonly firstBlockedStatementKind: () => Promise<ChatThreadBlockedStatementKind | null>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new Error("Expected the chat thread row");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat thread lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
    blockedKeyShareWaiterCount: async () => {
      return await blockedKeyShareWaiterCount(holderPid);
    },
    firstBlockedStatementKind: async () => {
      return await firstDirectBlockedStatementKind(holderPid);
    },
  };
}

/**
 * Deletes one test-owned thread and pauses before commit. Product APIs cannot
 * pause after DELETE has locked the parent but before the transaction commits,
 * so this fixture exposes that exact projection/deletion concurrency boundary.
 */
export async function holdChatThreadDeleteTransactionFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly firstBlockedStatementKind: () => Promise<ChatThreadBlockedStatementKind | null>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const deleted = await tx
      .delete(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .returning({ id: chatThreads.id });
    if (deleted.length !== 1) {
      throw new Error("Expected one chat thread to delete");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat thread delete holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    firstBlockedStatementKind: async () => {
      return await firstDirectBlockedStatementKind(holderPid);
    },
  };
}

async function pidIsBlocked(waiterPid: number): Promise<boolean> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT cardinality(pg_blocking_pids(${waiterPid})) > 0 AS "blocked"
    `,
    blockedByPidRowSchema,
  );
  return rows[0]?.blocked ?? false;
}

async function pidIsDirectlyBlockedBy(
  waiterPid: number,
  holderPid: number,
): Promise<boolean> {
  const rows = await executeRawRows(
    db(),
    sql`
      SELECT ${holderPid} = ANY(pg_blocking_pids(${waiterPid})) AS "blocked"
    `,
    blockedByPidRowSchema,
  );
  return rows[0]?.blocked ?? false;
}

/**
 * Acquires bdd-scoped ownership of the platform-managed built-in model key
 * pool for one vendor.
 *
 * Why product APIs cannot construct this state: built_in_model_keys is a
 * platform-operations table with no product write surface — keys are
 * provisioned out of band. Keys passed here must carry a
 * BDD_BUILT_IN_MODEL_KEY_PREFIXES prefix. The shared fixture service atomically
 * arbitrates the vendor-unique row and prevents one test owner from deleting
 * another owner's key.
 */
export async function acquireBddBuiltInModelKey(args: {
  readonly fixtureId: string;
  readonly vendor: string;
  readonly apiKey: string;
}): Promise<string> {
  const scoped = BDD_BUILT_IN_MODEL_KEY_PREFIXES.some((prefix) => {
    return args.apiKey.length > prefix.length && args.apiKey.startsWith(prefix);
  });
  if (!scoped) {
    throw new Error(
      `acquireBddBuiltInModelKey: api key must start with one of ${BDD_BUILT_IN_MODEL_KEY_PREFIXES.join(", ")}`,
    );
  }
  const [acquired] = await acquireBuiltInModelKeyFixture(db(), args.fixtureId, [
    {
      vendor: args.vendor,
      apiKey: args.apiKey,
    },
  ]);
  if (!acquired) {
    throw new Error(`Expected built-in model key for vendor: ${args.vendor}`);
  }
  return acquired.apiKey;
}

/** Releases only this bdd fixture's ownership of its vendor key. */
export async function releaseBddBuiltInModelKey(args: {
  readonly fixtureId: string;
}): Promise<void> {
  await releaseBuiltInModelKeyFixture(db(), args.fixtureId);
}

/**
 * Holds the production org admission advisory lock and reports its waiter
 * count. No product API exposes database lock timing, so this fixture is the
 * narrow boundary exception for the queue-drain concurrency test.
 */
export async function holdOrgAdmissionLockFixture(args: {
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
  readonly transitiveWaiterCount: () => Promise<number>;
  readonly cancelBlockedQueries: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(hashtext(${args.orgId}))
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the admission lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
    // B1 subjects precede the org lock. A second admission can wait on the
    // first admission's subject lock instead of this fixture's org lock.
    transitiveWaiterCount: () => {
      return transitiveBlockedWaiterCount(holderPid);
    },
    // Force a real admission rollback, scoped to this fixture's held lock.
    cancelBlockedQueries: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT pg_cancel_backend(activity.pid) AS cancelled
          FROM pg_stat_activity AS activity
          WHERE ${holderPid} = ANY(pg_blocking_pids(activity.pid))
        `,
        z.object({ cancelled: z.boolean() }),
      );
      return rows.filter((row) => {
        return row.cancelled;
      }).length;
    },
  };
}

/**
 * Holds the production Pi API-first lifecycle key so BDDs can deterministically
 * order publication and canonical cancellation without timing sleeps.
 */
export async function holdPiApiFirstTurnLifecycleLockFixture(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly waiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(
            hashtextextended(${`pi_api_first_turn:${args.runId}`}, 0)
          )
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the Pi lifecycle lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    waiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'advisory'
            AND NOT waiting.granted
            AND (waiting.classid, waiting.objid, waiting.objsubid) IN (
              SELECT held.classid, held.objid, held.objsubid
              FROM pg_locks AS held
              WHERE held.locktype = 'advisory'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Holds the workflow queue admission key so tests can observe concurrent
 * requests waiting on the per-thread lock.
 */
export async function holdChatEventQueueAdmissionLockFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly directWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const lockKey = `chat_event_queue:${args.threadId}`;
    const rows = await executeRawRows(
      tx,
      sql`
        SELECT
          pg_backend_pid() AS "pid",
          pg_advisory_xact_lock(hashtext(${lockKey}))
      `,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the queue admission lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    directWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Stages the canonical conversation clear inside an open transaction so a
 * concurrent run still resolves the pre-clear snapshot, then blocks on this
 * transaction when its launch commit re-reads the session row `FOR UPDATE`.
 *
 * Waiting on this transaction is a precise barrier for "the run captured its
 * snapshot and reached commit". Counting waiters on the org admission key is
 * not: the background queue drain takes that same key, so it can satisfy the
 * barrier before the run has resolved its session at all.
 */
export async function holdThreadSessionConversationClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .select({ agentSessionId: chatThreads.agentSessionId })
      .from(chatThreads)
      .where(eq(chatThreads.id, args.threadId))
      .limit(1);
    if (!thread?.agentSessionId) {
      throw new Error("Expected a bound chat thread session");
    }
    const [session] = await tx
      .update(agentSessions)
      .set({ conversationId: null })
      .where(eq(agentSessions.id, thread.agentSessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected a bound agent session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the conversation clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      const rows = await executeRawRows(
        db(),
        sql`
          SELECT ${count()}::int AS "waiterCount"
          FROM pg_locks AS waiting
          WHERE waiting.locktype = 'transactionid'
            AND NOT waiting.granted
            AND waiting.transactionid IN (
              SELECT held.transactionid
              FROM pg_locks AS held
              WHERE held.locktype = 'transactionid'
                AND held.pid = ${holderPid}
                AND held.granted
            )
        `,
        waiterCountRowSchema,
      );
      return rows[0]?.waiterCount ?? 0;
    },
  };
}

/**
 * Replaces one canonical binding with an otherwise valid session/run pair.
 * Product APIs cannot bind a thread to another owner's session, so this is the
 * narrow state boundary for ownership-corruption coverage.
 */
export async function replaceThreadSessionBindingFixture(args: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly runId: string;
}): Promise<void> {
  const updated = await db()
    .update(chatThreads)
    .set({
      agentSessionId: args.sessionId,
      agentSessionRunId: args.runId,
    })
    .where(eq(chatThreads.id, args.threadId))
    .returning({ id: chatThreads.id });
  if (updated.length !== 1) {
    throw new Error("Expected one chat thread session binding to be replaced");
  }
}

/**
 * Product APIs cannot transfer session ownership. Stage that infrastructure-only
 * race without changing the committed preparation snapshot, then let admission
 * observe it after waiting for the real session row lock.
 */
export async function holdThreadSessionOwnerChangeFixture(args: {
  readonly threadId: string;
  readonly ownerChange:
    | { readonly userId: string }
    | { readonly orgId: string }
    | { readonly agentId: string };
  readonly clearConversation: boolean;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = onRejection(
    db().transaction(async (tx) => {
      const [thread] = await tx
        .select({ agentSessionId: chatThreads.agentSessionId })
        .from(chatThreads)
        .where(eq(chatThreads.id, args.threadId));
      if (!thread?.agentSessionId) {
        throw new Error("Expected a bound chat thread session");
      }
      const [session] = await tx
        .update(agentSessions)
        .set({
          ...args.ownerChange,
          ...(args.clearConversation ? { conversationId: null } : {}),
        })
        .where(eq(agentSessions.id, thread.agentSessionId))
        .returning({ id: agentSessions.id });
      if (!session) {
        throw new Error("Expected a bound agent session");
      }
      const [row] = await executeRawRows(
        tx,
        sql`SELECT pg_backend_pid() AS "pid"`,
        databasePidRowSchema,
      );
      if (!row) {
        throw new Error("Expected the session owner change holder pid");
      }
      started.resolve(row.pid);
      await released.promise;
    }),
    (error) => {
      started.reject(error);
    },
  );
  const holderPid = await started.promise;
  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/** Replaces a completed run's native session blob with exact test-owned bytes. */
export async function replacePiSessionHistoryJsonlFixture(args: {
  readonly runId: string;
  readonly jsonl: string;
}): Promise<string> {
  const bytes = Buffer.from(args.jsonl, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await db().transaction(async (tx) => {
    await tx
      .insert(blobs)
      .values({
        hash,
        rawSize: bytes.length,
        encoding: "identity",
        encodedSize: bytes.length,
        refCount: 1,
      })
      .onConflictDoNothing();
    const [updated] = await tx
      .update(conversations)
      .set({
        cliAgentSessionHistory: null,
        cliAgentSessionHistoryHash: hash,
      })
      .where(eq(conversations.runId, args.runId))
      .returning({ id: conversations.id });
    if (!updated) {
      throw new Error("Expected one Pi session history fixture to be replaced");
    }
  });
  return hash;
}

/**
 * Stages a canonical binding clear after the queue-first message row is
 * visible. Starting this transaction earlier would block that row's parent FK
 * check; once the row exists, the uncommitted clear remains invisible to
 * resolution and blocks only final snapshot validation on the thread row.
 */
export async function holdThreadSessionBindingClearFixture(args: {
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [thread] = await tx
      .update(chatThreads)
      .set({ agentSessionId: null, agentSessionRunId: null })
      .where(eq(chatThreads.id, args.threadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Expected a bound chat thread session");
    }
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const holderPid = rows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the binding clear holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Deletes one completed run to reproduce retention cleanup of binding
 * provenance. No product endpoint exposes historical run deletion.
 */
export async function deleteAgentRunFixture(args: {
  readonly runId: string;
}): Promise<void> {
  const deleted = await db()
    .delete(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .returning({ id: agentRuns.id });
  if (deleted.length !== 1) {
    throw new Error("Expected one agent run to be deleted");
  }
}

async function readBoundThreadSessionConversation(threadId: string): Promise<{
  readonly sessionId: string;
  readonly conversationId: string;
}> {
  const [boundSession] = await db()
    .select({
      id: agentSessions.id,
      conversationId: agentSessions.conversationId,
    })
    .from(chatThreads)
    .innerJoin(agentSessions, eq(agentSessions.id, chatThreads.agentSessionId))
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!boundSession?.conversationId) {
    throw new Error("Expected a bound chat thread conversation");
  }
  return {
    sessionId: boundSession.id,
    conversationId: boundSession.conversationId,
  };
}

async function holdThreadSessionConversationChangeStage(args: {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly index: number;
  readonly stageRequest: Promise<void>;
  readonly release: Promise<void>;
  readonly markQueued: (holderPid: number) => void;
  readonly markStaged: (holderPid: number) => void;
  readonly markReleased: (holderPid: number) => void;
}): Promise<void> {
  await args.stageRequest;
  const holderPid = await db().transaction(async (tx) => {
    const rows = await executeRawRows(
      tx,
      sql`SELECT pg_backend_pid() AS "pid"`,
      databasePidRowSchema,
    );
    const pid = rows[0]?.pid;
    if (!pid) {
      throw new Error("Expected the conversation change holder pid");
    }
    args.markQueued(pid);
    const [session] = await tx
      .update(agentSessions)
      .set({
        conversationId: args.index % 2 === 0 ? null : args.conversationId,
      })
      .where(eq(agentSessions.id, args.sessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Expected the bound agent session");
    }
    args.markStaged(pid);
    await args.release;
    return pid;
  });
  args.markReleased(holderPid);
}

async function waitForConversationChangeStages(
  stages: readonly Promise<void>[],
): Promise<void> {
  await Promise.all(stages);
}

/**
 * Alternates the bound session's conversation snapshot while consecutive run
 * preparations reach final admission. This is the timing boundary for proving
 * the retry limit without mocking the resolver or admission service.
 */
export async function holdThreadSessionConversationChangesFixture(args: {
  readonly threadId: string;
  readonly changeCount: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly queueNextChange: () => void;
  readonly release: () => void;
  readonly releaseAll: () => void;
  readonly done: Promise<void>;
  readonly stagedChangeCount: () => number;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly queuedChangeIsBlocked: () => Promise<boolean>;
}> {
  if (args.changeCount < 1) {
    throw new Error("Expected at least one conversation snapshot change");
  }
  const boundSession = await readBoundThreadSessionConversation(args.threadId);

  const firstStaged = createDeferredPromise<void>(args.signal);
  const releases = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stageRequests = Array.from({ length: args.changeCount }, () => {
    return createDeferredPromise<void>(args.signal);
  });
  const stagePids: (number | undefined)[] = Array.from({
    length: args.changeCount,
  });
  let currentHolderPid: number | null = null;
  let requestedChanges = 1;
  let lastQueuedIndex: number | null = null;
  let stagedChanges = 0;
  const firstStageRequest = stageRequests[0];
  if (!firstStageRequest) {
    throw new Error("Missing first conversation snapshot stage request");
  }
  firstStageRequest.resolve(undefined);
  const stages = stageRequests.map(async (stageRequest, index) => {
    const release = releases[index];
    if (!release) {
      throw new Error("Missing conversation snapshot release gate");
    }
    await holdThreadSessionConversationChangeStage({
      sessionId: boundSession.sessionId,
      conversationId: boundSession.conversationId,
      index,
      stageRequest: stageRequest.promise,
      release: release.promise,
      markQueued: (holderPid) => {
        stagePids[index] = holderPid;
      },
      markStaged: (holderPid) => {
        currentHolderPid = holderPid;
        stagedChanges = index + 1;
        if (!firstStaged.settled()) {
          firstStaged.resolve(undefined);
        }
      },
      markReleased: (holderPid) => {
        if (currentHolderPid === holderPid) {
          currentHolderPid = null;
        }
      },
    });
  });
  const done = onRejection(waitForConversationChangeStages(stages), (error) => {
    if (!firstStaged.settled()) {
      firstStaged.reject(error);
    }
  });
  await firstStaged.promise;

  return {
    queueNextChange: () => {
      const stageRequest = stageRequests[requestedChanges];
      if (!stageRequest) {
        throw new Error("No remaining conversation snapshot change to queue");
      }
      lastQueuedIndex = requestedChanges;
      requestedChanges += 1;
      stageRequest.resolve(undefined);
    },
    release: () => {
      const release = releases[stagedChanges - 1];
      if (release && !release.settled()) {
        release.resolve(undefined);
      }
    },
    releaseAll: () => {
      for (const stageRequest of stageRequests) {
        if (!stageRequest.settled()) {
          stageRequest.resolve(undefined);
        }
      }
      for (const release of releases) {
        if (!release.settled()) {
          release.resolve(undefined);
        }
      }
    },
    done,
    stagedChangeCount: () => {
      return stagedChanges;
    },
    blockedWaiterCount: async () => {
      return currentHolderPid === null
        ? 0
        : await directBlockedWaiterCount(currentHolderPid);
    },
    queuedChangeIsBlocked: async () => {
      if (currentHolderPid === null || lastQueuedIndex === null) {
        return false;
      }
      const queuedPid = stagePids[lastQueuedIndex];
      if (!queuedPid || lastQueuedIndex < stagedChanges) {
        return false;
      }
      return await pidIsBlocked(queuedPid);
    },
  };
}

/**
 * Holds one pending chat input event so a claim and recall can reach the same
 * product lock in a test-owned order. This timing-only boundary neither creates
 * nor changes product rows and cannot block unrelated queue items.
 */
export async function holdChatEventQueueItemFixture(args: {
  readonly threadId: string;
  readonly eventId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly directBlockedWaiterCount: () => Promise<number>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
          eq(chatEvents.eventType, "input.prompt"),
          isNull(chatEvents.runId),
        ),
      )
      .for("update")
      .limit(1);
    if (!pending) {
      throw new Error("Expected the pending chat input event");
    }
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message queue lock holder pid");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    directBlockedWaiterCount: async () => {
      return await directBlockedWaiterCount(holderPid);
    },
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

/**
 * Inserts one event through the production sequence writer, then holds its
 * transaction open. No product endpoint can pause between INSERT and COMMIT,
 * so this fixture is the narrow timing boundary for sequence serialization.
 */
export async function holdChatEventInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly event: { readonly id: string; readonly seqId: number };
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
  readonly blocks: (waiterPid: number) => Promise<boolean>;
}> {
  const started = createDeferredPromise<{
    readonly pid: number;
    readonly event: { readonly id: string; readonly seqId: number };
  }>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the chat-message insert holder pid");
    }
    const event = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: args.content,
      runId: null,
    });
    if (!event) {
      throw new Error("Expected the held chat-message insert");
    }
    started.resolve({ pid: holderPid, event });
    await released.promise;
  });
  const { pid, event } = await started.promise;

  return {
    event,
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(pid);
    },
    blocks: async (waiterPid) => {
      return await pidIsDirectlyBlockedBy(waiterPid, pid);
    },
  };
}

/** Holds one existing run-output row to expose writes from later event batches. */
export async function holdRunOutputMaterializationRowFixture(args: {
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly release: () => void;
  readonly done: Promise<void>;
  readonly blockedWaiterCount: () => Promise<number>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const released = createDeferredPromise<void>(args.signal);
  const done = db().transaction(async (tx) => {
    const pidRows = await executeRawRows(
      tx,
      sql`
        SELECT pg_backend_pid() AS "pid"
      `,
      databasePidRowSchema,
    );
    const holderPid = pidRows[0]?.pid;
    if (!holderPid) {
      throw new Error("Expected the run-output row lock holder pid");
    }
    const [row] = await tx
      .select({ runId: runOutputMaterializations.runId })
      .from(runOutputMaterializations)
      .where(eq(runOutputMaterializations.runId, args.runId))
      .for("update")
      .limit(1);
    if (!row) {
      throw new Error("Expected an existing run-output materialization");
    }
    started.resolve(holderPid);
    await released.promise;
  });
  const holderPid = await started.promise;

  return {
    release: () => {
      if (!released.settled()) {
        released.resolve(undefined);
      }
    },
    done,
    blockedWaiterCount: async () => {
      return await transitiveBlockedWaiterCount(holderPid);
    },
  };
}

export async function readRunOutputMemoryCitationsFixture(runId: string) {
  return await db()
    .select({
      sequenceNumber: runOutputMemoryCitations.sequenceNumber,
      citation: runOutputMemoryCitations.citation,
    })
    .from(runOutputMemoryCitations)
    .where(eq(runOutputMemoryCitations.runId, runId))
    .orderBy(asc(runOutputMemoryCitations.sequenceNumber));
}

/** Starts one event insert with reservation and persistence in one transaction. */
export async function startChatEventInsertTransactionFixture(args: {
  readonly threadId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly pid: number;
  readonly done: Promise<{ readonly id: string; readonly seqId: number }>;
}> {
  const started = createDeferredPromise<number>(args.signal);
  const done = onRejection(
    db().transaction(async (tx) => {
      const pidRows = await executeRawRows(
        tx,
        sql`
          SELECT pg_backend_pid() AS "pid"
        `,
        databasePidRowSchema,
      );
      const pid = pidRows[0]?.pid;
      if (!pid) {
        throw new Error("Expected the chat-message insert pid");
      }
      started.resolve(pid);
      const event = await insertChatEvent(tx, {
        chatThreadId: args.threadId,
        eventType: "output.message",
        content: args.content,
        runId: null,
      });
      if (!event) {
        throw new Error("Expected the chat-message insert");
      }
      return event;
    }),
    (error) => {
      if (!started.settled()) {
        started.reject(error);
      }
    },
  );
  return { pid: await started.promise, done };
}

/**
 * Appends an explicit output event with a nullable compatibility payload owned
 * by a different ChatEvent leaf. Product writers intentionally
 * cannot create this divergent rollout shape; the fixture proves readers use
 * `event_type` as the semantic discriminator instead of legacy payload shape.
 */
export async function insertOutputEventWithConflictingLegacyPayloadFixture(args: {
  readonly threadId: string;
  readonly runId?: string;
  readonly content: string;
  readonly createdAt?: Date;
  readonly legacyPayload: "run.completed" | "usage.recorded";
}): Promise<{ readonly id: string; readonly seqId: number }> {
  const event = await db().transaction(async (tx) => {
    const identity = {
      chatThreadId: args.threadId,
      eventType: "output.message" as const,
      content: args.content,
      runId: args.runId ?? null,
      createdAt: args.createdAt,
    };
    const lifecyclePayloadEvent = {
      ...identity,
      runLifecycleEvent: "completed",
    };
    const usagePayloadEvent = {
      ...identity,
      usagePayload: {
        version: 1 as const,
        totalCredits: 0,
        settledAt: (args.createdAt ?? nowDate()).toISOString(),
        breakdown: [],
      },
    };
    const inserted =
      args.legacyPayload === "run.completed"
        ? await insertChatEvent(tx, lifecyclePayloadEvent)
        : await insertChatEvent(tx, usagePayloadEvent);
    if (!inserted) {
      throw new Error("Expected the conflicting legacy-payload event insert");
    }
    return inserted;
  });
  return event;
}

interface CanonicalChatEventStorageRow {
  readonly id: string;
  readonly eventType: string;
  readonly payload: ChatEventPayload | null;
  readonly runId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
  readonly revokesEventId: string | null;
}

interface CanonicalChatEventWriteFixture {
  readonly eventIds: readonly string[];
  readonly single: {
    readonly inputRejectedId: string;
    readonly outputErrorId: string;
    readonly interruptId: string;
    readonly interruptTargetRunId: string;
    readonly goalContextEventId: string;
    readonly goalId: string;
    readonly goalOpenId: string;
  };
  readonly batch: {
    readonly thinkingId: string;
    readonly runFailedId: string;
    readonly browserCloseId: string;
    readonly goalCloseId: string;
    readonly usageId: string;
  };
  readonly replacement: {
    readonly targetId: string;
    readonly replacementId: string;
  };
}

async function insertCanonicalSingleWrites(
  tx: Tx,
  threadId: string,
  single: CanonicalChatEventWriteFixture["single"],
): Promise<void> {
  const inputUserMessage = createUserMessageDocument({
    text: "rejected canonical input",
  });
  await insertChatEvent(tx, {
    id: single.inputRejectedId,
    chatThreadId: threadId,
    eventType: "input.rejected",
    userMessage: inputUserMessage,
    runId: null,
    error: "input rejected",
  });
  await insertChatEvent(tx, {
    id: single.outputErrorId,
    chatThreadId: threadId,
    eventType: "output.error",
    content: "output failed",
    error: "output error",
    runId: randomUUID(),
  });
  await insertChatEvent(tx, {
    id: single.interruptId,
    chatThreadId: threadId,
    eventType: "control.interrupt",
    interruptsRunId: single.interruptTargetRunId,
  });
  await insertChatEvent(tx, {
    id: single.goalContextEventId,
    chatThreadId: threadId,
    eventType: "output.message",
    content: "goal output",
    runId: randomUUID(),
    runGroupId: single.goalId,
  });
  await appendHistoricalGoalMarker(tx, {
    id: single.goalOpenId,
    chatThreadId: threadId,
    eventType: "goal.open",
    content: "goal opened",
  });
}

async function appendHistoricalGoalMarker(
  tx: Tx,
  event: {
    readonly id: string;
    readonly chatThreadId: string;
    readonly eventType: "goal.open" | "goal.close";
    readonly content?: string;
  },
) {
  const [thread] = await tx
    .update(chatThreads)
    .set({ lastChatEventSeqId: sql`${chatThreads.lastChatEventSeqId} + 1` })
    .where(eq(chatThreads.id, event.chatThreadId))
    .returning({ seqId: chatThreads.lastChatEventSeqId });
  if (!thread) {
    throw new Error("Missing historical marker thread");
  }
  await tx.insert(chatEvents).values({
    id: event.id,
    chatThreadId: event.chatThreadId,
    eventType: event.eventType,
    seqId: thread.seqId,
    payload: event.content === undefined ? null : { content: event.content },
  });
}

async function insertCanonicalBatchWrites(
  tx: Tx,
  threadId: string,
  batch: CanonicalChatEventWriteFixture["batch"],
): Promise<void> {
  await insertChatEvents(tx, [
    {
      id: batch.thinkingId,
      chatThreadId: threadId,
      eventType: "output.thinking",
      thinking: "canonical thinking",
      runId: randomUUID(),
    },
    {
      id: batch.runFailedId,
      chatThreadId: threadId,
      eventType: "run.failed",
      content: "run failed",
      error: "runner error",
      failureReason: "future_reason",
      runId: randomUUID(),
    },
    {
      id: batch.browserCloseId,
      chatThreadId: threadId,
      eventType: "browser.close",
    },
    {
      id: batch.usageId,
      chatThreadId: threadId,
      eventType: "usage.recorded",
      runId: randomUUID(),
      usagePayload: {
        version: 1,
        totalCredits: 9,
        settledAt: "2026-08-10T00:00:00.000Z",
        breakdown: [
          {
            kind: "model",
            credits: 9,
            providers: [{ provider: "test", credits: 9 }],
          },
        ],
      },
    },
  ]);
  await appendHistoricalGoalMarker(tx, {
    id: batch.goalCloseId,
    chatThreadId: threadId,
    eventType: "goal.close",
  });
}

async function insertCanonicalReplacementWrite(
  tx: Tx,
  threadId: string,
  replacement: CanonicalChatEventWriteFixture["replacement"],
): Promise<void> {
  const userMessage = createUserMessageDocument({
    text: "replacement canonical input",
  });
  await insertChatEvent(tx, {
    id: replacement.targetId,
    chatThreadId: threadId,
    eventType: "input.prompt",
    contextType: "web",
    userMessage,
    runId: null,
  });
  await replaceChatEvent(tx, replacement.targetId, {
    id: replacement.replacementId,
    chatThreadId: threadId,
    eventType: "input.rejected",
    userMessage,
    runId: null,
    error: "replacement rejected",
  });
}

/** Exercise the three production canonical persistence paths. */
export async function insertCanonicalChatEventWritesFixture(args: {
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<CanonicalChatEventWriteFixture> {
  const interruptTargetSessionId = randomUUID();
  const single = {
    inputRejectedId: randomUUID(),
    outputErrorId: randomUUID(),
    interruptId: randomUUID(),
    interruptTargetRunId: randomUUID(),
    goalContextEventId: randomUUID(),
    goalId: randomUUID(),
    goalOpenId: randomUUID(),
  };
  const batch = {
    thinkingId: randomUUID(),
    runFailedId: randomUUID(),
    browserCloseId: randomUUID(),
    goalCloseId: randomUUID(),
    usageId: randomUUID(),
  };
  const replacement = {
    targetId: randomUUID(),
    replacementId: randomUUID(),
  };
  await db().transaction(async (tx) => {
    await tx.insert(agentSessions).values({
      id: interruptTargetSessionId,
      userId: args.userId,
      orgId: args.orgId,
      agentId: args.agentId,
    });
    await tx.insert(agentRuns).values({
      id: single.interruptTargetRunId,
      userId: args.userId,
      orgId: args.orgId,
      sessionId: interruptTargetSessionId,
      status: "queued",
      prompt: "canonical interrupt target",
    });
    await insertCanonicalSingleWrites(tx, args.threadId, single);
    await insertCanonicalBatchWrites(tx, args.threadId, batch);
    await insertCanonicalReplacementWrite(tx, args.threadId, replacement);
  });

  return {
    eventIds: [
      single.inputRejectedId,
      single.outputErrorId,
      single.interruptId,
      single.goalContextEventId,
      single.goalOpenId,
      batch.thinkingId,
      batch.runFailedId,
      batch.browserCloseId,
      batch.goalCloseId,
      batch.usageId,
      replacement.targetId,
      replacement.replacementId,
    ],
    single,
    batch,
    replacement,
  };
}

export async function readCanonicalChatEventStorageFixture(
  eventIds: readonly string[],
): Promise<readonly CanonicalChatEventStorageRow[]> {
  return await db()
    .select({
      id: chatEvents.id,
      eventType: chatEvents.eventType,
      payload: chatEvents.payload,
      failureReason: chatEvents.failureReason,
      runId: chatEvents.runId,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      revokesEventId: chatEvents.revokesEventId,
    })
    .from(chatEvents)
    .where(inArray(chatEvents.id, [...eventIds]));
}

export async function isVisibleChatEventFixture(
  eventId: string,
): Promise<boolean> {
  const database = db();
  const [event] = await database
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(and(eq(chatEvents.id, eventId), visibleChatEventCondition(database)))
    .limit(1);
  return event !== undefined;
}

/**
 * Usage-ledger rows have no production read endpoint. This test-only fixture is
 * the narrow external-behavior exception needed to prove exactly-once billing
 * without exposing internal billing records through a new product API.
 */
export async function readRunUsageEventsFixture(runId: string): Promise<
  readonly {
    readonly provider: string;
    readonly category: string;
    readonly quantity: number;
    readonly status: string;
    readonly creditsCharged: number | null;
    readonly billingError: string | null;
  }[]
> {
  return await db()
    .select({
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      status: usageEvent.status,
      creditsCharged: usageEvent.creditsCharged,
      billingError: usageEvent.billingError,
    })
    .from(usageEvent)
    .where(eq(usageEvent.runId, runId))
    .orderBy(usageEvent.category);
}

/**
 * Seed immutable first-turn billing identities that production APIs cannot
 * create before the model response, for route-level retry and collision tests.
 */
export async function insertPiApiFirstTurnUsageEventsFixture(args: {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly provider: string;
  readonly events: readonly {
    readonly idempotencyKey: string;
    readonly category: string;
    readonly quantity: number;
  }[];
}): Promise<void> {
  await db()
    .insert(usageEvent)
    .values(
      args.events.map((event) => {
        return {
          runId: args.runId,
          idempotencyKey: event.idempotencyKey,
          orgId: args.orgId,
          userId: args.userId,
          kind: "model",
          provider: args.provider,
          category: event.category,
          quantity: event.quantity,
        };
      }),
    );
}

export async function deletePiApiFirstTurnUsageEventsFixture(
  idempotencyKeys: readonly string[],
): Promise<void> {
  await db()
    .delete(usageEvent)
    .where(inArray(usageEvent.idempotencyKey, [...idempotencyKeys]));
}

/**
 * Exercise the production predicates shared by artifact catalog/realtime,
 * thread/Google Drive, and Feishu/AgentPhone/Teams/Telegram dispatch readers.
 */
export async function readCanonicalRunIdCollisionSafetyFixture(args: {
  readonly chatThreadId: string;
  readonly interruptEventId: string;
  readonly runId: string;
}): Promise<{
  readonly artifactLookupMatchedInterrupt: boolean;
  readonly feishuDispatchMatchedInterrupt: boolean;
  readonly rawRunIdCollisionExists: boolean;
  readonly threadScopedArtifactLookupMatchedInterrupt: boolean;
  readonly threadScopedDispatchMatchedInterrupt: boolean;
}> {
  const database = db();
  const [
    rawRunIdCollision,
    artifactLookup,
    threadScopedArtifactLookup,
    feishuDispatch,
    threadScopedDispatch,
  ] = await Promise.all([
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          eq(chatEvents.runId, args.runId),
        ),
      )
      .limit(1),
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          runOwnedChatEventForRunCondition({ runId: args.runId }),
        ),
      )
      .limit(1),
    database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.interruptEventId),
          runOwnedChatEventForRunCondition({
            runId: args.runId,
            chatThreadId: args.chatThreadId,
          }),
        ),
      )
      .limit(1),
    database
      .select({ runId: agentRuns.id })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        chatInputPromptDispatchCondition({ eventId: args.interruptEventId }),
      )
      .limit(1),
    database
      .select({ runId: agentRuns.id })
      .from(chatEvents)
      .innerJoin(agentRuns, eq(agentRuns.id, chatEvents.runId))
      .where(
        chatInputPromptDispatchCondition({
          eventId: args.interruptEventId,
          chatThreadId: args.chatThreadId,
        }),
      )
      .limit(1),
  ]);
  return {
    rawRunIdCollisionExists: rawRunIdCollision.length > 0,
    artifactLookupMatchedInterrupt: artifactLookup.length > 0,
    threadScopedArtifactLookupMatchedInterrupt:
      threadScopedArtifactLookup.length > 0,
    feishuDispatchMatchedInterrupt: feishuDispatch.length > 0,
    threadScopedDispatchMatchedInterrupt: threadScopedDispatch.length > 0,
  };
}
