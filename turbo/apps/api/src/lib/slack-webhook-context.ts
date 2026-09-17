import type {
  ChatSlackMessageAssets,
  ChatSlackMessageFile,
} from "@okouai/db/jsonb-contracts/chat-slack-context";
import { CONVERSATION_GUIDANCE } from "./conversation-guidance";

import {
  formatSenderBlock,
  type SlackClient,
  type SlackConversationMessage,
  type SlackMessageAttachment,
  type SlackMessageBlock,
  type SlackRichTextElement,
  type SlackRichTextStyle,
  type SlackUserInfo,
  type SlackUserInfoResolver,
} from "../signals/external/slack-message-client";

export type SlackFile = ChatSlackMessageFile;

type SlackConversationContextPhase =
  | "replies"
  | "history"
  | "user_info"
  | "format";

type SlackConversationContextShape =
  | "dm_no_thread"
  | "channel_no_thread"
  | "dm_thread"
  | "channel_thread";

interface SlackConversationContextTelemetryDimensions {
  readonly slack_context_shape: SlackConversationContextShape;
  readonly slack_context_thread_message_count_bucket: string;
  readonly slack_context_channel_message_count_bucket: string;
  readonly slack_context_total_message_count_bucket: string;
  readonly slack_context_user_info_id_count_bucket: string;
}

interface SlackConversationContextObserver {
  readonly measure: <T>(
    phase: SlackConversationContextPhase,
    operation: () => T | Promise<T>,
  ) => Promise<T>;
  readonly dimensions: (
    dimensions: SlackConversationContextTelemetryDimensions,
  ) => void;
}

interface SlackConversationContextOptions {
  readonly observer?: SlackConversationContextObserver;
  readonly userInfoResolver?: SlackUserInfoResolver;
}

function applyTextStyle(
  text: string,
  style: SlackRichTextStyle | string | undefined,
): string {
  if (typeof style === "string" || !style) {
    return text;
  }
  if (style.code) {
    return `\`${text}\``;
  }
  let result = text;
  if (style.bold) {
    result = `**${result}**`;
  }
  if (style.italic) {
    result = `_${result}_`;
  }
  if (style.strike) {
    result = `~${result}~`;
  }
  return result;
}

function formatInlineElement(element: SlackRichTextElement): string {
  switch (element.type) {
    case "text": {
      return applyTextStyle(element.text ?? "", element.style);
    }
    case "link": {
      return element.url
        ? `[${element.text ?? element.url}](${element.url})`
        : (element.text ?? "");
    }
    case "emoji": {
      return element.unicode
        ? String.fromCodePoint(
            ...element.unicode.split("-").map((hex) => {
              return Number.parseInt(hex, 16);
            }),
          )
        : `:${element.name ?? "emoji"}:`;
    }
    case "user": {
      return `<@${element.user_id ?? "unknown"}>`;
    }
    case "usergroup": {
      return `<!subteam^${element.usergroup_id ?? "unknown"}>`;
    }
    case "channel": {
      return `<#${element.channel_id ?? "unknown"}>`;
    }
    case "broadcast": {
      return `@${element.range ?? "here"}`;
    }
    default: {
      return element.text ?? "";
    }
  }
}

function inlineElementsToText(
  elements: readonly SlackRichTextElement[],
): string {
  return elements.map(formatInlineElement).join("");
}

function formatRichTextList(section: SlackRichTextElement): string[] {
  const indent = "  ".repeat(section.indent ?? 0);
  const listStyle =
    typeof section.style === "string" ? section.style : undefined;
  const parts: string[] = [];
  const elements = section.elements ?? [];
  for (const [index, item] of elements.entries()) {
    const bullet =
      listStyle === "ordered" ? `${(section.offset ?? 0) + index + 1}.` : "-";
    parts.push(
      `${indent}${bullet} ${inlineElementsToText(item.elements ?? [])}`,
    );
  }
  return parts;
}

