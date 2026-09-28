import { Command } from "commander";
import { slackMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";
import { slackChannelCommand } from "./channel";

export const slackCommand = new Command()
  .name("slack")
  .description(
    "List channels, read history, send messages, and transfer files as the Slack bot",
  )
  .addCommand(slackMessageCommand)
  .addCommand(slackChannelCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  List channels:        okou slack channel list --json
  Read channel or DM:   okou slack message history -c <channel-or-dm-id> --json
  Send a message:        okou slack message send --to <channel-id> -t "Hello!"
  Reply in a thread:     okou slack message send --to <channel-id> --reply-to <ts> -t "reply"
  Upload a file:         okou slack upload-file -f /tmp/report.pdf --to <channel-id>
  Download a file:       okou slack download-file <file-id> -o /tmp/out.png`,
  );
