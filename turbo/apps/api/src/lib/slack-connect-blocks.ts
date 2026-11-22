import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

import type {
  SlackAnyBlock,
  SlackKnownBlock,
  SlackView,
} from "../signals/external/slack-block-kit";
import {
  OFFICIAL_SLACK_PRIMARY_COMMAND,
  officialSlackBotMention,
} from "./slack-official-app";

interface AppHomeViewOptions {
  readonly appUrl: string;
  readonly isLinked: boolean;
  readonly userId?: string;
  readonly userEmail?: string;
  readonly loginUrl?: string;
  readonly botUserId: string;
}

function appHomeIntroBlocks(): SlackAnyBlock[] {
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
        text: "Chat with Okou in Slack through direct messages and mentions.",
      },
    },
    { type: "divider" },
  ];
}

function disconnectedAppHomeBlocks(
  loginUrl: string | undefined,
): SlackAnyBlock[] {
  const blocks: SlackAnyBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":x: *Account not connected*",
      },
    },
  ];
  if (loginUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "Connect",
          },
          url: loginUrl,
          action_id: "home_login_prompt",
          style: "primary",
        },
      ],
    });
  }
  return blocks;
}

function connectedStatusBlock(options: AppHomeViewOptions): SlackKnownBlock {
  const { assistantName } = BRAND_PRESENTATION;
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:white_check_mark: *Connected to ${assistantName}*\nAccount: ${options.userEmail ?? options.userId}`,
    },
  };
}

export function buildWorkspaceSettingsBlock(appUrl: string): SlackKnownBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: "Manage your workspace connections." },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Settings" },
      url: `${appUrl}/works`,
      action_id: "home_environment_setup",
    },
  };
}

function appHomeHelpBlocks(options: AppHomeViewOptions): SlackAnyBlock[] {
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
        text: `*Usage*\nSend a DM or mention ${botMention} in any channel to chat with Okou.`,
      },
    },
  ];
}

function disconnectAccountBlock(): SlackKnownBlock {
  const { assistantName } = BRAND_PRESENTATION;
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Disconnect ${assistantName} Account*\nThis will remove your ${assistantName} account connection`,
    },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: "Disconnect",
      },
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
  };
}

export function buildAppHomeView(options: AppHomeViewOptions): SlackView {
  const blocks = appHomeIntroBlocks();

  if (!options.isLinked) {
    return {
      type: "home",
      blocks: [...blocks, ...disconnectedAppHomeBlocks(options.loginUrl)],
    };
  }

  blocks.push(
    connectedStatusBlock(options),
    { type: "divider" },
    buildWorkspaceSettingsBlock(options.appUrl),
    { type: "divider" },
    ...appHomeHelpBlocks(options),
    { type: "divider" },
    disconnectAccountBlock(),
  );

  return {
    type: "home",
    blocks,
  };
}

export function buildWelcomeMessage(botUserId: string): SlackAnyBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:wave: *Hi! I'm ${officialSlackBotMention(botUserId)}.*\n\nSend me a message or mention me in a channel to get started.`,
      },
    },
  ];
}

export function buildSuccessMessage(message: string): SlackAnyBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:white_check_mark: ${message}`,
      },
    },
  ];
}