function formatRichTextSection(section: SlackRichTextElement): string[] {
  switch (section.type) {
    case "rich_text_section": {
      return [inlineElementsToText(section.elements ?? [])];
    }
    case "rich_text_list": {
      return formatRichTextList(section);
    }
    case "rich_text_preformatted": {
      const code = inlineElementsToText(section.elements ?? []);
      const language = section.language ?? "";
      return [`\`\`\`${language}\n${code}\n\`\`\``];
    }
    case "rich_text_quote": {
      return [
        inlineElementsToText(section.elements ?? [])
          .split("\n")
          .map((line) => {
            return `> ${line}`;
          })
          .join("\n"),
      ];
    }
    default: {
      return [];
    }
  }
}

function extractTextFromBlocks(
  blocks: readonly SlackMessageBlock[] | undefined,
): string | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "rich_text") {
      continue;
    }
    for (const section of block.elements ?? []) {
      parts.push(...formatRichTextSection(section));
    }
  }

  const result = parts.join("\n");
  return result.length > 0 ? result : undefined;
}

function formatFileInfo(file: SlackFile): string {
  const parts: string[] = [];
  const name = file.name || file.title || "Untitled";
  const type = file.pretty_type || file.mimetype || "file";
  parts.push(`[Slack file] ${name} (${type})`);

  if (file.original_w && file.original_h) {
    parts.push(`   [Dimensions] ${file.original_w}x${file.original_h}`);
  }
  if (file.id) {
    parts.push(`   [ID] ${file.id}`);
  } else {
    const url =
      file.permalink_public ||
      file.thumb_480 ||
      file.thumb_360 ||
      file.permalink;
    if (url) {
      parts.push(`   [URL] ${url}`);
    }
  }

  return parts.join("\n");
}

function formatAttachmentImage(
  attachment: SlackMessageAttachment,
): string | null {
  if (!attachment.image_url && !attachment.thumb_url) {
    return null;
  }
  const parts: string[] = [];
  const title = attachment.title || attachment.fallback || "Image";
  parts.push(`[image]: ${title}`);
  if (attachment.image_width && attachment.image_height) {
    parts.push(
      `   [Dimensions] ${attachment.image_width}x${attachment.image_height}`,
    );
  }
  const url = attachment.image_url || attachment.thumb_url;
  if (url) {
    parts.push(
      `   View: curl -sS -o /tmp/attachment_image.jpg "${url}" && read /tmp/attachment_image.jpg`,
    );
  }
  return parts.join("\n");
}

export function resolveUserMentions(
  text: string,
  userInfoMap?: Map<string, SlackUserInfo>,
  includeSlackUserId = true,
): string {
  if (!userInfoMap || userInfoMap.size === 0) {
    return text;
  }
  return text.replace(/<@(\w+)>/g, (_match, userId: string) => {
    const info = userInfoMap.get(userId);
    return info?.name
      ? includeSlackUserId
        ? `@${info.name} (${userId})`
        : `@${info.name}`
      : `<@${userId}>`;
  });
}

function extractMentionedUserIds(
  messages: readonly SlackConversationMessage[],
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    addMentionedUserIdsFromBlocks(message.blocks, ids);
    if (message.text) {
      for (const match of message.text.matchAll(/<@(\w+)>/g)) {
        const userId = match[1];
        if (userId) {
          ids.add(userId);
        }
      }
    }
  }
  return [...ids];
}

function addMentionedUserIdsFromBlocks(
  blocks: readonly SlackMessageBlock[] | undefined,
  ids: Set<string>,
): void {
  for (const block of blocks ?? []) {
    for (const section of block.elements ?? []) {
      addMentionedUserIdsFromElements(section.elements, ids);
    }
  }
}

function addMentionedUserIdsFromElements(
  elements: readonly SlackRichTextElement[] | undefined,
  ids: Set<string>,
): void {
  for (const element of elements ?? []) {
    if (element.type === "user" && element.user_id) {
      ids.add(element.user_id);
    }
  }
}

function formatMessageWithMetadata(
  message: SlackConversationMessage,
  relativeIndex: number,
  fileParts: readonly string[],
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  const senderId = message.bot_id ? "BOT" : (message.user ?? "unknown");
  const userInfo = userInfoMap?.get(senderId);
  const rawText = extractTextFromBlocks(message.blocks) ?? message.text ?? "";
  const text = resolveUserMentions(rawText, userInfoMap);

  const parts = [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    formatSenderBlock(userInfo ?? { id: senderId }),
    "",
    text,
  ];
  if (fileParts.length > 0) {
    parts.push(...fileParts);
  }
  return parts.join("\n");
}

