import { Command } from "commander";
import { createPhoneMessageCommand } from "../phone/message";
import { imessageGroupCommand } from "./group";
import { createPhoneReactionCommand } from "../phone/reaction";

const imessageMessageCommand = new Command()
  .name("message")
  .description("Send and react to iMessages")
  .addCommand(createPhoneMessageCommand("imessage"))
  .addCommand(createPhoneReactionCommand("imessage"));

export const imessageCommand = new Command()
  .name("imessage")
  .description("Send messages, add reactions, and read group history")
  .addCommand(imessageMessageCommand)
  .addCommand(imessageGroupCommand);
