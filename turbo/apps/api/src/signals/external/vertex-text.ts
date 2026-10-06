import { z } from "zod";

import {
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  startUntrackedBestEffortCleanup,
} from "../utils";
import { gcpLlmAccessToken, gcpLlmConfiguration } from "./gcp-llm-auth";
import { gcpLlmTransportReason } from "./gcp-llm-transport";
import { VERTEX_MODELS, type VertexModel } from "./vertex-models";

/** Thinking and visible output share this budget. */
export const VERTEX_AUXILIARY_MAX_TOKENS = 2048;
const RESPONSE_MAX_BYTES = 256 * 1024;

export interface VertexTextMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface VertexTextTokens {
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

type VertexTextFailureReason =
  | "rate_limited"
  | "upstream_timeout"
  | "network"
  | "provider_unavailable"
  | "invalid_request"
  | "auth"
  | "output_truncated"
  | "unexpected_tool_calls"
  | "invalid_output";

export class VertexTextError extends Error {
  constructor(
    readonly reason: VertexTextFailureReason,
    readonly status?: number,
    readonly tokens: VertexTextTokens = {},
  ) {
    super("Google text generation failed");
    this.name = "VertexTextError";
  }
}

interface VertexTextOptions {
  readonly temperature?: number;
  readonly acceptTruncatedText?: boolean;
  /** Google supports JSON Schema directly; the feature still validates the result. */
  readonly responseJsonSchema?: Readonly<Record<string, unknown>>;
}

interface VertexTextGeneration {
  readonly text: string;
  readonly truncated: boolean;
  readonly tokens: VertexTextTokens;
}

const responseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      candidatesTokenCount: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      thoughtsTokenCount: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string(),
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
                thought: z.boolean().optional(),
                functionCall: z.unknown().optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
});

function parseGeneration(
  body: string,
  acceptTruncatedText: boolean,
): VertexTextGeneration {
  const parsed = responseSchema.safeParse(safeJsonParse(body));
  if (!parsed.success) {
    throw new VertexTextError("invalid_output");
  }
  const tokens: VertexTextTokens = {
    completionTokens: parsed.data.usageMetadata?.candidatesTokenCount,
    reasoningTokens: parsed.data.usageMetadata?.thoughtsTokenCount,
  };
  const candidate = parsed.data.candidates?.[0];
  if (
    parsed.data.promptFeedback?.blockReason ||
    !candidate ||
    parsed.data.candidates?.length !== 1
  ) {
    throw new VertexTextError("invalid_output", undefined, tokens);
  }
  const parts = candidate.content?.parts;
  if (
    parts?.some((part) => {
      return part.functionCall !== undefined;
    })
  ) {
    throw new VertexTextError("unexpected_tool_calls", undefined, tokens);
  }
  const truncated = candidate.finishReason === "MAX_TOKENS";
  if (truncated && !acceptTruncatedText) {
    throw new VertexTextError("output_truncated", undefined, tokens);
  }
  if (!truncated && candidate.finishReason !== "STOP") {
    throw new VertexTextError("invalid_output", undefined, tokens);
  }
  const text = parts
    ?.filter((part) => {
      return !part.thought;
    })
    .map((part) => {
      return part.text ?? "";
    })
    .join("")
    .trim();
  if (!text) {
    throw new VertexTextError(
      truncated ? "output_truncated" : "invalid_output",
      undefined,
      tokens,
    );
  }
  return { text, truncated, tokens };
}

function httpReason(status: number): VertexTextFailureReason {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 408 || status === 504) {
    return "upstream_timeout";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  return "invalid_request";
}

/** No OpenRouter credentials, fallback, payload logging, or implicit retries. */
export async function generateVertexTextWithUsage(
  model: VertexModel,
  messages: readonly VertexTextMessage[],
  maxTokens: number,
  options: VertexTextOptions | undefined,
  signal?: AbortSignal,
): Promise<VertexTextGeneration | null> {
  signal?.throwIfAborted();
  const configuration = gcpLlmConfiguration();
  if (!configuration) {
    return null;
  }
  // Bound generation even when the caller owns a long-lived background task.
  const deadline = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const assertActive = () => {
    signal?.throwIfAborted();
    if (deadline.aborted) {
      throw new VertexTextError("upstream_timeout");
    }
  };
  const selected = VERTEX_MODELS[model];
  const token = await onRejection(
    gcpLlmAccessToken(configuration, requestSignal),
    assertActive,
  );
  assertActive();
  const response = await onRejection(
    fetch(
      `https://${selected.host}/v1/projects/${configuration.project}/locations/${selected.location}/publishers/google/models/${selected.model}:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: messages
              .filter((message) => {
                return message.role === "system";
              })
              .map((message) => {
                return { text: message.content };
              }),
          },
          contents: messages
            .filter((message) => {
              return message.role !== "system";
            })
            .map((message) => {
              return {
                role: message.role === "assistant" ? "model" : "user",
                parts: [{ text: message.content }],
              };
            }),
          generationConfig: {
            ...selected.generationConfig,
            ...("temperature" in selected.generationConfig
              ? { temperature: options?.temperature ?? 0.3 }
              : {}),
            maxOutputTokens: maxTokens,
            ...(options?.responseJsonSchema === undefined
              ? {}
              : {
                  responseMimeType: "application/json",
                  responseJsonSchema: options.responseJsonSchema,
                }),
          },
        }),
        signal: requestSignal,
      },
    ),
    (error) => {
      assertActive();
      const reason = gcpLlmTransportReason(error);
      if (reason) {
        throw new VertexTextError(reason);
      }
    },
  );
  assertActive();
  if (!response.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new VertexTextError(httpReason(response.status), response.status);
  }
  const body = await onRejection(
    readBoundedResponseText(response, RESPONSE_MAX_BYTES),
    (error) => {
      assertActive();
      const reason = gcpLlmTransportReason(error);
      if (reason) {
        throw new VertexTextError(reason);
      }
    },
  );
  assertActive();
  if (body.kind !== "text") {
    throw new VertexTextError("invalid_output");
  }
  return parseGeneration(body.text, options?.acceptTruncatedText === true);
}

export async function generateVertexText(
  model: VertexModel,
  messages: readonly VertexTextMessage[],
  maxTokens: number,
  options: VertexTextOptions | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  return (
    (
      await generateVertexTextWithUsage(
        model,
        messages,
        maxTokens,
        options,
        signal,
      )
    )?.text ?? null
  );
}