const CONTEXT_PREAMBLE = [
  "The messages below are from a Slack conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent \u2014 prioritize them.",
].join("\n");

function formatContextForAgent(
  messages: readonly SlackConversationMessage[],
  contextType: "thread" | "channel" = "thread",
  userInfoMap?: Map<string, SlackUserInfo>,
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    const fileParts: string[] = [];
    for (const file of message.files ?? []) {
      fileParts.push(formatFileInfo(file));
    }
    for (const attachment of message.attachments ?? []) {
      const attachmentInfo = formatAttachmentImage(attachment);
      if (attachmentInfo) {
        fileParts.push(attachmentInfo);
      }
    }
    return formatMessageWithMetadata(
      message,
      index - totalMessages,
      fileParts,
      userInfoMap,
    );
  });

  const header =
    contextType === "thread"
      ? "# Slack Thread Context"
      : "# Recent Channel Messages";
  return `${header}\n\n${CONTEXT_PREAMBLE}\n\n${formattedMessages.join(
    "\n\n",
  )}\n\n---`;
}

function formatCurrentMessageFiles(files: readonly SlackFile[]): string {
  return files.map(formatFileInfo).join("\n");
}

function canonicalSlackFilesPrompt(
  files: readonly SlackFile[] | undefined,
  assets: ChatSlackMessageAssets,
): string {
  if (!files || files.length === 0) {
    return "";
  }
  const assetBySlackFileId = new Map(
    assets.map((asset) => {
      return [asset.slackFileId, asset] as const;
    }),
  );
  return files
    .flatMap((file) => {
      const asset =
        file.id === undefined ? undefined : assetBySlackFileId.get(file.id);
      if (asset?.status === "ready") {
        return [
          `[Web file] ${asset.filename} (${asset.contentType})\n   [ID] ${asset.assetId}`,
        ];
      }
      return [formatCurrentMessageFiles([file])];
    })
    .filter(Boolean)
    .join("\n");
}

export function canonicalSlackAgentPrompt(
  messagePrompt: string,
  files: readonly SlackFile[] | undefined,
  assets: ChatSlackMessageAssets,
): string {
  return [messagePrompt, canonicalSlackFilesPrompt(files, assets)]
    .filter(Boolean)
    .join("\n\n");
}

export function buildSlackSystemPrompt(args: {
  readonly botUserId: string;
  readonly channelId: string;
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly threadTs: string;
  readonly executionContext: string;
}): string {
  const typeLabel =
    args.channelType === "dm"
      ? "Direct message"
      : args.channelType === "group_dm"
        ? "Group direct message"
        : "Channel";
  return [
    CONVERSATION_GUIDANCE,
    "",
    "# Current Integration",
    "You are currently running inside: Slack",
    `Your bot user ID: ${args.botUserId}`,
    `Channel ID: ${args.channelId}`,
    `Channel type: ${typeLabel}`,
    `Thread ID: ${args.threadTs}`,
    args.executionContext,
  ]
    .filter(Boolean)
    .join("\n");
}

function countBucket(count: number): string {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function slackConversationContextShape(args: {
  readonly isDm: boolean;
  readonly hasThread: boolean;
}): SlackConversationContextShape {
  if (args.hasThread) {
    return args.isDm ? "dm_thread" : "channel_thread";
  }
  return args.isDm ? "dm_no_thread" : "channel_no_thread";
}

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }

  return result.value;
}

