import { Command } from "commander";
import { uploadWebFile } from "../../lib/api/domains/web";
import {
  sendWhatsappFile,
  WhatsappFileSendError,
} from "../../lib/api/domains/integrations-whatsapp-files";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { assertPhoneTarget, phoneToOption } from "../phone/target";

export const uploadWhatsappFileCommand = new Command("upload-file")
  .description(
    "Upload a private file and send it to your verified WhatsApp account",
  )
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .addOption(phoneToOption("WhatsApp"))
  .option("-t, --text <text>", "Caption (audio files cannot carry a caption)")
  .option("--content-type <mime>", "Override inferred content type")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou whatsapp upload-file -f /tmp/report.pdf
  okou whatsapp upload-file -f /tmp/photo.jpg -t "Here it is" --json

Files go only to your independently verified WhatsApp account within its 24-hour service window.
One attachment is sent per message. The uploaded artifact stays private; its temporary provider-fetch URL is not published.
A receipt means accepted, not confirmed delivered.
On failure, retain the artifact and delivery outcome; never blindly repeat an uncertain send.`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        to: string;
        text?: string;
        contentType?: string;
        json?: boolean;
      }) => {
        assertPhoneTarget(options.to, "WhatsApp");
        const file = await uploadWebFile(options.file, {
          contentType: options.contentType,
          purpose: "artifact",
          requirePrivateArtifact: true,
        });
        const result = await sendWhatsappFile(file, options.text);
        printMessageOutput(
          {
            integration: "whatsapp",
            chatId: result.toNumber,
            messages: result.messages.map((message) => {
              return { id: message.id, url: null };
            }),
            file: {
              name: result.file.filename,
              contentType: result.file.contentType,
              size: result.file.size,
              url: result.file.url,
            },
          },
          options,
        );
      },
      (error, options) => {
        if (!(error instanceof WhatsappFileSendError)) {
          return false;
        }
        if (options.json) {
          console.log(
            JSON.stringify({
              integration: "whatsapp",
              messages: [],
              file: {
                id: error.file.id,
                name: error.file.filename,
                contentType: error.file.contentType,
                size: error.file.size,
                url: error.file.url,
              },
              delivery: error.delivery,
              error: {
                code: error.code,
                message: error.message,
                status: error.status,
              },
            }),
          );
        } else {
          console.error(error.message);
          console.error(
            `Uploaded artifact: ${error.file.url} (id: ${error.file.id}); WhatsApp delivery: ${error.delivery}`,
          );
        }
        return true;
      },
    ),
  );
