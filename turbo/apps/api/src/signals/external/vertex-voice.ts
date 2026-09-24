import { z } from "zod";

import { logger } from "../../lib/log";
import {
  onRejection,
  readBoundedResponseText,
  safeJsonParse,
  safeSync,
  startUntrackedBestEffortCleanup,
} from "../utils";
import { gcpLlmAccessToken, gcpLlmConfiguration } from "./gcp-llm-auth";
import {
  gcpLlmTransportReason,
  type GcpLlmTransportReason,
} from "./gcp-llm-transport";
import type { VoiceCompletionRequest } from "./voice-completion-types";
import { requestVoiceProvider } from "./voice-provider-request";

const L = logger("VertexVoice");
const MODELS = {
  "google/gemini-3.1-flash-lite": {
    model: "gemini-3.1-flash-lite",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" },
      temperature: 0,
      maxOutputTokens: 65_536,
    },
  },
  "google/gemini-3.8-flash": {
    model: "gemini-3.8-flash",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "LOW" },
      maxOutputTokens: 65_536,
    },
  },
} as const;
type VertexVoiceModel = keyof typeof MODELS;

/** Voice input is served only by Gemini 3.1 Flash-Lite on Vertex AI. */
export const VOICE_INPUT_MODEL =
  "google/gemini-3.1-flash-lite" satisfies VertexVoiceModel;

type VertexVoiceFailureReason =
  | GcpLlmTransportReason
  | "http"
  | "response_too_large"
  | "invalid_response"
  | "blocked"
  | "output_truncated"
  | "non_stop"
  | "empty_output"
  | "invalid_output";

export type VertexVoiceDiagnosticOwner = "provider" | "segment";

export interface VertexVoiceDiagnostics {
  readonly location?: string;
  readonly operation?: string;
  readonly promptTokens?: number;
  readonly candidateTokens?: number;
  readonly thoughtTokens?: number;
  readonly toolUsePromptTokens?: number;
  readonly cachedContentTokens?: number;
  readonly totalTokens?: number;
  readonly candidateCharacters?: number;
  readonly thoughtCharacters?: number;
  readonly providerModelVersion?: string;
}

export class VertexVoiceError extends Error {
  constructor(
    readonly status: number,
    readonly reason: VertexVoiceFailureReason,
    readonly diagnostics: VertexVoiceDiagnostics = {},
    readonly diagnosticOwner: VertexVoiceDiagnosticOwner = "provider",
  ) {
    super("Google voice request failed");
    this.name = "VertexVoiceError";
  }

  get temporary(): boolean {
    return this.reason === "network" || this.reason === "upstream_timeout";
  }
}

export function vertexVoiceDiagnosticFields(error: VertexVoiceError) {
  const diagnostics = error.diagnostics;
  return {
    ...(diagnostics.location === undefined
      ? {}
      : { location: diagnostics.location }),
    ...(diagnostics.operation === undefined
      ? {}
      : { operation: diagnostics.operation }),
    ...(diagnostics.promptTokens === undefined
      ? {}
      : { prompt_tokens: diagnostics.promptTokens }),
    ...(diagnostics.candidateTokens === undefined
      ? {}
      : { candidate_tokens: diagnostics.candidateTokens }),
    ...(diagnostics.thoughtTokens === undefined
      ? {}
      : { thought_tokens: diagnostics.thoughtTokens }),
    ...(diagnostics.toolUsePromptTokens === undefined
      ? {}
      : { tool_use_prompt_tokens: diagnostics.toolUsePromptTokens }),
    ...(diagnostics.cachedContentTokens === undefined
      ? {}
      : { cached_content_tokens: diagnostics.cachedContentTokens }),
    ...(diagnostics.totalTokens === undefined
      ? {}
      : { total_tokens: diagnostics.totalTokens }),
    ...(diagnostics.candidateCharacters === undefined
      ? {}
      : { candidate_chars: diagnostics.candidateCharacters }),
    ...(diagnostics.thoughtCharacters === undefined
      ? {}
      : { thought_chars: diagnostics.thoughtCharacters }),
    ...(diagnostics.providerModelVersion === undefined
      ? {}
      : { provider_model_version: diagnostics.providerModelVersion }),
  };
}

async function vertexIo<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await onRejection(pending, (error) => {
    signal.throwIfAborted();
    const reason = gcpLlmTransportReason(error);
    if (reason) {
      throw new VertexVoiceError(503, reason);
    }
  });
}

const responseSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.unknown().optional(),
  modelVersion: z.unknown().optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.string(),
        content: z
          .object({
            parts: z.array(
              z.object({ text: z.string(), thought: z.boolean().optional() }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
});

type VertexVoiceResponse = z.infer<typeof responseSchema>;

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined;
}

function safeModelVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value)
    ? value
    : undefined;
}

