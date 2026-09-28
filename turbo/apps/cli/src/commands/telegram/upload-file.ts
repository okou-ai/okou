import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { Command } from "commander";
import {
  completeTelegramFileUpload,
  initTelegramFileUpload,
} from "../../lib/api/domains/integrations-telegram";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  toOptionDescription,
} from "../../lib/command/message-target";
import { parsePositiveInteger, resolveTelegramChatId } from "./message/target";

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
  .description("Upload a local file to a Telegram chat as the bot")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption("--as <bot-id>", "Telegram bot ID to send as")
  .requiredOption(TO_OPTION_FLAGS, toOptionDescription("chat ID or @channel"))
  .option("-t, --text <text>", "Caption to accompany the file")
  .option("--topic <id>", "Forum topic (message thread) ID")
  .option("--content-type <mime>", "Override inferred content type")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:          okou telegram upload-file -f /tmp/report.pdf --as 123456789 --to -1001234567890
  Upload to a topic:      okou telegram upload-file -f /tmp/log.txt --as 123456789 --to -1001234567890 --topic 42
  With a caption:         okou telegram upload-file -f /tmp/data.csv --as 123456789 --to @channel -t "Daily report"

Output:
  Prints a JSON object to stdout on success:
    {"messageId":123,"chatId":"-1001234567890","fileId":"...","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Uses the Telegram bot token on the server side
  - Uploads through Okou storage first, then asks Telegram to fetch the file URL
  - Okou does not apply file type or size restrictions before calling Telegram`,
  )
  .action(
    withErrorHandler(
      async (options: {
        file: string;
        as: string;
        to: string;
        text?: string;
        topic?: string;
        contentType?: string;
      }) => {
        const chatId = resolveTelegramChatId(options.to);
        const messageThreadId = options.topic
          ? parsePositiveInteger(options.topic, "--topic")
          : undefined;
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
          botId: options.as,
          chatId,
          contentType: prepared.contentType,
          caption: options.text,
          messageThreadId,
        });

        console.log(JSON.stringify(result));
      },
    ),
  );
