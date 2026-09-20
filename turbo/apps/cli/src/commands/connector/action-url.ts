import { getOkouAgentId, getOkouChatThreadId } from "../../lib/okou-env";

export const CALLBACK_PROMPT_PLACEHOLDER =
  "SOMETHING_AGENT_WANT_TO_BE_CALLBACK";

export const CALLBACK_PROMPT_MAX_LENGTH = 200;
export const CALLBACK_PROMPT_GUIDANCE = `Keep callback prompts concise and within ${CALLBACK_PROMPT_MAX_LENGTH} characters to avoid long URLs that are difficult to recognize. Do not include secrets.`;

export function connectorActionCallbackAvailable(): boolean {
  return Boolean(getOkouChatThreadId()?.trim());
}

function currentChatThreadId(agentId: string | undefined): string | null {
  const threadId = getOkouChatThreadId()?.trim();
  const currentAgentId = getOkouAgentId()?.trim();
  if (!threadId || !currentAgentId || agentId !== currentAgentId) {
    return null;
  }
  return threadId;
}

export function currentChatSupportsActionCallback(
  agentId: string | undefined,
): boolean {
  return currentChatThreadId(agentId) !== null;
}

function serializeCallbackActionUrl(
  actionUrl: URL,
  threadId: string,
  callbackPrompt: string,
): string {
  const finalizedUrl = new URL(actionUrl.toString());
  finalizedUrl.searchParams.delete("threadId");
  finalizedUrl.searchParams.delete("callbackPrompt");
  finalizedUrl.searchParams.append("threadId", threadId);
  finalizedUrl.searchParams.append("callbackPrompt", callbackPrompt);
  return finalizedUrl.toString();
}

export function finalizeActionUrl(
  actionUrl: URL,
  callbackPrompt: string | undefined,
  agentId: string | undefined,
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

  const threadId = currentChatThreadId(agentId);
  if (!threadId) {
    throw new Error(
      "--callback-prompt can only target the current web chat thread and agent",
    );
  }
  return serializeCallbackActionUrl(actionUrl, threadId, normalizedPrompt);
}

export function connectorActionUrl(args: {
  readonly origin: string;
  readonly path: string;
  readonly agentId?: string;
}): string {
  const url = new URL(args.path, args.origin);
  if (args.agentId) {
    url.searchParams.set("agentId", args.agentId);
  }
  return url.toString();
}

function callbackActionUrlExample(
  actionUrl: string,
  agentId: string | undefined,
): string | null {
  const threadId = currentChatThreadId(agentId);
  if (!threadId) {
    return null;
  }

  return serializeCallbackActionUrl(
    new URL(actionUrl),
    threadId,
    CALLBACK_PROMPT_PLACEHOLDER,
  );
}

export function printCallbackActionUrlExample(
  actionUrl: string,
  agentId: string | undefined,
): void {
  const callbackUrl = callbackActionUrlExample(actionUrl, agentId);
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
