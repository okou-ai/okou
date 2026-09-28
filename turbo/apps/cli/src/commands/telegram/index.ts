import { Command } from "commander";
import { downloadFileCommand } from "./download-file";
import { telegramMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const telegramCommand = new Command()
  .name("telegram")
  .description("Send messages and files through the official Okou Telegram bot")
  .addCommand(telegramMessageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:   okou telegram message send --to <chat-id> -t "Hello!"
  Upload a file:    okou telegram upload-file -f /tmp/report.pdf --to <chat-id>
  Download a file:  okou telegram download-file <file-id> -o /tmp/out.jpg`,
  );
