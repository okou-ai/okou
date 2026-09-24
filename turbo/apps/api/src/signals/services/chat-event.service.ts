/** Typed append-only commands for the canonical ChatEvent stream. */
import { randomUUID } from "node:crypto";
import { isValidChatEventRevocation } from "@okouai/api-contracts/contracts/chat-events";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import type { ChatFeishuMessageFiles } from "@okouai/db/jsonb-contracts/chat-feishu-context";
import type {
  ChatSlackMentionDisplayNames,
  ChatSlackMessageAssets,
  ChatSlackMessageFiles,
} from "@okouai/db/jsonb-contracts/chat-slack-context";
import type { ChatTeamsMessageFiles } from "@okouai/db/jsonb-contracts/chat-teams-context";
import type { ChatEventPayload } from "@okouai/db/jsonb-contracts/chat-event";
import { chatAgentRunContext } from "@okouai/db/schema/chat-agent-run-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatGithubContext } from "@okouai/db/schema/chat-github-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { nowDate } from "../../lib/time";
import type {
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import type { ApiDb, Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import {
  appendCanonicalChatEvents,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import {
  isSplitChatEventWriteEnabled,
  type ChatEventWriteOptions,
} from "./chat-event-write-mode.service";

const log = logger("chat-event-context");

type CanonicalChatEventInsert = typeof chatEvents.$inferInsert;
type ChatEventWriteTransaction = ApiDb | Tx;

type ChatEventIdentity = {
  readonly id?: string;
  readonly chatThreadId: string;
  readonly runId?: string | null;
  readonly runGroupId?: string | null;
  readonly createdAt?: Date;
};

type ChatEventDisplayContext =
  | {
      readonly slackContext: {
        readonly channelId: string;
        readonly messageTs: string;
        readonly botUserId: string;
        readonly publicBrand: PublicBrand;
        readonly conversationContext: string;
        readonly messageText: string;
        readonly messageFiles: ChatSlackMessageFiles;
        readonly messageAssets: ChatSlackMessageAssets;
        readonly mentionDisplayNames: ChatSlackMentionDisplayNames;
        readonly senderDisplayName: string | null;
        readonly senderUserId: string | null;
        readonly channelType: "channel" | "dm" | "group_dm";
        readonly threadTs: string;
        readonly routeThreadTs: string | null;
      };
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext: {
        readonly conversationHistory: string;
        readonly messageText: string;
        readonly messageFiles: ChatFeishuMessageFiles;
        readonly chatType: "group" | "p2p" | "topic_group";
        readonly chatId: string;
        readonly messageId: string;
        readonly threadId: string;
        readonly replyInThread: boolean;
        readonly reactionId: string | null;
        readonly senderOpenId: string;
        readonly connectionId: string;
        readonly installationId: string;
        readonly publicBrand: PublicBrand;
      };
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext: {
        readonly tenantId: string;
        readonly teamId: string | null;
        readonly channelId: string | null;
        readonly conversationId: string;
        readonly conversationType: string | null;
        readonly activityId: string | null;
        readonly threadContext: string;
        readonly messageText: string;
        readonly messageFiles: ChatTeamsMessageFiles;
        readonly tenantName: string | null;
        readonly teamName: string | null;
        readonly threadId: string;
        readonly serviceUrl: string;
        readonly teamsAppId: string | null;
        readonly publicBrand: PublicBrand;
        readonly senderUserId: string;
        readonly senderDisplayName: string | null;
        readonly senderPrincipalName: string | null;
        readonly connectionId: string;
      };
      readonly telegramContext?: never;
      readonly githubContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext: {
        readonly chatId: string;
        readonly messageId: string;
        readonly messageThreadId: number | null;
        readonly messageText: string;
        readonly threadContext: string;
        readonly rootMessageId: string | null;
        readonly thinkingMessageId: string | null;
        readonly publicBrand: PublicBrand;
        readonly userLinkId: string;
        readonly userLinkKind: "custom" | "official";
        readonly chatType: string;
        readonly senderUserId: string | null;
        readonly senderDisplayName: string | null;
        readonly senderUsername: string | null;
        readonly senderLanguage: string | null;
      };
      readonly githubContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext: {
        readonly repo: string;
        readonly subjectNumber: number;
        readonly subjectKind: "issue" | "pull_request";
        readonly triggerCommentId: string | null;
        readonly issueContext: string;
        readonly messageText: string;
        readonly triggerReactionId: string | null;
        readonly triggerCommentBody: string | null;
        readonly publicBrand: PublicBrand;
      };
      readonly agentphoneContext?: never;
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
      readonly agentphoneContext: {
        readonly messageText: string;
        readonly threadContext: string;
        readonly messageId: string;
        readonly rootMessageId: string;
        readonly conversationId: string | null;
        readonly groupId: string | null;
        readonly channel: "imessage" | "sms" | "mms";
        readonly isGroup: boolean;
        readonly phoneHandle: string;
        readonly fromNumber: string;
        readonly toNumber: string;
        readonly userLinkId: string;
        readonly agentphoneAgentId: string;
      };
    }
  | {
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly githubContext?: never;
      readonly agentphoneContext?: never;
    };

type ChatEventInputPayload = {
  readonly userMessage: NonNullable<ChatEventPayload["userMessage"]>;
};

interface ChatAgentRunDisplayContext {
  readonly agentRunContext?: {
    readonly sourceRunId: string;
    readonly sourceChatThreadId: string;
    readonly sourceAgentId: string;
  };
}

type ChatEventOutputSequence = Pick<
  CanonicalChatEventInsert,
  "runEventSequenceNumber" | "runEventId"
>;

type InputPromptEvent = ChatEventIdentity &
  ChatEventDisplayContext &
  ChatAgentRunDisplayContext &
  ChatEventInputPayload & {
    readonly eventType: "input.prompt";
    readonly content?: null;
    readonly contextType?: "web" | "agent_run";
    readonly contextId?: string;
    readonly requiredOfficialWorkflowIds?: readonly string[];
  };

type InputAutomationEvent = ChatEventIdentity &
  Pick<ChatEventInputPayload, "userMessage"> & {
    readonly eventType: "input.automation";
    readonly content?: null;
    readonly automationId: string;
    readonly workflowName?: string;
    readonly workflowAutomationEventType?: WorkflowAutomationEventType;
    readonly workflowAutomationEventPayload?: WorkflowAutomationEventPayload;
    readonly connectorSourceId?: string;
    readonly publicBrand?: PublicBrand;
    readonly triggerBrief: string | null;
  };

type InputBudgetEvent = ChatEventIdentity &
  ChatAgentRunDisplayContext &
  Pick<ChatEventInputPayload, "userMessage"> & {
    readonly eventType: "input.budget";
    readonly content?: null;
  };

type InputRejectedEvent = ChatEventIdentity &
  ChatEventDisplayContext &
  ChatEventInputPayload &
  Pick<CanonicalChatEventInsert, "runEventSequenceNumber"> & {
    readonly eventType: "input.rejected";
    readonly content?: null;
    readonly error: string;
    readonly automationId?: string;
    readonly triggerBrief?: string | null;
  };

type OutputMessageEvent = ChatEventIdentity &
  ChatEventOutputSequence & {
    readonly eventType: "output.message";
    readonly content: string;
  };

type OutputErrorEvent = ChatEventIdentity &
  Pick<CanonicalChatEventInsert, "runEventSequenceNumber"> & {
    readonly eventType: "output.error";
    readonly content: string | null;
    readonly error: string;
  };

type OutputThinkingEvent = ChatEventIdentity &
  ChatEventOutputSequence & {
    readonly eventType: "output.thinking";
    readonly content?: null;
    readonly thinking: string;
  };

type OutputFollowupsEvent = ChatEventIdentity & {
  readonly eventType: "output.followups";
  readonly content: string;
};

type RunQueuedEvent = ChatEventIdentity & {
  readonly eventType: "run.queued";
  readonly runId: string;
  readonly content: string;
  readonly runEventId: "queue:queued";
};

type RunDequeuedEvent = ChatEventIdentity & {
  readonly eventType: "run.dequeued";
  readonly runId: string;
  readonly content?: null;
  readonly runEventId: "queue:dequeued";
};

type RunCompletedEvent = ChatEventIdentity & {
  readonly eventType: "run.completed";
  readonly runId: string;
  readonly content?: string | null;
};

type RunFailedEvent = ChatEventIdentity & {
  readonly eventType: "run.failed";
  readonly runId: string;
  readonly content?: string | null;
  readonly error?: string;
  readonly failureReason?: RunFailureReasonToken;
};

type RunCancelledEvent = ChatEventIdentity & {
  readonly eventType: "run.cancelled";
  readonly runId: string;
  readonly content?: string | null;
  readonly error?: string;
};

type ControlInterruptEvent = Omit<ChatEventIdentity, "runId"> & {
  readonly eventType: "control.interrupt";
  readonly content?: null;
  readonly interruptsRunId: string;
};

type ControlRevokeEvent = ChatEventIdentity & {
  readonly eventType: "control.revoke";
  readonly content?: null;
};

type BrowserLifecycleEvent = Pick<
  ChatEventIdentity,
  "id" | "chatThreadId" | "createdAt"
> & {
  readonly eventType: "browser.open" | "browser.close";
  readonly content?: null;
};

type UsageRecordedEvent = ChatEventIdentity & {
  readonly eventType: "usage.recorded";
  readonly runId: string;
  readonly content?: null;
  readonly usagePayload: NonNullable<ChatEventPayload["usage"]>;
};

export type NewChatEvent =
  | InputPromptEvent
  | InputAutomationEvent
  | InputBudgetEvent
  | InputRejectedEvent
  | OutputMessageEvent
  | OutputErrorEvent
  | OutputThinkingEvent
  | OutputFollowupsEvent
  | RunQueuedEvent
  | RunDequeuedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | ControlInterruptEvent
  | ControlRevokeEvent
  | BrowserLifecycleEvent
  | UsageRecordedEvent;

type AppendChatEvent = Exclude<
  NewChatEvent,
  RunDequeuedEvent | ControlRevokeEvent
>;

interface ChatEventCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
}

interface ChatEventBatchCommandResult {
  readonly id: string;
  readonly createdAt: Date;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
}

type InsertChatEventConflict = "none" | "any" | "id" | "run-lifecycle";

type PersistedChatEvent = Omit<
  CanonicalChatEventInsert,
  "seqId" | "contextType"
> &
  ChatEventContextPointer;

type ChatEventContextPointer = {
  readonly contextType?: string | null;
  readonly contextId?: CanonicalChatEventInsert["contextId"];
};

interface StoredChatEventContextPointer {
  readonly contextType: string | null;
  readonly contextId: string | null;
}

export interface LoadedChatEventReplacementTarget extends StoredChatEventContextPointer {
  readonly id: string;
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly eventType: NonNullable<CanonicalChatEventInsert["eventType"]>;
}

type NewDisplayContext =
  | {
      readonly type: "agent_run";
      readonly id: string;
      readonly sourceChatThreadId: string;
      readonly sourceAgentId: string;
    }
  | {
      readonly type: "slack";
      readonly id: string;
      readonly chatThreadId: string;
      readonly channelId: string;
      readonly messageTs: string;
      readonly botUserId: string;
      readonly publicBrand: PublicBrand;
      readonly conversationContext: string;
      readonly messageText: string;
      readonly messageFiles: ChatSlackMessageFiles;
      readonly messageAssets: ChatSlackMessageAssets;
      readonly mentionDisplayNames: ChatSlackMentionDisplayNames;
      readonly senderDisplayName: string | null;
      readonly senderUserId: string | null;
      readonly channelType: "channel" | "dm" | "group_dm";
      readonly threadTs: string;
      readonly routeThreadTs: string | null;
    }
  | {
      readonly type: "feishu";
      readonly id: string;
      readonly chatThreadId: string;
      readonly conversationHistory: string;
      readonly messageText: string;
      readonly messageFiles: ChatFeishuMessageFiles;
      readonly chatType: "group" | "p2p" | "topic_group";
      readonly chatId: string;
      readonly messageId: string;
      readonly threadId: string;
      readonly replyInThread: boolean;
      readonly reactionId: string | null;
      readonly senderOpenId: string;
      readonly connectionId: string;
      readonly installationId: string;
      readonly publicBrand: PublicBrand;
    }
  | {
      readonly type: "teams";
      readonly id: string;
      readonly chatThreadId: string;
      readonly tenantId: string;
      readonly teamId: string | null;
      readonly channelId: string | null;
      readonly conversationId: string;
      readonly conversationType: string | null;
      readonly activityId: string | null;
      readonly threadContext: string;
      readonly messageText: string;
      readonly messageFiles: ChatTeamsMessageFiles;
      readonly tenantName: string | null;
      readonly teamName: string | null;
      readonly threadId: string;
      readonly serviceUrl: string;
      readonly teamsAppId: string | null;
      readonly publicBrand: PublicBrand;
      readonly senderUserId: string;
      readonly senderDisplayName: string | null;
      readonly senderPrincipalName: string | null;
      readonly connectionId: string;
    }
  | {
      readonly type: "telegram";
      readonly id: string;
      readonly chatThreadId: string;
      readonly chatId: string;
      readonly messageId: string;
      readonly messageThreadId: number | null;
      readonly messageText: string;
      readonly threadContext: string;
      readonly rootMessageId: string | null;
      readonly thinkingMessageId: string | null;
      readonly publicBrand: PublicBrand;
      readonly userLinkId: string;
      readonly userLinkKind: "custom" | "official";
      readonly chatType: string;
      readonly senderUserId: string | null;
      readonly senderDisplayName: string | null;
      readonly senderUsername: string | null;
      readonly senderLanguage: string | null;
    }
  | {
      readonly type: "github";
      readonly id: string;
      readonly chatThreadId: string;
      readonly repo: string;
      readonly subjectNumber: number;
      readonly subjectKind: "issue" | "pull_request";
      readonly triggerCommentId: string | null;
      readonly issueContext: string;
      readonly messageText: string;
      readonly triggerReactionId: string | null;
      readonly triggerCommentBody: string | null;
      readonly publicBrand: PublicBrand;
    }
  | {
      readonly type: "agentphone";
      readonly id: string;
      readonly chatThreadId: string;
      readonly messageText: string;
      readonly threadContext: string;
      readonly messageId: string;
      readonly rootMessageId: string;
      readonly conversationId: string | null;
      readonly groupId: string | null;
      readonly channel: "imessage" | "sms" | "mms";
      readonly isGroup: boolean;
      readonly phoneHandle: string;
      readonly fromNumber: string;
      readonly toNumber: string;
      readonly userLinkId: string;
      readonly agentphoneAgentId: string;
    }
  | {
      readonly type: "automation";
      readonly id: string;
      readonly chatThreadId: string;
      readonly automationId: string;
      readonly workflowName: string | null;
      readonly workflowAutomationEventType: WorkflowAutomationEventType | null;
      readonly workflowAutomationEventPayload: WorkflowAutomationEventPayload | null;
      readonly connectorSourceId: string | null;
      readonly publicBrand: PublicBrand;
      readonly triggerBrief: string | null;
    };

function newAutomationDisplayContext(
  eventId: string,
  values: NewChatEvent,
): Extract<NewDisplayContext, { readonly type: "automation" }> | undefined {
  const automationId =
    "automationId" in values ? values.automationId : undefined;
  if (automationId === undefined) {
    return undefined;
  }
  return {
    type: "automation",
    id: eventId,
    chatThreadId: values.chatThreadId,
    automationId,
    workflowName:
      "workflowName" in values ? (values.workflowName ?? null) : null,
    workflowAutomationEventType:
      "workflowAutomationEventType" in values
        ? (values.workflowAutomationEventType ?? null)
        : null,
    workflowAutomationEventPayload:
      "workflowAutomationEventPayload" in values
        ? (values.workflowAutomationEventPayload ?? null)
        : null,
    connectorSourceId:
      "connectorSourceId" in values ? (values.connectorSourceId ?? null) : null,
    publicBrand: PUBLIC_BRAND,
    triggerBrief:
      "triggerBrief" in values ? (values.triggerBrief ?? null) : null,
  };
}

function newDisplayContext(
  eventId: string,
  values: NewChatEvent,
): NewDisplayContext | undefined {
  const agentRunContext =
    "agentRunContext" in values ? values.agentRunContext : undefined;
  if (agentRunContext !== undefined) {
    return {
      type: "agent_run",
      id: agentRunContext.sourceRunId,
      sourceChatThreadId: agentRunContext.sourceChatThreadId,
      sourceAgentId: agentRunContext.sourceAgentId,
    };
  }

  const slackContext =
    "slackContext" in values ? values.slackContext : undefined;
  if (slackContext !== undefined) {
    return {
      type: "slack",
      id: eventId,
      chatThreadId: values.chatThreadId,
      channelId: slackContext.channelId,
      messageTs: slackContext.messageTs,
      botUserId: slackContext.botUserId,
      publicBrand: PUBLIC_BRAND,
      conversationContext: slackContext.conversationContext,
      messageText: slackContext.messageText,
      messageFiles: slackContext.messageFiles,
      messageAssets: slackContext.messageAssets,
      mentionDisplayNames: slackContext.mentionDisplayNames,
      senderDisplayName: slackContext.senderDisplayName,
      senderUserId: slackContext.senderUserId,
      channelType: slackContext.channelType,
      threadTs: slackContext.threadTs,
      routeThreadTs: slackContext.routeThreadTs,
    };
  }

  const feishuContext =
    "feishuContext" in values ? values.feishuContext : undefined;
  if (feishuContext !== undefined) {
    return {
      type: "feishu",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...feishuContext,
      publicBrand: PUBLIC_BRAND,
    };
  }

  const teamsContext =
    "teamsContext" in values ? values.teamsContext : undefined;
  if (teamsContext !== undefined) {
    return {
      type: "teams",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...teamsContext,
      publicBrand: PUBLIC_BRAND,
    };
  }

  const telegramContext =
    "telegramContext" in values ? values.telegramContext : undefined;
  if (telegramContext !== undefined) {
    return {
      type: "telegram",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...telegramContext,
      publicBrand: PUBLIC_BRAND,
    };
  }

  const githubContext =
    "githubContext" in values ? values.githubContext : undefined;
  if (githubContext !== undefined) {
    return {
      type: "github",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...githubContext,
      publicBrand: PUBLIC_BRAND,
    };
  }

  const agentphoneContext =
    "agentphoneContext" in values ? values.agentphoneContext : undefined;
  if (agentphoneContext !== undefined) {
    return {
      type: "agentphone",
      id: eventId,
      chatThreadId: values.chatThreadId,
      ...agentphoneContext,
    };
  }

  const automationContext = newAutomationDisplayContext(eventId, values);
  if (automationContext !== undefined) {
    return automationContext;
  }

  return undefined;
}

function displayContextPointer(
  context: NewDisplayContext | undefined,
): ChatEventContextPointer | undefined {
  if (!context) {
    return undefined;
  }
  return {
    contextType: context.type,
    contextId: context.id,
  };
}

function replacementContext(
  target: StoredChatEventContextPointer,
  eventId: string,
  values: NewChatEvent,
): {
  readonly pointer: ChatEventContextPointer | undefined;
  readonly displayContext: NewDisplayContext | undefined;
} {
  if (target.contextType !== null || values.eventType === "usage.recorded") {
    return {
      pointer: {
        contextType: target.contextType,
        contextId: target.contextId,
      },
      displayContext: undefined,
    };
  }
  const displayContext = newDisplayContext(eventId, values);
  return {
    pointer: displayContextPointer(displayContext),
    displayContext,
  };
}

async function insertAgentphoneDisplayContext(
  tx: ChatEventWriteTransaction,
  context: Extract<NewDisplayContext, { readonly type: "agentphone" }>,
  createdAt: Date,
): Promise<void> {
  await tx
    .insert(chatAgentphoneContext)
    .values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      messageText: context.messageText,
      threadContext: context.threadContext,
      messageId: context.messageId,
      rootMessageId: context.rootMessageId,
      conversationId: context.conversationId,
      groupId: context.groupId,
      channel: context.channel,
      isGroup: context.isGroup,
      phoneHandle: context.phoneHandle,
      fromNumber: context.fromNumber,
      toNumber: context.toNumber,
      userLinkId: context.userLinkId,
      agentphoneAgentId: context.agentphoneAgentId,
      createdAt,
    })
    .onConflictDoNothing();
}

