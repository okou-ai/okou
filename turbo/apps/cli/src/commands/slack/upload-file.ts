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
  unsupportedTargetError,
} from "../../lib/command/message-target";
import { isSlackUserId } from "./message/send";

interface UploadFileOptions {
  readonly file: string;
  readonly channel: string;
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

async function uploadDirectlyToSlack(
  initialized: DirectUploadInitialization,
  options: UploadFileOptions,
  fileContent: Buffer,
): Promise<void> {
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
    channel: options.channel,
    threadTs: options.thread,
    title: options.title,
    initialComment: options.comment,
  });
  console.log(chalk.green(`✓ File uploaded (file_id: ${result.fileId})`));
  console.log(chalk.dim(`  permalink: ${result.permalink}`));
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

async function completeCanonicalSlackDelivery(args: {
  readonly initialized: CanonicalUploadInitialization;
  readonly delivery: PendingSlackDelivery;
  readonly options: UploadFileOptions;
  readonly fileContent: Buffer;
}): Promise<void> {
  const uploadError = await uploadPendingSlackBody(
    args.delivery,
    args.fileContent,
  );
  let result: Awaited<ReturnType<typeof completeSlackFileUpload>>;
  try {
    result = await completeSlackFileUpload({
      fileId: args.delivery.fileId,
      channel: args.options.channel,
      ...(args.options.thread ? { threadTs: args.options.thread } : {}),
      ...(args.options.title ? { title: args.options.title } : {}),
      ...(args.options.comment ? { initialComment: args.options.comment } : {}),
      canonicalAssetId: args.initialized.assetId,
      operationId: args.initialized.operationId,
      ...(uploadError ? { uploadError } : {}),
    });
  } catch (error) {
    console.warn(
      chalk.yellow(
        `⚠ Slack delivery status could not be recorded: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      ),
    );
    warnDeliveryRetry(args.initialized.operationId);
    return;
  }
  if (result.deliveryStatus === "failed") {
    console.warn(
      chalk.yellow(
        `⚠ Slack delivery failed: ${result.deliveryError ?? "Unknown error"}`,
      ),
    );
    warnDeliveryRetry(args.initialized.operationId);
    return;
  }
  console.log(chalk.green(`✓ Delivered to Slack (file_id: ${result.fileId})`));
  console.log(chalk.dim(`  permalink: ${result.permalink}`));
}

async function publishCanonicalFile(
  initialized: CanonicalUploadInitialization,
  options: UploadFileOptions,
  contentType: string,
  fileContent: Buffer,
): Promise<void> {
  await uploadCanonicalBody(initialized, contentType, fileContent);
  const materialized = await materializeSlackFileUpload({
    assetId: initialized.assetId,
    operationId: initialized.operationId,
  });
  console.log(
    chalk.green(`✓ File published (asset_id: ${materialized.assetId})`),
  );
  console.log(chalk.dim(`  url: ${materialized.url}`));

  if (materialized.delivery.status === "delivered") {
    console.log(
      chalk.green(
        `✓ Delivered to Slack (file_id: ${materialized.delivery.fileId})`,
      ),
    );
    console.log(chalk.dim(`  permalink: ${materialized.delivery.permalink}`));
    return;
  }
  if (materialized.delivery.status === "failed") {
    console.warn(
      chalk.yellow(`⚠ Slack delivery failed: ${materialized.delivery.message}`),
    );
    warnDeliveryRetry(initialized.operationId);
    return;
  }
  await completeCanonicalSlackDelivery({
    initialized,
    delivery: materialized.delivery,
    options,
    fileContent,
  });
}

interface UploadFileCliOptions {
  readonly file: string;
  readonly to: string;
  readonly replyTo?: string;
  readonly title?: string;
  readonly text?: string;
  readonly contentType?: string;
  readonly operationId?: string;
}

function resolveUploadOptions(
  options: UploadFileCliOptions,
): UploadFileOptions {
  const target = parseMessageTarget(options.to, isSlackUserId);
  if (target.kind !== "chat") {
    throw unsupportedTargetError(
      "Slack upload-file",
      target,
      "Pass a channel or DM conversation ID (C…, G…, or D…)",
    );
  }
  return {
    file: options.file,
    channel: target.id,
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
      channel: options.channel,
      threadTs: options.thread,
      title: options.title,
      initialComment: options.comment,
    },
  });

  if ("fileId" in initialized) {
    await uploadDirectlyToSlack(initialized, options, file.content);
    return;
  }
  await publishCanonicalFile(initialized, options, contentType, file.content);
}

export const uploadFileCommand = new Command()
  .name("upload-file")
  .description("Upload a file to a Slack channel as the bot")
  .requiredOption("-f, --file <path>", "Local file path to upload")
  .requiredOption(
    TO_OPTION_FLAGS,
    toOptionDescription("C… channel or D… DM conversation"),
  )
  .option("--reply-to <ts>", "Parent message timestamp to reply in thread")
  .option("--title <title>", "Display title for the file")
  .option("-t, --text <text>", "Initial comment to accompany the file")
  .option("--content-type <mime>", "Override inferred content type")
  .option("--operation-id <uuid>", "Reuse a failed upload operation")
  .addHelpText(
    "after",
    `
Examples:
  Upload a file:           okou slack upload-file -f /tmp/report.pdf --to C01234
  Upload to thread:        okou slack upload-file -f /tmp/log.txt --to C01234 --reply-to 1234567890.123456
  With title and comment:  okou slack upload-file -f /tmp/data.csv --to C01234 --title "Daily Report" -t "Here's the report"

Notes:
  - Uses the bot token (not user SLACK_TOKEN), so no files:write permission is needed
  - Run-scoped calls publish to Okou storage before Slack delivery
  - Returns canonical asset details and Slack delivery status`,
  )
  .action(withErrorHandler(uploadFile));
