// Guild installs only; private channels between other users are unsupported.
const COMMAND_SETTINGS = {
  type: 1,
  integration_types: [0],
  contexts: [0, 1],
} as const;

/** Discord chat-input commands shared by interaction handling and registration. */
export const DISCORD_COMMANDS = [
  {
    ...COMMAND_SETTINGS,
    name: "help",
    description: "Learn how to use Okou in Discord",
  },
  {
    ...COMMAND_SETTINGS,
    name: "connect",
    description:
      "View your connection status or choose your workspace for bot DMs",
  },
  {
    ...COMMAND_SETTINGS,
    name: "disconnect",
    description: "Disconnect your account from the selected Discord server",
  },
  {
    ...COMMAND_SETTINGS,
    name: "switch",
    description: "Show the workspace default agent used in Discord",
  },
  {
    ...COMMAND_SETTINGS,
    name: "model",
    description: "Choose a model for the current Okou conversation",
  },
] as const;

export type DiscordCommandName = (typeof DISCORD_COMMANDS)[number]["name"];
