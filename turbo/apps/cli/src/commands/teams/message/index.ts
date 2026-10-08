import { Command } from "commander";
import { sendCommand } from "./send";

export const teamsMessageCommand = new Command()
  .name("message")
  .description("Manage Microsoft Teams messages")
  .addCommand(sendCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou teams message send --to <conversation-id> -t "Hello!"
  okou teams message send --to me -t "Hello!"`,
  );
