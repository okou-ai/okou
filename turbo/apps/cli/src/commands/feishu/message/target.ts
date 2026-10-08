import { Option } from "commander";
import {
  missingTargetError,
  parseMessageTarget,
} from "../../../lib/command/message-target";

export interface FeishuDestinationOptions {
  readonly to?: string;
  readonly replyTo?: string;
  readonly replyMode?: "thread" | "quote";
}

export interface FeishuDestination {
  readonly chat?: string;
  readonly user?: string;
  readonly replyToMessageId?: string;
  readonly replyInThread?: boolean;
}

export function replyModeOption(): Option {
  return new Option(
    "--reply-mode <mode>",
    "Reply as a thread or an inline quote (default: quote)",
  ).choices(["thread", "quote"]);
}

/**
 * Feishu derives the chat from the replied-to message, so --reply-to stands
 * alone; otherwise --to selects a chat (oc_…) or a user (ou_… or me).
 */
export function resolveFeishuDestination(
  providerName: string,
  options: FeishuDestinationOptions,
): FeishuDestination {
  if (options.replyTo) {
    if (options.to) {
      throw new Error("--to and --reply-to are mutually exclusive", {
        cause: new Error(
          `${providerName} replies go to the chat of the --reply-to message; omit --to`,
        ),
      });
    }
    return {
      replyToMessageId: options.replyTo,
      replyInThread: options.replyMode === "thread" ? true : undefined,
    };
  }
  if (options.replyMode) {
    throw new Error("--reply-mode requires --reply-to");
  }
  if (!options.to) {
    throw missingTargetError(
      providerName,
      "me, a chat ID (oc_…), a user open ID (ou_…), or --reply-to",
    );
  }
  const target = parseMessageTarget(options.to, (id) => {
    return id.startsWith("ou_");
  });
  if (target.kind === "chat") {
    return { chat: target.id };
  }
  return { user: target.kind === "me" ? "me" : target.id };
}
