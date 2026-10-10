import { readFile, stat } from "node:fs/promises";
import { Command } from "commander";
import { z } from "zod";
import {
  notifyMailBodySchema,
  type NotificationResponse,
} from "@okouai/api-contracts/contracts/notifications";
import {
  getNotification,
  notifyMail,
} from "../../lib/api/domains/notifications";
import { ApiRequestError } from "../../lib/api/core/client-factory";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface MailOptions {
  readonly to: string;
  readonly kind: string;
  readonly subject: string;
  readonly idempotencyKey: string;
  readonly text?: string;
  readonly file?: string;
  readonly json?: boolean;
}
const MAX_BODY_BYTES = 32_000;
class NotificationInputError extends Error {}

async function readBody(options: MailOptions): Promise<string> {
  if (options.text !== undefined && options.file !== undefined) {
    throw new NotificationInputError(
      "Choose either --text or --file; they cannot be combined.",
    );
  }
  if (options.text !== undefined) {
    return options.text;
  }
  if (options.file !== undefined) {
    const info = await stat(options.file);
    if (!info.isFile() || info.size > MAX_BODY_BYTES) {
      throw new NotificationInputError(
        "--file must be a text file of at most 32000 bytes (8000 Unicode characters).",
      );
    }
    return await readFile(options.file, "utf8");
  }
  if (process.stdin.isTTY) {
    throw new NotificationInputError(
      "Provide Markdown using --text, --file, or piped stdin.",
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      throw new NotificationInputError(
        "Piped body exceeds 32000 bytes (8000 Unicode characters).",
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printNotification(
  result: NotificationResponse,
  options: { readonly json?: boolean },
) {
  if (options.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(
    `Mail notification ${result.status}: ${result.notificationId}${result.reason ? ` (${result.reason})` : ""}${result.deduplicated ? " [existing notification]" : ""}`,
  );
  if (result.status === "queued") {
    console.log(
      `Check status: okou notify get ${result.notificationId} --json`,
    );
  }
  if (result.status === "sent") {
    console.log(
      "Accepted by the email provider; inbox delivery is not confirmed.",
    );
  }
}

function renderJsonError(
  error: unknown,
  options: { readonly json?: boolean },
): boolean {
  if (!options.json) {
    return false;
  }
  console.error(
    JSON.stringify({
      error: {
        code:
          error instanceof ApiRequestError
            ? error.code
            : error instanceof NotificationInputError
              ? "INVALID_INPUT"
              : "NOTIFICATION_ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Unexpected notification error",
        ...(error instanceof ApiRequestError ? { status: error.status } : {}),
      },
    }),
  );
  return true;
}

export function createNotifyCommand(): Command {
  const mail = new Command("mail")
    .description(
      "Send an Okou email notification to the user of the current run",
    )
    .option("--to <recipient>", "Recipient (only me is supported)", "me")
    .option(
      "--kind <kind>",
      "Notification purpose: notification or morning-brief",
      "notification",
    )
    .requiredOption(
      "--subject <subject>",
      "Email subject (at most 180 characters)",
    )
    .requiredOption(
      "--idempotency-key <key>",
      "Stable key for this notification; reuse on retries",
    )
    .option("-t, --text <markdown>", "Markdown body (at most 8000 characters)")
    .option("-f, --file <path>", "Read Markdown body from a UTF-8 file")
    .option("--json", "Print the notification receipt as JSON")
    .addHelpText(
      "after",
      `
Examples:
  okou notify mail --kind morning-brief --subject "Morning Brief" --file brief.md --idempotency-key morning-brief:2026-10-08 --json
  printf 'A useful update' | okou notify mail --subject "Update" --idempotency-key update:123 --json

Requires an active Okou run with notify:write.
Uses Okou's sender and your account email; no Gmail or Outlook connector is needed.
notification is the default. morning-brief requires a run from the official Morning Brief automation
and uses its original artwork and Manage link; it does not disable the completion email.
queued means awaiting delivery; sent means provider accepted, not inbox delivered.
skipped means opt-out, suppression, or no account email stopped delivery.
Provider requests already in flight cannot be recalled.
The key is scoped to your user and workspace and survives run/outbox deletion.
Reuse the same key and exact content after a timeout. Different content returns a conflict.
Use a new key only for an intentional new notification. --text/--file take precedence over stdin.`,
    )
    .action(
      withErrorHandler(async (options: MailOptions) => {
        const parsed = notifyMailBodySchema.safeParse({
          to: options.to,
          kind: options.kind,
          subject: options.subject,
          idempotencyKey: options.idempotencyKey,
          text: await readBody(options),
        });
        if (!parsed.success) {
          throw new NotificationInputError(
            parsed.error.issues
              .map((issue) => {
                return `${issue.path.join(".")}: ${issue.message}`;
              })
              .join("; "),
          );
        }
        printNotification(await notifyMail(parsed.data), options);
      }, renderJsonError),
    );
  const get = new Command("get")
    .description("Read your notification's current delivery status")
    .argument("<notification-id>", "ID returned by notify mail")
    .option("--json", "Print the notification receipt as JSON")
    .action(
      withErrorHandler(
        async (id: string, options: { readonly json?: boolean }) => {
          const parsed = z.uuid().safeParse(id);
          if (!parsed.success) {
            throw new NotificationInputError(
              "notification-id must be the UUID returned by okou notify mail.",
            );
          }
          printNotification(await getNotification(parsed.data), options);
        },
        (error, _id, options) => {
          return renderJsonError(error, options);
        },
      ),
    );
  return new Command("notify")
    .description("Send notifications to yourself through Okou")
    .addCommand(mail)
    .addCommand(get);
}

export const notifyCommand = createNotifyCommand();
