import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import * as z from "zod";
import { safeJsonParse, settle } from "../utils";

const log = logger("api:agentphone");

interface AgentPhoneSentMessage {
  readonly id: string;
  readonly channel: string | null;
  readonly fromNumber: string | null;
  readonly toNumber: string;
  readonly mediaUrls: readonly string[];
}

interface AgentPhoneApiError extends Error {
  readonly name: "AgentPhoneApiError";
  readonly status: number;
  readonly body: string;
  readonly code: string | null;
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
  const details = valueObject(valueObject(safeJsonParse(body)).error);
  return Object.assign(new Error(`Phone provider error: ${status}`), {
    name: "AgentPhoneApiError" as const,
    status,
    body,
    code: typeof details.code === "string" ? details.code : null,
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
  const responseResult = await settle(
    accept(
      fetch(`${agentPhoneApiBase()}/v1/messages`, {
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
      }),
      [200, 201],
    ),
  );
  if (!responseResult.ok) {
    const failure = responseResult.error;
    if (!(failure instanceof HttpStatusError)) {
      throw failure;
    }
    const response = failure.response;
    const text = await response.text();
    const error = makeAgentPhoneApiError(response.status, text);
    if (
      error.status !== 422 ||
      error.code !== "CONVERSATION_CONTENT_RESTRICTED"
    ) {
      log.error("AgentPhone send message failed", {
        status: response.status,
        body: text,
      });
    }
    throw error;
  }
  const response = responseResult.value;

  const result = valueObject(await response.json());
  const id = typeof result.id === "string" ? result.id : undefined;
  if (!id?.trim()) {
    throw new Error("AgentPhone send response is missing a message id");
  }
  const mediaUrls = Array.isArray(result.media_urls)
    ? result.media_urls.filter((item): item is string => {
        return typeof item === "string";
      })
    : [];

  return {
    id,
    channel: typeof result.channel === "string" ? result.channel : null,
    fromNumber:
      typeof result.from_number === "string" ? result.from_number : null,
    toNumber:
      typeof result.to_number === "string" ? result.to_number : opts.toNumber,
    mediaUrls,
  };
}

const conversationMediaCapabilitiesSchema = z.object({
  capabilities: z
    .object({ canSendMessages: z.boolean(), media: z.boolean() })
    .nullish(),
});

export async function canSendAgentPhoneConversationMedia(
  conversationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const responseResult = await settle(
    accept(
      fetch(
        `${agentPhoneApiBase()}/v1/conversations/${encodeURIComponent(conversationId)}`,
        { headers: { Authorization: `Bearer ${agentPhoneApiKey()}` }, signal },
      ),
      [200, 404],
    ),
  );
  if (!responseResult.ok) {
    const failure = responseResult.error;
    if (!(failure instanceof HttpStatusError)) {
      throw failure;
    }
    const response = failure.response;
    throw makeAgentPhoneApiError(response.status, await response.text());
  }
  const response = responseResult.value;
  if (response.status === 404) {
    return false;
  }

  const { capabilities } = conversationMediaCapabilitiesSchema.parse(
    await response.json(),
  );
  return capabilities?.canSendMessages === true && capabilities.media;
}

const conversationMessagesSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      body: z.string(),
      fromNumber: z.string(),
      toNumber: z.string(),
      direction: z.string(),
      status: z.string().nullish(),
      mediaUrl: z.string().nullish(),
      mediaUrls: z.array(z.string()).default([]),
      receivedAt: z.iso.datetime({ offset: true }),
    }),
  ),
  hasMore: z.boolean(),
});

export async function getAgentPhoneMessagesAfter(
  conversationId: string,
  after: Date,
  signal: AbortSignal,
): Promise<z.infer<typeof conversationMessagesSchema> | null> {
  const query = new URLSearchParams({
    after: after.toISOString(),
    limit: "200",
  });
  const responseResult = await settle(
    accept(
      fetch(
        `${agentPhoneApiBase()}/v1/conversations/${encodeURIComponent(conversationId)}/messages?${query}`,
        { headers: { Authorization: `Bearer ${agentPhoneApiKey()}` }, signal },
      ),
      [200, 404],
    ),
  );
  if (!responseResult.ok) {
    const failure = responseResult.error;
    if (!(failure instanceof HttpStatusError)) {
      throw failure;
    }
    const response = failure.response;
    throw makeAgentPhoneApiError(response.status, await response.text());
  }
  const response = responseResult.value;
  if (response.status === 404) {
    return null;
  }

  return conversationMessagesSchema.parse(await response.json());
}

export async function getAgentPhoneConversationParticipants(
  opts: { readonly conversationId: string },
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const responseResult = await settle(
    accept(
      fetch(
        `${agentPhoneApiBase()}/v1/conversations/${encodeURIComponent(
          opts.conversationId,
        )}`,
        {
          headers: { Authorization: `Bearer ${agentPhoneApiKey()}` },
          signal,
        },
      ),
      [200],
    ),
  );
  if (!responseResult.ok) {
    const failure = responseResult.error;
    if (!(failure instanceof HttpStatusError)) {
      throw failure;
    }
    const response = failure.response;
    log.warn("AgentPhone conversation lookup failed", {
      status: response.status,
    });
    throw makeAgentPhoneApiError(response.status, "");
  }
  const response = responseResult.value;

  const result = valueObject(await response.json());
  const data = valueObject(result.data);
  const conversation =
    valueObject(result.conversation).participants !== undefined
      ? valueObject(result.conversation)
      : valueObject(data.conversation);
  const source =
    Object.keys(conversation).length > 0
      ? conversation
      : Object.keys(data).length > 0
        ? data
        : result;
  const participants = Array.isArray(source.participants)
    ? source.participants
    : [];

  return participants
    .map((participant) => {
      if (typeof participant === "string") {
        return participant;
      }
      return typeof participant === "object" &&
        participant !== null &&
        "identifier" in participant &&
        typeof participant.identifier === "string"
        ? participant.identifier
        : null;
    })
    .filter((identifier): identifier is string => {
      return Boolean(identifier);
    });
}

function valueObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export async function sendAgentPhoneTypingIndicator(
  opts: { readonly conversationId: string },
  signal?: AbortSignal,
): Promise<void> {
  const responseResult = await settle(
    accept(
      fetch(
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
      ),
      [200, 204],
    ),
  );
  if (!responseResult.ok) {
    const failure = responseResult.error;
    if (!(failure instanceof HttpStatusError)) {
      throw failure;
    }
    const response = failure.response;
    const text = await response.text();
    log.debug("AgentPhone typing indicator failed", {
      conversationId: opts.conversationId,
      status: response.status,
      body: text,
    });
    throw makeAgentPhoneApiError(response.status, text);
  }
}
