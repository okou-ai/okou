import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/brand-presentation";

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
  readonly agentName?: string;
  readonly isOverrideActive?: boolean;
  readonly canSwitch?: boolean;
  readonly loginUrl?: string;
  readonly botUserId: string;
}

function appHomeIntroBlocks(): SlackAnyBlock[] {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
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
        text: "Connect your AI agents to Slack and interact with them through messages.",
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
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `:white_check_mark: *Connected to ${assistantName}*\nAccount: ${options.userEmail ?? options.userId}`,
    },
  };
}

function appHomeAgentBlocks(options: AppHomeViewOptions): SlackAnyBlock[] {
  const agentHeading = options.isOverrideActive
    ? ":robot_face: *Your Agent*"
    : ":robot_face: *Workspace Agent*";
  const blocks: SlackAnyBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: agentHeading,
      },
    },
  ];

  if (!options.agentName) {
    return [
      ...blocks,
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "_No agent configured yet._",
        },
      },
    ];
  }

  const settingsButton = {
    type: "button" as const,
    text: { type: "plain_text" as const, text: "Settings" },
    url: `${options.appUrl}/works`,
    action_id: "home_environment_setup",
  };
  const agentBlock: SlackKnownBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `AgentName: *${options.agentName}*`,
    },
    ...(options.canSwitch ? {} : { accessory: settingsButton }),
  };
  blocks.push(agentBlock);
  if (options.canSwitch) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Switch" },
          action_id: "home_switch_agent",
          style: "primary",
        },
        settingsButton,
      ],
    });
  }
  return blocks;
}

function appHomeHelpBlocks(options: AppHomeViewOptions): SlackAnyBlock[] {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
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
        text: `*Commands*\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} connect\` - Connect to ${assistantName}\n\u2022 \`${OFFICIAL_SLACK_PRIMARY_COMMAND} disconnect\` - Disconnect from ${assistantName}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Usage*\nSend a DM or mention ${botMention} in any channel to chat with your agents`,
      },
    },
  ];
}

function disconnectAccountBlock(): SlackKnownBlock {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
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
    ...appHomeAgentBlocks(options),
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

export function buildWelcomeMessage(
  botUserId: string,
  agentName?: string,
): SlackAnyBlock[] {
  const botMention = officialSlackBotMention(botUserId);
  const blocks: SlackAnyBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:wave: *Hi! I'm ${botMention}.*\n\nI can connect you to AI agents to help with your tasks.`,
      },
    },
    {
      type: "divider",
    },
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
      text: {
        type: "mrkdwn",
        text: "_No workspace agent configured yet._",
      },
    });
  }

  return blocks;
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
