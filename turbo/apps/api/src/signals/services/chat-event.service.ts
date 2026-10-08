/** Typed append-only commands for the canonical ChatEvent stream. */
import {
  chatInputModelSelectionSchema,
  type ChatInputModelSelection,
} from "@okouai/api-contracts/contracts/chat-input-model";
import { randomUUID } from "node:crypto";
import {
  chatEventTypeSchema,
  isValidChatEventRevocation,
} from "@okouai/api-contracts/contracts/chat-events";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
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
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  and,
  eq,
  getTableColumns,
  sql,
  type InferInsertModel,
  type SQL,
} from "drizzle-orm";
import { PgDialect, QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { pgTimestampWithoutTimezoneToDateSchema } from "../../lib/db-raw-rows";
import { agents } from "@okouai/db/schema/agent";
import { nowDate } from "../../lib/time";
import type {
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import {
  appendCanonicalChatEventsSql,
  type PreparedChatEventRow,
} from "./chat-event-append.service";

import { canonicalChatInputModelSelection } from "./canonical-chat-event-read.service";

type CanonicalChatEventInsert = typeof chatEvents.$inferInsert;

type ChatEventIdentity = {
  readonly id?: string;
  readonly chatThreadId: string;
  readonly runId?: string | null;
  readonly createdAt?: Date;
};

/** Complete provider-owned snapshot; event identity and time belong to Chat. */
export type DiscordChatEventContext = Readonly<
  Omit<
    typeof chatDiscordContext.$inferSelect,
    "id" | "chatThreadId" | "createdAt"
  >
>;

type ChatEventDisplayContext =
  | {
      readonly discordContext: DiscordChatEventContext;
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly discordContext?: never;
      readonly slackContext: {
        readonly channelId: string;
        readonly messageTs: string;
        readonly botUserId: string;
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
      readonly agentphoneContext?: never;
    }
  | {
      readonly discordContext?: never;
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
      };
      readonly teamsContext?: never;
      readonly telegramContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly discordContext?: never;
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
        readonly senderUserId: string;
        readonly senderDisplayName: string | null;
        readonly senderPrincipalName: string | null;
        readonly connectionId: string;
      };
      readonly telegramContext?: never;
      readonly agentphoneContext?: never;
    }
  | {
      readonly discordContext?: never;
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
        readonly userLinkId: string;
        readonly userLinkKind: "official";
        readonly chatType: string;
        readonly senderUserId: string | null;
        readonly senderDisplayName: string | null;
        readonly senderUsername: string | null;
        readonly senderLanguage: string | null;
      };
      readonly agentphoneContext?: never;
    }
  | {
      readonly discordContext?: never;
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
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
      readonly discordContext?: never;
      readonly slackContext?: never;
      readonly feishuContext?: never;
      readonly teamsContext?: never;
      readonly telegramContext?: never;
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
    readonly modelSelection?: ChatInputModelSelection;
    readonly content?: null;
    readonly contextType?: "web" | "agent_run";
    readonly contextId?: string;
    readonly requiredOfficialWorkflowIds?: readonly string[];
  };

