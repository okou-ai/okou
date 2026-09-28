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
import { TO_OPTION_FLAGS } from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { resolveDiscordChannelId } from "./target";

interface UploadFileOptions {
  readonly file: string;
  readonly to: string;
  readonly guildId?: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly operationId?: string;
  readonly json?: boolean;
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

function printDelivery(
  result: DiscordUploadMaterializeResponse,
  upload: {
    readonly channelId: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
    readonly json?: boolean;
  },
): void {
  const { delivery } = result;
  printMessageOutput(
    {
      integration: "discord",
      chatId:
        delivery.status === "delivered" ? delivery.channelId : upload.channelId,
      messages:
        delivery.status === "delivered"
          ? [{ id: delivery.messageId, url: delivery.permalink }]
          : [],
      file: {
        name: upload.filename,
        contentType: upload.contentType,
        size: upload.size,
        url: result.url,
      },
      delivery: {
        status: delivery.status,
        ...(delivery.status === "failed" ? { error: delivery.message } : {}),
        operationId: result.operationId,
      },
    },
    upload,
  );
  if (delivery.status === "failed") {
    console.warn(`Discord delivery failed: ${delivery.message}`);
  }
}

async function uploadFile(options: UploadFileOptions): Promise<void> {
  const channelId = resolveDiscordChannelId(options.to);
  const content = await readUploadFile(options.file);
  const contentType = new MIMEType(
    options.contentType ?? inferWebUploadContentType(options.file),
  ).essence;
  const operationId = options.operationId ?? randomUUID();
  const filename = basename(options.file);
  const upload = {
    channelId,
    filename,
    contentType,
    size: content.byteLength,
    json: options.json,
  };
  console.warn(`Upload operation: ${operationId}`);
  try {
    const initialized = await initDiscordFileUpload({
      filename,
      length: content.byteLength,
      contentType,
      checksumSha256: createHash("sha256").update(content).digest("hex"),
      operationId,
      channelId,
      ...(options.guildId === undefined ? {} : { guildId: options.guildId }),
      ...(options.text === undefined ? {} : { comment: options.text }),
    });
    await uploadCanonicalBody(initialized, contentType, content);
    const operation = { assetId: initialized.assetId, operationId };
    const materialized = await materializeDiscordFileUpload(operation);
    if (materialized.delivery.status === "delivered") {
      printDelivery(materialized, upload);
      return;
    }
    let completed: DiscordUploadMaterializeResponse;
    try {
      completed = await completeDiscordFileUpload(operation);
    } catch (error) {
      // Publication has succeeded even if the delivery response was lost.
      printDelivery(materialized, upload);
      throw error;
    }
    printDelivery(completed, upload);
  } catch (error) {
    console.warn(
      `To resume publication or check delivery status, reuse the same file and destination with --operation-id ${operationId}; delivery will not be resent.`,
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
  .requiredOption(
    TO_OPTION_FLAGS,
    "Destination: chat:<id> or a Discord channel or thread ID",
  )
  .option(
    "--guild-id <id>",
    "Optional; must match your organization's bound guild",
  )
  .option("-t, --text <text>", "Comment to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option("--operation-id <uuid>", "Reuse a previous upload operation")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou discord upload-file -f /tmp/report.pdf --to 123456789012345678
  okou discord upload-file -f /tmp/report.pdf --to 123456789012345678 -t "Weekly report"

Output:
  Prints "✓ File uploaded" with the Discord message ID, permalink, and Okou file URL.
  With --json, prints one JSON object:
    {"integration":"discord","chatId":"123456789012345678","messages":[{"id":"...","url":"https://discord.com/channels/..."}],"file":{"name":"report.pdf","contentType":"application/pdf","size":12345,"url":"https://..."},"delivery":{"status":"delivered","operationId":"..."}}
  delivery.status is delivered, pending, or failed; messages is empty until delivered.

Notes:
  - Canonical publication completes before Discord delivery begins.
  - Reuse the same file, destination and --operation-id to resume publication or
    check a recorded delivery; it will never resend that delivery.
  - Uses server-side bot credentials; no Discord token is needed locally.
  - Like okou slack upload-file, the command exits 0 whenever the server reports a
    delivery status, even if Discord delivery failed or is pending. Check
    delivery.status in the --json output. To send again after a failed delivery,
    start a new upload operation.`,
  )
  .action(withErrorHandler(uploadFile));
