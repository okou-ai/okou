import type { MultimodalVoiceInputModelId } from "@okouai/api-contracts/contracts/voice-input-models";
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
type VertexVoiceModel = Exclude<
  MultimodalVoiceInputModelId,
  "openai/gpt-audio" | "openai/gpt-audio-mini"
>;
// New public multimodal selections must make an explicit routing decision.
const MODELS = {
  "google/gemini-2.5-flash-lite": {
    model: "gemini-2.5-flash-lite",
    location: "us-west1",
    host: "us-west1-aiplatform.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0,
      maxOutputTokens: 65_535,
    },
  },
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
  "google/gemini-3.6-flash": {
    model: "gemini-3.6-flash",
    location: "us",
    host: "aiplatform.us.rep.googleapis.com",
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" },
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
} as const satisfies Readonly<Record<VertexVoiceModel, unknown>>;

export function isVertexVoiceModel(
  model: MultimodalVoiceInputModelId,
): model is VertexVoiceModel {
  return Object.hasOwn(MODELS, model);
}

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

export class VertexVoiceError extends Error {
  constructor(
    readonly status: number,
    readonly reason: VertexVoiceFailureReason,
  ) {
    super("Google voice request failed");
    this.name = "VertexVoiceError";
  }

  get temporary(): boolean {
    return this.reason === "network" || this.reason === "upstream_timeout";
  }
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

function parseVertexResponse<T>(
  body: string,
  parseResponse: (content: string) => T,
): T {
  const parsed = responseSchema.safeParse(safeJsonParse(body));
  if (!parsed.success) {
    throw new VertexVoiceError(502, "invalid_response");
  }
  if (parsed.data.promptFeedback?.blockReason) {
    throw new VertexVoiceError(502, "blocked");
  }
  const candidate = parsed.data.candidates?.[0];
  if (!candidate || parsed.data.candidates?.length !== 1) {
    throw new VertexVoiceError(502, "invalid_response");
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
    throw new VertexVoiceError(502, reason);
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
    throw new VertexVoiceError(502, "empty_output");
  }
  const result = safeSync(() => {
    return parseResponse(text);
  });
  if (!("ok" in result)) {
    throw new VertexVoiceError(502, "invalid_output");
  }
  return result.ok;
}

/** Voice-only native transport; other Google consumers keep their own routing. */
export async function generateVertexVoice<T>(
  args: VoiceCompletionRequest & { readonly model: VertexVoiceModel },
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
        L.warn("Google voice request rejected", {
          model: args.model,
          location: model.location,
          operation: args.jsonSchema?.name ?? "plain_text_polish",
          status: error.status,
          reason: error.reason,
        });
      }
    },
  );
}
