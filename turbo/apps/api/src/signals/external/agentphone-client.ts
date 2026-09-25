import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";

const log = logger("api:agentphone");

interface AgentPhoneSentMessage {
  readonly id: string;
  readonly status: string;
  readonly channel: string | null;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly mediaUrls: readonly string[];
}

interface AgentPhoneApiError extends Error {
  readonly name: "AgentPhoneApiError";
  readonly status: number;
  readonly body: string;
}

function agentPhoneApiBase(): string {
  const baseUrl = optionalEnv("AGENTPHONE_API_BASE_URL");
  if (!baseUrl) {
    throw new Error("AGENTPHONE_API_BASE_URL is not configured");
  }
  return baseUrl;
}

function agentPhoneApiKey(): string {
  const apiKey = optionalEnv("AGENTPHONE_API_KEY");
  if (!apiKey) {
    throw new Error("AGENTPHONE_API_KEY is not configured");
  }
  return apiKey;
}

function makeAgentPhoneApiError(
  status: number,
  body: string,
): AgentPhoneApiError {
  return Object.assign(new Error(`Phone provider error: ${status}`), {
    name: "AgentPhoneApiError" as const,
    status,
    body,
  });
}

export function isAgentPhoneApiError(
  error: unknown,
): error is AgentPhoneApiError {
  return (
    error instanceof Error &&
    error.name === "AgentPhoneApiError" &&
    "status" in error
  );
}

export async function sendAgentPhoneMessage(
  opts: {
    readonly agentphoneAgentId: string;
    readonly toNumber: string;
    readonly replyToMessageId?: string | null;
    readonly body: string;
    readonly mediaUrl?: string | null;
    readonly mediaUrls?: readonly string[] | null;
  },
  signal?: AbortSignal,
): Promise<AgentPhoneSentMessage> {
  const response = await fetch(`${agentPhoneApiBase()}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentPhoneApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: opts.agentphoneAgentId,
      to_number: opts.toNumber,
      ...(opts.replyToMessageId
        ? { reply_to_message_id: opts.replyToMessageId }
        : {}),
      body: opts.body,
      ...(opts.mediaUrl ? { media_url: opts.mediaUrl } : {}),
      ...(opts.mediaUrls?.length ? { media_urls: opts.mediaUrls } : {}),
    }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("AgentPhone send message failed", {
      status: response.status,
      body: text,
    });
    throw makeAgentPhoneApiError(response.status, text);
  }

  const result = (await response.json()) as Record<string, unknown>;
  const mediaUrls = Array.isArray(result.media_urls)
    ? result.media_urls.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];

  return {
    id: typeof result.id === "string" ? result.id : "unknown",
    status: typeof result.status === "string" ? result.status : "sent",
    channel: typeof result.channel === "string" ? result.channel : null,
    fromNumber:
      typeof result.from_number === "string" ? result.from_number : null,
    toNumber:
      typeof result.to_number === "string" ? result.to_number : opts.toNumber,
    mediaUrls,
  };
}

export async function sendAgentPhoneTypingIndicator(
  opts: { readonly conversationId: string },
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${agentPhoneApiBase()}/v1/conversations/${encodeURIComponent(
      opts.conversationId,
    )}/typing`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${agentPhoneApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal,
    },
  );

  if (!response.ok) {
    const text = await response.text();
    log.debug("AgentPhone typing indicator failed", {
      conversationId: opts.conversationId,
      status: response.status,
      body: text,
    });
    throw makeAgentPhoneApiError(response.status, text);
  }
}
