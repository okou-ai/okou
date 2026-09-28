import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import {
  completeTelegramFileUpload,
  initTelegramFileUpload,
} from "../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../lib/command/with-error-handler";

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

function parseMessageThreadId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("message-thread-id must be a positive integer");
  }
  return parsed;
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a file through the official Okou Telegram bot")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption("-c, --chat-id <chat-id>", "Telegram chat id or @channel")
  .option("--caption <text>", "Caption to accompany the file")
  .option("--message-thread-id <id>", "Forum topic message thread id")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:          okou telegram upload-file -f /tmp/report.pdf -c -1001234567890
  Upload to a topic:      okou telegram upload-file -f /tmp/log.txt -c -1001234567890 --message-thread-id 42
  With a caption:         okou telegram upload-file -f /tmp/data.csv -c @channel --caption "Daily report"

Output:
  Prints a JSON object to stdout on success:
    {"messageId":123,"chatId":"-1001234567890","fileId":"...","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Uses the official Okou Telegram bot
  - Uploads through Okou storage first, then asks Telegram to fetch the file URL
  - Okou does not apply file type or size restrictions before calling Telegram`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        chatId: string;
        caption?: string;
        messageThreadId?: string;
        contentType?: string;
      }) => {
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
        const messageThreadId = parseMessageThreadId(options.messageThreadId);

        const prepared = await initTelegramFileUpload({
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

        const result = await completeTelegramFileUpload({
          uploadId: prepared.uploadId,
          chatId: options.chatId,
          contentType: prepared.contentType,
          caption: options.caption,
          messageThreadId,
        });

        console.log(JSON.stringify(result));
      },
    ),
  );