async function insertTelegramDisplayContext(
  tx: ChatEventWriteTransaction,
  context: Extract<NewDisplayContext, { readonly type: "telegram" }>,
  createdAt: Date,
): Promise<void> {
  await tx
    .insert(chatTelegramContext)
    .values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      chatId: context.chatId,
      messageId: context.messageId,
      messageThreadId: context.messageThreadId,
      messageText: context.messageText,
      threadContext: context.threadContext,
      rootMessageId: context.rootMessageId,
      thinkingMessageId: context.thinkingMessageId,
      publicBrand: context.publicBrand,
      userLinkId: context.userLinkId,
      userLinkKind: context.userLinkKind,
      chatType: context.chatType,
      senderUserId: context.senderUserId,
      senderDisplayName: context.senderDisplayName,
      senderUsername: context.senderUsername,
      senderLanguage: context.senderLanguage,
      createdAt,
    })
    .onConflictDoNothing();
}

async function insertAgentRunDisplayContext(
  tx: ChatEventWriteTransaction,
  context: Extract<NewDisplayContext, { readonly type: "agent_run" }>,
  createdAt: Date,
): Promise<void> {
  const [source] = await tx
    .select({
      sourceUserId: chatThreads.userId,
      sourceOrgId: agents.orgId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, context.sourceChatThreadId),
        eq(agents.id, context.sourceAgentId),
      ),
    );
  if (!source) {
    return;
  }
  await tx
    .insert(chatAgentRunContext)
    .values({
      id: context.id,
      sourceChatThreadId: context.sourceChatThreadId,
      sourceAgentId: context.sourceAgentId,
      ...source,
      createdAt,
    })
    .onConflictDoNothing({ target: chatAgentRunContext.id });
}

