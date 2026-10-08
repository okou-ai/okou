import { Command } from "commander";
import { groupHistoryCommand } from "./history";

export const imessageGroupCommand = new Command()
  .name("group")
  .description("Read group message history")
  .addCommand(groupHistoryCommand);
