import type {
TeamsInboundActivity,
TeamsInboundAttachment,
} from "@okouai/api-contracts/contracts/teams-bot";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import type {
ChatTeamsMessageFile,
ChatTeamsMessageFiles,
} from "@okouai/db/jsonb-contracts/chat-teams-context";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { command } from "ccstate";
import { and,eq,or } from "drizzle-orm";
import { convert } from "html-to-text";
import { createHash,randomBytes } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { logger } from "../../lib/log";
import { inferMimetype } from "../../lib/mimetype";
import { isAllowedTeamsDownloadUrl } from "../../lib/teams-file-url";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$,type Db } from "../external/db";
import {
publishChatThreadMessageCreatedSafely,
publishThreadListChangedSafely,
} from "../external/realtime";
import {
fetchTeamsChannelMessage,
fetchTeamsChannelMessageReplies,
fetchTeamsChannelMessages,
fetchTeamsFile,
fetchTeamsPersonalChatMessages,
fetchTeamsUsers,
sendTeamsMessageReply,
sendTeamsReaction,
sendTeamsTypingActivity,
type TeamsAdaptiveCard,
type TeamsGraphAttachment,
type TeamsGraphMessage,
type TeamsGraphUserInfo,
} from "../external/teams-bot-client";
import { bestEffort,safeJsonParse,settle } from "../utils";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { InputFileImportError } from "./canonical-asset.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { chatQueueWaitNotice } from "./chat-queue-wait-notice";
import type { ChatQueueWaitReason } from "./chat-queue-wait-reason";
import {
enqueuedChatQueueWaitReason$,
notifyRunningChatRunOfPendingInput$,
pickEnqueuedChatThread$,
} from "./chat-thread-queue-drain.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";
import {
readIntegrationChatThreadModel$,
updateIntegrationChatThreadModel$,
} from "./integration-chat-thread-model.service";
import {
integrationInputMessageFiles,
materializeIntegrationInputAssets$,
readyIntegrationInputAsset,
type IntegrationInputAsset,
type IntegrationInputFile,
} from "./integration-input-assets.service";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { loadOptionalChatEnrichment } from "./queued-launch-enrichment.service";
import { listAvailableRunModelsWithDefault$ } from "./run-models.service";
import {
ensureTeamsChatThreadRoute$,
findTeamsRoutedChatThreadId$,
} from "./teams-chat-ingress.service";
import {
buildTeamsConnectUrlForActivity,
disconnectTeamsConnection$,
publishTeamsChanged$,
} from "./teams-connect.service";
import type { TeamsFileTokenPayload } from "./teams-file-token";
import { formatTeamsFileForContext } from "./teams-prompt";
const L = logger("TeamsDispatch");
const TEAMS_SUPPORTED_COMMANDS_TEXT =
  "`help`, `connect`, `disconnect`, `model`";
const TEAMS_MODEL_PICKER_MAX_OPTIONS = 100;
const TEAMS_CARD_ACTION_KEY = "okouTeamsAction";
const TEAMS_AGENT_PICKER_ACTION = "switch_agent";
const TEAMS_MODEL_PICKER_ACTION = "switch_model";
const TEAMS_MODEL_PICKER_INPUT_ID = "selectedModel";
// The submit activity replies to the card, so the card carries the route key
// of the conversation where `/model` was sent.
const TEAMS_MODEL_PICKER_CONVERSATION_KEY = "routeConversationId";
const TEAMS_MODEL_PICKER_THREAD_KEY = "routeThreadId";
const TEAMS_MODEL_PICKER_CHAT_THREAD_KEY = "chatThreadId";
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";
const TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE =
  "application/vnd.microsoft.teams.file.download.info";
const TEAMS_REFERENCE_ATTACHMENT_CONTENT_TYPE = "reference";
const TEAMS_CHAT_MESSAGE_ID_NAMESPACE = "b60a5846-d85f-4db8-b9aa-d7d803efbb57";

type TeamsBotCommand = "help" | "connect" | "disconnect" | "switch" | "model";
type TeamsCardAction = "switch_agent" | "switch_model";

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;
type BoundTeamsInstallation = TeamsInstallation & { readonly orgId: string };
type TeamsConnection = typeof teamsOrgConnections.$inferSelect;
type TeamsMessageActivity = Extract<TeamsInboundActivity, { kind: "message" }>;

function teamsIdentity(installation: TeamsInstallation | null | undefined): {
  readonly assistantName: "Okou";
  readonly brandName: "Okou";
  readonly botName: string;
} {
  const presentation = BRAND_PRESENTATION;
  return {
    ...presentation,
    botName: teamsBotDisplayName(installation?.botName),
  };
}

export function teamsWelcomeText(
  installation: TeamsInstallation | null | undefined,
): string {
  const { botName, brandName } = teamsIdentity(installation);
  return [
    `Hi, I'm ${botName}. I connect Teams conversations to AI agents for research, triage, reports, engineering work, operations, and support.`,
    "",
    `To get started, use \`connect\` to link this Teams workspace to ${brandName}. An org admin may need to complete workspace setup first.`,
    "",
    `Commands: ${TEAMS_SUPPORTED_COMMANDS_TEXT}. Mention \`@${botName}\` with a task or send a DM to work privately.`,
  ].join("\n");
}

interface TeamsContextMessage {
  readonly id: string | null;
  readonly createdDateTime: string | null;
  readonly text: string;
  readonly senderId: string;
  readonly senderName: string | null;
  readonly senderPrincipalName: string | null;
  readonly files: readonly TeamsPromptFile[];
}

interface TeamsAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface TeamsModelPickerOption {
  readonly model: string;
  readonly label: string;
  readonly isDefault: boolean;
}

type TeamsPromptFile = Omit<ChatTeamsMessageFile, "inCurrentMessage"> & {
  readonly upstreamFileId: string;
};

interface TeamsAttachmentDownload {
  readonly url: string;
  readonly mode: "graph" | undefined;
}

interface TeamsPromptContext {
  readonly text: string;
  readonly files: readonly TeamsPromptFile[];
}

type EffectiveComposeResolution =
  | {
      readonly status: "resolved";
      readonly composeId: string;
      readonly agent: TeamsAgent;
    }
  | {
      readonly status: "not_configured" | "not_found" | "not_accessible";
    };

type ResolvedEffectiveCompose = Extract<
  EffectiveComposeResolution,
  { readonly status: "resolved" }
>;

type TeamsMessageDispatchResult =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "notice";
      readonly replyText: string;
      readonly connectUrl?: string;
      readonly card?: TeamsAdaptiveCard;
    }
  | { readonly kind: "accepted" };

function isTeamsBotCommand(value: string): value is TeamsBotCommand {
  return (
    value === "help" ||
    value === "connect" ||
    value === "disconnect" ||
    value === "switch" ||
    value === "model"
  );
}