async function insertAutomationDisplayContext(
  tx: ChatEventWriteTransaction,
  context: Extract<NewDisplayContext, { readonly type: "automation" }>,
  createdAt: Date,
): Promise<void> {
  await tx
    .insert(chatAutomationContext)
    .values({
      id: context.id,
      chatThreadId: context.chatThreadId,
      automationId: context.automationId,
      workflowName: context.workflowName,
      eventType: context.workflowAutomationEventType,
      eventPayload: context.workflowAutomationEventPayload,
      connectorSourceId: context.connectorSourceId,
      publicBrand: context.publicBrand,
      triggerBrief: context.triggerBrief,
      createdAt,
    })
    .onConflictDoNothing();
  return;
}

async function insertDisplayContext(
  tx: ChatEventWriteTransaction,
  context: NewDisplayContext,
  createdAt: Date,
): Promise<void> {
  if (context.type === "agent_run") {
    await insertAgentRunDisplayContext(tx, context, createdAt);
    return;
  }
  if (context.type === "slack") {
    await tx
      .insert(chatSlackContext)
      .values({
        id: context.id,
        chatThreadId: context.chatThreadId,
        channelId: context.channelId,
        messageTs: context.messageTs,
        botUserId: context.botUserId,
        publicBrand: context.publicBrand,
        conversationContext: context.conversationContext,
        messageText: context.messageText,
        messageFiles: context.messageFiles,
        messageAssets: context.messageAssets,
        mentionDisplayNames: context.mentionDisplayNames,
        senderDisplayName: context.senderDisplayName,
        senderUserId: context.senderUserId,
        channelType: context.channelType,
        threadTs: context.threadTs,
        routeThreadTs: context.routeThreadTs,
        createdAt,
      })
      .onConflictDoNothing();
    return;
  }
  if (context.type === "feishu") {
    await tx
      .insert(chatFeishuContext)
      .values({
        id: context.id,
        chatThreadId: context.chatThreadId,
        conversationHistory: context.conversationHistory,
        messageText: context.messageText,
        messageFiles: context.messageFiles,
        chatType: context.chatType,
        chatId: context.chatId,
        messageId: context.messageId,
        threadId: context.threadId,
        replyInThread: context.replyInThread,
        reactionId: context.reactionId,
        senderOpenId: context.senderOpenId,
        connectionId: context.connectionId,
        installationId: context.installationId,
        publicBrand: context.publicBrand,
        createdAt,
      })
      .onConflictDoNothing();
    return;
  }
  if (context.type === "teams") {
    await tx
      .insert(chatTeamsContext)
      .values({
        id: context.id,
        chatThreadId: context.chatThreadId,
        tenantId: context.tenantId,
        teamId: context.teamId,
        channelId: context.channelId,
        conversationId: context.conversationId,
        conversationType: context.conversationType,
        activityId: context.activityId,
        threadContext: context.threadContext,
        messageText: context.messageText,
        messageFiles: context.messageFiles,
        tenantName: context.tenantName,
        teamName: context.teamName,
        threadId: context.threadId,
        serviceUrl: context.serviceUrl,
        teamsAppId: context.teamsAppId,
        publicBrand: context.publicBrand,
        senderUserId: context.senderUserId,
        senderDisplayName: context.senderDisplayName,
        senderPrincipalName: context.senderPrincipalName,
        connectionId: context.connectionId,
        createdAt,
      })
      .onConflictDoNothing();
    return;
  }
  if (context.type === "telegram") {
    await insertTelegramDisplayContext(tx, context, createdAt);
    return;
  }
  if (context.type === "github") {
    await tx
      .insert(chatGithubContext)
      .values({
        id: context.id,
        chatThreadId: context.chatThreadId,
        repo: context.repo,
        subjectNumber: context.subjectNumber,
        subjectKind: context.subjectKind,
        triggerCommentId: context.triggerCommentId,
        issueContext: context.issueContext,
        messageText: context.messageText,
        triggerReactionId: context.triggerReactionId,
        triggerCommentBody: context.triggerCommentBody,
        publicBrand: context.publicBrand,
        createdAt,
      })
      .onConflictDoNothing();
    return;
  }
  if (context.type === "agentphone") {
    return insertAgentphoneDisplayContext(tx, context, createdAt);
  }
  if (context.type === "automation") {
    await insertAutomationDisplayContext(tx, context, createdAt);
  }
}

