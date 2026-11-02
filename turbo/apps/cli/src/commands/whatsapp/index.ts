import { Command } from "commander";
import {
  sendWhatsappMessage,
  WhatsappMessageSendError,
} from "../../lib/api/domains/integrations-whatsapp";
import { uploadWhatsappFileCommand } from "./upload-file";
import { readMessageText } from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { assertPhoneTarget, phoneToOption } from "../phone/target";

const sendCommand = new Command("send")
  .description("Send a WhatsApp message to your verified connected account")
  .addOption(phoneToOption("WhatsApp"))
  .option("-t, --text <message>", "Message text (or pipe it on stdin)")
  .option(
    "--task-completed",
    "Allow the approved task-completion template when the 24-hour window is closed (requires a current run)",
  )
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou whatsapp message send -t "Hello!"
  okou whatsapp message send --task-completed -t "Your report is ready."
  printf "Hello!" | okou whatsapp message send --json

Messages go only to your independently verified WhatsApp account.
Free-form messages require a message from you within the past 24 hours.
For completed tasks only, --task-completed allows a single approved en_US
notification linking to the current run's chat if Meta rejects the first part
because the window is closed. Other reminders cannot use this template.
Long messages are split; never blindly retry an uncertain or partial send.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        to: string;
        text?: string;
        json?: boolean;
        taskCompleted?: boolean;
      }) => {
        assertPhoneTarget(options.to, "WhatsApp");
        const text = readMessageText(options.text);
        if (!text) {
          throw new Error("Either --text or piped stdin must be provided");
        }
        const result = await sendWhatsappMessage(text, options.taskCompleted);
        printMessageOutput(
          {
            integration: "whatsapp",
            chatId: result.toNumber,
            messages: result.messages.map((message) => {
              return {
                id: message.id,
                url: null,
              };
            }),
            ...(result.template ? { template: result.template } : {}),
          },
          options,
        );
      },
      (error, options) => {
        if (!(error instanceof WhatsappMessageSendError) || !options.json) {
          return false;
        }
        console.log(
          JSON.stringify({
            integration: "whatsapp",
            messages: error.acceptedMessages.map((message) => {
              return { id: message.id, url: null };
            }),
            delivery: error.delivery,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
            },
          }),
        );
        return true;
      },
    ),
  );

export const whatsappCommand = new Command("whatsapp")
  .description("Send messages and files to your connected WhatsApp account")
  .addCommand(uploadWhatsappFileCommand)
  .addCommand(
    new Command("message")
      .description("Send a WhatsApp message")
      .addCommand(sendCommand),
  );
