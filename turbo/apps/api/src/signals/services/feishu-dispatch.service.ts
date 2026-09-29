import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import {
  getBuiltInVisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
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
  listFeishuMessages,
  replyWithFeishuMessage,
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
import {
  feishuRouteThreadId,
  findFeishuRoutedChatThreadId$,
} from "./feishu-chat-ingress.service";
import { updateIntegrationChatThreadModel$ } from "./integration-chat-thread-model.service";
import { listOrgModelPolicies$ } from "./model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./user-data.service";

const L = logger("FeishuDispatch");
const FEISHU_THINKING_EMOJI = "Typing";
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

export async function resolveEffectiveFeishuAgent(args: {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
}): Promise<EffectiveAgentResolution> {
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

function formatConversationHistory(
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

async function loadFeishuHistory(
  args: {
    readonly db: Db;
    readonly installationId: string;
    readonly containerType: "chat" | "thread";
    readonly containerId: string;
  },
  signal: AbortSignal,
): Promise<readonly FeishuHistoryMessage[]> {
  const history = await tapError(listFeishuMessages(args, signal), (error) => {
    L.warn("Failed to load Feishu conversation history", {
      error,
      installationId: args.installationId,
      containerType: args.containerType,
      containerId: args.containerId,
    });
  });
  signal.throwIfAborted();
  return history ?? [];
}

export async function loadFeishuConversationHistory(
  args: {
    readonly db: Db;
    readonly message: FeishuInboundMessage;
  },
  signal: AbortSignal,
): Promise<FeishuPromptContext> {
  const { message } = args;
  const [history, threadHistory] = await Promise.all([
    loadFeishuHistory(
      {
        db: args.db,
        installationId: message.installationId,
        containerType: "chat",
        containerId: message.chatId,
      },
      signal,
    ),
    message.chatType !== "p2p" && message.threadId
      ? loadFeishuHistory(
          {
            db: args.db,
            installationId: message.installationId,
            containerType: "thread",
            containerId: message.threadId,
          },
          signal,
        )
      : Promise.resolve([]),
  ]);
  signal.throwIfAborted();
  return formatConversationHistory(history, message, threadHistory);
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
  readonly command: "model";
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

async function replyModelUnavailable(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
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
      await replyModelUnavailable(args, signal);
      return;
    }
    const chatThreadId = await set(
      findFeishuRoutedChatThreadId$,
      {
        connectionId: args.connection.id,
        chatId: args.message.chatId,
        threadId: feishuRouteThreadId(args.message),
        userId: args.connection.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    const threadModel = await set(
      updateIntegrationChatThreadModel$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.userId,
        chatThreadId,
        model: selected.model,
      },
      signal,
    );
    if (threadModel.kind === "rejected") {
      await replyModelUnavailable(args, signal);
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
