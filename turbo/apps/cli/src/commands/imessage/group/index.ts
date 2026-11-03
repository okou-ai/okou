import { Command } from "commander";
import { groupHistoryCommand } from "./history";
import { groupListCommand } from "./list";

export const imessageGroupCommand = new Command()
  .name("group")
  .description("Discover shared groups and read group message history")
  .addCommand(groupListCommand)
  .addCommand(groupHistoryCommand);