function canonicalChatEventPayload(
  values: NewChatEvent,
): ChatEventPayload | null {
  const content = "content" in values ? values.content : undefined;
  const userMessage = "userMessage" in values ? values.userMessage : undefined;
  const thinking = "thinking" in values ? values.thinking : undefined;
  const error = "error" in values ? values.error : undefined;
  const usagePayload =
    "usagePayload" in values ? values.usagePayload : undefined;
  const payload: ChatEventPayload = {
    ...(content === null || content === undefined ? {} : { content }),
    ...(userMessage === null || userMessage === undefined
      ? {}
      : { userMessage }),
    ...(thinking === null || thinking === undefined ? {} : { thinking }),
    ...(error === null || error === undefined ? {} : { error }),
    ...(usagePayload === null || usagePayload === undefined
      ? {}
      : { usage: usagePayload }),
  };
  return Object.keys(payload).length === 0 ? null : payload;
}

function canonicalChatEventContext(
  values: NewChatEvent,
  overrides?: ChatEventContextPointer,
) {
  const runGroupId = "runGroupId" in values ? values.runGroupId : undefined;
  const context =
    runGroupId === null || runGroupId === undefined
      ? {
          contextType: "contextType" in values ? values.contextType : undefined,
          contextId: "contextId" in values ? values.contextId : undefined,
        }
      : { contextType: "goal" as const, contextId: runGroupId };
  // Replacement provenance is authoritative, including explicit null pointers.
  return { ...context, ...overrides };
}

