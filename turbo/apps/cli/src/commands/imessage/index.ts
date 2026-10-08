import { Command } from "commander";
import { createPhoneMessageCommand } from "../phone/message";
import { imessageGroupCommand } from "./group";

const imessageMessageCommand = new Command()
  .name("message")
  .description("Send an iMessage")
  .addCommand(createPhoneMessageCommand("imessage"));

export const imessageCommand = new Command()
  .name("imessage")
  .description("Send messages and read group history")
  .addCommand(imessageMessageCommand)
  .addCommand(imessageGroupCommand);
