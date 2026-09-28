import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import {
  completePhoneFileUpload,
  initPhoneFileUpload,
} from "../../lib/api/domains/integrations-phone";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { assertPhoneTarget, phoneToOption } from "./target";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
};

function inferContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Send a local file to your connected phone")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .addOption(phoneToOption())
  .option(
    "--as <agent-id>",
    "Phone agent ID to send as (inferred when omitted)",
  )
  .option("-t, --text <text>", "Caption to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:    okou phone upload-file -f /tmp/report.pdf
  With a caption:   okou phone upload-file -f /tmp/photo.jpg -t "Here it is"

Output:
  Prints a JSON object to stdout on success:
    {"messageId":"msg_123","toNumber":"+15551234567","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        to: string;
        as?: string;
        text?: string;
        contentType?: string;
      }) => {
        assertPhoneTarget(options.to);
        let fileSize: number;
        try {
          const stat = statSync(options.file);
          if (!stat.isFile()) {
            throw new Error(`Not a regular file: ${options.file}`);
          }
          fileSize = stat.size;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Not ")) {
            throw error;
          }
          throw new Error(`File not found: ${options.file}`);
        }

        if (fileSize === 0) {
          throw new Error("File is empty");
        }

        const filename = basename(options.file);
        const contentType =
          options.contentType ?? inferContentType(options.file);

        const prepared = await initPhoneFileUpload({
          filename,
          contentType,
          length: fileSize,
        });

        const fileContent = readFileSync(options.file);
        const uploadResponse = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": prepared.contentType,
            ...prepared.uploadHeaders,
          },
          body: new Uint8Array(fileContent),
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
          );
        }

        const result = await completePhoneFileUpload({
          uploadId: prepared.uploadId,
          agentphoneAgentId: options.as,
          contentType: prepared.contentType,
          caption: options.text,
        });

        console.log(JSON.stringify(result));
      },
    ),
  );