function stringValue(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function teamsCardAction(
  value: Readonly<Record<string, unknown>> | null,
): TeamsCardAction | null {
  const action = stringValue(value, TEAMS_CARD_ACTION_KEY);
  if (action === TEAMS_AGENT_PICKER_ACTION) {
    return "switch_agent";
  }
  if (action === TEAMS_MODEL_PICKER_ACTION) {
    return "switch_model";
  }
  return null;
}

function choiceLabel(value: string): string {
  return value.slice(0, 80);
}

function modelLabel(option: TeamsModelPickerOption): string {
  if (!option.isDefault) {
    return choiceLabel(option.label);
  }
  const suffix = " (workspace default)";
  if (option.label.length + suffix.length <= 80) {
    return `${option.label}${suffix}`;
  }
  return `${option.label.slice(0, 80 - suffix.length)}${suffix}`;
}

function parseTeamsBotCommand(prompt: string): TeamsBotCommand | null {
  const parts = prompt.trim().split(/\s+/u);
  const first = parts[0]?.toLowerCase().replace(/^\//u, "") ?? "";
  const prefixed = first === "okou";
  const command = prefixed
    ? (parts[1]?.toLowerCase().replace(/^\//u, "") ?? "")
    : first;
  if (!isTeamsBotCommand(command)) {
    return null;
  }
  return prefixed || parts.length === 1 ? command : null;
}

function isTeamsBotGreeting(prompt: string): boolean {
  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "");
  return normalized === "hi" || normalized === "hello" || normalized === "hey";
}

function commandHelpNotice(args: {
  readonly canSwitch: boolean;
  readonly canModel: boolean;
  readonly installation?: TeamsInstallation | null;
}): TeamsMessageDispatchResult {
  const { assistantName, botName } = teamsIdentity(args.installation);
  const switchLine = args.canSwitch
    ? "\n- `switch` - Choose which agent responds to your messages"
    : "";
  const modelLine = args.canModel ? "\n- `model` - Choose your model" : "";
  return {
    kind: "notice",
    replyText: [
      `**${botName} Teams Bot Help**`,
      "",
      "**Commands**",
      `- \`connect\` - Connect to ${assistantName}${switchLine}${modelLine}`,
      `- \`disconnect\` - Disconnect from ${assistantName}`,
      "",
      "**Usage**",
      `- \`@${botName} <message>\` - Send a message to your agent`,
      `- Send a DM to ${botName} to chat without mentioning the bot`,
    ].join("\n"),
  };
}

function greetingNotice(
  installation: TeamsInstallation | null | undefined,
): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText: teamsWelcomeText(installation),
  };
}

function connectedNotice(
  installation: TeamsInstallation,
): TeamsMessageDispatchResult {
  const { assistantName, botName } = teamsIdentity(installation);
  return {
    kind: "notice",
    replyText: `You're already connected to ${assistantName}. Mention @${botName} in any channel or send a DM to start chatting with your agent.`,
  };
}

function notInstalledNotice(
  installation: TeamsInstallation | null | undefined,
): TeamsMessageDispatchResult {
  const { botName, brandName } = teamsIdentity(installation);
  return {
    kind: "notice",
    replyText: `The ${botName} Teams app hasn't been set up for this workspace yet. An org admin can complete the setup in ${brandName}.`,
  };
}

function orgDefaultAgentNotice(): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText:
      "Teams always uses your workspace's default agent. Agent switching is not available.",
  };
}

function disconnectedNotice(): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText:
      "You have been disconnected and your agent access has been revoked.",
  };
}

function buildTeamsModelPickerCard(args: {
  readonly options: readonly TeamsModelPickerOption[];
  readonly currentSelectedModel: string | null;
  readonly routeConversationId: string;
  readonly routeThreadId: string;
  readonly chatThreadId: string;
}): TeamsAdaptiveCard {
  const choices = args.options.map((option) => {
    return {
      title: modelLabel(option),
      value: option.model,
    };
  });
  const currentChoice = args.currentSelectedModel
    ? choices.find((choice) => {
        return choice.value === args.currentSelectedModel;
      })
    : undefined;
  const initialValue = currentChoice?.value ?? choices[0]?.value;

  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Choose the model for this conversation.",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: TEAMS_MODEL_PICKER_INPUT_ID,
        label: "Model",
        style: "compact",
        isMultiSelect: false,
        ...(initialValue ? { value: initialValue } : {}),
        choices,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Switch",
        data: {
          [TEAMS_CARD_ACTION_KEY]: TEAMS_MODEL_PICKER_ACTION,
          [TEAMS_MODEL_PICKER_CONVERSATION_KEY]: args.routeConversationId,
          [TEAMS_MODEL_PICKER_THREAD_KEY]: args.routeThreadId,
          [TEAMS_MODEL_PICKER_CHAT_THREAD_KEY]: args.chatThreadId,
        },
      },
    ],
  };
}

