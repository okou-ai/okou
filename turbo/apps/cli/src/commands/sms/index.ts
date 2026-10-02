import { Command } from "commander";
import { createPhoneMessageCommand } from "../phone/message";

const smsMessageCommand = new Command()
  .name("message")
  .description("Send an SMS")
  .addCommand(createPhoneMessageCommand("sms"));

export const smsCommand = new Command()
  .name("sms")
  .description("Send text messages")
  .addCommand(smsMessageCommand);
