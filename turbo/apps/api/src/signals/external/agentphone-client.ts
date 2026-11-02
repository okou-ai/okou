import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  array,
  boolean,
  iso,
  literal,
  object,
  string,
  type infer as zInfer,
} from "zod";

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

const whatsappNumbersSchema = object({
  data: array(object({ phoneNumber: string(), whatsappEnabled: boolean() })),
  hasMore: boolean(),
});

export async function isAgentPhoneWhatsappNumberEnabled(
  phoneNumber: string,
  signal: AbortSignal,
): Promise<boolean> {
  let offset = 0;
  for (;;) {
    const response = await accept(
      fetch(`${agentPhoneApiBase()}/v1/numbers?limit=100&offset=${offset}`, {
        headers: { Authorization: `Bearer ${agentPhoneApiKey()}` },
        signal,
      }),
      [200],
    );
    const page = whatsappNumbersSchema.parse(await response.json());
    const number = page.data.find((item) => {
      return item.phoneNumber === phoneNumber;
    });
    if (number) {
      return number.whatsappEnabled;
    }
    if (!page.hasMore) {
      return false;
    }
    if (page.data.length === 0) {
      throw new Error("AgentPhone number pagination did not advance");
    }
    offset += page.data.length;
  }
}

export async function sendAgentPhoneMessage(
  opts: {
    readonly agentphoneAgentId: string;
    readonly toNumber: string;
    readonly replyToMessageId?: string | null;
    readonly body: string;
    readonly mediaUrl?: string | null;
    readonly mediaUrls?: readonly string[] | null;
    readonly channel?: "whatsapp";
  },
  signal?: AbortSignal,
): Promise<AgentPhoneSentMessage> {
  const fromNumber =
    opts.channel === "whatsapp"
      ? optionalEnv("AGENTPHONE_PHONE_NUMBER")
      : undefined;
  if (opts.channel === "whatsapp" && !fromNumber) {
    throw new Error("AGENTPHONE_PHONE_NUMBER is not configured");
  }
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
          ...(opts.channel
            ? { channel: opts.channel, from_number: fromNumber }
            : {}),
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

const agentPhoneReactionSchema = object({
  id: string().min(1),
  reaction_type: string().min(1),
  message_id: string().min(1),
  channel: literal("imessage"),
});

export async function sendAgentPhoneReaction(
  opts: { readonly messageId: string; readonly reaction: string },
  signal: AbortSignal,
) {
  const result = await settle(
    accept(
      fetch(
        `${agentPhoneApiBase()}/v1/messages/${encodeURIComponent(opts.messageId)}/reactions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${agentPhoneApiKey()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reaction: opts.reaction }),
          signal,
        },
      ),
      [200],
    ),
  );
  if (!result.ok) {
    if (!(result.error instanceof HttpStatusError)) {
      throw result.error;
    }
    const response = result.error.response;
    throw makeAgentPhoneApiError(response.status, await response.text());
  }
  return agentPhoneReactionSchema.parse(await result.value.json());
}

const conversationMediaCapabilitiesSchema = object({
  capabilities: object({
    canSendMessages: boolean(),
    media: boolean(),
  }).nullish(),
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

const conversationMessagesSchema = object({
  data: array(
    object({
      id: string().min(1),
      body: string(),
      fromNumber: string(),
      toNumber: string(),
      direction: string(),
      status: string().nullish(),
      mediaUrl: string().nullish(),
      mediaUrls: array(string()).default([]),
      receivedAt: iso.datetime({ offset: true }),
    }),
  ),
  hasMore: boolean(),
});

export async function getAgentPhoneMessagesAfter(
  conversationId: string,
  after: Date,
  signal: AbortSignal,
): Promise<zInfer<typeof conversationMessagesSchema> | null> {
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
