import type { UserMessagePart } from "@okouai/api-contracts/contracts/chat-threads";

type UserMessageSourcePart = Extract<
  UserMessagePart,
  { readonly type: "source" }
>;

type ChatEventSourceContext =
  | {
      readonly kind: "slack";
      readonly messagePermalink: string | null;
    }
  | {
      readonly kind: "feishu" | "lark";
      readonly chatOpenUrl: string | null;
    }
  | {
      readonly kind: "teams";
      readonly tenantId: string | null;
      readonly channelId: string | null;
      readonly activityId: string | null;
      readonly conversationId: string | null;
      readonly conversationType: string | null;
      readonly botId: string | null;
    }
  | {
      readonly kind: "telegram";
      readonly chatId: string | null;
      readonly messageId: string | null;
      readonly isDm: boolean | null;
      readonly botUsername: string | null;
    }
  | {
      readonly kind: "github";
      readonly repo: string | null;
      readonly subjectNumber: number | null;
      readonly subjectKind: "issue" | "pull_request" | null;
      readonly triggerCommentId: string | null;
    }
  | {
      readonly kind: "agentphone";
      readonly toNumber: string;
      readonly isGroup: boolean;
    };

function storedHref(value: string | null): string | undefined {
  return value ?? undefined;
}

function teamsSourceUrl(
  context: Extract<ChatEventSourceContext, { readonly kind: "teams" }>,
): string | undefined {
  if (!context.tenantId || !context.activityId) {
    return undefined;
  }
  const tenantQuery = `tenantId=${encodeURIComponent(context.tenantId)}`;
  if (context.channelId) {
    return `https://teams.microsoft.com/l/message/${encodeURIComponent(context.channelId)}/${encodeURIComponent(context.activityId)}?${tenantQuery}`;
  }
  if (context.conversationId?.startsWith("19:")) {
    const chatId = encodeURIComponent(context.conversationId);
    return `https://teams.microsoft.com/l/message/${chatId}/${encodeURIComponent(context.activityId)}?${tenantQuery}&context=${encodeURIComponent(JSON.stringify({ contextType: "chat" }))}`;
  }
  // Bot Framework personal conversation IDs (a:...) are not Graph chat IDs.
  if (
    context.conversationType === "personal" &&
    context.botId?.startsWith("28:")
  ) {
    return `https://teams.microsoft.com/l/chat/0/0?${tenantQuery}&users=${encodeURIComponent(context.botId)}`;
  }
  return undefined;
}

function telegramSourceUrl(
  context: Extract<ChatEventSourceContext, { readonly kind: "telegram" }>,
): string | undefined {
  if (context.isDm === true) {
    const username = context.botUsername?.trim().replace(/^@/u, "");
    return username && /^[a-z\d_]+$/iu.test(username)
      ? `https://t.me/${username}`
      : undefined;
  }
  if (
    context.isDm !== false ||
    context.chatId === null ||
    context.messageId === null ||
    !context.chatId.startsWith("-100")
  ) {
    return undefined;
  }
  const internalChatId = context.chatId.slice(4);
  if (
    !/^[1-9]\d*$/u.test(internalChatId) ||
    !/^[1-9]\d*$/u.test(context.messageId)
  ) {
    return undefined;
  }
  return `https://t.me/c/${internalChatId}/${context.messageId}`;
}

function agentphoneChatUrl(
  context: Extract<ChatEventSourceContext, { readonly kind: "agentphone" }>,
): string | undefined {
  // The inbound destination is the assistant's number; the sender is the user.
  return !context.isGroup && /^\+[1-9]\d{7,14}$/u.test(context.toNumber)
    ? `sms:${context.toNumber}`
    : undefined;
}

function githubSubjectUrl(
  context: Extract<ChatEventSourceContext, { readonly kind: "github" }>,
): string | undefined {
  if (
    context.repo === null ||
    context.subjectNumber === null ||
    context.subjectKind === null
  ) {
    return undefined;
  }
  const [owner, repo, ...extraParts] = context.repo.split("/");
  if (
    !owner ||
    !repo ||
    extraParts.length > 0 ||
    !Number.isInteger(context.subjectNumber) ||
    context.subjectNumber <= 0
  ) {
    return undefined;
  }
  const commentId = context.triggerCommentId;
  if (commentId !== null && !/^[1-9]\d*$/u.test(commentId)) {
    return undefined;
  }
  const subjectPath =
    context.subjectKind === "pull_request" ? "pull" : "issues";
  const subjectUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/${subjectPath}/${context.subjectNumber}`;
  return commentId === null
    ? subjectUrl
    : `${subjectUrl}#issuecomment-${commentId}`;
}

export function createChatEventSourcePart(
  context: ChatEventSourceContext,
): UserMessageSourcePart {
  let href: string | undefined;
  if (context.kind === "slack") {
    href = storedHref(context.messagePermalink);
  } else if (context.kind === "feishu" || context.kind === "lark") {
    href = storedHref(context.chatOpenUrl);
  } else if (context.kind === "teams") {
    href = teamsSourceUrl(context);
  } else if (context.kind === "telegram") {
    href = telegramSourceUrl(context);
  } else if (context.kind === "github") {
    href = githubSubjectUrl(context);
  } else if (context.kind === "agentphone") {
    href = agentphoneChatUrl(context);
  }
  return {
    type: "source",
    kind: context.kind,
    ...(href ? { href } : {}),
  };
}
