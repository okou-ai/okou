import { Command } from "commander";
import { teamsMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { downloadFileCommand } from "./download-file";

export const teamsCommand = new Command()
  .name("teams")
  .description(
    "Send messages, upload files, and download files from Microsoft Teams as the bot",
  )
  .addCommand(teamsMessageCommand)
  .addCommand(uploadFileCommand)
  .addCommand(downloadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:    okou teams message send --to <conversation-id> -t "Hello!"
  DM a user:         okou teams message send --to me -t "Hello!"
  Reply in a thread: okou teams message send --to <conversation-id> --reply-to <activity-id> -t "reply"
  Upload a file:     okou teams upload-file -f /tmp/report.pdf --to <conversation-id>
  Download a file:   okou teams download-file <file-id> -o /tmp/out.png`,
  );
