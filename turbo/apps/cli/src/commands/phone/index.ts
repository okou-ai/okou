import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { messageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const phoneCommand = new Command()
  .name("phone")
  .description(
    "Send phone messages, share files with your phone or iMessage groups, and download media",
  )
  .addCommand(messageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   okou phone message -t "Hello!"
  Upload a file:    okou phone upload-file -f /tmp/report.pdf
  Download a file:  okou phone download-file <file-id> -o /tmp/out.jpg`,
  );
