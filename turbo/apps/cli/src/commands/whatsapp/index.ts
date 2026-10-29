import { Command } from "commander";
import {
  sendWhatsappMessage,
  WhatsappMessageSendError,
} from "../../lib/api/domains/integrations-whatsapp";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
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
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou whatsapp message send -t "Hello!"
  printf "Hello!" | okou whatsapp message send --json

Messages go only to your independently verified WhatsApp account.
Free-form messages require a message from you within the past 24 hours.
Long messages are split; never blindly retry an uncertain or partial send.`,
  )
  .action(
    withErrorHandler(
      async (options: { to: string; text?: string; json?: boolean }) => {
        assertPhoneTarget(options.to, "WhatsApp");
        const text = readMessageText(options.text);
        if (!text) {
          throw new Error("Either --text or piped stdin must be provided");
        }
        const result = await sendWhatsappMessage(text);
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

const tokenPayload = decodeSandboxTokenPayload();

export const whatsappCommand = new Command("whatsapp")
  .description("Send messages and files to your connected WhatsApp account")
  .addCommand(uploadWhatsappFileCommand, {
    hidden:
      tokenPayload !== undefined &&
      !tokenPayload.capabilities.includes("whatsapp:file:write"),
  })
  .addCommand(
    new Command("message")
      .description("Send a WhatsApp message")
      .addCommand(sendCommand),
  );
