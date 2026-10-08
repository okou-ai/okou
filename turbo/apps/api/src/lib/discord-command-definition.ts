/** Discord chat-input command shared by interaction handling and registration. */
export const DISCORD_OKOU_COMMAND = {
  type: 1,
  name: "okou",
  description: "Manage your Okou account and conversation preferences",
  // Guild installs only; private channels between other users are unsupported.
  integration_types: [0],
  contexts: [0, 1],
  options: [
    {
      type: 1,
      name: "help",
      description: "Learn how to use Okou in Discord",
    },
    {
      type: 1,
      name: "connect",
      description: "View your connection status and setup availability",
    },
    {
      type: 1,
      name: "disconnect",
      description: "Disconnect your account from the selected Discord server",
    },
    {
      type: 1,
      name: "switch",
      description: "Choose an agent for new conversations",
    },
    {
      type: 1,
      name: "model",
      description: "Choose a model for new conversations",
    },
    {
      type: 1,
      name: "org",
      description: "Choose which organization to use in bot DMs",
    },
  ],
} as const;

export type DiscordCommandName =
  (typeof DISCORD_OKOU_COMMAND.options)[number]["name"];
