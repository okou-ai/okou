import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { MIMEType } from "node:util";
import { Command } from "commander";
import {
  MAX_DISCORD_FILE_SIZE_BYTES,
  type DiscordUploadInitResponse,
  type DiscordUploadMaterializeResponse,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import {
  completeDiscordFileUpload,
  initDiscordFileUpload,
  materializeDiscordFileUpload,
} from "../../lib/api/domains/integrations-discord-files";
import { inferWebUploadContentType } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface UploadFileOptions {
  readonly file: string;
  readonly channel: string;
  readonly guildId?: string;
  readonly comment?: string;
  readonly contentType?: string;
  readonly operationId?: string;
}

async function readUploadFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Upload path must be a file");
    if (metadata.size === 0) throw new Error("File is empty");
    if (metadata.size > MAX_DISCORD_FILE_SIZE_BYTES) {
      throw new Error("Discord file exceeds the 10 MiB limit");
    }
    // One extra byte detects a file growing between stat and read without
    // allowing an unbounded read into memory.
    const buffer = Buffer.alloc(metadata.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== metadata.size) {
      throw new Error("File changed while being read; retry the upload");
    }
    return buffer.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function uploadCanonicalBody(
  initialized: DiscordUploadInitResponse,
  contentType: string,
  content: Buffer,
): Promise<void> {
  if (!initialized.uploadUrl) return;
  const headers = new Headers(initialized.uploadHeaders);
  if (headers.has("authorization") || headers.has("cookie")) {
    throw new Error("Canonical upload must not carry authentication headers");
  }
  headers.set("Content-Type", contentType);
  const response = await fetch(initialized.uploadUrl, {
    method: "PUT",
    headers,
    body: content,
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Canonical file upload failed (HTTP ${response.status})`);
  }
}

function printDelivery(result: DiscordUploadMaterializeResponse): void {
  console.log(JSON.stringify(result));
  if (result.delivery.status === "failed") {
    console.warn(`Discord delivery failed: ${result.delivery.message}`);
    if (result.delivery.retryable) {
      const retryAfter = result.delivery.retryAfterSeconds;
      console.warn(
        retryAfter !== undefined && retryAfter > 0
          ? `Retry after ${retryAfter} seconds with --operation-id ${result.operationId}`
          : `Retry with --operation-id ${result.operationId}`,
      );
    }
  } else if (result.delivery.status === "pending") {
    console.warn(
      `Discord delivery is pending; retry with --operation-id ${result.operationId}`,
    );
  }
}

async function uploadFile(options: UploadFileOptions): Promise<void> {
  const content = await readUploadFile(options.file);
  const contentType = new MIMEType(
    options.contentType ?? inferWebUploadContentType(options.file),
  ).essence;
  const operationId = options.operationId ?? randomUUID();
  console.warn(`Upload operation: ${operationId}`);
  try {
    const initialized = await initDiscordFileUpload({
      filename: basename(options.file),
      length: content.byteLength,
      contentType,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      operationId,
      channelId: options.channel,
      ...(options.guildId === undefined ? {} : { guildId: options.guildId }),
      ...(options.comment === undefined ? {} : { comment: options.comment }),
    });
    await uploadCanonicalBody(initialized, contentType, content);
    const operation = { assetId: initialized.assetId, operationId };
    const materialized = await materializeDiscordFileUpload(operation);
    if (materialized.delivery.status === "delivered") {
      printDelivery(materialized);
      return;
    }
    let completed: DiscordUploadMaterializeResponse;
    try {
      completed = await completeDiscordFileUpload(operation);
    } catch (error) {
      // Publication has succeeded even if the delivery response was lost.
      printDelivery(materialized);
      throw error;
    }
    printDelivery(completed);
  } catch (error) {
    console.warn(
      `Retry the same file and destination with --operation-id ${operationId}`,
    );
    throw error;
  }
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Publish a file to Okou and deliver it to a Discord channel")
  .requiredOption(
    "-f, --file <path>",
    "Local file path to upload (up to 10 MiB)",
  )
  .requiredOption("-c, --channel <id>", "Discord channel or thread ID")
  .option("--guild-id <id>", "Guild for the Discord connection")
  .option("--comment <text>", "Comment to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option("--operation-id <uuid>", "Reuse a previous upload operation")
  .addHelpText(
    "after",
    `
Examples:
  okou discord upload-file -f /tmp/report.pdf -c 123456789012345678
  okou discord upload-file -f /tmp/report.pdf -c 123456789012345678 --comment "Weekly report"

Output:
  Prints JSON containing the canonical asset URL, operation ID and Discord delivery status.
  A delivered file includes the Discord message permalink.

Notes:
  - Canonical publication completes before Discord delivery begins.
  - Retry with the same file, destination and --operation-id to avoid duplicate publication.
  - Uses server-side bot credentials; no Discord token is needed locally.`,
  )
  .action(withErrorHandler(uploadFile));
