import { Command } from "commander";
import { discordChannelCommand } from "./channel";
import { discordMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";

export const discordCommand = new Command()
  .name("discord")
  .description("Read Discord conversations, send messages, and transfer files")
  .addCommand(discordChannelCommand)
  .addCommand(discordMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  List channels:    okou discord channel list --json
  Read history:     okou discord message history --channel-id <id> --json
  Read a thread:    okou discord message replies --channel-id <parent-channel-id> --message-id <root-message-id> --json
  Send a message:   okou discord message send --channel-id <id> --text "Hello!"
  Upload a file:    okou discord upload-file --file report.pdf --channel <id>
  Download a file:  okou discord download-file <attachment-id> --channel <id> --message <id> --out report.pdf

Notes:
  - Uses an existing verified Discord binding; OAuth onboarding is not available.
  - Your binding is resolved from the current organization. --guild-id is optional; when given, it must match that binding's guild.
  - Attachment URLs are not returned; use download-file with the attachment ID.
  - All Discord IDs are decimal strings. Copy IDs from Discord with Developer Mode enabled.`,
  );
