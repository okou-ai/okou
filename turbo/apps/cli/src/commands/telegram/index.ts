import { Command } from "commander";
import { telegramBotCommand } from "./bot";
import { downloadFileCommand } from "./download-file";
import { telegramMessageCommand } from "./message";
import { uploadFileCommand } from "./upload-file";

export const telegramCommand = new Command()
  .name("telegram")
  .description(
    "Inspect bots, send messages, upload files, and download files from Telegram",
  )
  .addCommand(telegramBotCommand)
  .addCommand(telegramMessageCommand)
  .addCommand(downloadFileCommand)
  .addCommand(uploadFileCommand)
  .addHelpText(
    "after",
    `
Examples:
  List bots:        okou telegram bot list
  Send a message:   okou telegram message send --as <bot-id> --to <chat-id> -t "Hello!"
  Upload a file:    okou telegram upload-file -f /tmp/report.pdf --as <bot-id> --to <chat-id>
  Download a file:  okou telegram download-file <file-id> --bot-id <bot-id> -o /tmp/out.jpg`,
  );
