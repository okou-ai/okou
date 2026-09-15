import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { command } from "ccstate";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import {
  getBuiltInVisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { feishuUserAgentPreferences } from "@okouai/db/schema/feishu-user-agent-preference";
import { agents } from "@okouai/db/schema/agent";
import {
  buildFeishuHelpMessage,
  buildFeishuLoginMessage,
  buildFeishuNoticeMessage,
} from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  formatFeishuMessageContent,
  parseFeishuMessageContent,
  type FeishuPromptFile,
} from "../../lib/feishu-message-content";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import {
  addFeishuMessageReaction,
  listFeishuChatMessages,
  replyWithFeishuMessage,
  sendFeishuMessage,
  type FeishuHistoryMessage,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { buildFeishuConnectUrl } from "./feishu-connect-token";
import { publishCustomConnectorUserInvalidationAfterCommit } from "./connector-client-invalidation.service";
import { disconnectFeishuCustomConnectorOAuthConnection } from "./feishu-custom-connector.service";
import { publishFeishuOrgChanged } from "./feishu-realtime.service";
import { listOrgModelPolicies$ } from "./model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./user-data.service";

const L = logger("FeishuDispatch");
const FEISHU_THINKING_EMOJI = "Typing";
const FEISHU_AGENT_PICKER_MAX_OPTIONS = 100;
const FEISHU_MODEL_PICKER_MAX_OPTIONS = 100;
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

export function shouldReplyInFeishuThread(
  message: FeishuInboundMessage,
): boolean {
  return message.chatType !== "p2p" || message.threadId !== null;
}

interface FeishuAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

export interface FeishuDispatchInstallation {
  readonly platform?: FeishuPlatform;
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
  readonly botName: string | null;
  readonly messageReceivedAt: Date | null;
  readonly publicBrand: PublicBrand;
}

export interface FeishuDispatchConnection {
  readonly id: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly feishuUserName: string | null;
}

interface FeishuModelOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly isDefault: boolean;
}

