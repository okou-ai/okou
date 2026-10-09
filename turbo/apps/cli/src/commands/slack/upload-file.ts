import { createHash, randomUUID } from "node:crypto";
import { statSync, readFileSync } from "fs";
import { basename } from "path";
import { Command } from "commander";
import chalk from "chalk";
import type {
  SlackUploadInitResponse,
  SlackUploadMaterializeResponse,
} from "@okouai/api-contracts/contracts/integrations";
import {
  completeSlackFileUpload,
  initSlackFileUpload,
  materializeSlackFileUpload,
} from "../../lib/api/domains/integrations-slack";
import { inferWebUploadContentType } from "../../lib/api/domains/web";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  TO_OPTION_FLAGS,
  parseMessageTarget,
  toOptionDescription,
} from "../../lib/command/message-target";
import {
  JSON_OPTION_DESCRIPTION,
  JSON_OPTION_FLAGS,
  type MessageSendOutput,
  printMessageOutput,
} from "../../lib/command/message-output";
import { isSlackUserId } from "./message/send";

type SlackUploadDestination =
  { readonly channel: string } | { readonly user: string };

interface UploadFileOptions {
  readonly file: string;
  readonly destination: SlackUploadDestination;
  readonly thread?: string;
  readonly title?: string;
  readonly comment?: string;
  readonly contentType?: string;
  readonly operationId?: string;
}

type DirectUploadInitialization = Extract<
  SlackUploadInitResponse,
  { fileId: string }
>;
type CanonicalUploadInitialization = Extract<
  SlackUploadInitResponse,
  { kind: "canonical" }
>;
type PendingSlackDelivery = Extract<
  SlackUploadMaterializeResponse["delivery"],
  { status: "pending" }
>;

function readUploadFile(path: string): {
  readonly content: Buffer;
  readonly size: number;
} {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (size === 0) {
    throw new Error("File is empty");
  }
  return { content: readFileSync(path), size };
}

function warnDeliveryRetry(operationId: string): void {
  console.warn(chalk.dim(`  Retry with --operation-id ${operationId}`));
}

type SlackUploadOutput = Pick<MessageSendOutput, "messages" | "delivery"> & {
  readonly fileUrl: string | null;
};

async function uploadDirectlyToSlack(
  initialized: DirectUploadInitialization,
  options: UploadFileOptions,
  fileContent: Buffer,
): Promise<SlackUploadOutput & { readonly chatId: string }> {
  const uploadResponse = await fetch(initialized.uploadUrl, {
    method: "POST",
    body: fileContent,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
    );
  }
  const result = await completeSlackFileUpload({
    fileId: initialized.fileId,
    ...options.destination,
    threadTs: options.thread,
    title: options.title,
    initialComment: options.comment,
  });
  return {
    chatId: result.channel,
    messages: [{ id: result.fileId, url: result.permalink }],
    fileUrl: result.assetUrl ?? null,
  };
}

async function uploadCanonicalBody(
  initialized: CanonicalUploadInitialization,
  contentType: string,
  fileContent: Buffer,
): Promise<void> {
  if (!initialized.uploadUrl) {
    return;
  }
  const uploadResponse = await fetch(initialized.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      ...initialized.uploadHeaders,
    },
    body: fileContent,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Canonical file upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
    );
  }
}

