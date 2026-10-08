import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import {
  completeTeamsFileUpload,
  initTeamsFileUpload,
} from "../../lib/api/domains/integrations-teams";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  toOptionDescription,
} from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { resolveTeamsDestination } from "./message/target";

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
  .description(
    "Upload a local file to a Microsoft Teams conversation as the bot",
  )
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption(
    TO_OPTION_FLAGS,
    toOptionDescription("19:… conversation, 29:… user"),
  )
  .option("--reply-to <activity-id>", "Activity ID to reply to in thread")
  .option("-t, --text <message>", "Message text to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:     okou teams upload-file -f /tmp/report.pdf --to 19:thread@thread.tacv2
  Upload to thread:  okou teams upload-file -f /tmp/log.txt --to 19:thread@thread.tacv2 --reply-to root-activity
  DM yourself:       okou teams upload-file -f /tmp/report.pdf --to me
  With message text: okou teams upload-file -f /tmp/data.csv --to 19:thread@thread.tacv2 -t "Daily report"

Output:
  Prints "✓ File uploaded" with the activity ID, conversation ID, and file URL.
  With --json, prints one JSON object:
    {"integration":"teams","chatId":"19:...","messages":[{"id":"...","url":null}],"file":{"name":"report.pdf","contentType":"application/pdf","size":12345,"url":"https://..."}}

Notes:
  - Uploads through Okou storage first, then sends the Teams message with the file URL
  - Use the Conversation ID and Activity ID from the current Teams run prompt`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        to: string;
        replyTo?: string;
        text?: string;
        contentType?: string;
        json?: boolean;
      }) => {
        const destination = resolveTeamsDestination(
          options.to,
          options.replyTo,
        );

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
        const prepared = await initTeamsFileUpload({
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

        const result = await completeTeamsFileUpload({
          uploadId: prepared.uploadId,
          ...destination,
          contentType: prepared.contentType,
          text: options.text,
        });

        printMessageOutput(
          {
            integration: "teams",
            chatId: result.conversationId,
            messages: result.activityId
              ? [{ id: result.activityId, url: null }]
              : [],
            file: {
              name: result.filename,
              contentType: result.mimetype,
              size: result.size,
              url: result.url,
            },
          },
          options,
        );
      },
    ),
  );
