import { Command } from "commander";

import { connectCommand } from "./connect";
import { linkCommand } from "./link";
import { listCommand } from "./list";

export const mailCommand = new Command()
  .name("mail")
  .description("Review linked Gmail drafts")
  .addCommand(listCommand)
  .addCommand(connectCommand)
  .addCommand(linkCommand);