interface FeishuCommand {
  readonly name: string;
  readonly argument: string;
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

function agentLabel(agent: FeishuAgent): string {
  return agent.displayName ?? agent.name;
}

function parseFeishuCommand(text: string): FeishuCommand | null {
  const match = /^\/(\S+)(?:\s+(.+))?$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    name: match[1]?.toLowerCase() ?? "",
    argument: match[2]?.trim() ?? "",
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
  if (!shouldReplyInFeishuThread(args.message)) {
    await sendFeishuMessage(
      {
        db: args.db,
        installationId: args.message.installationId,
        receiveIdType: "chat_id",
        receiveId: args.message.chatId,
        message: args.outbound,
      },
      signal,
    );
    return;
  }
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
    readonly publicBrand: PublicBrand;
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
    publicBrand: args.publicBrand,
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

async function getVisibleAgent(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<FeishuAgent | undefined> {
  const [agent] = await args.db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, args.composeId),
        eq(agents.orgId, args.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .limit(1);
  return agent;
}

async function getVisibleAgents(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<readonly FeishuAgent[]> {
  return await args.db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, args.orgId),
        or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(FEISHU_AGENT_PICKER_MAX_OPTIONS);
}

async function getUserAgentPreference(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<string | null> {
  const [preference] = await args.db
    .select({
      selectedAgentId: feishuUserAgentPreferences.selectedAgentId,
    })
    .from(feishuUserAgentPreferences)
    .where(
      and(
        eq(feishuUserAgentPreferences.userId, args.userId),
        eq(feishuUserAgentPreferences.orgId, args.orgId),
      ),
    )
    .limit(1);
  return preference?.selectedAgentId ?? null;
}

async function setUserAgentPreference(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string | null;
}): Promise<void> {
  await args.db
    .insert(feishuUserAgentPreferences)
    .values({
      userId: args.userId,
      orgId: args.orgId,
      selectedAgentId: args.composeId,
    })
    .onConflictDoUpdate({
      target: [
        feishuUserAgentPreferences.userId,
        feishuUserAgentPreferences.orgId,
      ],
      set: {
        selectedAgentId: args.composeId,
        updatedAt: nowDate(),
      },
    });
}

export async function resolveEffectiveFeishuAgent(args: {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
}): Promise<EffectiveAgentResolution> {
  const preference = await getUserAgentPreference({
    db: args.db,
    orgId: args.installation.orgId,
    userId: args.connection.userId,
  });
  if (preference) {
    const preferredAgent = await getVisibleAgent({
      db: args.db,
      composeId: preference,
      orgId: args.installation.orgId,
      userId: args.connection.userId,
    });
    if (preferredAgent) {
      return { status: "resolved", agent: preferredAgent };
    }
  }
  const composeId = args.installation.defaultAgentId;
  const agent = await getVisibleAgent({
    db: args.db,
    composeId,
    orgId: args.installation.orgId,
    userId: args.connection.userId,
  });
  if (agent) {
    return { status: "resolved", agent };
  }
  const [existing] = await args.db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, composeId), eq(agents.orgId, args.installation.orgId)),
    )
    .limit(1);
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
      ? `The configured agent is not available to your ${providerName} account. Use \`/switch\` to choose an accessible agent.`
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

function formatConversationHistory(
  history: readonly FeishuHistoryMessage[],
  current: FeishuInboundMessage,
): FeishuPromptContext {
  const messages = [...history]
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
  const threadMessages = messages.filter((message) => {
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

export async function loadFeishuConversationHistory(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
  },
  signal: AbortSignal,
): Promise<FeishuPromptContext> {
  const history = await tapError(
    listFeishuChatMessages(
      {
        db: args.db,
        installationId: args.message.installationId,
        chatId: args.message.chatId,
      },
      signal,
    ),
    (error) => {
      L.warn("Failed to load Feishu conversation history", {
        error,
        installationId: args.message.installationId,
        chatId: args.message.chatId,
      });
    },
  );
  signal.throwIfAborted();
  return history
    ? formatConversationHistory(history, args.message)
    : { text: "", files: [] };
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
  readonly history: string;
}): string {
  const platformName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const isDirectMessage = args.chatType === "p2p";
  const typeLabel = isDirectMessage ? "Direct message" : "Group mention";
  const groupIdLine = isDirectMessage
    ? ""
    : `Group ID: ${args.chatId} (same as Chat ID; use it directly as the \`--chat\` value for \`okou ${args.platform ?? "feishu"} message send\`)`;
  return [
    CONVERSATION_GUIDANCE,
    "",
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
    args.history,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function markFeishuMessageReceived(
  args: {
    readonly db: Db;
    readonly installation: FeishuDispatchInstallation;
    readonly message: FeishuInboundMessage;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.installation.messageReceivedAt) {
    return;
  }
  const [markedAsReceived] = await args.db
    .update(feishuOrgInstallations)
    .set({
      feishuTenantKey: args.message.tenantKey,
      messageReceivedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(feishuOrgInstallations.id, args.message.installationId),
        isNull(feishuOrgInstallations.messageReceivedAt),
      ),
    )
    .returning({ id: feishuOrgInstallations.id });
  signal.throwIfAborted();
  if (markedAsReceived) {
    await publishFeishuOrgChanged(
      args.db,
      args.installation.orgId,
      args.installation.ownerUserId,
    );
  }
}

const feishuModelPickerState$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly options: readonly FeishuModelOption[];
    readonly currentSelectedModel: string | null;
  }> => {
    const visibleModels = new Set(getBuiltInVisibleModels());
    const [policies, preference] = await Promise.all([
      set(listOrgModelPolicies$, { orgId, userId }, signal),
      get(userModelPreference({ orgId, userId })),
    ]);
    signal.throwIfAborted();
    return {
      options: policies.policies
        .flatMap((policy) => {
          if (
            !isSupportedRunModel(policy.model) ||
            !visibleModels.has(policy.model) ||
            policy.routeStatus !== "valid"
          ) {
            return [];
          }
          return {
            model: policy.model,
            label: policy.modelLabel,
            isDefault: policy.isDefault,
          };
        })
        .slice(0, FEISHU_MODEL_PICKER_MAX_OPTIONS),
      currentSelectedModel: preference.selectedModel,
    };
  },
);

function commandOptionsText(args: {
  readonly intro: string;
  readonly options: readonly {
    readonly commandValue: string;
    readonly label: string;
    readonly current: boolean;
  }[];
  readonly command: "model" | "switch";
}): string {
  return [
    args.intro,
    "",
    ...args.options.map((option) => {
      return `• \`/${args.command} ${option.commandValue}\` — ${option.label}${option.current ? " (current)" : ""}`;
    }),
  ].join("\n");
}

async function handleDisconnectCommand(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
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
  await publishCustomConnectorUserInvalidationAfterCommit(
    args.connection.userId,
    signal,
  );
  await publishFeishuOrgChanged(
    args.db,
    args.installation.orgId,
    args.installation.ownerUserId,
    [args.connection.userId],
  );
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

async function replyAgentPicker(
  args: {
    readonly commandArgs: ConnectedCommandArgs;
    readonly agents: readonly FeishuAgent[];
    readonly defaultAgent: FeishuAgent | undefined;
    readonly currentPreference: string | null;
  },
  signal: AbortSignal,
): Promise<void> {
  await replyNotice(
    {
      db: args.commandArgs.db,
      message: args.commandArgs.message,
      title: "Choose an agent",
      text: commandOptionsText({
        intro: `Send one of these commands to choose which agent responds to your ${FEISHU_PLATFORMS[args.commandArgs.message.platform ?? "feishu"].name} messages.`,
        command: "switch",
        options: [
          ...(args.defaultAgent
            ? [
                {
                  commandValue: "default",
                  label: `${agentLabel(args.defaultAgent)} (installation default)`,
                  current: args.currentPreference === null,
                },
              ]
            : []),
          ...args.agents
            .filter((agent) => {
              return agent.id !== args.commandArgs.installation.defaultAgentId;
            })
            .map((agent) => {
              return {
                commandValue: agent.id,
                label: agentLabel(agent),
                current: args.currentPreference === agent.id,
              };
            }),
        ],
      }),
    },
    signal,
  );
}

async function handleSwitchCommand(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
  const [agents, defaultAgent, currentPreference] = await Promise.all([
    getVisibleAgents({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.userId,
    }),
    getVisibleAgent({
      db: args.db,
      composeId: args.installation.defaultAgentId,
      orgId: args.installation.orgId,
      userId: args.connection.userId,
    }),
    getUserAgentPreference({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.userId,
    }),
  ]);
  signal.throwIfAborted();
  if (!args.command.argument) {
    await replyAgentPicker(
      {
        commandArgs: args,
        agents,
        defaultAgent,
        currentPreference,
      },
      signal,
    );
    return;
  }
  if (args.command.argument.toLowerCase() === "default") {
    if (!defaultAgent) {
      await replyNotice(
        {
          db: args.db,
          message: args.message,
          title: "Agent unavailable",
          text: "You don't have access to the installation default agent.",
          kind: "error",
        },
        signal,
      );
      return;
    }
    await setUserAgentPreference({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.userId,
      composeId: null,
    });
    signal.throwIfAborted();
    await replyNotice(
      {
        db: args.db,
        message: args.message,
        title: "Agent switched",
        text: `Switched to **${agentLabel(defaultAgent)}**.`,
        kind: "success",
      },
      signal,
    );
    return;
  }
  const normalized = args.command.argument.toLowerCase();
  const selected = agents.find((agent) => {
    return (
      agent.id === args.command.argument ||
      agent.name.toLowerCase() === normalized ||
      agent.displayName?.toLowerCase() === normalized
    );
  });
  if (!selected) {
    await replyNotice(
      {
        db: args.db,
        message: args.message,
        title: "Agent unavailable",
        text: "You don't have access to that agent. Use `/switch` to list available agents.",
        kind: "error",
      },
      signal,
    );
    return;
  }
  await setUserAgentPreference({
    db: args.db,
    orgId: args.installation.orgId,
    userId: args.connection.userId,
    composeId:
      selected.id === args.installation.defaultAgentId ? null : selected.id,
  });
  signal.throwIfAborted();
  await replyNotice(
    {
      db: args.db,
      message: args.message,
      title: "Agent switched",
      text: `Switched to **${agentLabel(selected)}**.`,
      kind: "success",
    },
    signal,
  );
}

const handleModelCommand$ = command(
  async (
    { set },
    args: ConnectedCommandArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const picker = await set(
      feishuModelPickerState$,
      args.installation.orgId,
      args.connection.userId,
      signal,
    );
    signal.throwIfAborted();
    if (picker.options.length === 0) {
      await replyNotice(
        {
          db: args.db,
          message: args.message,
          title: "No models available",
          text: "No models are configured for this workspace.",
          kind: "error",
        },
        signal,
      );
      return;
    }
    if (!args.command.argument) {
      await replyNotice(
        {
          db: args.db,
          message: args.message,
          title: "Choose a model",
          text: commandOptionsText({
            intro: `Send one of these commands to choose the model for your own ${FEISHU_PLATFORMS[args.message.platform ?? "feishu"].name} runs.`,
            command: "model",
            options: picker.options.map((option) => {
              return {
                commandValue: option.model,
                label: `${option.label}${option.isDefault ? " (workspace default)" : ""}`,
                current:
                  picker.currentSelectedModel === option.model ||
                  (!picker.currentSelectedModel && option.isDefault),
              };
            }),
          }),
        },
        signal,
      );
      return;
    }
    const normalized = args.command.argument.toLowerCase();
    const selected = picker.options.find((option) => {
      return (
        option.model.toLowerCase() === normalized ||
        option.label.toLowerCase() === normalized
      );
    });
    if (!selected) {
      await replyNotice(
        {
          db: args.db,
          message: args.message,
          title: "Model unavailable",
          text: "You don't have access to that model. Use `/model` to list available models.",
          kind: "error",
        },
        signal,
      );
      return;
    }
    await set(
      updateUserModelPreference$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.userId,
        preference: { selectedModel: selected.model, serviceTier: null },
      },
      signal,
    );
    signal.throwIfAborted();
    await replyNotice(
      {
        db: args.db,
        message: args.message,
        title: "Model switched",
        text: `Switched to **${selected.label}**.`,
        kind: "success",
      },
      signal,
    );
  },
);

const handleConnectedCommand$ = command(
  async (
    { set },
    args: ConnectedCommandArgs,
    signal: AbortSignal,
  ): Promise<void> => {
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
            text: `Your ${FEISHU_PLATFORMS[args.message.platform ?? "feishu"].name} account is already connected to ${PUBLIC_BRAND_PRESENTATION.brandName}. Send a task to start working with your agent.`,
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
      case "switch": {
        await handleSwitchCommand(args, signal);
        return;
      }
      case "model": {
        await set(handleModelCommand$, args, signal);
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

export async function addFeishuThinkingReaction(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
  },
  signal: AbortSignal,
): Promise<string | undefined> {
  const reactionId = await tapError(
    addFeishuMessageReaction(
      {
        db: args.db,
        installationId: args.message.installationId,
        messageId: args.message.messageId,
        emojiType: FEISHU_THINKING_EMOJI,
      },
      signal,
    ),
    (error) => {
      L.warn("Failed to set Feishu thinking indicator", {
        error,
        messageId: args.message.messageId,
      });
    },
  );
  signal.throwIfAborted();
  return reactionId;
}