/** Map the public event command into its canonical storage representation. */
function canonicalChatEventValues(
  values: NewChatEvent,
  overrides?: ChatEventContextPointer & Pick<CanonicalChatEventInsert, "id">,
): PersistedChatEvent {
  const { contextType, contextId } = canonicalChatEventContext(
    values,
    overrides,
  );

  return {
    id: overrides?.id ?? values.id,
    chatThreadId: values.chatThreadId,
    runId:
      values.eventType === "control.interrupt"
        ? values.interruptsRunId
        : "runId" in values
          ? values.runId
          : undefined,
    eventType: values.eventType,
    payload: canonicalChatEventPayload(values),
    failureReason:
      values.eventType === "run.failed" ? values.failureReason : undefined,
    requiredOfficialWorkflowIds:
      "requiredOfficialWorkflowIds" in values
        ? values.requiredOfficialWorkflowIds
        : undefined,
    contextType,
    contextId,
    runEventSequenceNumber:
      "runEventSequenceNumber" in values
        ? values.runEventSequenceNumber
        : undefined,
    runEventId: "runEventId" in values ? values.runEventId : undefined,
    createdAt: values.createdAt,
  };
}

interface PreparedChatEvent {
  readonly row: PreparedChatEventRow;
  readonly displayContext: NewDisplayContext | undefined;
}