async function uploadPendingSlackBody(
  delivery: PendingSlackDelivery,
  fileContent: Buffer,
): Promise<string | undefined> {
  try {
    const uploadResponse = await fetch(delivery.uploadUrl, {
      method: "POST",
      body: fileContent,
    });
    if (!uploadResponse.ok) {
      return `Slack upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`;
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Slack upload failed";
  }
}

function failedSlackDelivery(
  operationId: string,
  error: string,
): Pick<MessageSendOutput, "messages" | "delivery"> {
  console.warn(chalk.yellow(`⚠ Slack delivery failed: ${error}`));
  warnDeliveryRetry(operationId);
  return { messages: [], delivery: { status: "failed", error, operationId } };
}

async function completeCanonicalSlackDelivery(args: {
  readonly initialized: CanonicalUploadInitialization;
  readonly delivery: PendingSlackDelivery;
  readonly options: UploadFileOptions;
  readonly fileContent: Buffer;
}): Promise<Pick<MessageSendOutput, "messages" | "delivery">> {
  const { operationId } = args.initialized;
  const uploadError = await uploadPendingSlackBody(
    args.delivery,
    args.fileContent,
  );
  let result: Awaited<ReturnType<typeof completeSlackFileUpload>>;
  try {
    result = await completeSlackFileUpload({
      fileId: args.delivery.fileId,
      ...args.options.destination,
      ...(args.options.thread ? { threadTs: args.options.thread } : {}),
      ...(args.options.title ? { title: args.options.title } : {}),
      ...(args.options.comment ? { initialComment: args.options.comment } : {}),
      canonicalAssetId: args.initialized.assetId,
      operationId,
      ...(uploadError ? { uploadError } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn(
      chalk.yellow(`⚠ Slack delivery status could not be recorded: ${message}`),
    );
    warnDeliveryRetry(operationId);
    return {
      messages: [],
      delivery: { status: "pending", error: message, operationId },
    };
  }
  if (result.deliveryStatus === "failed") {
    return failedSlackDelivery(
      operationId,
      result.deliveryError ?? "Unknown error",
    );
  }
  return {
    messages: [{ id: result.fileId, url: result.permalink }],
    delivery: { status: "delivered", operationId },
  };
}

async function publishCanonicalFile(
  initialized: CanonicalUploadInitialization,
  options: UploadFileOptions,
  contentType: string,
  fileContent: Buffer,
): Promise<SlackUploadOutput> {
  await uploadCanonicalBody(initialized, contentType, fileContent);
  const materialized = await materializeSlackFileUpload({
    assetId: initialized.assetId,
    operationId: initialized.operationId,
  });
  const fileUrl = materialized.url;

  if (materialized.delivery.status === "delivered") {
    return {
      fileUrl,
      messages: [
        {
          id: materialized.delivery.fileId,
          url: materialized.delivery.permalink,
        },
      ],
      delivery: { status: "delivered", operationId: initialized.operationId },
    };
  }
  if (materialized.delivery.status === "failed") {
    return {
      fileUrl,
      ...failedSlackDelivery(
        initialized.operationId,
        materialized.delivery.message,
      ),
    };
  }
  return {
    fileUrl,
    ...(await completeCanonicalSlackDelivery({
      initialized,
      delivery: materialized.delivery,
      options,
      fileContent,
    })),
  };
}

interface UploadFileCliOptions {
  readonly file: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly title?: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly operationId?: string;
  readonly json?: boolean;
}

function resolveUploadOptions(
  options: UploadFileCliOptions,
): UploadFileOptions {
  const target = parseMessageTarget(options.to, isSlackUserId);
  return {
    file: options.file,
    destination:
      target.kind === "chat"
        ? { channel: target.id }
        : { user: target.kind === "me" ? "me" : target.id },
    thread: options.replyTo,
    title: options.title,
    comment: options.text,
    contentType: options.contentType,
    operationId: options.operationId,
  };
}

async function uploadFile(cliOptions: UploadFileCliOptions): Promise<void> {
  const options = resolveUploadOptions(cliOptions);
  const file = readUploadFile(options.file);
  const filename = basename(options.file);
  const rawContentType =
    options.contentType ?? inferWebUploadContentType(options.file);
  const contentType =
    rawContentType.split(";")[0]?.trim().toLowerCase() ?? rawContentType;
  const operationId = options.operationId ?? randomUUID();
  const checksumSha256 = createHash("sha256")
    .update(file.content)
    .digest("hex");
  const initialized = await initSlackFileUpload({
    filename,
    length: file.size,
    canonical: {
      operationId,
      contentType,
      checksumSha256,
      ...options.destination,
      threadTs: options.thread,
      title: options.title,
      initialComment: options.comment,
    },
  });

  const { chatId, fileUrl, ...delivered } =
    "fileId" in initialized
      ? await uploadDirectlyToSlack(initialized, options, file.content)
      : {
          chatId: initialized.channel,
          ...(await publishCanonicalFile(
            initialized,
            options,
            contentType,
            file.content,
          )),
        };
  printMessageOutput(
    {
      integration: "slack",
      chatId,
      ...delivered,
      file: { name: filename, contentType, size: file.size, url: fileUrl },
    },
    cliOptions,
  );
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a file to a Slack channel as the bot")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption(
    TO_OPTION_FLAGS,
    toOptionDescription("C… channel, D… DM, U…/W… user"),
  )
  .option("--reply-to <ts>", "Parent message timestamp to reply in thread")
  .option("--title <title>", "Display title for the file")
  .option("-t, --text <text>", "Initial comment to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option("--operation-id <uuid>", "Reuse a failed upload operation")
  .option(JSON_OPTION_FLAGS, JSON_OPTION_DESCRIPTION)
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:           okou slack upload-file -f /tmp/report.pdf --to C01234
  Upload to thread:        okou slack upload-file -f /tmp/log.txt --to C01234 --reply-to 1234567890.123456
  DM yourself:             okou slack upload-file -f /tmp/report.pdf --to me
  With title and comment:  okou slack upload-file -f /tmp/data.csv --to C01234 --title "Daily Report" -t "Here's the report"

Notes:
  - Uses the bot token (not user SLACK_TOKEN), so no files:write permission is needed
  - Run-scoped calls publish to Okou storage before Slack delivery
  - Delivery failures are reported on stderr with an --operation-id retry hint

Output:
  Prints "✓ File uploaded" with the Slack file ID, permalink, and Okou file URL.
  With --json, prints one JSON object:
    {"integration":"slack","chatId":"C01234","messages":[{"id":"F0123","url":"https://..."}],"file":{"name":"report.pdf","contentType":"application/pdf","size":12345,"url":"https://..."},"delivery":{"status":"delivered","operationId":"..."}}
  delivery is present for canonical uploads; status is delivered, pending, or failed.`,
  )
  .action(withErrorHandler(uploadFile));
