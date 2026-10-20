import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { agents } from "@okouai/db/schema/agent";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import {
  buildFeishuHelpMessage,
  buildFeishuLoginMessage,
  buildFeishuNoticeMessage,
} from "../../lib/feishu-message-card";
import {
  formatFeishuMessageContent,
  parseFeishuMessageContent,
  type FeishuPromptFile,
} from "../../lib/feishu-message-content";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  replyWithFeishuMessage,
  type FeishuHistoryMessage,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import { buildFeishuConnectUrl } from "./feishu-connect-token";
import { disconnectFeishuCustomConnectorOAuthConnection } from "./feishu-custom-connector.service";
import {
  feishuOrgChangedAdminReadPlan,
  feishuOrgChangedUserIds,
} from "./feishu-realtime.service";

interface FeishuPromptContext {
  readonly text: string;
  readonly files: readonly FeishuPromptFile[];
}

export interface FeishuInboundMessage {
  readonly platform?: FeishuPlatform;
  readonly installationId: string;
  readonly eventId: string;
  readonly tenantKey: string;
  readonly appId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "group" | "p2p" | "topic_group";
  readonly rootId: string | null;
  readonly parentId: string | null;
  readonly threadId: string | null;
  readonly openId: string;
  readonly text: string;
  readonly promptText: string;
  readonly files: readonly FeishuPromptFile[];
}

interface FeishuAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

export interface FeishuDispatchInstallation {
  readonly platform: FeishuPlatform;
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
  readonly botName: string | null;
  readonly messageReceivedAt: Date | null;
}

export interface FeishuDispatchConnection {
  readonly id: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly feishuUserName: string | null;
}

interface FeishuCommand {
  readonly name: string;
}

interface ConnectedCommandArgs {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
  readonly message: FeishuInboundMessage;
  readonly command: FeishuCommand;
}

type ConnectedDispatchArgs = Omit<ConnectedCommandArgs, "command">;

type EffectiveAgentResolution =
  | { readonly status: "resolved"; readonly agent: FeishuAgent }
  | {
      readonly status: "not_accessible" | "not_found";
    };

function parseFeishuCommand(text: string): FeishuCommand | null {
  const match = /^\/(\S+)(?:\s+.+)?$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    name: match[1]?.toLowerCase() ?? "",
  };
}

async function reply(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
    readonly outbound: FeishuOutboundMessage;
  },
  signal: AbortSignal,
): Promise<void> {
  await replyWithFeishuMessage(
    {
      db: args.db,
      installationId: args.message.installationId,
      messageId: args.message.messageId,
      message: args.outbound,
      replyInThread: true,
    },
    signal,
  );
}

async function replyNotice(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
    readonly title: string;
    readonly text: string;
    readonly kind?: "error" | "info" | "success" | "warning";
  },
  signal: AbortSignal,
): Promise<void> {
  await reply(
    {
      db: args.db,
      message: args.message,
      outbound: buildFeishuNoticeMessage({
        title: args.title,
        text: args.text,
        kind: args.kind,
      }),
    },
    signal,
  );
}

export async function replyToUnconnectedFeishuMessage(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
    readonly botName: string | null;
  },
  signal: AbortSignal,
): Promise<void> {
  const commandInput = parseFeishuCommand(args.message.text);
  if (commandInput?.name === "help") {
    await reply(
      {
        db: args.db,
        message: args.message,
        outbound: buildFeishuHelpMessage({
          platform: args.message.platform,
          botName: args.botName,
        }),
      },
      signal,
    );
    return;
  }
  if (commandInput?.name === "disconnect") {
    await reply(
      {
        db: args.db,
        message: args.message,
        outbound: buildFeishuNoticeMessage({
          title: "Not connected",
          text: "You are not connected.",
          kind: "error",
        }),
      },
      signal,
    );
    return;
  }
  const connectUrl = buildFeishuConnectUrl({
    platform: args.message.platform,
    installationId: args.message.installationId,
    openId: args.message.openId,
    chatId: args.message.chatId,
  });
  await reply(
    {
      db: args.db,
      message: args.message,
      outbound: buildFeishuLoginMessage({
        platform: args.message.platform,
        connectUrl,
      }),
    },
    signal,
  );
}

export function feishuEffectiveAgentReadPlan(args: {
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
}) {
  const composeId = args.installation.defaultAgentId;
  return {
    visibleColumns: {
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    },
    visibleCondition: and(
      eq(agents.id, composeId),
      eq(agents.orgId, args.installation.orgId),
      or(
        eq(agents.visibility, "public"),
        eq(agents.owner, args.connection.userId),
      ),
    ),
    existingColumns: { id: agents.id },
    existingCondition: and(
      eq(agents.id, composeId),
      eq(agents.orgId, args.installation.orgId),
    ),
  };
}

export function feishuEffectiveAgentFromRows(
  agent: FeishuAgent | undefined,
  existing: { readonly id: string } | undefined,
): EffectiveAgentResolution {
  if (agent) {
    return { status: "resolved", agent };
  }
  return { status: existing ? "not_accessible" : "not_found" };
}

