import { Command } from "commander";
import { sendCommand } from "./send";

export const telegramMessageCommand = new Command()
  .name("message")
  .description("Manage Telegram messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou telegram message send -c <chat-id> -t "Hello!"`,
  );