function stringRecordValue(
  source: Readonly<Record<string, unknown>> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordFromUnknown(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = safeJsonParse(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Readonly<Record<string, unknown>>)
    : null;
}

function teamsAttachmentDownloadUrl(
  attachment: TeamsInboundAttachment,
): TeamsAttachmentDownload | null {
  const directUrl = stringRecordValue(attachment.content, "downloadUrl");
  if (directUrl) {
    return { url: directUrl, mode: undefined };
  }
  if (!attachment.contentUrl) {
    return null;
  }
  return {
    url: attachment.contentUrl,
    mode:
      attachment.contentType === TEAMS_REFERENCE_ATTACHMENT_CONTENT_TYPE
        ? "graph"
        : undefined,
  };
}

function teamsAttachmentName(attachment: TeamsInboundAttachment): string {
  return (
    attachment.name ??
    stringRecordValue(attachment.content, "name") ??
    stringRecordValue(attachment.content, "fileName") ??
    "teams-file"
  );
}

function teamsAttachmentContentType(
  attachment: TeamsInboundAttachment,
  filename: string,
): string {
  if (
    attachment.contentType &&
    attachment.contentType !== TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE &&
    attachment.contentType !== TEAMS_REFERENCE_ATTACHMENT_CONTENT_TYPE
  ) {
    return attachment.contentType;
  }

  const fileType = stringRecordValue(attachment.content, "fileType");
  if (fileType && !filename.endsWith(`.${fileType}`)) {
    return inferMimetype(`${filename}.${fileType}`);
  }
  return inferMimetype(filename);
}

function teamsUpstreamFileId(
  content: Readonly<Record<string, unknown>> | null,
  downloadUrl: string,
): string {
  const uniqueId = stringRecordValue(content, "uniqueId");
  return uniqueId
    ? `file:${uniqueId}`
    : `url:${createHash("sha256").update(downloadUrl).digest("hex")}`;
}

function teamsPromptFile(
  activity: TeamsMessageActivity,
  attachment: TeamsInboundAttachment,
): TeamsPromptFile | null {
  const download = teamsAttachmentDownloadUrl(attachment);
  if (!download || !URL.canParse(download.url)) {
    return null;
  }

  const name = teamsAttachmentName(attachment);
  const contentType = teamsAttachmentContentType(attachment, name);
  const payload: TeamsFileTokenPayload = {
    tenantId: activity.tenantId,
    url: download.url,
    downloadMode: download.mode,
    id: attachment.id ?? undefined,
    name,
    contentType,
  };
  return {
    fileId: `teams_file_${randomBytes(16).toString("base64url")}`,
    upstreamFileId: teamsUpstreamFileId(attachment.content, download.url),
    sourceId: attachment.id ?? undefined,
    name,
    contentType,
    payload,
  };
}

function teamsPromptFiles(activity: TeamsMessageActivity): TeamsPromptFile[] {
  return activity.attachments.flatMap((attachment) => {
    const file = teamsPromptFile(activity, attachment);
    return file ? [file] : [];
  });
}

function graphAttachmentContent(
  attachment: TeamsGraphAttachment,
): Readonly<Record<string, unknown>> | null {
  return recordFromUnknown(attachment.content);
}

function teamsGraphAttachmentDownloadUrl(
  attachment: TeamsGraphAttachment,
): TeamsAttachmentDownload | null {
  const content = graphAttachmentContent(attachment);
  const directUrl = stringRecordValue(content, "downloadUrl");
  if (directUrl) {
    return { url: directUrl, mode: undefined };
  }
  const contentUrl =
    attachment.contentUrl ?? stringRecordValue(content, "contentUrl");
  if (!contentUrl) {
    return null;
  }
  return {
    url: contentUrl,
    mode:
      attachment.contentType === TEAMS_REFERENCE_ATTACHMENT_CONTENT_TYPE
        ? "graph"
        : undefined,
  };
}

function teamsGraphAttachmentName(attachment: TeamsGraphAttachment): string {
  const content = graphAttachmentContent(attachment);
  return (
    attachment.name ??
    stringRecordValue(content, "name") ??
    stringRecordValue(content, "fileName") ??
    "teams-file"
  );
}

function teamsGraphAttachmentContentType(
  attachment: TeamsGraphAttachment,
  filename: string,
): string {
  const content = graphAttachmentContent(attachment);
  if (
    attachment.contentType &&
    attachment.contentType !== TEAMS_FILE_DOWNLOAD_INFO_CONTENT_TYPE &&
    attachment.contentType !== TEAMS_REFERENCE_ATTACHMENT_CONTENT_TYPE
  ) {
    return attachment.contentType;
  }

  const fileType = stringRecordValue(content, "fileType");
  if (fileType && !filename.endsWith(`.${fileType}`)) {
    return inferMimetype(`${filename}.${fileType}`);
  }
  return inferMimetype(filename);
}

function teamsGraphPromptFile(
  tenantId: string,
  attachment: TeamsGraphAttachment,
): TeamsPromptFile | null {
  const download = teamsGraphAttachmentDownloadUrl(attachment);
  if (!download || !URL.canParse(download.url)) {
    return null;
  }

  const name = teamsGraphAttachmentName(attachment);
  const contentType = teamsGraphAttachmentContentType(attachment, name);
  const payload: TeamsFileTokenPayload = {
    tenantId,
    url: download.url,
    downloadMode: download.mode,
    id: attachment.id ?? undefined,
    name,
    contentType,
  };
  return {
    fileId: `teams_file_${randomBytes(16).toString("base64url")}`,
    upstreamFileId: teamsUpstreamFileId(
      graphAttachmentContent(attachment),
      download.url,
    ),
    sourceId: attachment.id ?? undefined,
    name,
    contentType,
    payload,
  };
}

function teamsGraphPromptFiles(
  tenantId: string,
  message: TeamsGraphMessage,
): TeamsPromptFile[] {
  return (message.attachments ?? []).flatMap((attachment) => {
    const file = teamsGraphPromptFile(tenantId, attachment);
    return file ? [file] : [];
  });
}

async function installationForTenant(
  db: Db,
  tenantId: string,
): Promise<TeamsInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  return installation;
}

async function connectionForTeamsUser(
  db: Db,
  tenantId: string,
  teamsUserId: string | null,
  teamsAadObjectId: string | null,
): Promise<TeamsConnection | undefined> {
  if (teamsAadObjectId) {
    const [connection] = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, tenantId),
          eq(teamsOrgConnections.teamsAadObjectId, teamsAadObjectId),
        ),
      )
      .limit(1);

    if (connection) {
      if (teamsUserId && connection.teamsUserId !== teamsUserId) {
        await db
          .update(teamsOrgConnections)
          .set({ teamsUserId, updatedAt: nowDate() })
          .where(eq(teamsOrgConnections.id, connection.id));
      }
      return connection;
    }
  }

  if (!teamsUserId) {
    return undefined;
  }

  const [connection] = await db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, tenantId),
        eq(teamsOrgConnections.teamsUserId, teamsUserId),
      ),
    )
    .limit(1);
  return connection;
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function sendTeamsRunStartIndicator(
  args: {
    readonly activity: TeamsMessageActivity;
  },
  signal: AbortSignal,
): Promise<void> {
  const activityId = args.activity.activityId;
  let indicator:
    | ReturnType<typeof sendTeamsTypingActivity>
    | ReturnType<typeof sendTeamsReaction>;
  if (isTeamsDirectMessage(args.activity) || !activityId) {
    indicator = sendTeamsTypingActivity(
      {
        serviceUrl: args.activity.serviceUrl,
        conversationId: args.activity.conversationId,
        tenantId: args.activity.tenantId,
      },
      signal,
    );
  } else {
    indicator = sendTeamsReaction(
      {
        serviceUrl: args.activity.serviceUrl,
        conversationId: args.activity.conversationId,
        activityId,
        tenantId: args.activity.tenantId,
        reactionType: TEAMS_THINKING_REACTION_TYPE,
      },
      signal,
    );
  }
  await bestEffort(indicator, signal);
}

async function getWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId: string,
): Promise<TeamsAgent | undefined> {
  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      displayName: agents.displayName,
    })
    .from(agents)
    .where(and(eq(agents.id, composeId), eq(agents.orgId, orgId)))
    .limit(1);
  return agent;
}

async function getVisibleWorkspaceAgent(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<TeamsAgent | undefined> {
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

async function resolveEffectiveCompose(args: {
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
}): Promise<EffectiveComposeResolution> {
  const defaultAgentId = await resolveDefaultComposeId(args.db, args.orgId);
  if (!defaultAgentId) {
    return { status: "not_configured" };
  }
  const configuredDefaultAgent = await getWorkspaceAgent(
    args.db,
    defaultAgentId,
    args.orgId,
  );
  if (!configuredDefaultAgent) {
    return { status: "not_found" };
  }
  const visibleDefaultAgent = await getVisibleWorkspaceAgent({
    db: args.db,
    composeId: defaultAgentId,
    orgId: args.orgId,
    userId: args.userId,
  });
  if (!visibleDefaultAgent) {
    return { status: "not_accessible" };
  }
  return {
    status: "resolved",
    composeId: defaultAgentId,
    agent: visibleDefaultAgent,
  };
}

const teamsModelPickerState$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    currentSelectedModel: string,
    signal: AbortSignal,
  ): Promise<{
    readonly enabled: boolean;
    readonly options: readonly TeamsModelPickerOption[];
    readonly currentSelectedModel: string | null;
  }> => {
    const { response: policies, systemDefaultModel } = await set(
      listAvailableRunModelsWithDefault$,
      { orgId, userId },
      signal,
    );
    signal.throwIfAborted();

    return {
      enabled: true,
      options: policies.models
        .flatMap((policy) => {
          if (policy.routeStatus !== "valid") {
            return [];
          }
          return {
            model: policy.model,
            label: policy.modelLabel,
            isDefault: policy.model === systemDefaultModel,
          };
        })
        .slice(0, TEAMS_MODEL_PICKER_MAX_OPTIONS),
      currentSelectedModel,
    };
  },
);