export async function replyFeishuAgentUnavailable(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
    readonly status: "not_accessible" | "not_found";
  },
  signal: AbortSignal,
): Promise<void> {
  const providerName = FEISHU_PLATFORMS[args.message.platform ?? "feishu"].name;
  const text =
    args.status === "not_accessible"
      ? `The configured agent is not available to your ${providerName} account. Ask an admin to update the organization default agent.`
      : `The configured ${providerName} agent could not be found. Ask an admin to select another agent.`;
  await replyNotice(
    {
      db: args.db,
      message: args.message,
      title: "Agent unavailable",
      text,
      kind: "error",
    },
    signal,
  );
}

function historyMessageContext(
  message: FeishuHistoryMessage,
  platform: FeishuPlatform,
): FeishuPromptContext {
  const content = message.body?.content
    ? parseFeishuMessageContent({
        messageId: message.message_id,
        messageType: message.msg_type,
        content: message.body.content,
      })
    : null;
  if (!content) {
    return { text: `[${message.msg_type} message]`, files: [] };
  }
  const text = (message.mentions ?? []).reduce((currentText, mention) => {
    if (!mention.key) {
      return currentText;
    }
    const label = mention.name ? `@${mention.name}` : "@user";
    return currentText.replaceAll(
      mention.key,
      mention.id ? `${label} (${mention.id})` : label,
    );
  }, content.text);
  return {
    text: formatFeishuMessageContent({ text, files: content.files }, platform),
    files: content.files,
  };
}

function formatFeishuSenderBlock(message: FeishuHistoryMessage): string {
  const parts = message.sender?.id ? [`id: ${message.sender.id}`] : [];
  if (message.sender?.sender_name) {
    parts.push(`name: ${message.sender.sender_name}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

function formatFeishuContextMessage(
  message: FeishuHistoryMessage,
  relativeIndex: number,
  platform: FeishuPlatform,
): FeishuPromptContext {
  const context = historyMessageContext(message, platform);
  return {
    text: [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      formatFeishuSenderBlock(message),
      "",
      context.text,
    ].join("\n"),
    files: context.files,
  };
}

const FEISHU_CONTEXT_PREAMBLE = [
  "The messages below are from a Feishu conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
].join("\n");

function formatFeishuContext(
  header: string,
  messages: readonly FeishuHistoryMessage[],
  platform: FeishuPlatform = "feishu",
): FeishuPromptContext {
  if (messages.length === 0) {
    return { text: "", files: [] };
  }
  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    return formatFeishuContextMessage(message, index - totalMessages, platform);
  });
  return {
    text: `${header}\n\n${FEISHU_CONTEXT_PREAMBLE.replace("Feishu", FEISHU_PLATFORMS[platform].name)}\n\n${formattedMessages
      .map((context) => {
        return context.text;
      })
      .join("\n\n")}\n\n---`,
    files: formattedMessages.flatMap((context) => {
      return context.files;
    }),
  };
}

export function formatFeishuConversationHistory(
  history: readonly FeishuHistoryMessage[],
  current: FeishuInboundMessage,
  threadHistory: readonly FeishuHistoryMessage[],
): FeishuPromptContext {
  const messages = [
    ...new Map(
      [...history, ...threadHistory].map((message) => {
        return [message.message_id, message];
      }),
    ).values(),
  ]
    .filter((message) => {
      return !message.deleted && message.message_id !== current.messageId;
    })
    .sort((left, right) => {
      return Number(left.create_time ?? 0) - Number(right.create_time ?? 0);
    });
  if (messages.length === 0) {
    return { text: "", files: [] };
  }
  if (current.chatType === "p2p") {
    return formatFeishuContext(
      `# ${FEISHU_PLATFORMS[current.platform ?? "feishu"].name} Thread Context`,
      messages.slice(-30),
      current.platform,
    );
  }

  const threadKeys = new Set(
    [
      current.rootId,
      current.threadId,
      current.parentId,
      current.messageId,
    ].filter((value): value is string => {
      return Boolean(value);
    }),
  );
  const fetchedThreadIds = new Set(
    threadHistory.map((message) => {
      return message.message_id;
    }),
  );
  const threadMessages = messages.filter((message) => {
    if (fetchedThreadIds.has(message.message_id)) {
      return true;
    }
    return [
      message.thread_id,
      message.root_id,
      message.parent_id,
      message.message_id,
    ]
      .filter((value): value is string => {
        return Boolean(value);
      })
      .some((value) => {
        return threadKeys.has(value);
      });
  });
  const threadIds = new Set(
    threadMessages.map((message) => {
      return message.message_id;
    }),
  );
  const recentChat = messages
    .filter((message) => {
      return !threadIds.has(message.message_id);
    })
    .slice(-10);
  const recentContext = formatFeishuContext(
    "# Recent Channel Messages",
    recentChat,
    current.platform,
  );
  const threadContext = formatFeishuContext(
    `# ${FEISHU_PLATFORMS[current.platform ?? "feishu"].name} Thread Context`,
    threadMessages,
    current.platform,
  );
  return {
    text: [recentContext.text, threadContext.text].filter(Boolean).join("\n\n"),
    files: [...recentContext.files, ...threadContext.files],
  };
}