function responseDiagnostics(
  response: VertexVoiceResponse,
): VertexVoiceDiagnostics {
  const usage = response.usageMetadata;
  const parts = response.candidates?.[0]?.content?.parts;
  return {
    promptTokens: safeTokenCount(property(usage, "promptTokenCount")),
    candidateTokens: safeTokenCount(property(usage, "candidatesTokenCount")),
    thoughtTokens: safeTokenCount(property(usage, "thoughtsTokenCount")),
    toolUsePromptTokens: safeTokenCount(
      property(usage, "toolUsePromptTokenCount"),
    ),
    cachedContentTokens: safeTokenCount(
      property(usage, "cachedContentTokenCount"),
    ),
    totalTokens: safeTokenCount(property(usage, "totalTokenCount")),
    ...(parts === undefined
      ? {}
      : {
          candidateCharacters: parts.reduce((total, part) => {
            return total + (part.thought ? 0 : part.text.length);
          }, 0),
          thoughtCharacters: parts.reduce((total, part) => {
            return total + (part.thought ? part.text.length : 0);
          }, 0),
        }),
    providerModelVersion: safeModelVersion(response.modelVersion),
  };
}

function parseVertexResponse<T>(
  body: string,
  parseResponse: (content: string) => T,
): T {
  const parsed = responseSchema.safeParse(safeJsonParse(body));
  if (!parsed.success) {
    throw new VertexVoiceError(502, "invalid_response");
  }
  const diagnostics = responseDiagnostics(parsed.data);
  if (parsed.data.promptFeedback?.blockReason) {
    throw new VertexVoiceError(502, "blocked", diagnostics);
  }
  const candidate = parsed.data.candidates?.[0];
  if (!candidate || parsed.data.candidates?.length !== 1) {
    throw new VertexVoiceError(502, "invalid_response", diagnostics);
  }
  if (candidate.finishReason !== "STOP") {
    const reason =
      candidate.finishReason === "MAX_TOKENS"
        ? "output_truncated"
        : [
              "SAFETY",
              "RECITATION",
              "BLOCKLIST",
              "PROHIBITED_CONTENT",
              "SPII",
              "IMAGE_SAFETY",
            ].includes(candidate.finishReason)
          ? "blocked"
          : "non_stop";
    throw new VertexVoiceError(502, reason, diagnostics);
  }
  const text = candidate.content?.parts
    .filter((part) => {
      return !part.thought;
    })
    .map((part) => {
      return part.text;
    })
    .join("")
    .trim();
  if (!text) {
    throw new VertexVoiceError(502, "empty_output", diagnostics);
  }
  const result = safeSync(() => {
    return parseResponse(text);
  });
  if (!("ok" in result)) {
    throw new VertexVoiceError(502, "invalid_output", diagnostics);
  }
  return result.ok;
}

/** Voice-only native transport; other Google consumers keep their own routing. */
export async function generateVertexVoice<T>(
  args: VoiceCompletionRequest & {
    readonly model: VertexVoiceModel;
    readonly diagnosticOwner?: VertexVoiceDiagnosticOwner;
  },
  parseResponse: (content: string) => T,
  signal: AbortSignal,
): Promise<T | null> {
  const configuration = gcpLlmConfiguration();
  if (!configuration) {
    return null;
  }
  const model = MODELS[args.model];
  const parts =
    typeof args.content === "string"
      ? [{ text: args.content }]
      : args.content.map((part) => {
          return part.type === "audio"
            ? { inlineData: { mimeType: "audio/wav", data: part.audio.data } }
            : { text: part.text };
        });
  const schema = args.jsonSchema?.schema;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: args.systemPrompt }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      ...model.generationConfig,
      ...(schema && {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, property]) => {
              return [
                key,
                { type: "STRING", description: property.description },
              ];
            }),
          ),
          required: schema.required,
        },
      }),
    },
  });
  return await onRejection(
    requestVoiceProvider(
      async (requestSignal) => {
        const token = await gcpLlmAccessToken(configuration, requestSignal);
        requestSignal.throwIfAborted();
        return await vertexIo(
          fetch(
            `https://${model.host}/v1/projects/${configuration.project}/locations/${model.location}/publishers/google/models/${model.model}:generateContent`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body,
              signal: requestSignal,
            },
          ),
          requestSignal,
        );
      },
      async (response) => {
        signal.throwIfAborted();
        if (!response.ok) {
          if (response.body) {
            startUntrackedBestEffortCleanup(response.body.cancel());
          }
          throw new VertexVoiceError(response.status, "http");
        }
        const body = await vertexIo(
          readBoundedResponseText(
            response,
            args.jsonSchema ? 1024 * 1024 : 2 * 1024 * 1024,
          ),
          signal,
        );
        signal.throwIfAborted();
        if (body.kind !== "text") {
          throw new VertexVoiceError(502, "response_too_large");
        }
        return parseVertexResponse(body.text, parseResponse);
      },
      {
        provider: "vertex",
        model: args.model,
        responseSchema: args.jsonSchema?.name,
      },
      signal,
    ),
    (error) => {
      signal.throwIfAborted();
      if (error instanceof VertexVoiceError) {
        const ownedError = new VertexVoiceError(
          error.status,
          error.reason,
          {
            ...error.diagnostics,
            location: model.location,
            operation: args.jsonSchema?.name ?? "plain_text_polish",
          },
          args.diagnosticOwner ?? "provider",
        );
        if (ownedError.diagnosticOwner === "provider") {
          L.warn("Google voice request rejected", {
            model: args.model,
            status: ownedError.status,
            reason: ownedError.reason,
            ...vertexVoiceDiagnosticFields(ownedError),
          });
        }
        throw ownedError;
      }
    },
  );
}
