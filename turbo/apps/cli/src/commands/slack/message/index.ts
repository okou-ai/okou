import { Command } from "commander";
import { sendCommand } from "./send";
import { historyCommand } from "./history";
import { repliesCommand } from "./replies";

export const slackMessageCommand = new Command()
  .name("message")
  .description("Manage Slack messages")
  .addCommand(sendCommand)
  .addCommand(historyCommand)
  .addCommand(repliesCommand)
  .addHelpText(
    "after",
    `
Examples:
  okou slack message send -c <channel-id> -t "Hello!"
  okou slack message history -c <channel-or-dm-id> --json
  okou slack message replies -c <channel-or-dm-id> --thread <parent-ts> --json`,
  );
