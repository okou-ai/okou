import { Command } from "commander";
import { discordChannelCommand } from "./channel";
import { discordMessageCommand } from "./message";

export const discordCommand = new Command()
  .name("discord")
  .description(
    "List channels, read history, and send messages as the Discord bot",
  )
  .addCommand(discordChannelCommand)
  .addCommand(discordMessageCommand)
  .addHelpText(
    "after",
    `
Examples:
  List channels:    okou discord channel list --json
  Read history:     okou discord message history --channel-id <id> --json
  Read a thread:    okou discord message replies --channel-id <parent-channel-id> --message-id <root-message-id> --json
  Send a message:   okou discord message send --channel-id <id> --text "Hello!"

Notes:
  - Uses an existing verified Discord binding; OAuth onboarding is not available.
  - Pass --guild-id when you have bindings in multiple guilds.
  - All Discord IDs are decimal strings. Copy IDs from Discord with Developer Mode enabled.`,
  );
