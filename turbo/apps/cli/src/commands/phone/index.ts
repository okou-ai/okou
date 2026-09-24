import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { messageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const phoneCommand = new Command()
  .name("phone")
  .description("Send phone messages, upload files, and download media")
  .addCommand(messageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   okou phone message --to +15551234567 -t "Hello!"
  Upload a file:    okou phone upload-file -f /tmp/report.pdf --to +15551234567
  Download a file:  okou phone download-file <file-id> -o /tmp/out.jpg`,
  );