function formatTeamsSenderBlock(message: TeamsContextMessage): string {
  const parts = [`id: ${message.senderId}`];
  if (message.senderName) {
    parts.push(`name: ${message.senderName}`);
  }
  if (message.senderPrincipalName) {
    parts.push(`email: ${message.senderPrincipalName}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

function formatTeamsContextMessage(
  message: TeamsContextMessage,
  relativeIndex: number,
): string {
  const parts = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    formatTeamsSenderBlock(message),
    "",
    message.text,
  ];
  if (message.files.length > 0) {
    parts.push(...message.files.map(formatTeamsFileForContext));
  }
  return parts.join("\n");
}

const TEAMS_CONTEXT_PREAMBLE = [
  "The messages below are from a Microsoft Teams conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent; prioritize them.",
].join("\n");

function formatTeamsThreadContext(
  messages: readonly TeamsContextMessage[],
): string {
  return formatTeamsContext("# Microsoft Teams Thread Context", messages);
}

function formatRecentTeamsChannelContext(
  messages: readonly TeamsContextMessage[],
): string {
  return formatTeamsContext("# Recent Channel Messages", messages);
}

function formatTeamsContext(
  header: string,
  messages: readonly TeamsContextMessage[],
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    return formatTeamsContextMessage(message, index - totalMessages);
  });
  return `${header}\n\n${TEAMS_CONTEXT_PREAMBLE}\n\n${formattedMessages.join(
    "\n\n",
  )}\n\n---`;
}

function formattedTeamsContext(
  text: string,
  messages: readonly TeamsContextMessage[],
): TeamsPromptContext {
  return {
    text,
    files: messages.flatMap((message) => {
      return message.files;
    }),
  };
}

function plainTeamsMentionLabel(mentionText: string): string {
  return mentionText
    .replace(/<at[^>]*>/giu, "")
    .replace(/<\/at>/giu, "")
    .trim();
}

function teamsGraphMentionReplacement(
  mention: NonNullable<TeamsGraphMessage["mentions"]>[number],
): string | null {
  const mentioned =
    mention.mentioned?.user ??
    mention.mentioned?.application ??
    mention.mentioned?.device;
  const label =
    mentioned?.displayName ??
    (mention.mentionText ? plainTeamsMentionLabel(mention.mentionText) : null);
  if (!label) {
    return null;
  }
  return mentioned?.id ? `@${label} (${mentioned.id})` : `@${label}`;
}

function replaceTeamsGraphMentions(
  content: string,
  mentions: readonly NonNullable<TeamsGraphMessage["mentions"]>[number][],
): string {
  let result = content;
  for (const mention of mentions) {
    if (!mention.mentionText) {
      continue;
    }
    const replacement = teamsGraphMentionReplacement(mention);
    if (!replacement) {
      continue;
    }
    result = result.split(mention.mentionText).join(replacement);
  }
  return result;
}

function teamsGraphMessageText(message: TeamsGraphMessage): string {
  const content = replaceTeamsGraphMentions(
    message.body?.content?.trim() ?? "",
    message.mentions ?? [],
  );
  if (message.body?.contentType === "html") {
    return convert(content, { wordwrap: false }).trim();
  }
  return content;
}

function teamsGraphMessageSender(
  message: TeamsGraphMessage,
  userInfoMap: ReadonlyMap<string, TeamsGraphUserInfo>,
): Pick<
  TeamsContextMessage,
  "senderId" | "senderName" | "senderPrincipalName"
> {
  const sender =
    message.from?.user ?? message.from?.application ?? message.from?.device;
  const userInfo = sender?.id ? userInfoMap.get(sender.id) : undefined;
  return {
    senderId: sender?.id ?? "unknown",
    senderName: userInfo?.displayName ?? sender?.displayName ?? null,
    senderPrincipalName:
      userInfo?.userPrincipalName ??
      sender?.userPrincipalName ??
      sender?.mail ??
      null,
  };
}

function teamsGraphContextMessage(
  tenantId: string,
  message: TeamsGraphMessage,
  userInfoMap: ReadonlyMap<string, TeamsGraphUserInfo>,
): TeamsContextMessage | null {
  if (message.messageType && message.messageType !== "message") {
    return null;
  }

  const text = teamsGraphMessageText(message);
  const files = teamsGraphPromptFiles(tenantId, message);
  if (!text && files.length === 0) {
    return null;
  }

  return {
    id: message.id ?? null,
    createdDateTime: message.createdDateTime ?? null,
    text,
    files,
    ...teamsGraphMessageSender(message, userInfoMap),
  };
}

function sortTeamsContextMessages(
  messages: readonly TeamsContextMessage[],
): TeamsContextMessage[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.createdDateTime ?? "";
    const rightTime = right.createdDateTime ?? "";
    const byTime = leftTime.localeCompare(rightTime);
    if (byTime !== 0) {
      return byTime;
    }
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

function teamsContextMessages(
  tenantId: string,
  messages: readonly TeamsGraphMessage[],
  excludedIds: ReadonlySet<string>,
  userInfoMap: ReadonlyMap<string, TeamsGraphUserInfo>,
): TeamsContextMessage[] {
  return sortTeamsContextMessages(
    messages.flatMap((message) => {
      if (message.id && excludedIds.has(message.id)) {
        return [];
      }
      const contextMessage = teamsGraphContextMessage(
        tenantId,
        message,
        userInfoMap,
      );
      return contextMessage ? [contextMessage] : [];
    }),
  );
}

function teamsGraphSenderUserIds(
  messages: readonly TeamsGraphMessage[],
): readonly string[] {
  return [
    ...new Set(
      messages.flatMap((message) => {
        const sender = message.from?.user;
        const userId = sender?.id;
        if (sender?.userPrincipalName || sender?.mail) {
          return [];
        }
        return userId ? [userId] : [];
      }),
    ),
  ];
}

async function fetchTeamsGraphUserInfoMap(
  args: {
    readonly tenantId: string;
    readonly messages: readonly TeamsGraphMessage[];
  },
  signal: AbortSignal,
): Promise<ReadonlyMap<string, TeamsGraphUserInfo>> {
  const userIds = teamsGraphSenderUserIds(args.messages);
  if (userIds.length === 0) {
    return new Map();
  }

  const result = await fetchTeamsUsers(
    {
      tenantId: args.tenantId,
      userIds,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "teams-error") {
    L.debug("Teams user context fetch failed", {
      tenantId: args.tenantId,
      status: result.status,
      error: result.error,
    });
    return new Map();
  }
  return result.users;
}

function isTeamsThreadReply(activity: TeamsMessageActivity): boolean {
  return Boolean(
    activity.activityId && activity.threadId !== activity.activityId,
  );
}

function teamsSessionThreadId(args: {
  readonly activity: TeamsMessageActivity;
}): string {
  const { activity } = args;
  if (
    activity.conversationType === "personal" &&
    !isTeamsThreadReply(activity)
  ) {
    return INTEGRATION_DM_SESSION_KEY;
  }
  return activity.threadId;
}

function currentTeamsActivityIds(
  activity: TeamsMessageActivity,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (activity.activityId) {
    ids.add(activity.activityId);
  }
  return ids;
}

function recentChannelContextExcludedIds(
  activity: TeamsMessageActivity,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (activity.activityId) {
    ids.add(activity.activityId);
  }
  if (activity.threadId) {
    ids.add(activity.threadId);
  }
  return ids;
}

async function fetchTeamsThreadRootMessage(
  args: {
    readonly activity: TeamsMessageActivity;
  },
  signal: AbortSignal,
): Promise<TeamsGraphMessage | null> {
  const { activity } = args;
  if (
    !isTeamsThreadReply(activity) ||
    !activity.teamAadGroupId ||
    !activity.channelId
  ) {
    return null;
  }

  const rootResult = await fetchTeamsChannelMessage(
    {
      tenantId: activity.tenantId,
      teamId: activity.teamAadGroupId,
      channelId: activity.channelId,
      messageId: activity.threadId,
    },
    signal,
  );
  if (rootResult.kind === "teams-error") {
    L.warn("Teams thread root context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      teamAadGroupId: activity.teamAadGroupId,
      channelId: activity.channelId,
      threadId: activity.threadId,
      status: rootResult.status,
      error: rootResult.error,
    });
    return null;
  }

  return rootResult.message;
}

async function fetchTeamsThreadContext(
  args: {
    readonly activity: TeamsMessageActivity;
    readonly rootMessage: TeamsGraphMessage | null;
  },
  signal: AbortSignal,
): Promise<TeamsPromptContext> {
  const { activity } = args;
  if (!args.rootMessage || !activity.teamAadGroupId || !activity.channelId) {
    return { text: "", files: [] };
  }

  const repliesResult = await fetchTeamsChannelMessageReplies(
    {
      tenantId: activity.tenantId,
      teamId: activity.teamAadGroupId,
      channelId: activity.channelId,
      messageId: activity.threadId,
      limit: 100,
    },
    signal,
  );
  if (repliesResult.kind === "teams-error") {
    L.warn("Teams thread replies context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      teamAadGroupId: activity.teamAadGroupId,
      channelId: activity.channelId,
      threadId: activity.threadId,
      status: repliesResult.status,
      error: repliesResult.error,
    });
    return { text: "", files: [] };
  }

  const messages = [args.rootMessage, ...repliesResult.messages];
  const userInfoMap = await fetchTeamsGraphUserInfoMap(
    {
      tenantId: activity.tenantId,
      messages,
    },
    signal,
  );

  const contextMessages = teamsContextMessages(
    activity.tenantId,
    messages,
    currentTeamsActivityIds(activity),
    userInfoMap,
  );
  return formattedTeamsContext(
    formatTeamsThreadContext(contextMessages),
    contextMessages,
  );
}

function teamsMessagesBeforeReference(
  messages: readonly TeamsGraphMessage[],
  reference: TeamsGraphMessage | null,
): readonly TeamsGraphMessage[] {
  const referenceTime = reference?.createdDateTime;
  if (!referenceTime) {
    return messages;
  }

  return messages.filter((message) => {
    return !message.createdDateTime || message.createdDateTime < referenceTime;
  });
}

async function fetchRecentTeamsChannelContext(
  args: {
    readonly activity: TeamsMessageActivity;
    readonly beforeMessage: TeamsGraphMessage | null;
  },
  signal: AbortSignal,
): Promise<TeamsPromptContext> {
  const { activity } = args;
  const teamAadGroupId = activity.teamAadGroupId;
  const channelId = activity.channelId;
  if (!teamAadGroupId || !channelId) {
    return { text: "", files: [] };
  }

  const result = await fetchTeamsChannelMessages(
    {
      tenantId: activity.tenantId,
      teamId: teamAadGroupId,
      channelId,
      limit: 10,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    L.warn("Teams channel context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      teamAadGroupId: activity.teamAadGroupId,
      channelId: activity.channelId,
      status: result.status,
      error: result.error,
    });
    return { text: "", files: [] };
  }

  const messages = teamsMessagesBeforeReference(
    result.messages,
    args.beforeMessage,
  );
  const userInfoMap = await fetchTeamsGraphUserInfoMap(
    {
      tenantId: activity.tenantId,
      messages,
    },
    signal,
  );

  const contextMessages = teamsContextMessages(
    activity.tenantId,
    messages,
    recentChannelContextExcludedIds(activity),
    userInfoMap,
  );
  return formattedTeamsContext(
    formatRecentTeamsChannelContext(contextMessages),
    contextMessages,
  );
}

function isTeamsDirectMessage(activity: TeamsMessageActivity): boolean {
  return activity.conversationType === "personal";
}

async function fetchTeamsDirectMessageThreadContext(
  args: {
    readonly activity: TeamsMessageActivity;
  },
  signal: AbortSignal,
): Promise<TeamsPromptContext> {
  const { activity } = args;
  const userId = activity.sender.aadObjectId;
  const teamsAppId = activity.teamsAppId ?? env("MICROSOFT_TEAMS_BOT_APP_ID");
  if (!userId || !teamsAppId) {
    return { text: "", files: [] };
  }

  const result = await fetchTeamsPersonalChatMessages(
    {
      tenantId: activity.tenantId,
      userId,
      teamsAppId,
      limit: 50,
    },
    signal,
  );
  if (result.kind === "teams-error") {
    L.warn("Teams direct message thread context fetch failed", {
      tenantId: activity.tenantId,
      conversationId: activity.conversationId,
      threadId: activity.threadId,
      status: result.status,
      error: result.error,
    });
    return { text: "", files: [] };
  }

  const messages = result.messages;
  const userInfoMap = await fetchTeamsGraphUserInfoMap(
    {
      tenantId: activity.tenantId,
      messages,
    },
    signal,
  );
  const contextMessages = teamsContextMessages(
    activity.tenantId,
    messages,
    currentTeamsActivityIds(activity),
    userInfoMap,
  );
  return formattedTeamsContext(
    formatTeamsThreadContext(contextMessages),
    contextMessages,
  );
}

function shouldDispatchTeamsMessage(activity: TeamsMessageActivity): boolean {
  return isTeamsDirectMessage(activity) || activity.mentionsRecipient;
}

function teamsValidationFallbackNotice(args: {
  readonly command: TeamsBotCommand | null;
  readonly isGreeting: boolean;
  readonly installation?: TeamsInstallation | null;
}): TeamsMessageDispatchResult | null {
  if (args.command === "help") {
    return commandHelpNotice({
      canSwitch: false,
      canModel: false,
      installation: args.installation,
    });
  }
  if (args.isGreeting) {
    return greetingNotice(args.installation);
  }
  return null;
}

async function fetchTeamsPromptContext(
  args: {
    readonly activity: TeamsMessageActivity;
  },
  signal: AbortSignal,
): Promise<TeamsPromptContext> {
  if (isTeamsDirectMessage(args.activity)) {
    return await fetchTeamsDirectMessageThreadContext(args, signal);
  }

  const threadRootMessage = await fetchTeamsThreadRootMessage(
    {
      activity: args.activity,
    },
    signal,
  );
  const recentChannelContext = await fetchRecentTeamsChannelContext(
    {
      activity: args.activity,
      beforeMessage: threadRootMessage,
    },
    signal,
  );
  const threadContext = await fetchTeamsThreadContext(
    {
      activity: args.activity,
      rootMessage: threadRootMessage,
    },
    signal,
  );
  return {
    text: [recentChannelContext.text, threadContext.text]
      .filter((context) => {
        return context.length > 0;
      })
      .join("\n\n"),
    files: [...recentChannelContext.files, ...threadContext.files],
  };
}

interface CanonicalTeamsLaunchContext {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly channelId: string | null;
  readonly conversationId: string;
  readonly conversationType: string | null;
  readonly threadId: string;
  readonly activityId: string | null;
  readonly serviceUrl: string;
  readonly teamsAppId: string | null;
  readonly senderUserId: string;
  readonly senderDisplayName: string | null;
  readonly senderPrincipalName: string | null;
  readonly connectionId: string;
  readonly threadContext: string;
  readonly messageText: string;
  readonly messageFiles: ChatTeamsMessageFiles;
}

function canonicalTeamsLaunchContext(args: {
  readonly activity: TeamsMessageActivity;
  readonly connectionId: string;
  readonly threadId: string;
  readonly threadContext: string;
  readonly messageFiles: ChatTeamsMessageFiles;
}): CanonicalTeamsLaunchContext {
  return {
    tenantId: args.activity.tenantId,
    tenantName: args.activity.tenantName,
    teamId: args.activity.teamId,
    teamName: args.activity.teamName,
    channelId: args.activity.channelId,
    conversationId: args.activity.conversationId,
    conversationType: args.activity.conversationType,
    threadId: args.threadId,
    activityId: args.activity.activityId,
    serviceUrl: args.activity.serviceUrl,
    teamsAppId: args.activity.teamsAppId,
    senderUserId: args.activity.sender.id,
    senderDisplayName: args.activity.sender.name,
    senderPrincipalName: args.activity.sender.userPrincipalName,
    connectionId: args.connectionId,
    threadContext: args.threadContext,
    messageText: args.activity.text,
    messageFiles: args.messageFiles,
  };
}

function teamsChatMessageId(
  activity: TeamsMessageActivity,
  connectionId: string,
): string {
  return uuidv5(
    `${connectionId}:${activity.idempotencyKey}`,
    TEAMS_CHAT_MESSAGE_ID_NAMESPACE,
  );
}

function teamsInputFiles(
  activity: TeamsMessageActivity,
  installation: BoundTeamsInstallation,
  files: readonly TeamsPromptFile[],
): readonly IntegrationInputFile[] {
  return files.map((file) => {
    return {
      sourceId: file.fileId,
      filename: file.name,
      contentType: file.contentType,
      provenance: {
        provider: "teams" as const,
        installationId: installation.teamsTenantId,
        messageId: `${activity.conversationId}:${activity.activityId ?? activity.idempotencyKey}`,
        externalFileId: file.upstreamFileId,
      },
      download: async (downloadSignal: AbortSignal) => {
        if (!isAllowedTeamsDownloadUrl(file.payload.url)) {
          throw new InputFileImportError(
            "invalid-url",
            "Invalid Teams attachment URL",
          );
        }
        const result = await fetchTeamsFile(file.payload, downloadSignal);
        if (result.kind === "teams-error") {
          throw new InputFileImportError(
            "download-failed",
            "Teams attachment download failed",
            result.status,
          );
        }
        return result.response;
      },
    };
  });
}

function teamsLaunchMessageFile(
  file: TeamsPromptFile,
): Omit<ChatTeamsMessageFile, "inCurrentMessage"> {
  return {
    fileId: file.fileId,
    sourceId: file.sourceId,
    name: file.name,
    contentType: file.contentType,
    payload: file.payload,
  };
}

function teamsLaunchMessageFiles(
  files: readonly TeamsPromptFile[],
  historyFiles: readonly TeamsPromptFile[],
  assets: readonly IntegrationInputAsset[],
): ChatTeamsMessageFiles {
  return [
    ...files.map((file) => {
      const asset = readyIntegrationInputAsset(assets, file.fileId);
      return {
        ...teamsLaunchMessageFile(file),
        inCurrentMessage: true,
        ...(asset
          ? {
              canonicalAsset: {
                assetId: asset.assetId,
                filename: asset.filename,
                contentType: asset.contentType,
              },
            }
          : {}),
      };
    }),
    ...historyFiles.map((file) => {
      return { ...teamsLaunchMessageFile(file), inCurrentMessage: false };
    }),
  ];
}

type PersistedTeamsChatMessage =
  | {
      readonly inserted: true;
      readonly chatThreadId: string;
      readonly chatEventId: string;
    }
  | { readonly inserted: false };

const persistTeamsChatMessage$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly composeId: string;
      readonly promptFiles: readonly TeamsPromptFile[];
      readonly promptContext: TeamsPromptContext;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<PersistedTeamsChatMessage> => {
    const currentTime = new Date(args.apiStartTime);
    const threadId = teamsSessionThreadId({
      activity: args.activity,
    });
    const route = await set(
      ensureTeamsChatThreadRoute$,
      {
        initialModel: await set(
          resolveDefaultModelFirstPin$,
          {
            orgId: args.installation.orgId,
            userId: args.connection.userId,
            defaultSource: undefined,
            orgPlanCapabilities: undefined,
          },
          signal,
        ),
        connectionId: args.connection.id,
        conversationId: args.activity.conversationId,
        threadId,
        userId: args.connection.userId,
        orgId: args.installation.orgId,
        agentId: args.composeId,
        currentTime,
      },
      signal,
    );
    signal.throwIfAborted();

    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: args.connection.userId,
        orgId: args.installation.orgId,
        chatThreadId: route.chatThreadId,
        files: teamsInputFiles(
          args.activity,
          args.installation,
          args.promptFiles,
        ),
      },
      signal,
    );

    const launchContext = canonicalTeamsLaunchContext({
      activity: args.activity,
      connectionId: args.connection.id,
      threadId,
      threadContext: args.promptContext.text,
      messageFiles: teamsLaunchMessageFiles(
        args.promptFiles,
        args.promptContext.files,
        assets,
      ),
    });
    const chatEventId = teamsChatMessageId(args.activity, args.connection.id);
    const values = {
      id: chatEventId,
      chatThreadId: route.chatThreadId,
      eventType: "input.prompt",
      modelSelection: await set(
        resolveEnqueuedChatInputModel$,
        {
          threadId: route.chatThreadId,
          orgId: args.installation.orgId,
          userId: args.connection.userId,
        },
        signal,
      ),
      userMessage: createUserMessageDocument({
        text: [
          args.activity.text,
          ...args.promptFiles
            .filter((file) => {
              return !readyIntegrationInputAsset(assets, file.fileId);
            })
            .map(formatTeamsFileForContext),
        ]
          .filter(Boolean)
          .join("\n\n"),
        files: integrationInputMessageFiles(assets),
        nonContentPart: createChatEventSourcePart({
          kind: "teams",
          tenantId: launchContext.tenantId,
          channelId: launchContext.channelId,
          activityId: launchContext.activityId,
          conversationId: launchContext.conversationId,
          conversationType: launchContext.conversationType,
          botId: args.installation.botId,
        }),
      }),
      runId: null,
      teamsContext: launchContext,
      createdAt: currentTime,
    } as const;
    const eventId = await set(
      enqueueIntegrationChatInput$,
      { orgId: args.installation.orgId, input: values },
      signal,
    );
    signal.throwIfAborted();
    if (eventId === null) {
      return { inserted: false };
    }
    return { inserted: true, chatThreadId: route.chatThreadId, chatEventId };
  },
);

/** Reply with the wait notice when the input waits for an org run slot. */
const replyTeamsChatQueueWait$ = command(
  async (
    _,
    activity: TeamsMessageActivity,
    reason: ChatQueueWaitReason,
    signal: AbortSignal,
  ): Promise<void> => {
    const notice = chatQueueWaitNotice(reason);
    if (!notice) {
      return;
    }
    const reply = await sendTeamsMessageReply(
      {
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversationId,
        activityId: activity.activityId ?? undefined,
        tenantId: activity.tenantId,
        text: notice,
      },
      signal,
    );
    if (reply.kind === "teams-error") {
      L.warn("Teams wait notice failed", {
        tenantId: activity.tenantId,
        conversationId: activity.conversationId,
        activityId: activity.activityId,
        status: reply.status,
        error: reply.error,
      });
    }
  },
);

const runAgentForTeams$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly composeId: string;
      readonly promptFiles: readonly TeamsPromptFile[];
      readonly promptContext: TeamsPromptContext;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    args.timing.recordElapsed(
      "api_dispatch_pre_create_agent_teams_create_run",
      "nested",
      nowDate().getTime(),
    );
    const db = set(writeDb$);
    const persisted = await set(
      persistTeamsChatMessage$,
      {
        db,
        activity: args.activity,
        installation: args.installation,
        connection: args.connection,
        composeId: args.composeId,
        promptFiles: args.promptFiles,
        promptContext: args.promptContext,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.inserted) {
      return { kind: "ignored" };
    }

    waitUntil(
      (async () => {
        const picked = await settle(
          set(
            pickEnqueuedChatThread$,
            {
              orgId: args.installation.orgId,
              chatThreadId: persisted.chatThreadId,
            },
            signal,
          ),
        );
        await set(
          touchNativeChatThread$,
          {
            chatThreadId: persisted.chatThreadId,
            createdAt: new Date(args.apiStartTime),
            eventId: persisted.chatEventId,
          },
          signal,
        );
        await publishThreadListChangedSafely({
          userId: args.connection.userId,
          orgId: args.installation.orgId,
        });
        await publishChatThreadMessageCreatedSafely({
          userId: args.connection.userId,
          orgId: args.installation.orgId,
          threadId: persisted.chatThreadId,
        });
        const noticed = await settle(
          (async () => {
            const pick = await set(
              enqueuedChatQueueWaitReason$,
              {
                orgId: args.installation.orgId,
                chatThreadId: persisted.chatThreadId,
                eventId: persisted.chatEventId,
              },
              signal,
            );
            await set(
              replyTeamsChatQueueWait$,
              args.activity,
              pick.reason,
              signal,
            );
          })(),
        );
        if (!picked.ok && !noticed.ok) {
          throw new AggregateError(
            [picked.error, noticed.error],
            "Enqueued chat thread pick and wait notice failed",
          );
        }
        if (!picked.ok) {
          throw picked.error;
        }
        if (!noticed.ok) {
          throw noticed.error;
        }
      })(),
    );
    waitUntil(
      set(notifyRunningChatRunOfPendingInput$, persisted.chatThreadId, signal),
    );
    return { kind: "accepted" };
  },
);

function connectNotice(
  activity: TeamsMessageActivity,
  installation: TeamsInstallation | null,
): TeamsMessageDispatchResult {
  const { assistantName } = teamsIdentity(installation);
  const connectUrl = buildTeamsConnectUrlForActivity({
    activity,
    installation,
  });
  return {
    kind: "notice",
    replyText: `Please connect your account to use ${assistantName} in this Teams workspace.`,
    ...(connectUrl ? { connectUrl } : {}),
  };
}

function composeResolutionNotice(
  status: Exclude<EffectiveComposeResolution["status"], "resolved">,
): TeamsMessageDispatchResult {
  switch (status) {
    case "not_configured": {
      return {
        kind: "notice",
        replyText:
          "No agent is configured for this org. Please ask your org admin to set a default agent.",
      };
    }
    case "not_found": {
      return {
        kind: "notice",
        replyText:
          "The configured agent could not be found. Please contact your org admin.",
      };
    }
    case "not_accessible": {
      return {
        kind: "notice",
        replyText:
          "The configured agent is not available to your Teams account.",
      };
    }
  }
}

function unboundInstallationNotice(args: {
  readonly command: TeamsBotCommand | null;
  readonly isGreeting: boolean;
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation | null;
}): TeamsMessageDispatchResult {
  if (args.command === "help") {
    return commandHelpNotice({
      canSwitch: false,
      canModel: false,
      installation: args.installation,
    });
  }
  if (args.command === "connect" && !args.installation) {
    return notInstalledNotice(args.installation);
  }
  if (args.isGreeting) {
    return greetingNotice(args.installation);
  }
  return connectNotice(args.activity, args.installation);
}

function missingConnectionNotice(args: {
  readonly command: TeamsBotCommand | null;
  readonly isGreeting: boolean;
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
}): TeamsMessageDispatchResult {
  if (args.command === "help") {
    return commandHelpNotice({
      canSwitch: true,
      canModel: false,
      installation: args.installation,
    });
  }
  if (args.isGreeting) {
    return greetingNotice(args.installation);
  }
  return connectNotice(args.activity, args.installation);
}

interface ConnectedCommandBeforeComposeArgs {
  readonly db: Db;
  readonly activity: TeamsMessageActivity;
  readonly command: TeamsBotCommand | null;
  readonly installation: BoundTeamsInstallation;
  readonly connection: TeamsConnection;
}

const connectedCommandBeforeCompose$ = command(
  async (
    { set },
    args: ConnectedCommandBeforeComposeArgs,
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult | null> => {
    switch (args.command) {
      case "help": {
        return commandHelpNotice({
          canSwitch: true,
          canModel: true,
          installation: args.installation,
        });
      }
      case "connect": {
        return connectedNotice(args.installation);
      }
      case "disconnect": {
        const result = await set(
          disconnectTeamsConnection$,
          {
            orgId: args.installation.orgId,
            userId: args.connection.userId,
          },
          signal,
        );
        signal.throwIfAborted();
        if (result.kind === "not_found") {
          return {
            kind: "notice",
            replyText: "You are not connected.",
          };
        }
        await set(
          publishTeamsChanged$,
          { orgId: result.orgId, userIds: [result.userId] },
          signal,
        );
        signal.throwIfAborted();
        return disconnectedNotice();
      }
      case "switch": {
        return orgDefaultAgentNotice();
      }
      case "model": {
        const routeThreadId = teamsSessionThreadId({ activity: args.activity });
        const chatThreadId = await set(
          findTeamsRoutedChatThreadId$,
          {
            connectionId: args.connection.id,
            conversationId: args.activity.conversationId,
            threadId: routeThreadId,
            userId: args.connection.userId,
          },
          signal,
        );
        signal.throwIfAborted();
        const currentModel = await set(
          readIntegrationChatThreadModel$,
          {
            orgId: args.installation.orgId,
            userId: args.connection.userId,
            chatThreadId,
          },
          signal,
        );
        signal.throwIfAborted();
        if (!chatThreadId || !currentModel) {
          return {
            kind: "notice",
            replyText:
              "Start or enter an existing Okou conversation before using /model.",
          };
        }
        const picker = await set(
          teamsModelPickerState$,
          args.installation.orgId,
          args.connection.userId,
          currentModel,
          signal,
        );
        signal.throwIfAborted();
        if (!picker.enabled) {
          return {
            kind: "notice",
            replyText: "Model switching is not available for this workspace.",
          };
        }
        if (picker.options.length === 0) {
          return {
            kind: "notice",
            replyText: "No models are configured for this workspace.",
          };
        }
        return {
          kind: "notice",
          replyText: "Choose the model for this Teams conversation.",
          card: buildTeamsModelPickerCard({
            options: picker.options,
            currentSelectedModel: picker.currentSelectedModel,
            routeConversationId: args.activity.conversationId,
            routeThreadId,
            chatThreadId,
          }),
        };
      }
      case null: {
        return null;
      }
    }
  },
);

const connectedTeamsCardAction$ = command(
  async (
    { set },
    args: {
      readonly action: TeamsCardAction;
      readonly db: Db;
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    if (args.action === "switch_agent") {
      return orgDefaultAgentNotice();
    }

    const selected = stringValue(
      args.activity.value,
      TEAMS_MODEL_PICKER_INPUT_ID,
    );
    if (!selected) {
      return {
        kind: "notice",
        replyText: "Please choose a model.",
      };
    }
    const routeConversationId = stringValue(
      args.activity.value,
      TEAMS_MODEL_PICKER_CONVERSATION_KEY,
    );
    const routeThreadId = stringValue(
      args.activity.value,
      TEAMS_MODEL_PICKER_THREAD_KEY,
    );
    const expectedChatThreadId = stringValue(
      args.activity.value,
      TEAMS_MODEL_PICKER_CHAT_THREAD_KEY,
    );
    if (!routeConversationId || !routeThreadId || !expectedChatThreadId) {
      return {
        kind: "notice",
        replyText: "This model picker is out of date. Send `/model` again.",
      };
    }

    const chatThreadId = await set(
      findTeamsRoutedChatThreadId$,
      {
        connectionId: args.connection.id,
        conversationId: routeConversationId,
        threadId: routeThreadId,
        userId: args.connection.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!chatThreadId || chatThreadId !== expectedChatThreadId) {
      return {
        kind: "notice",
        replyText: "This model picker is out of date. Send `/model` again.",
      };
    }
    const currentModel = await set(
      readIntegrationChatThreadModel$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.userId,
        chatThreadId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!currentModel) {
      return {
        kind: "notice",
        replyText: "This model picker is out of date. Send `/model` again.",
      };
    }
    const picker = await set(
      teamsModelPickerState$,
      args.installation.orgId,
      args.connection.userId,
      currentModel,
      signal,
    );
    signal.throwIfAborted();
    const option = picker.options.find((candidate) => {
      return candidate.model === selected;
    });
    if (!option) {
      return {
        kind: "notice",
        replyText: "You don't have access to that model.",
      };
    }
    signal.throwIfAborted();
    const threadModel = await set(
      updateIntegrationChatThreadModel$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.userId,
        chatThreadId,
        model: option.model,
      },
      signal,
    );
    if (threadModel.kind !== "updated") {
      return {
        kind: "notice",
        replyText:
          threadModel.kind === "no_thread"
            ? "This model picker is out of date. Send `/model` again."
            : "You don't have access to that model.",
      };
    }
    signal.throwIfAborted();
    return {
      kind: "notice",
      replyText: `Switched to **${option.label}**.`,
    };
  },
);

const runResolvedTeamsAgentForActivity$ = command(
  async (
    { set },
    args: {
      readonly prompt: string;
      readonly promptFiles: readonly TeamsPromptFile[];
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly effectiveCompose: ResolvedEffectiveCompose;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    const db = set(writeDb$);
    const [existingMessage] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        eq(
          chatEvents.id,
          teamsChatMessageId(args.activity, args.connection.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (existingMessage) {
      return { kind: "ignored" };
    }

    await sendTeamsRunStartIndicator(
      {
        activity: args.activity,
      },
      signal,
    );
    signal.throwIfAborted();

    const promptContext = await loadOptionalChatEnrichment(
      "teams",
      () => {
        return fetchTeamsPromptContext({ activity: args.activity }, signal);
      },
      () => {
        return { text: "", files: [] };
      },
      signal,
    );
    signal.throwIfAborted();

    return await set(
      runAgentForTeams$,
      {
        activity: { ...args.activity, text: args.prompt },
        installation: args.installation,
        connection: args.connection,
        composeId: args.effectiveCompose.composeId,
        promptFiles: args.promptFiles,
        promptContext,
        apiStartTime: args.apiStartTime,
        timing: args.timing,
      },
      signal,
    );
  },
);

function teamsAgentPrompt(activity: TeamsMessageActivity): string {
  const recipientMention =
    activity.mentionsRecipient && activity.recipient
      ? `@${activity.recipient.name ?? activity.recipient.id}`
      : "";
  return [recipientMention, activity.text.trim()].filter(Boolean).join(" ");
}

export const dispatchTeamsMessageToAgent$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsInboundActivity;
      readonly installation?: TeamsInstallation | null;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    const { activity } = args;
    if (activity.kind !== "message") {
      return { kind: "ignored" };
    }

    const cardAction = teamsCardAction(activity.value);
    const commandText = activity.text.trim();
    const prompt = teamsAgentPrompt(activity);
    const command = cardAction ? null : parseTeamsBotCommand(commandText);
    const isGreeting = !cardAction && isTeamsBotGreeting(commandText);
    if (!cardAction && !shouldDispatchTeamsMessage(activity)) {
      return (
        teamsValidationFallbackNotice({
          command,
          isGreeting,
          installation: args.installation,
        }) ?? {
          kind: "ignored",
        }
      );
    }

    const promptFiles = cardAction ? [] : teamsPromptFiles(activity);
    if (!prompt && promptFiles.length === 0 && !cardAction) {
      const { botName } = teamsIdentity(args.installation);
      return {
        kind: "notice",
        replyText: `Please include a message for ${botName}.`,
      };
    }

    const db = set(writeDb$);
    const installation =
      args.installation ??
      (await installationForTenant(db, activity.tenantId)) ??
      null;
    signal.throwIfAborted();

    if (!installation?.orgId) {
      return unboundInstallationNotice({
        command,
        isGreeting,
        activity,
        installation,
      });
    }
    const boundInstallation: BoundTeamsInstallation = {
      ...installation,
      orgId: installation.orgId,
    };

    const connection = await connectionForTeamsUser(
      db,
      activity.tenantId,
      activity.sender.id,
      activity.sender.aadObjectId,
    );
    signal.throwIfAborted();

    if (!connection) {
      return missingConnectionNotice({
        command,
        isGreeting,
        activity,
        installation,
      });
    }

    if (cardAction) {
      return set(
        connectedTeamsCardAction$,
        {
          action: cardAction,
          db,
          activity,
          installation: boundInstallation,
          connection,
        },
        signal,
      );
    }

    const commandResult = await set(
      connectedCommandBeforeCompose$,
      {
        db,
        activity,
        command,
        installation: boundInstallation,
        connection,
      },
      signal,
    );
    signal.throwIfAborted();
    if (commandResult) {
      return commandResult;
    }

    const effectiveCompose = await resolveEffectiveCompose({
      db,
      userId: connection.userId,
      orgId: boundInstallation.orgId,
    });
    signal.throwIfAborted();

    if (effectiveCompose.status !== "resolved") {
      return composeResolutionNotice(effectiveCompose.status);
    }

    return set(
      runResolvedTeamsAgentForActivity$,
      {
        prompt,
        promptFiles,
        activity,
        installation: boundInstallation,
        connection,
        effectiveCompose,
        apiStartTime: args.apiStartTime,
        timing: args.timing,
      },
      signal,
    );
  },
);
