import { Command } from "commander";
import { historyCommand } from "./history";
import { repliesCommand } from "./replies";
import { sendCommand } from "./send";

export const discordMessageCommand = new Command()
  .name("message")
  .description("Read and send Discord messages")
  .addCommand(historyCommand)
  .addCommand(repliesCommand)
  .addCommand(sendCommand);