export async function fetchConversationContexts(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  currentMessageTs?: string,
  options?: SlackConversationContextOptions,
): Promise<{ readonly executionContext: string }> {
  const observer = options?.observer;
  const measureContext = async <T>(
    phase: SlackConversationContextPhase,
    operation: () => T | Promise<T>,
  ): Promise<T> => {
    if (observer) {
      return await observer.measure(phase, operation);
    }
    return await operation();
  };
  const isDm = channelId.startsWith("D");
  const contextType = threadTs ? "thread" : "channel";
  const contextShape = slackConversationContextShape({
    isDm,
    hasThread: Boolean(threadTs),
  });
  let allMessages: readonly SlackConversationMessage[];
  let channelMessages: readonly SlackConversationMessage[];
  if (threadTs) {
    const [threadResult, channelResult] = await Promise.allSettled([
      measureContext("replies", async () => {
        return await client.fetchThreadMessages(channelId, threadTs);
      }),
      isDm
        ? Promise.resolve([])
        : measureContext("history", async () => {
            return await client.fetchChannelMessages(channelId, 10, threadTs);
          }),
    ]);
    allMessages = unwrapSettled(threadResult);
    channelMessages = unwrapSettled(channelResult);
  } else {
    allMessages = isDm
      ? []
      : await measureContext("history", async () => {
          return await client.fetchChannelMessages(channelId, 10);
        });
    channelMessages = [];
  }
  const contextMessages = currentMessageTs
    ? allMessages.filter((message) => {
        return message.ts !== currentMessageTs;
      })
    : allMessages;
  const allContextMessages = [...channelMessages, ...allMessages];
  const senderIds = allContextMessages.flatMap((message) => {
    return message.user && !message.bot_id ? [message.user] : [];
  });
  const mentionedIds = extractMentionedUserIds(allContextMessages);
  const userInfoIds = [...senderIds, ...mentionedIds];
  const threadMessageCount = threadTs ? allMessages.length : 0;
  const channelMessageCount = threadTs
    ? channelMessages.length
    : allMessages.length;
  observer?.dimensions({
    slack_context_shape: contextShape,
    slack_context_thread_message_count_bucket: countBucket(threadMessageCount),
    slack_context_channel_message_count_bucket:
      countBucket(channelMessageCount),
    slack_context_total_message_count_bucket: countBucket(
      allContextMessages.length,
    ),
    slack_context_user_info_id_count_bucket: countBucket(
      new Set(userInfoIds).size,
    ),
  });
  const userInfoMap = await measureContext("user_info", async () => {
    return await client.fetchUserInfoMap(
      userInfoIds,
      options?.userInfoResolver,
    );
  });
  const { channelContextPrefix, threadExecContext } = await measureContext(
    "format",
    () => {
      return {
        channelContextPrefix:
          channelMessages.length > 0
            ? formatContextForAgent(channelMessages, "channel", userInfoMap)
            : "",
        threadExecContext:
          contextMessages.length > 0
            ? formatContextForAgent(contextMessages, contextType, userInfoMap)
            : "",
      };
    },
  );
  return {
    executionContext: channelContextPrefix
      ? `${channelContextPrefix}\n\n${threadExecContext}`
      : threadExecContext,
  };
}

export async function enrichMessageContent(opts: {
  readonly messageContent: string;
  readonly files: readonly SlackFile[] | undefined;
  readonly client: SlackClient;
  readonly userId: string;
  readonly userInfoResolver?: SlackUserInfoResolver;
}): Promise<{
  readonly prompt: string;
  readonly displayContent: string;
  readonly userInfoExtras: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
  readonly mentionDisplayNames: Readonly<Record<string, string>>;
}> {
  let prompt = opts.messageContent;
  let displayContent = opts.messageContent;
  if (opts.files && opts.files.length > 0) {
    prompt = `${prompt}\n\n${formatCurrentMessageFiles(opts.files)}`;
    displayContent = [
      displayContent,
      ...opts.files.map((file) => {
        const name = file.name || file.title || "Untitled";
        const type = file.pretty_type || file.mimetype || "file";
        return `[Slack file] ${name} (${type})`;
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const mentionedIds = extractMentionedUserIds([{ text: opts.messageContent }]);
  const userInfoMap = await opts.client.fetchUserInfoMap(
    [opts.userId, ...mentionedIds],
    opts.userInfoResolver,
  );
  prompt = resolveUserMentions(prompt, userInfoMap);
  displayContent = resolveUserMentions(displayContent, userInfoMap, false);

  const currentUser = userInfoMap.get(opts.userId);
  return {
    prompt,
    displayContent,
    userInfoExtras: currentUser
      ? {
          slackDisplayName: currentUser.name,
          slackUserId: currentUser.id,
        }
      : {},
    mentionDisplayNames: Object.fromEntries(
      mentionedIds.flatMap((userId) => {
        const displayName = userInfoMap.get(userId)?.name;
        return displayName ? [[userId, displayName]] : [];
      }),
    ),
  };
}
