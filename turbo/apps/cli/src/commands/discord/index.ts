import { Command } from "commander";
import { discordChannelCommand } from "./channel";
import { discordMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";
import { connectCommand } from "./connect";

export const discordCommand = new Command()
  .name("discord")
  .description(
    "Connect Discord, read conversations, and transfer messages or files",
  )
  .addCommand(connectCommand)
  .addCommand(discordChannelCommand)
  .addCommand(discordMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Connect account:  okou discord connect
  Install server:   okou discord connect --install
  List channels:    okou discord channel list --json
  Read history:     okou discord message history --channel-id <id> --json
  Read a thread:    okou discord message replies --channel-id <parent-channel-id> --message-id <root-message-id> --json
  Send a message:   okou discord message send --to <id> --text "Hello!"
  Upload a file:    okou discord upload-file --file report.pdf --to <id>
  Download a file:  okou discord download-file <attachment-id> --channel <id> --message <id> --out report.pdf

Notes:
  - Start onboarding with okou discord connect, then complete official Discord browser consent.
  - Read, send, and file commands require a verified binding resolved from the current organization. Their optional --guild-id must match that binding's guild.
  - Attachment URLs are not returned; use download-file with the attachment ID.
  - All Discord IDs are decimal strings. Copy IDs from Discord with Developer Mode enabled.`,
  );