/** Pure preparation: IDs, timestamps, payload and context do not require a lock. */
function prepareChatEvent(values: AppendChatEvent): PreparedChatEvent {
  const id = values.id ?? randomUUID();
  const createdAt = values.createdAt ?? nowDate();
  const displayContext = newDisplayContext(id, values);
  return {
    row: {
      ...canonicalChatEventValues(values, {
        id,
        ...displayContextPointer(displayContext),
      }),
      id,
      createdAt,
    },
    displayContext,
  };
}

/**
 * Context is required event data. Split mode writes it before the append so a
 * failure rejects the input; legacy mode writes it after the append inside the
 * caller's transaction.
 */
async function persistPreparedChatEventContext(
  db: ChatEventWriteTransaction,
  prepared: PreparedChatEvent,
): Promise<void> {
  const context = prepared.displayContext;
  if (!context) {
    return;
  }
  await insertDisplayContext(db, context, prepared.row.createdAt);
}

/** Slow-path telemetry separates allocation/lock wait from event insertion. */
function recordChatEventAppendTiming(timing: {
  readonly mode: "legacy" | "split";
  readonly attemptedEvents?: number;
  readonly insertedEvents: number;
  readonly statementDurationMs: number;
  readonly allocationDurationMs?: number;
  readonly insertDurationMs?: number;
}): void {
  log.debug("Chat event append statement finished", timing);
  if (timing.statementDurationMs >= 250) {
    log.warn("Chat event append exceeded 250 ms", timing);
  }
}

