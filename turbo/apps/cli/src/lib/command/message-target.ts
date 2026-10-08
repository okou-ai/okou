import { readFileSync } from "node:fs";

/**
 * Shared vocabulary for channel messaging commands (`okou <channel> message
 * send` and `okou <channel> upload-file`):
 *
 *   --to <target>        where to send: `me`, `user:<id>`, `chat:<id>`, or a
 *                        channel-native ID classified by its prefix
 *   --reply-to <id>      the message being replied to
 *   --as <id>            the bot, installation, or phone agent to send as
 *   -t, --text <text>    plain text (message body or file caption)
 *   --rich <json>        channel-native rich payload
 */
export type MessageTarget =
  | { readonly kind: "me" }
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "chat"; readonly id: string };

export const TO_OPTION_FLAGS = "--to <target>";

export function toOptionDescription(examples: string): string {
  return `Destination: me, user:<id>, chat:<id>, or a native ID (${examples})`;
}

/**
 * Parses a `--to` value. `me` addresses the current user, explicit
 * `user:`/`chat:` prefixes win, and bare IDs are classified by the channel.
 */
export function parseMessageTarget(
  value: string,
  isUserId: (id: string) => boolean,
): MessageTarget {
  const trimmed = value.trim();
  if (trimmed === "me") {
    return { kind: "me" };
  }
  for (const kind of ["user", "chat"] as const) {
    const prefix = `${kind}:`;
    if (trimmed.startsWith(prefix)) {
      const id = trimmed.slice(prefix.length).trim();
      if (!id) {
        throw new Error(`--to ${prefix} requires an ID`);
      }
      return { kind, id };
    }
  }
  if (!trimmed) {
    throw new Error("--to requires a value");
  }
  return isUserId(trimmed)
    ? { kind: "user", id: trimmed }
    : { kind: "chat", id: trimmed };
}

export function missingTargetError(channel: string, accepted: string): Error {
  return new Error("Missing --to", {
    cause: new Error(`Use ${accepted} as the ${channel} destination`),
  });
}

export function unsupportedTargetError(
  channel: string,
  target: MessageTarget,
  hint: string,
): Error {
  const label = target.kind === "me" ? "me" : `${target.kind} targets`;
  return new Error(`${channel} does not support --to ${label} here`, {
    cause: new Error(hint),
  });
}

/**
 * Returns `--text`, or piped stdin when `--text` is absent and stdin is not a
 * terminal.
 */
export function readMessageText(text: string | undefined): string | undefined {
  if (text || process.stdin.isTTY) {
    return text;
  }
  try {
    return readFileSync(0, "utf8").trim() || undefined;
  } catch {
    // stdin is not readable (e.g. a test runner with no piped input).
    return undefined;
  }
}

export function parseRichJson(value: string, expected: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid JSON for --rich", {
      cause: new Error(`Provide ${expected}`),
    });
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
