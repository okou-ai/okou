import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { OpenRouterRequestError } from "./openrouter";
import { readBoundedResponseText, safeJsonParse } from "../utils";
import {
  isRetryableVoiceProviderStatus,
  requestVoiceProvider,
  VoiceProviderTemporaryResponseError,
} from "./voice-provider-request";
import type {
  VoiceCompletionRequest,
  VoiceJsonSchema,
} from "./voice-completion-types";

const L = logger("OpenRouterVoice");
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_VOICE_RESPONSE_MAX_BYTES = 1024 * 1024;

interface OpenRouterVoiceChoice {
  readonly finish_reason?: unknown;
  readonly native_finish_reason?: unknown;
  readonly error?: unknown;
  readonly message?: { readonly content?: unknown };
}

interface OpenRouterVoiceResponse {
  readonly error?: unknown;
  readonly choices?: readonly OpenRouterVoiceChoice[];
}

function objectProperty(value: unknown, property: string): unknown | undefined {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return value[property as keyof typeof value];
}

function providerErrorType(value: unknown): string | undefined {
  const error = objectProperty(value, "error") ?? value;
  const metadata = objectProperty(error, "metadata");
  const errorType = objectProperty(metadata, "error_type");
  return typeof errorType === "string" &&
    /^[a-z][a-z0-9_]{0,127}$/u.test(errorType)
    ? errorType
    : undefined;
}

function requestError(
  message: string,
  status: number,
  value: unknown,
): OpenRouterRequestError {
  const errorType = providerErrorType(value);
  return new OpenRouterRequestError({
    message,
    status,
    ...(errorType === undefined ? {} : { errorType }),
  });
}

function completionError(
  value: unknown,
  context: { readonly model: string; readonly responseSchema: string },
): Error {
  const code = objectProperty(value, "code");
  const status =
    typeof code === "number" &&
    Number.isInteger(code) &&
    code >= 400 &&
    code < 600
      ? code
      : undefined;
  const errorType = providerErrorType(value);
  const rawType = objectProperty(
    objectProperty(value, "metadata"),
    "error_type",
  );
  // A permanent or unknown typed error must not become retryable merely
  // because its lossy numeric code resembles a temporary failure.
  if (
    status !== undefined &&
    isRetryableVoiceProviderStatus(status) &&
    (rawType === undefined ||
      errorType === "rate_limit_exceeded" ||
      errorType === "provider_overloaded" ||
      errorType === "provider_unavailable" ||
      errorType === "server" ||
      errorType === "timeout")
  ) {
    return new VoiceProviderTemporaryResponseError(status, errorType);
  }
  L.warn("OpenRouter voice completion rejected", {
    ...context,
    source: "completion",
    status,
    errorType,
  });
  return new Error("OpenRouter voice completion failed");
}

function parseCompletionText(
  value: unknown,
  context: { readonly model: string; readonly responseSchema: string },
): string {
  const data = value as OpenRouterVoiceResponse;
  const choice = data.choices?.[0];
  if (data.error !== undefined) {
    throw completionError(data.error, context);
  }
  if (!choice) {
    throw new Error("OpenRouter voice response contained no choices");
  }
  if (choice.finish_reason === "error") {
    throw completionError(choice.error, context);
  }
  if (choice.finish_reason !== "stop") {
    const nativeReason =
      typeof choice.native_finish_reason === "string"
        ? ` (native: ${choice.native_finish_reason})`
        : "";
    const finishReason =
      typeof choice.finish_reason === "string"
        ? choice.finish_reason
        : "unknown";
    throw new Error(
      `OpenRouter voice completion finished with ${finishReason}${nativeReason}`,
    );
  }
  const content = choice.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter voice response contained invalid content");
  }
  return content.trim();
}

export async function generateOpenRouterVoice<T>(
  args: VoiceCompletionRequest & { readonly jsonSchema: VoiceJsonSchema },
  parseResponse: (content: string) => T,
  signal: AbortSignal,
): Promise<T | null> {
  const apiKey = optionalEnv("OPENROUTER_API_KEY");
  if (!apiKey) {
    return null;
  }

  // GPT Audio returns prompted JSON; strict validation belongs to the shared caller.
  const systemPrompt = `${args.systemPrompt}\nJSON schema: ${JSON.stringify(args.jsonSchema.schema)}`;
  const content =
    typeof args.content === "string"
      ? args.content
      : args.content.map((part) => {
          return part.type === "audio"
            ? { type: "input_audio", input_audio: part.audio }
            : part;
        });

  return await requestVoiceProvider(
    (requestSignal) => {
      return fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content },
          ],
          max_tokens: 16_384,
          modalities: ["text"],
          temperature: 0,
          store: false,
        }),
        signal: requestSignal,
      });
    },
    async (response) => {
      const responseBody = await readBoundedResponseText(
        response,
        OPENROUTER_VOICE_RESPONSE_MAX_BYTES,
      );
      signal.throwIfAborted();
      const parsedBody =
        responseBody.kind === "text"
          ? safeJsonParse(responseBody.text)
          : undefined;
      if (!response.ok) {
        const error = requestError(
          "OpenRouter voice request failed",
          response.status,
          parsedBody,
        );
        L.warn("OpenRouter voice request rejected", {
          model: args.model,
          responseSchema: args.jsonSchema.name,
          source: "http",
          status: error.status,
          errorType: error.errorType,
        });
        throw error;
      }
      if (parsedBody === undefined) {
        throw new Error("OpenRouter voice response was not valid JSON");
      }

      const content = parseCompletionText(parsedBody, {
        model: args.model,
        responseSchema: args.jsonSchema.name,
      });
      return parseResponse(content);
    },
    {
      provider: "openrouter",
      model: args.model,
      responseSchema: args.jsonSchema.name,
    },
    signal,
  );
}