/** The caller independently prepares/persists context before this atomic append. */
async function appendPreparedChatEvent(
  db: ChatEventWriteTransaction,
  prepared: PreparedChatEvent,
  conflict: InsertChatEventConflict = "none",
  options?: ChatEventWriteOptions,
): Promise<ChatEventCommandResult | null> {
  const splitWrites =
    options?.splitWrites ?? (await isSplitChatEventWriteEnabled(db));
  const startedAt = performance.now();
  const rows = await appendCanonicalChatEvents(
    db,
    [prepared.row],
    conflict,
    splitWrites,
  );
  recordChatEventAppendTiming({
    mode: splitWrites ? "split" : "legacy",
    insertedEvents: rows.length,
    statementDurationMs: performance.now() - startedAt,
    allocationDurationMs: rows[0]?.allocationDurationMs,
    insertDurationMs: rows[0]?.insertDurationMs,
  });
  const inserted = rows[0];
  return inserted
    ? { id: inserted.id, createdAt: inserted.createdAt, seqId: inserted.seqId }
    : null;
}

/** Legacy callers keep their control transaction; ordinary split writes pass DB. */
export async function insertChatEvent(
  db: ChatEventWriteTransaction,
  values: AppendChatEvent,
  conflict: InsertChatEventConflict = "none",
  options?: ChatEventWriteOptions,
): Promise<ChatEventCommandResult | null> {
  const prepared = prepareChatEvent(values);
  const splitWrites =
    options?.splitWrites ?? (await isSplitChatEventWriteEnabled(db));
  if (splitWrites) {
    await persistPreparedChatEventContext(db, prepared);
  }
  const inserted = await appendPreparedChatEvent(db, prepared, conflict, {
    splitWrites,
  });
  if (inserted && !splitWrites) {
    await persistPreparedChatEventContext(db, prepared);
  }
  return inserted;
}

