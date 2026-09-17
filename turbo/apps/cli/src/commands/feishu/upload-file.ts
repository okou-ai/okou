import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import { Command } from "commander";
import { FEISHU_FILE_UPLOAD_MAX_BYTES } from "@okouai/api-contracts/contracts/integrations";

import {
  completeFeishuFileUpload,
  initFeishuFileUpload,
} from "../../lib/api/domains/integrations-feishu";
import { withErrorHandler } from "../../lib/command/with-error-handler";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

interface UploadFeishuOptions {
  readonly file: string;
  readonly installation?: string;
  readonly chat?: string;
  readonly user?: string;
  readonly reply?: string;
  readonly thread?: boolean;
  readonly contentType?: string;
}

function inferContentType(localPath: string): string {
  return (
    MIME_BY_EXTENSION[extname(localPath).toLowerCase()] ??
    "application/octet-stream"
  );
}

export function createFeishuUploadCommand(platform: FeishuPlatform) {
  const providerName = FEISHU_PLATFORMS[platform].name;
  return new Command()
    .name("upload-file")
    .description(
      `Upload a local file to ${providerName} as an organization bot`,
    )
    .requiredOption("-f, --file <path>", "Local file path to upload")
    .option("-i, --installation <id>", `${providerName} installation ID`)
    .option("-c, --chat <id>", `${providerName} chat ID`)
    .option(
      "-u, --user <open-id>",
      `${providerName} user open ID (use "me" for yourself)`,
    )
    .option("-r, --reply <message-id>", "Message ID to reply to")
    .option("--thread", `Reply in a ${providerName} thread`)
    .option("--content-type <mime>", "Override inferred content type")
    .addHelpText(
      "after",
      `
Examples:
  Upload to a chat:    okou ${platform} upload-file -f /tmp/report.pdf -c oc_xxx
  Send a DM:           okou ${platform} upload-file -f /tmp/report.pdf -u ou_xxx
  Reply with a file:   okou ${platform} upload-file -f /tmp/report.pdf -r om_xxx --thread
  Select a custom app: okou ${platform} upload-file -f /tmp/report.pdf -i <installation-id> -c oc_xxx

Output:
  Prints a JSON object to stdout on success:
    {"messageId":"om_xxx","chatId":"oc_xxx","fileKey":"file_xxx","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Exactly one of --chat, --user, or --reply is required
  - ${providerName} accepts non-empty files up to 30 MB
  - Specify --installation when the organization has multiple ${providerName} bots`,
    )
    .action(
      withErrorHandler(async (options: UploadFeishuOptions) => {
        const targets = [options.chat, options.user, options.reply].filter(
          Boolean,
        );
        if (targets.length !== 1) {
          throw new Error(
            "Exactly one of --chat, --user, or --reply must be provided",
          );
        }
        if (options.thread && !options.reply) {
          throw new Error("--thread requires --reply");
        }

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
        if (fileSize > FEISHU_FILE_UPLOAD_MAX_BYTES) {
          throw new Error(
            `File exceeds ${providerName}'s ${FEISHU_FILE_UPLOAD_MAX_BYTES}-byte limit`,
          );
        }

        const filename = basename(options.file);
        const contentType =
          options.contentType ?? inferContentType(options.file);
        const prepared = await initFeishuFileUpload({
          ...(platform === "lark" ? { platform } : {}),
          filename,
          contentType,
          length: fileSize,
        });
        const uploadResponse = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": prepared.contentType,
            ...prepared.uploadHeaders,
          },
          body: new Uint8Array(readFileSync(options.file)),
        });
        if (!uploadResponse.ok) {
          throw new Error(
            `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
          );
        }

        const result = await completeFeishuFileUpload({
          ...(platform === "lark" ? { platform } : {}),
          uploadId: prepared.uploadId,
          installationId: options.installation,
          chat: options.chat,
          user: options.user,
          replyToMessageId: options.reply,
          replyInThread: options.thread,
          contentType: prepared.contentType,
        });
        console.log(JSON.stringify(result));
      }),
    );
}
