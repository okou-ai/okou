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
import {
  TO_OPTION_FLAGS,
  toOptionDescription,
} from "../../lib/command/message-target";
import {
  type FeishuDestinationOptions,
  replyModeOption,
  resolveFeishuDestination,
} from "./message/target";

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

interface UploadFeishuOptions extends FeishuDestinationOptions {
  readonly file: string;
  readonly as?: string;
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
    .option(
      TO_OPTION_FLAGS,
      toOptionDescription("oc_… chat, ou_… user open ID"),
    )
    .option("--reply-to <message-id>", "Message ID to reply to (om_…)")
    .addOption(replyModeOption())
    .option("--as <installation-id>", `${providerName} installation to send as`)
    .option("--content-type <mime>", "Override inferred content type")
    .addHelpText(
      "after",
      `
Examples:
  Upload to a chat:    okou ${platform} upload-file -f /tmp/report.pdf --to oc_xxx
  Send a DM:           okou ${platform} upload-file -f /tmp/report.pdf --to ou_xxx
  Reply with a file:   okou ${platform} upload-file -f /tmp/report.pdf --reply-to om_xxx --reply-mode thread
  Select a custom app: okou ${platform} upload-file -f /tmp/report.pdf --as <installation-id> --to oc_xxx

Output:
  Prints a JSON object to stdout on success:
    {"messageId":"om_xxx","chatId":"oc_xxx","fileKey":"file_xxx","filename":"report.pdf","mimetype":"application/pdf","size":12345,"url":"https://..."}

Notes:
  - Exactly one of --to or --reply-to is required
  - ${providerName} accepts non-empty files up to 30 MB
  - Specify --as when the organization has multiple ${providerName} bots`,
    )
    .action(
      withErrorHandler(async (options: UploadFeishuOptions) => {
        const destination = resolveFeishuDestination(providerName, options);

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
          installationId: options.as,
          ...destination,
          contentType: prepared.contentType,
        });
        console.log(JSON.stringify(result));
      }),
    );
}
