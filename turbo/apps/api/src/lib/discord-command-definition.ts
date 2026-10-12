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
    description: "Show commands and usage",
  },
  {
    ...COMMAND_SETTINGS,
    name: "connect",
    description: "Connect to Okou",
  },
  {
    ...COMMAND_SETTINGS,
    name: "disconnect",
    description: "Disconnect from Okou",
  },
] as const;

export type DiscordCommandName = (typeof DISCORD_COMMANDS)[number]["name"];
