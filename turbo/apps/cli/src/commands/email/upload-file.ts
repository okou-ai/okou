import { stat } from "node:fs/promises";
import { Command } from "commander";
import { MAX_EMAIL_ATTACHMENT_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-email";
import { uploadWebFile } from "../../lib/api/domains/web";
import { completeEmailFileUpload } from "../../lib/api/domains/integrations-email";
import { getOkouCurrentIntegration } from "../../lib/okou-env";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { printMessageOutput } from "../../lib/command/message-output";

interface UploadFileOptions {
  readonly file?: string;
  readonly uploadId?: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly json?: boolean;
}

async function publishFile(options: UploadFileOptions): Promise<string> {
  if (options.uploadId) return options.uploadId;
  if (!options.file)
    throw new Error(
      "Use --file <path>, or --upload-id <id> to resume an existing delivery.",
    );
  const info = await stat(options.file);
  if (
    !info.isFile() ||
    info.size === 0 ||
    info.size > MAX_EMAIL_ATTACHMENT_SIZE_BYTES
  )
    throw new Error(
      "Email attachments must be non-empty files of at most 10 MiB.",
    );
  const file = await uploadWebFile(options.file, {
    contentType: options.contentType,
    purpose: "artifact",
    requirePrivateArtifact: true,
  });
  return file.id;
}

export function createEmailUploadFileCommand() {
  return new Command("upload-file")
    .description(
      "Upload a private file and attach it to the current Email conversation",
    )
    .option("-f, --file <path>", "Local file path (up to 10 MiB)")
    .option(
      "--upload-id <uuid>",
      "Inspect or resume the same private upload without sending it twice",
    )
    .option("-t, --text <text>", "Caption to accompany the attachment")
    .option("--content-type <mime>", "Override inferred content type")
    .option("--json", "Print one structured file and delivery receipt")
    .addHelpText(
      "after",
      `
Examples:
  okou email upload-file -f /tmp/report.pdf
  okou email upload-file -f /tmp/report.pdf --text "Here is the report" --json
  okou email upload-file --upload-id <uuid> --json

Notes:
  - Requires the current Email-originated run; the server derives the verified recipient and reply headers
  - Files stay private in Okou and arrive as real attachments in the original email conversation
  - Preserve the upload ID printed to stderr before delivery begins
  - After an uncertain result, reuse --upload-id; do not upload again or change the original caption
  - Pending means queued; accepted means Resend accepted the message, not that the recipient received it
  - Your final text reply is delivered separately; use this command only for requested files
  - Requires email:write and file:write capabilities on OKOU_TOKEN`,
    )
    .action(
      withErrorHandler(async (options: UploadFileOptions) => {
        if (getOkouCurrentIntegration() !== "email")
          throw new Error(
            "This command requires an Email-originated run. Continue the request in its email conversation.",
          );
        if (options.file && options.uploadId)
          throw new Error("Use either --file or --upload-id, not both.");
        const uploadId = await publishFile(options);
        console.warn(
          `Email upload ID: ${uploadId}. Resume with --upload-id ${uploadId}; do not upload again after an uncertain delivery.`,
        );
        const result = await completeEmailFileUpload({
          uploadId,
          ...(options.text === undefined ? {} : { text: options.text }),
        });
        printMessageOutput(
          {
            integration: "email",
            chatId: result.chatThreadId,
            messages:
              result.delivery.status === "accepted"
                ? [{ id: result.delivery.providerId, url: null }]
                : [],
            file: {
              name: result.filename,
              contentType: result.contentType,
              size: result.size,
              url: result.url,
            },
            delivery: {
              status: result.delivery.status,
              operationId: result.operationId,
              ...(result.delivery.status === "failed"
                ? { error: result.delivery.message }
                : {}),
            },
          },
          options,
        );
        if (result.delivery.status === "failed")
          throw new Error(
            `Email attachment delivery failed: ${result.delivery.message}. The private file is retained; do not resend automatically.`,
          );
      }),
    );
}
