import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { messageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";
import { createPhoneReactionCommand } from "./reaction";

export const phoneCommand = new Command()
  .name("phone")
  .description(
    "Send phone messages, react to iMessages, share files, and download media",
  )
  .addCommand(messageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addCommand(createPhoneReactionCommand())
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   okou phone message -t "Hello!"
  Add a reaction:   okou phone reaction <message-id> --emoji like
  Upload a file:    okou phone upload-file -f /tmp/report.pdf
  Download a file:  okou phone download-file <file-id> -o /tmp/out.jpg`,
  );