type InputAutomationEvent = ChatEventIdentity &
  Pick<ChatEventInputPayload, "userMessage"> & {
    readonly eventType: "input.automation";
    readonly modelSelection?: ChatInputModelSelection;
    readonly content?: null;
    readonly automationId: string;
    readonly workflowName?: string;
    readonly workflowAutomationEventType?: WorkflowAutomationEventType;
    readonly workflowAutomationEventPayload?: WorkflowAutomationEventPayload;
    readonly connectorSourceId?: string;
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
    readonly contextType?: "web";
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

type OutputFollowupsEvent = ChatEventIdentity & {
  readonly eventType: "output.followups";
  readonly content: string;
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
  | OutputFollowupsEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | ControlInterruptEvent
  | ControlRevokeEvent
  | UsageRecordedEvent;

type AppendChatEvent = Exclude<NewChatEvent, ControlRevokeEvent>;

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
  readonly modelSelection?: ChatInputModelSelection | null;
  readonly id: string;
  readonly chatThreadId: string;
  readonly createdAt: Date;
  readonly eventType: NonNullable<CanonicalChatEventInsert["eventType"]>;
}

type NewDisplayContext =
  | {
      readonly type: "discord";
      readonly id: string;
      readonly chatThreadId: string;
      readonly snapshot: DiscordChatEventContext;
    }
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
      readonly userLinkId: string;
      readonly userLinkKind: "official";
      readonly chatType: string;
      readonly senderUserId: string | null;
      readonly senderDisplayName: string | null;
      readonly senderUsername: string | null;
      readonly senderLanguage: string | null;
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

  const discordContext =
    "discordContext" in values ? values.discordContext : undefined;
  if (discordContext !== undefined) {
    return {
      type: "discord",
      id: eventId,
      chatThreadId: values.chatThreadId,
      snapshot: discordContext,
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

/** Construct a schema-encoded INSERT without a session or database capability. */
function contextInsertSql<T extends PgTable>(
  table: T,
  values: InferInsertModel<T>,
  onConflict: SQL = sql`do nothing`,
): SQL {
  const columns = getTableColumns(table);
  return new PgDialect().buildInsertQuery({
    table,
    values: [
      Object.fromEntries(
        Object.entries(values).map(([key, value]) => {
          return [key, sql.param(value, columns[key])];
        }),
      ),
    ],
    onConflict,
  });
}

function insertAgentphoneDisplayContext(
  context: Extract<NewDisplayContext, { readonly type: "agentphone" }>,
  createdAt: Date,
): SQL {
  return contextInsertSql(chatAgentphoneContext, {
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
  });
}

function insertTelegramDisplayContext(
  context: Extract<NewDisplayContext, { readonly type: "telegram" }>,
  createdAt: Date,
): SQL {
  return contextInsertSql(chatTelegramContext, {
    id: context.id,
    chatThreadId: context.chatThreadId,
    chatId: context.chatId,
    messageId: context.messageId,
    messageThreadId: context.messageThreadId,
    messageText: context.messageText,
    threadContext: context.threadContext,
    rootMessageId: context.rootMessageId,
    thinkingMessageId: context.thinkingMessageId,
    userLinkId: context.userLinkId,
    userLinkKind: context.userLinkKind,
    chatType: context.chatType,
    senderUserId: context.senderUserId,
    senderDisplayName: context.senderDisplayName,
    senderUsername: context.senderUsername,
    senderLanguage: context.senderLanguage,
    createdAt,
  });
}

function insertAgentRunDisplayContext(
  context: Extract<NewDisplayContext, { readonly type: "agent_run" }>,
  createdAt: Date,
): SQL {
  const source = new QueryBuilder()
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
  return sql`INSERT INTO ${chatAgentRunContext} (
    id, source_chat_thread_id, source_agent_id, source_user_id, source_org_id, created_at
  ) SELECT ${context.id}::uuid, ${context.sourceChatThreadId}::uuid,
    ${context.sourceAgentId}::uuid, source.user_id, source.org_id,
    ${createdAt.toISOString()}::timestamp
    FROM (${source.getSQL()}) AS source
    ON CONFLICT (id) DO NOTHING`;
}

function insertAutomationDisplayContext(
  context: Extract<NewDisplayContext, { readonly type: "automation" }>,
  createdAt: Date,
): SQL {
  return contextInsertSql(chatAutomationContext, {
    id: context.id,
    chatThreadId: context.chatThreadId,
    automationId: context.automationId,
    workflowName: context.workflowName,
    eventType: context.workflowAutomationEventType,
    eventPayload: context.workflowAutomationEventPayload,
    connectorSourceId: context.connectorSourceId,
    triggerBrief: context.triggerBrief,
    createdAt,
  });
}

function insertDiscordDisplayContext(
  context: Extract<NewDisplayContext, { readonly type: "discord" }>,
  createdAt: Date,
): SQL {
  return contextInsertSql(
    chatDiscordContext,
    {
      ...context.snapshot,
      id: context.id,
      chatThreadId: context.chatThreadId,
      createdAt,
    },
    sql`(${sql.identifier("id")}) do nothing`,
  );
}

function insertDisplayContext(
  context: NewDisplayContext,
  createdAt: Date,
): SQL {
  if (context.type === "agent_run") {
    return insertAgentRunDisplayContext(context, createdAt);
  }
  if (context.type === "discord") {
    return insertDiscordDisplayContext(context, createdAt);
  }
  if (context.type === "slack") {
    return contextInsertSql(chatSlackContext, {
      id: context.id,
      chatThreadId: context.chatThreadId,
      channelId: context.channelId,
      messageTs: context.messageTs,
      botUserId: context.botUserId,
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
    });
  }
  if (context.type === "feishu") {
    return contextInsertSql(chatFeishuContext, {
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
      createdAt,
    });
  }
  if (context.type === "teams") {
    return contextInsertSql(chatTeamsContext, {
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
      senderUserId: context.senderUserId,
      senderDisplayName: context.senderDisplayName,
      senderPrincipalName: context.senderPrincipalName,
      connectionId: context.connectionId,
      createdAt,
    });
  }
  if (context.type === "telegram") {
    return insertTelegramDisplayContext(context, createdAt);
  }
  if (context.type === "agentphone") {
    return insertAgentphoneDisplayContext(context, createdAt);
  }
  return insertAutomationDisplayContext(context, createdAt);
}

function canonicalChatEventPayload(
  values: NewChatEvent,
): ChatEventPayload | null {
  const content = "content" in values ? values.content : undefined;
  const userMessage = "userMessage" in values ? values.userMessage : undefined;
  const error = "error" in values ? values.error : undefined;
  const usagePayload =
    "usagePayload" in values ? values.usagePayload : undefined;
  const payload: ChatEventPayload = {
    ...(content === null || content === undefined ? {} : { content }),
    ...(userMessage === null || userMessage === undefined
      ? {}
      : { userMessage }),
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
  const context = {
    contextType: "contextType" in values ? values.contextType : undefined,
    contextId: "contextId" in values ? values.contextId : undefined,
  };
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
    modelSelection:
      "modelSelection" in values ? values.modelSelection : undefined,
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
export function prepareChatEvent(values: AppendChatEvent): PreparedChatEvent {
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

/** Pure context plan. The enqueue owner executes it after reserving the event
 * sequence, in the same transaction, to preserve thread lock ordering. */
export function chatEventContextInsertSql(
  values: AppendChatEvent & { readonly id: string },
): SQL | null {
  const context = newDisplayContext(values.id, values);
  return context
    ? insertDisplayContext(context, values.createdAt ?? nowDate())
    : null;
}

/** The caller independently persists context before this atomic append. */
export function chatEventInsertSql(
  values: AppendChatEvent,
  conflict: InsertChatEventConflict = "none",
): SQL {
  return appendCanonicalChatEventsSql([prepareChatEvent(values).row], conflict);
}

/** Empty batches reserve nothing and return no rows. */
export function chatEventsInsertSql(values: readonly AppendChatEvent[]): SQL {
  return appendCanonicalChatEventsSql(
    values.map((value) => {
      return prepareChatEvent(value).row;
    }),
    "any",
  );
}

export const chatEventReplacementTargetSchema = z.object({
  id: z.string().uuid(),
  chatThreadId: z.string().uuid(),
  createdAt: pgTimestampWithoutTimezoneToDateSchema,
  eventType: chatEventTypeSchema,
  contextType: z.string().nullable(),
  contextId: z.string().uuid().nullable(),
  modelSelection: chatInputModelSelectionSchema.nullable(),
});

/** Execute on the caller's transaction when replacement needs its snapshot. */
export function chatEventReplacementTargetSql(eventId: string): SQL {
  return new QueryBuilder()
    .select({
      id: chatEvents.id,
      chatThreadId: sql`${chatEvents.chatThreadId}`.as("chatThreadId"),
      createdAt: sql`${chatEvents.createdAt}::text`.as("createdAt"),
      eventType: sql`${chatEvents.eventType}`.as("eventType"),
      contextType: sql`${chatEvents.contextType}`.as("contextType"),
      contextId: sql`${chatEvents.contextId}`.as("contextId"),
      modelSelection: canonicalChatInputModelSelection().as("modelSelection"),
    })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1)
    .getSQL();
}

export function requireChatEventReplacementTarget(
  rows: readonly LoadedChatEventReplacementTarget[],
): LoadedChatEventReplacementTarget {
  const target = rows[0];
  if (!target) {
    throw new Error("Cannot revoke a missing chat event");
  }
  return target;
}

/** Append a replacement for a target already loaded by an authoritative read. */
export function chatEventReplacementInsertSql(
  target: LoadedChatEventReplacementTarget,
  replacement: NewChatEvent,
): SQL {
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
  // Claims and rejections retain their input's context. A new input revoking
  // an output uses the context already written by its entry transaction.
  const contextPointer =
    target.contextType !== null || replacement.eventType === "usage.recorded"
      ? { contextType: target.contextType, contextId: target.contextId }
      : displayContextPointer(newDisplayContext(replacementId, replacement));
  const prepared: PreparedChatEvent = {
    row: {
      ...canonicalChatEventValues(
        { ...replacement, createdAt },
        {
          id: replacementId,
          ...contextPointer,
        },
      ),
      modelSelection:
        "modelSelection" in replacement &&
        replacement.modelSelection !== undefined
          ? replacement.modelSelection
          : replacement.eventType === "input.prompt" ||
              replacement.eventType === "input.automation"
            ? target.modelSelection
            : undefined,
      id: replacementId,
      createdAt,
      revokesEventId: target.id,
    },
    displayContext: undefined,
  };
  return appendCanonicalChatEventsSql([prepared.row], "any");
}
