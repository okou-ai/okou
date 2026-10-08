import { Command } from "commander";
import { listCommand } from "./list";

export const discordChannelCommand = new Command()
  .name("channel")
  .description("Discover Discord channels visible to you and Okou")
  .addCommand(listCommand);
