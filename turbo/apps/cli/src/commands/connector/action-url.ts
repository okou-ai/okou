import { getOkouChatThreadId } from "../../lib/okou-env";

export const CALLBACK_PROMPT_PLACEHOLDER =
  "SOMETHING_AGENT_WANT_TO_BE_CALLBACK";

export const CALLBACK_PROMPT_MAX_LENGTH = 200;
export const CALLBACK_PROMPT_GUIDANCE = `Keep callback prompts concise and within ${CALLBACK_PROMPT_MAX_LENGTH} characters to avoid long URLs that are difficult to recognize. Do not include secrets.`;

export function connectorActionCallbackAvailable(): boolean {
  return Boolean(getOkouChatThreadId()?.trim());
}

function serializeCallbackActionUrl(
  actionUrl: URL,
  threadId: string,
  callbackPrompt: string,
): string {
  const finalizedUrl = new URL(actionUrl.toString());
  finalizedUrl.searchParams.delete("threadId");
  finalizedUrl.searchParams.delete("callbackPrompt");
  finalizedUrl.searchParams.append("callbackPrompt", callbackPrompt);
  // End in the UUID so chat autolinking preserves prompt punctuation.
  finalizedUrl.searchParams.append("threadId", threadId);
  return finalizedUrl.toString();
}

export function finalizeActionUrl(
  actionUrl: URL,
  callbackPrompt: string | undefined,
): string {
  if (callbackPrompt === undefined) {
    return actionUrl.toString();
  }

  const normalizedPrompt = callbackPrompt.trim();
  if (!normalizedPrompt) {
    throw new Error("--callback-prompt cannot be empty");
  }
  if ([...normalizedPrompt].length > CALLBACK_PROMPT_MAX_LENGTH) {
    throw new Error(
      `--callback-prompt is too long. ${CALLBACK_PROMPT_GUIDANCE}`,
    );
  }

  const threadId = getOkouChatThreadId()?.trim();
  if (!threadId) {
    throw new Error(
      "--callback-prompt requires the current web chat and its execution context",
    );
  }
  return serializeCallbackActionUrl(actionUrl, threadId, normalizedPrompt);
}

export function connectorActionUrl(args: {
  readonly origin: string;
  readonly path: string;
}): string {
  const url = new URL(args.path, args.origin);
  const threadId = getOkouChatThreadId()?.trim();
  if (threadId && url.pathname !== "/connectors") {
    url.searchParams.set("threadId", threadId);
  }
  return url.toString();
}

function callbackActionUrlExample(actionUrl: string): string | null {
  const threadId = getOkouChatThreadId()?.trim();
  if (!threadId) {
    return null;
  }

  return serializeCallbackActionUrl(
    new URL(actionUrl),
    threadId,
    CALLBACK_PROMPT_PLACEHOLDER,
  );
}

export function printCallbackActionUrlExample(actionUrl: string): void {
  const callbackUrl = callbackActionUrlExample(actionUrl);
  if (!callbackUrl) {
    return;
  }

  console.log("");
  console.log(
    "Or, if this is the only connector or permission action needed, use the callback URL below. After the user completes this action, Okou will automatically start the next round with the callback prompt:",
  );
  console.log(CALLBACK_PROMPT_GUIDANCE);
  console.log(callbackUrl);
}

export function printCallbackTurnInstruction(): void {
  console.log("");
  console.log(
    "Return the exact callback URL above verbatim, without rewriting, shortening, reconstructing, or omitting any query parameters. Then end the current turn. When the user completes the action, Okou will automatically start the next round with the callback prompt.",
  );
}
