import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import type {
  SlackAnyBlock,
  SlackView,
} from "../signals/external/slack-block-kit";
import { env } from "./env";
import {
  OFFICIAL_SLACK_APP_NAME,
  OFFICIAL_SLACK_PRIMARY_COMMAND,
  officialSlackBotMention,
} from "./slack-official-app";

type SlackBlocks = SlackAnyBlock[];

interface AppHomeOptions {
  readonly isLinked: boolean;
  readonly isInstalled?: boolean;
  readonly userId?: string;
  readonly userEmail?: string;
  readonly agentName?: string;
  readonly loginUrl?: string;
  readonly botUserId: string;
}

function appUrl(): string {
  return env("APP_URL");
}

function buildAppHomeHeaderBlocks(): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Welcome to ${assistantName}! :wave:`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Chat with your workspace's default agent in Slack through direct messages and mentions.",
      },
    },
    { type: "divider" },
  ];
}

function buildAppHomeNotInstalledBlocks(): SlackBlocks {
  const { brandName } = BRAND_PRESENTATION;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *${OFFICIAL_SLACK_APP_NAME} is not installed for this workspace*\nAsk a workspace admin to install ${OFFICIAL_SLACK_APP_NAME} from the platform.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: `Open ${brandName} Settings` },
          url: `${appUrl()}/works`,
          action_id: "home_open_settings",
          style: "primary",
        },
      ],
    },
  ];
}

function buildAppHomeDisconnectedBlocks(loginUrl?: string): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: ":x: *Account not connected*" },
    },
  ];
  if (!loginUrl) {
    return blocks;
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Connect" },
        url: loginUrl,
        action_id: "home_login_prompt",
        style: "primary",
      },
    ],
  });
  return blocks;
}

function buildAppHomeAccountBlock(options: AppHomeOptions): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: *Connected to ${assistantName}*\nAccount: ${
          options.userEmail || options.userId
        }`,
      },
    },
  ];
}

function buildAppHomeAgentBlocks(options: AppHomeOptions): SlackBlocks {
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":robot_face: *Workspace Agent*",
      },
    },
  ];

  const settingsButton = {
    type: "button" as const,
    text: { type: "plain_text" as const, text: "Settings" },
    url: `${appUrl()}/works`,
    action_id: "home_environment_setup",
  };
  if (options.agentName) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Default agent: *${options.agentName}*`,
      },
      accessory: settingsButton,
    });
    return blocks;
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: "_No agent configured yet._" },
  });
  return blocks;
}

function buildAppHomeUsageBlocks(options: AppHomeOptions): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  const botMention = officialSlackBotMention(options.botUserId);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":bulb: *Here are some things you can do:*",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Commands*\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} help\` - Show available commands\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} connect\` - Connect to ${assistantName}\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} disconnect\` - Disconnect from ${assistantName}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Usage*\nSend a DM or mention ${botMention} in any channel to chat with your workspace's default agent.`,
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Disconnect ${assistantName} Account*\nThis will remove your ${assistantName} account connection`,
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Disconnect" },
        action_id: "home_disconnect",
        style: "danger",
        confirm: {
          title: {
            type: "plain_text",
            text: `Disconnect ${assistantName} Account`,
          },
          text: {
            type: "plain_text",
            text: `This will remove your ${assistantName} account connection`,
          },
          confirm: { type: "plain_text", text: "Disconnect" },
          deny: { type: "plain_text", text: "Cancel" },
        },
      },
    },
  ];
}

export function buildAppHomeView(options: AppHomeOptions): SlackView {
  const blocks = buildAppHomeHeaderBlocks();

  if (options.isInstalled === false) {
    return {
      type: "home",
      blocks: [...blocks, ...buildAppHomeNotInstalledBlocks()],
    };
  }

  if (!options.isLinked) {
    return {
      type: "home",
      blocks: [...blocks, ...buildAppHomeDisconnectedBlocks(options.loginUrl)],
    };
  }

  return {
    type: "home",
    blocks: [
      ...blocks,
      ...buildAppHomeAccountBlock(options),
      { type: "divider" },
      ...buildAppHomeAgentBlocks(options),
      { type: "divider" },
      ...buildAppHomeUsageBlocks(options),
    ],
  };
}

export function buildErrorMessage(error: string): SlackBlocks {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:x: *Error*\n${error}` },
    },
  ];
}

export function buildLoginPromptMessage(loginUrl: string): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `To use ${assistantName} in Slack, please connect your account first.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          url: loginUrl,
          action_id: "login_prompt",
          style: "primary",
        },
      ],
    },
  ];
}

export function buildHelpMessage(opts?: {
  readonly botUserId?: string;
}): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  const botMention = opts?.botUserId
    ? officialSlackBotMention(opts.botUserId)
    : undefined;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: botMention
          ? `*${botMention} Slack Bot Help*`
          : "*Slack Bot Help*",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Commands*\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} help\` - Show available commands\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} connect\` - Connect to ${assistantName}\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} disconnect\` - Disconnect from ${assistantName}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: botMention
          ? `*Usage*\n\u2022 ${botMention} <message> - Send a message to your agent`
          : "*Usage*\n\u2022 Send a DM to this bot or mention it in a channel to message your agent",
      },
    },
  ];
}

export function buildSuccessMessage(message: string): SlackBlocks {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:white_check_mark: ${message}` },
    },
  ];
}

export function buildWelcomeMessage(
  botUserId: string,
  agentName?: string,
): SlackBlocks {
  const botMention = officialSlackBotMention(botUserId);
  const blocks: SlackBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:wave: *Hi! I'm ${botMention}.*\n\nI can connect you to AI agents to help with your tasks.`,
      },
    },
    { type: "divider" },
  ];

  if (agentName) {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Workspace Agent*\n\u2022 \`${agentName}\``,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*How to Use*\n\u2022 Just describe what you need help with",
        },
      },
    );
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No workspace agent configured yet._" },
    });
  }

  return blocks;
}

export function buildLoginMessage(loginUrl: string): SlackBlocks {
  const { assistantName } = BRAND_PRESENTATION;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Please connect your account to use ${assistantName} in this workspace.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          url: loginUrl,
          action_id: "login",
          style: "primary",
        },
      ],
    },
  ];
}