export function buildFeishuSystemPrompt(args: {
  readonly platform?: FeishuPlatform;
  readonly chatType: FeishuInboundMessage["chatType"];
  readonly installationId: string;
  readonly tenantKey: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly senderOpenId: string;
  readonly integrationNote: string;
  readonly history: string;
}): string {
  const platformName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const isDirectMessage = args.chatType === "p2p";
  const typeLabel = isDirectMessage ? "Direct message" : "Group mention";
  const groupIdLine = isDirectMessage
    ? ""
    : `Group ID: ${args.chatId} (same as Chat ID; use it directly as the \`--to\` value for \`okou ${args.platform ?? "feishu"} message send\`)`;
  const currentIntegration = [
    "# Current Integration",
    `You are currently running inside: ${platformName}`,
    `Scope: ${typeLabel}`,
    `Installation ID: ${args.installationId}`,
    `Tenant key: ${args.tenantKey}`,
    `Chat ID: ${args.chatId}`,
    groupIdLine,
    `Thread ID: ${args.threadId}`,
    `Message ID: ${args.messageId}`,
    `Sender open ID: ${args.senderOpenId}`,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    CONVERSATION_GUIDANCE,
    currentIntegration,
    args.integrationNote,
    args.history,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function feishuMessageReceivedValues(tenantKey: string) {
  return {
    feishuTenantKey: tenantKey,
    messageReceivedAt: nowDate(),
    updatedAt: nowDate(),
  };
}

export function feishuMessageReceivedCondition(installationId: string) {
  return and(
    eq(feishuOrgInstallations.id, installationId),
    isNull(feishuOrgInstallations.messageReceivedAt),
  );
}

async function handleDisconnectCommand(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0164; new non-billing transactions are prohibited.
  await args.db.transaction(async (tx) => {
    await disconnectFeishuCustomConnectorOAuthConnection(
      tx,
      {
        orgId: args.installation.orgId,
        userId: args.connection.userId,
        installationId: args.message.installationId,
        memberConnectorId: args.connection.connectorId,
        feishuOpenId: args.message.openId,
      },
      signal,
    );
    await tx
      .delete(feishuOrgConnections)
      .where(eq(feishuOrgConnections.id, args.connection.id));
    signal.throwIfAborted();
  });
  signal.throwIfAborted();
  await (async () => {
    const plan = feishuOrgChangedAdminReadPlan(args.installation.orgId);
    const admins = await args.db
      .select(plan.columns)
      .from(orgMembersCache)
      .where(plan.condition);
    const userIds = feishuOrgChangedUserIds(
      admins,
      args.installation.ownerUserId,
      [args.connection.userId],
    );
    if (userIds.length === 0) {
      return;
    }
    await publishUserSignal(userIds, "feishu:changed");
  })();
  await replyNotice(
    {
      db: args.db,
      message: args.message,
      title: "Disconnected",
      text: `Your ${FEISHU_PLATFORMS[args.message.platform ?? "feishu"].name} account has been disconnected and its agent access has been revoked.`,
      kind: "success",
    },
    signal,
  );
}

const handleConnectedCommand$ = command(
  async (_, args: ConnectedCommandArgs, signal: AbortSignal): Promise<void> => {
    switch (args.command.name) {
      case "help": {
        await reply(
          {
            db: args.db,
            message: args.message,
            outbound: buildFeishuHelpMessage({
              platform: args.message.platform,
              botName: args.installation.botName,
            }),
          },
          signal,
        );
        return;
      }
      case "connect": {
        await replyNotice(
          {
            db: args.db,
            message: args.message,
            title: "Already connected",
            text: `Your ${FEISHU_PLATFORMS[args.message.platform ?? "feishu"].name} account is already connected to ${BRAND_PRESENTATION.brandName}. Send a task to start working with your agent.`,
            kind: "success",
          },
          signal,
        );
        return;
      }
      case "disconnect": {
        await handleDisconnectCommand(args, signal);
        return;
      }
      default: {
        await reply(
          {
            db: args.db,
            message: args.message,
            outbound: buildFeishuHelpMessage({
              platform: args.message.platform,
              botName: args.installation.botName,
            }),
          },
          signal,
        );
      }
    }
  },
);

export const dispatchConnectedFeishuCommand$ = command(
  async (
    { set },
    args: ConnectedDispatchArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const commandInput = parseFeishuCommand(args.message.text);
    if (!commandInput) {
      return false;
    }
    await set(
      handleConnectedCommand$,
      {
        ...args,
        command: commandInput,
      },
      signal,
    );
    return true;
  },
);
