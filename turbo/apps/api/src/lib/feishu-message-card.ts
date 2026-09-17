import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";

import type { FeishuOutboundMessage } from "../signals/external/feishu-client";

const MARKDOWN_ELEMENT_MAX_LENGTH = 12_000;

type FeishuCardTemplate = "blue" | "green" | "orange" | "red";

function markdownElements(
  content: string,
): Readonly<Record<string, unknown>>[] {
  const suffix = "\n\n_(Message too long to view in this chat.)_";
  const truncated =
    content.length > MARKDOWN_ELEMENT_MAX_LENGTH
      ? content.slice(0, MARKDOWN_ELEMENT_MAX_LENGTH - suffix.length) + suffix
      : content;
  return [{ tag: "markdown", content: truncated || "\u200b" }];
}

function cardMessage(args: {
  readonly title: string;
  readonly template: FeishuCardTemplate;
  readonly summary: string;
  readonly elements: readonly Readonly<Record<string, unknown>>[];
}): FeishuOutboundMessage {
  return {
    msgType: "interactive",
    content: {
      schema: "2.0",
      config: {
        update_multi: true,
        width_mode: "default",
        summary: { content: args.summary },
      },
      header: {
        title: { tag: "plain_text", content: args.title },
        template: args.template,
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 20px 12px",
        vertical_spacing: "medium",
        elements: args.elements,
      },
    },
  };
}

export function buildFeishuLoginMessage(args: {
  readonly platform?: FeishuPlatform;
  readonly connectUrl: string;
}): FeishuOutboundMessage {
  const platformName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
  return cardMessage({
    title: "Connect your account",
    template: "blue",
    summary: `Connect your account to use ${assistantName} in ${platformName}.`,
    elements: [
      {
        tag: "markdown",
        content: `To use ${assistantName} in ${platformName}, please connect your account first.`,
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "Connect" },
        type: "primary_filled",
        width: "fill",
        behaviors: [{ type: "open_url", default_url: args.connectUrl }],
      },
    ],
  });
}

export function buildFeishuWelcomeMessage(args: {
  readonly platform?: FeishuPlatform;
  readonly agentName: string | null;
  readonly botName: string | null;
}): FeishuOutboundMessage {
  const platformName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const { brandName } = PUBLIC_BRAND_PRESENTATION;
  // Provider bot metadata is unavailable until Feishu discovery succeeds, so
  // keep the fallback provider-neutral while botName is nullable.
  const botName = args.botName ?? `your ${platformName} bot`;
  const agentLine = args.agentName
    ? `\n\nYour current agent is **${args.agentName}**.`
    : "";
  return cardMessage({
    title: "You're connected! 🎉",
    template: "green",
    summary: `Your ${platformName} account is connected to ${brandName}.`,
    elements: [
      {
        tag: "markdown",
        content: `👋 **Hi! I'm ${botName}.**\n\nI connect ${platformName} conversations to AI agents to help with your tasks.${agentLine}`,
      },
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content:
          "Send me a direct message or mention me in a group chat to get started.\n\nCommands: `/help`, `/connect`, `/disconnect`, `/switch`, `/model`.",
      },
    ],
  });
}

export function buildFeishuHelpMessage(args: {
  readonly platform?: FeishuPlatform;
  readonly botName: string | null;
}): FeishuOutboundMessage {
  const platformName = FEISHU_PLATFORMS[args.platform ?? "feishu"].name;
  const { brandName } = PUBLIC_BRAND_PRESENTATION;
  // Keep this fallback provider-neutral while Feishu bot metadata is nullable.
  const botName = args.botName ?? `${platformName} bot`;
  return {
    msgType: "text",
    content: {
      text: [
        `${botName} commands`,
        "",
        "/help — Show this help",
        `/connect — Connect your ${brandName} account`,
        `/disconnect — Disconnect your ${brandName} account`,
        "/switch — Choose which agent responds",
        "/model — Choose your model",
        "",
        "Send a task in a direct message, or mention the bot with a task in a group chat.",
      ].join("\n"),
    },
  };
}

export function buildFeishuNoticeMessage(args: {
  readonly title: string;
  readonly text: string;
  readonly kind?: "error" | "info" | "success" | "warning";
}): FeishuOutboundMessage {
  const templateByKind = {
    error: "red",
    info: "blue",
    success: "green",
    warning: "orange",
  } as const;
  return cardMessage({
    title: args.title,
    template: templateByKind[args.kind ?? "info"],
    summary: args.text,
    elements: markdownElements(args.text),
  });
}

export function buildFeishuAgentResponseMessage(args: {
  readonly text: string;
  readonly auditUrl?: string;
  readonly footerText?: string;
}): FeishuOutboundMessage {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
  const footerElements: Readonly<Record<string, unknown>>[] =
    args.auditUrl || args.footerText
      ? [
          { tag: "hr" },
          {
            tag: "markdown",
            content: [
              args.auditUrl ? `[Audit](${args.auditUrl})` : undefined,
              args.footerText ? `*${args.footerText}*` : undefined,
            ]
              .filter((part): part is string => {
                return Boolean(part);
              })
              .join(" · "),
            text_size: "notation",
          },
        ]
      : [];
  return cardMessage({
    title: assistantName,
    template: "blue",
    summary: args.text.slice(0, 200),
    elements: [...markdownElements(args.text), ...footerElements],
  });
}
