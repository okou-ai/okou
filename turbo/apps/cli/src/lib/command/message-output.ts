import chalk from "chalk";

/**
 * Shared output for channel messaging commands (`okou <channel> message send`
 * and `okou <channel> upload-file`). Every command prints either a concise
 * human summary or, with `--json`, exactly one {@link MessageSendOutput}.
 */
export type MessageIntegration =
  | "slack"
  | "feishu"
  | "lark"
  | "teams"
  | "telegram"
  | "discord"
  | "phone";

export interface DeliveredMessage {
  readonly id: string;
  readonly url: string | null;
}

export interface UploadedFile {
  readonly name: string;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly url: string | null;
}

export interface MessageDelivery {
  readonly status: "delivered" | "pending" | "failed";
  readonly error?: string;
  readonly operationId?: string;
}

export interface MessageSendOutput {
  readonly integration: MessageIntegration;
  /** Conversation, channel, or chat the message landed in. */
  readonly chatId: string | null;
  readonly messages: readonly DeliveredMessage[];
  /** Present for uploads only. */
  readonly file?: UploadedFile;
  /** Present for uploads whose delivery is asynchronous or can fail. */
  readonly delivery?: MessageDelivery;
}

export const JSON_OPTION_FLAGS = "--json";
export const JSON_OPTION_DESCRIPTION =
  "Print the result as a single JSON object";

function formatHumanOutput(output: MessageSendOutput): string[] {
  const [first] = output.messages;
  const ids =
    output.messages.length === 1 && first
      ? ` (id: ${first.id})`
      : output.messages.length > 1
        ? ` (${output.messages.length} messages)`
        : "";
  const lines = [
    chalk.green(`✓ ${output.file ? "File uploaded" : "Message sent"}${ids}`),
  ];
  if (output.chatId) {
    lines.push(chalk.dim(`  chat: ${output.chatId}`));
  }
  if (output.messages.length === 1 && first?.url) {
    lines.push(chalk.dim(`  permalink: ${first.url}`));
  }
  if (output.messages.length > 1) {
    for (const message of output.messages) {
      lines.push(chalk.dim(`  ${message.id}  ${message.url ?? ""}`.trimEnd()));
    }
  }
  if (output.file) {
    const details = [
      output.file.contentType,
      output.file.size === null ? null : `${output.file.size} bytes`,
    ].filter((detail): detail is string => {
      return detail !== null;
    });
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    lines.push(chalk.dim(`  file: ${output.file.name}${suffix}`));
    if (output.file.url) {
      lines.push(chalk.dim(`  url: ${output.file.url}`));
    }
  }
  if (output.delivery && output.delivery.status !== "delivered") {
    lines.push(chalk.dim(`  delivery: ${output.delivery.status}`));
  }
  return lines;
}

/**
 * Prints the command result to stdout: one JSON object with `--json`,
 * otherwise a green success line followed by dim detail lines.
 */
export function printMessageOutput(
  output: MessageSendOutput,
  options: { readonly json?: boolean },
): void {
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  for (const line of formatHumanOutput(output)) {
    console.log(line);
  }
}
