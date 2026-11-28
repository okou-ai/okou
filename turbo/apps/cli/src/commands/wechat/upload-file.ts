import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { MIMEType } from "node:util";
import { Command } from "commander";
import {
  MAX_WECHAT_FILE_SIZE_BYTES,
  type WechatUploadCompleteResponse,
  type WechatUploadInitResponse,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import {
  completeWechatFileUpload,
  initWechatFileUpload,
} from "../../lib/api/domains/integrations-wechat-files";
import { inferWebUploadContentType } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import { TO_OPTION_FLAGS } from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  printMessageOutput,
} from "../../lib/command/message-output";
import { wechatChannelId } from "./target";

interface UploadFileOptions {
  readonly file: string;
  readonly to: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly json?: boolean;
}

async function readUploadFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("Upload path must be a file");
    if (metadata.size === 0) throw new Error("File is empty");
    if (metadata.size > MAX_WECHAT_FILE_SIZE_BYTES) {
      throw new Error("Wechat file exceeds the 10 MiB limit");
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
  initialized: WechatUploadInitResponse,
  contentType: string,
  content: Buffer,
): Promise<void> {
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
  result: WechatUploadCompleteResponse,
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
      integration: "wechat",
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
      },
    },
    upload,
  );
  if (delivery.status === "failed") {
    console.warn(`Wechat delivery failed: ${delivery.message}`);
  }
}

async function uploadFile(options: UploadFileOptions): Promise<void> {
  const channelId = await wechatChannelId(options.to);
  const content = await readUploadFile(options.file);
  const contentType = new MIMEType(
    options.contentType ?? inferWebUploadContentType(options.file),
  ).essence;
  const filename = basename(options.file);
  const upload = {
    channelId,
    filename,
    contentType,
    size: content.byteLength,
    json: options.json,
  };
  const comment = options.text === undefined ? {} : { comment: options.text };
  const initialized = await initWechatFileUpload({
    filename,
    length: content.byteLength,
    contentType,
    checksumSha256: createHash("sha256").update(content).digest("hex"),
    channelId,
    ...comment,
  });
  await uploadCanonicalBody(initialized, contentType, content);
  const completed = await completeWechatFileUpload({
    assetId: initialized.assetId,
    channelId,
    ...comment,
  });
  printDelivery(completed, upload);
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Publish a file to Okou and deliver it to a Wechat channel")
  .requiredOption(
    "-f, --file <path>",
    "Local file path to upload (up to 10 MiB)",
  )
  .requiredOption(
    TO_OPTION_FLAGS,
    "Destination: me, chat:<id> or a conversation UUID from channel list",
  )
  .option("-t, --text <text>", "Comment to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  okou wechat upload-file -f /tmp/report.pdf --to <conversation-id>
  okou wechat upload-file -f /tmp/report.pdf --to <conversation-id> -t "Weekly report"

Output:
  Prints "✓ File uploaded" with the stored message ID and Okou file URL. Wechat has no message permalink.
  With --json, prints one JSON object:
    {"integration":"wechat","chatId":"<conversation-id>","messages":[{"id":"...","url":null}],"file":{"name":"report.pdf","contentType":"application/pdf","size":12345,"url":"https://..."},"delivery":{"status":"delivered"}}
  delivery.status is delivered or failed; messages is empty when failed.

Notes:
  - Canonical publication completes before Wechat delivery begins.
  - External delivery is fire-and-forget; check delivery.status in --json output.
  - Uses server-side bot credentials; no Wechat token is needed locally.
  - Like okou slack upload-file, the command exits 0 whenever the server reports a
    delivery status, even if Wechat delivery failed.`,
  )
  .action(withErrorHandler(uploadFile));
