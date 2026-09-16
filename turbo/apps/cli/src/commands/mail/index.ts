import { Command } from "commander";

import { connectCommand } from "./connect";
import { draftCommand } from "./draft";
import { linkCommand } from "./link";
import { listCommand } from "./list";

export const mailCommand = new Command()
  .name("mail")
  .description("Create and review Gmail drafts")
  .addCommand(listCommand)
  .addCommand(connectCommand)
  .addCommand(draftCommand)
  .addCommand(linkCommand);
