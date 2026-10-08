import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { messageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const phoneCommand = new Command()
  .name("phone")
  .description(
    "Send messages and files to your connected phone, and download media",
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