/** Reserve N and insert atomically, preserving every existing idempotency index. */
export async function insertChatEvents(
  db: ChatEventWriteTransaction,
  values: readonly AppendChatEvent[],
  options?: ChatEventWriteOptions,
): Promise<readonly ChatEventBatchCommandResult[]> {
  if (values.length === 0) {
    return [];
  }
  const prepared = values.map(prepareChatEvent);
  const splitWrites =
    options?.splitWrites ?? (await isSplitChatEventWriteEnabled(db));
  if (splitWrites) {
    for (const event of prepared) {
      await persistPreparedChatEventContext(db, event);
    }
  }
  const startedAt = performance.now();
  const rows = await appendCanonicalChatEvents(
    db,
    prepared.map((event) => {
      return event.row;
    }),
    "any",
    splitWrites,
  );
  recordChatEventAppendTiming({
    mode: splitWrites ? "split" : "legacy",
    attemptedEvents: values.length,
    insertedEvents: rows.length,
    statementDurationMs: performance.now() - startedAt,
    allocationDurationMs: rows[0]?.allocationDurationMs,
    insertDurationMs: rows[0]?.insertDurationMs,
  });
  if (!splitWrites) {
    const insertedIds = new Set(
      rows.map((row) => {
        return row.id;
      }),
    );
    for (const event of prepared) {
      if (insertedIds.has(event.row.id)) {
        await persistPreparedChatEventContext(db, event);
      }
    }
  }
  return rows.map(({ id, createdAt, seqId, sequenceNumber }) => {
    return { id, createdAt, seqId, sequenceNumber };
  });
}

/** Append a replacement event after validating its immutable revoke edge. */
export async function replaceChatEvent(
  tx: ChatEventWriteTransaction,
  eventId: string,
  replacement: NewChatEvent,
): Promise<ChatEventCommandResult | null> {
  const [target] = await tx
    .select({
      id: chatEvents.id,
      chatThreadId: chatEvents.chatThreadId,
      createdAt: chatEvents.createdAt,
      eventType: chatEvents.eventType,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
    })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  if (!target) {
    throw new Error("Cannot revoke a missing chat event");
  }
  return await replaceLoadedChatEvent(tx, target, replacement);
}

/** Append a replacement for a target already loaded by an authoritative read. */
export async function replaceLoadedChatEvent(
  tx: ChatEventWriteTransaction,
  target: LoadedChatEventReplacementTarget,
  replacement: NewChatEvent,
): Promise<ChatEventCommandResult | null> {
  if (target.chatThreadId !== replacement.chatThreadId) {
    throw new Error("Cannot revoke a chat event from another thread");
  }
  if (replacement.id === target.id) {
    throw new Error("A chat event cannot revoke itself");
  }
  const createdAt =
    replacement.createdAt ??
    new Date(Math.max(nowDate().getTime(), target.createdAt.getTime() + 1));
  if (createdAt <= target.createdAt) {
    throw new Error("A chat event can only revoke an earlier event");
  }
  if (!isValidChatEventRevocation(replacement.eventType, target.eventType)) {
    throw new Error(
      `Invalid chat event revocation: ${replacement.eventType} -> ${target.eventType}`,
    );
  }

  const replacementId = replacement.id ?? randomUUID();
  const { pointer: contextPointer, displayContext } = replacementContext(
    target,
    replacementId,
    replacement,
  );
  const prepared: PreparedChatEvent = {
    row: {
      ...canonicalChatEventValues(
        { ...replacement, createdAt },
        {
          id: replacementId,
          ...contextPointer,
        },
      ),
      id: replacementId,
      createdAt,
      revokesEventId: target.id,
    },
    displayContext,
  };
  const splitWrites = await isSplitChatEventWriteEnabled(tx);
  if (splitWrites) {
    await persistPreparedChatEventContext(tx, prepared);
  }
  const inserted = await appendPreparedChatEvent(tx, prepared, "any", {
    splitWrites,
  });
  if (inserted && !splitWrites) {
    await persistPreparedChatEventContext(tx, prepared);
  }
  return inserted;
}

/** Append a payload-free revocation event for an existing chat event. */
export async function revokeChatEvent(
  tx: ChatEventWriteTransaction,
  eventId: string,
  revocation: ControlRevokeEvent | RunDequeuedEvent,
): Promise<ChatEventCommandResult | null> {
  return await replaceChatEvent(tx, eventId, {
    ...revocation,
    content: null,
  });
}
