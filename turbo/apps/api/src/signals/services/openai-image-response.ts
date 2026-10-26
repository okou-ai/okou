import { accept, HttpStatusError } from "@okouai/connectors/accept";
import {
  array,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { settle, safeJsonParse } from "../utils";
import { logger } from "../../lib/log";

import type {
  ImageOptions,
  ImageProviderReferences,
  ParsedImageGeneration,
} from "./image-generation.service";

// Explicitly listed as an image-tool mainline model in the provider guide.
export const MAINLINE_MODEL = "gpt-4.1";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface OpenAiImageResponseError {
  readonly status: 400 | 502;
  readonly body: {
    readonly error: { readonly code: string; readonly message: string };
  };
}

export interface OpenAiImageMainModelUsage {
  /** Total main-model input, INCLUDING cachedInputTokens. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

const tokenCount = number().int().nonnegative();
const mainModelUsageSchema = object({
  input_tokens: tokenCount,
  input_tokens_details: object({ cached_tokens: tokenCount }),
  output_tokens: tokenCount,
  total_tokens: tokenCount,
}).refine((usage) => {
  return (
    usage.input_tokens_details.cached_tokens <= usage.input_tokens &&
    usage.total_tokens === usage.input_tokens + usage.output_tokens
  );
});

// Runtime-verified Responses ledger (Flare, 2026-10-22). This aggregate belongs
// to the single forced image tool call, not the enclosing mainline-model usage.
const imageToolUsageSchema = object({
  input_tokens: tokenCount,
  input_tokens_details: object({
    text_tokens: tokenCount,
    image_tokens: tokenCount,
  }),
  output_tokens: tokenCount.positive(),
  output_tokens_details: object({
    image_tokens: tokenCount.positive(),
    text_tokens: literal(0),
  }),
  total_tokens: tokenCount,
}).refine((usage) => {
  return (
    usage.input_tokens ===
      usage.input_tokens_details.text_tokens +
        usage.input_tokens_details.image_tokens &&
    usage.output_tokens === usage.output_tokens_details.image_tokens &&
    usage.total_tokens === usage.input_tokens + usage.output_tokens
  );
});
const toolUsageSchema = object({ image_gen: imageToolUsageSchema });

const imageSchema = object({
  type: literal("image_generation_call"),
  id: string().min(1),
  status: zEnum(["in_progress", "completed", "generating", "failed"]),
  result: string().nullable(),
  action: zEnum(["generate", "edit", "auto"]).nullish(),
  background: zEnum(["transparent", "opaque", "auto"]).nullish(),
  output_format: zEnum(["png", "webp", "jpeg"]).nullish(),
  quality: zEnum(["low", "medium", "high", "xhigh", "max", "auto"]).nullish(),
  revised_prompt: string().nullish(),
  size: string().nullish(),
  error: zUnknown().optional(),
});

const responseSchema = object({
  id: string().min(1),
  status: zEnum([
    "queued",
    "in_progress",
    "completed",
    "failed",
    "cancelled",
    "incomplete",
  ]),
  metadata: object({ generation_id: string().min(1).optional() }).nullish(),
  output: array(zUnknown()),
  usage: zUnknown().optional(),
  tool_usage: zUnknown().optional(),
  error: zUnknown().optional(),
});

export interface OpenAiImageResponse {
  readonly id: string;
  readonly status: zInfer<typeof responseSchema>["status"];
  readonly metadata: { readonly generation_id?: string };
  readonly image: zInfer<typeof imageSchema> | undefined;
  readonly imageUsage: zInfer<typeof imageToolUsageSchema> | undefined;
  /** Mainline model usage only; never includes or substitutes image-tool billing. */
  readonly mainModelUsage: OpenAiImageMainModelUsage | undefined;
  /** Sanitized public failure; provider error messages are never retained. */
  readonly error: OpenAiImageResponseError | undefined;
}

function providerError(): OpenAiImageResponseError {
  return {
    status: 502,
    body: {
      error: {
        code: "OPENAI_IMAGE_REQUEST_FAILED",
        message: "Image generation failed",
      },
    },
  };
}

function badResponse(): OpenAiImageResponseError {
  return {
    status: 502,
    body: {
      error: {
        code: "OPENAI_IMAGE_BAD_RESPONSE",
        message: "OpenAI returned invalid image response data or token usage",
      },
    },
  };
}

const providerFailureSchema = object({
  type: string().nullish(),
  code: string().nullish(),
  moderation_details: object({
    moderation_stage: zEnum(["input", "output", "unknown"]).optional(),
  }).nullish(),
});

function classifyFailure(
  status: number,
  error: unknown,
): OpenAiImageResponseError {
  const parsed = providerFailureSchema.safeParse(error);
  if (
    status !== 400 ||
    !parsed.success ||
    parsed.data.type !== "image_generation_user_error"
  ) {
    return providerError();
  }
  const failure = parsed.data;
  if (failure.code === "invalid_image_file") {
    return {
      status: 400,
      body: {
        error: {
          code: "GENERATION_INPUT_MEDIA_INVALID",
          message:
            "An input image could not be read by the generation provider.",
        },
      },
    };
  }
  if (failure.code === "moderation_blocked") {
    return failure.moderation_details?.moderation_stage === "output"
      ? {
          status: 400,
          body: {
            error: {
              code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
              message: "The generated image was blocked by the safety filter.",
            },
          },
        }
      : {
          status: 400,
          body: {
            error: {
              code: "GENERATION_INPUT_SAFETY_REJECTED",
              message:
                "The prompt or reference image was blocked by the safety filter.",
            },
          },
        };
  }
  return providerError();
}

async function readFailure(
  response: Response,
  signal: AbortSignal,
): Promise<OpenAiImageResponseError> {
  // Do not include the body in exceptions or logs: it can echo private prompts.
  // These statuses cannot establish whether a POST was accepted by the provider.
  if (
    response.status === 408 ||
    response.status >= 500 ||
    response.status < 400
  ) {
    throw new Error("OpenAI image response request outcome is uncertain");
  }
  const text = await response.text();
  signal.throwIfAborted();
  const body: unknown = safeJsonParse(text);
  const parsed = object({ error: zUnknown() }).safeParse(body);
  const diagnostic = object({
    error: object({
      code: zEnum([
        "model_not_found",
        "unsupported_parameter",
        "invalid_value",
        "missing_required_parameter",
        "rate_limit_exceeded",
        "insufficient_quota",
        "unrecognized",
      ]),
      param: zEnum([
        "model",
        "background",
        "store",
        "tools",
        "tools[0].model",
        "tools[0].action",
        "max_tool_calls",
        "tool_choice",
      ]).nullish(),
    }),
  }).safeParse(body);
  logger("OpenAiImageResponses").warn(
    "OpenAI image response request rejected",
    {
      providerStatus: response.status,
      providerErrorCode: diagnostic.success
        ? diagnostic.data.error.code
        : "unrecognized",
      providerParameter: diagnostic.success
        ? diagnostic.data.error.param
        : undefined,
    },
  );
  return classifyFailure(
    response.status,
    parsed.success ? parsed.data.error : undefined,
  );
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function submitOpenAiImageResponse(
  options: ImageOptions,
  references: ImageProviderReferences,
  apiKey: string,
  generationId: string,
  signal: AbortSignal,
): Promise<{ readonly id: string } | OpenAiImageResponseError> {
  const editing = references.sourceImageUrls.length > 0;
  const fetched = await settle(
    accept(
      fetch(RESPONSES_URL, {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          model: MAINLINE_MODEL,
          background: true,
          store: true,
          metadata: { generation_id: generationId },
          tool_choice: { type: "image_generation" },
          max_tool_calls: 1,
          tools: [
            {
              type: "image_generation",
              model: options.model,
              action: editing ? "edit" : "generate",
              size: options.size,
              quality: options.quality,
              background: options.background,
              output_format: options.outputFormat,
              output_compression: options.outputCompression,
              moderation: options.moderation,
              ...(editing && options.inputFidelity
                ? { input_fidelity: options.inputFidelity }
                : {}),
              ...(editing && references.maskImageUrl
                ? { input_image_mask: { image_url: references.maskImageUrl } }
                : {}),
            },
          ],
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: options.prompt },
                ...references.sourceImageUrls.map((imageUrl) => {
                  return {
                    type: "input_image",
                    image_url: imageUrl,
                    detail: "auto",
                  };
                }),
              ],
            },
          ],
        }),
      }),
      [200],
    ),
  );
  if (!fetched.ok) {
    if (!(fetched.error instanceof HttpStatusError)) {
      throw fetched.error;
    }
    return readFailure(fetched.error.response, signal);
  }
  const response = fetched.value;
  // JSON/transport/shape errors after POST remain uncertain: never resubmit.
  const body: unknown = await response.json();
  signal.throwIfAborted();
  const parsed = object({ id: string().min(1) }).safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "OpenAI image submission returned no response ID; outcome is uncertain",
    );
  }
  return parsed.data;
}

export async function deleteOpenAiImageResponse(
  responseId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await accept(
    fetch(`${RESPONSES_URL}/${encodeURIComponent(responseId)}`, {
      method: "DELETE",
      headers: headers(apiKey),
    }),
    [200, 404],
  );
  await response.arrayBuffer();
  signal.throwIfAborted();
}

function readMainlineUsage(
  value: unknown,
): OpenAiImageMainModelUsage | undefined {
  const parsed = mainModelUsageSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return {
    inputTokens: parsed.data.input_tokens,
    cachedInputTokens: parsed.data.input_tokens_details.cached_tokens,
    outputTokens: parsed.data.output_tokens,
  };
}

function responseFailure(error: unknown): OpenAiImageResponseError | undefined {
  return error ? classifyFailure(400, error) : undefined;
}

export async function retrieveOpenAiImageResponse(
  responseId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<OpenAiImageResponse | OpenAiImageResponseError> {
  const fetched = await settle(
    accept(
      fetch(`${RESPONSES_URL}/${encodeURIComponent(responseId)}`, {
        method: "GET",
        headers: headers(apiKey),
      }),
      [200],
    ),
  );
  if (!fetched.ok) {
    if (!(fetched.error instanceof HttpStatusError)) {
      throw fetched.error;
    }
    if (fetched.error.status === 429) {
      throw new Error(
        "OpenAI image response retrieval is temporarily unavailable",
      );
    }
    return readFailure(fetched.error.response, signal);
  }
  const response = fetched.value;
  const body: unknown = await response.json();
  signal.throwIfAborted();
  return readOpenAiImageResponse(body, responseId);
}

function readOpenAiImageResponse(
  body: unknown,
  responseId: string,
): OpenAiImageResponse | OpenAiImageResponseError {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.id !== responseId) {
    return badResponse();
  }
  const result = parsed.data;
  const images = result.output.filter((item) => {
    const type = object({ type: string() }).safeParse(item);
    return type.success && type.data.type === "image_generation_call";
  });
  if (images.length > 1) {
    return badResponse();
  }
  const image =
    images.length === 1 ? imageSchema.safeParse(images[0]) : undefined;
  if (image && !image.success) {
    return badResponse();
  }
  const mainModelUsage = readMainlineUsage(result.usage);
  const toolUsage = toolUsageSchema.safeParse(result.tool_usage);
  if (
    result.status === "completed" &&
    image?.success &&
    (!toolUsage.success || !mainModelUsage)
  ) {
    logger("OpenAiImageResponses").warn(
      "Completed image response has unverified tool accounting",
      {
        generationId: result.metadata?.generation_id,
        mainModelUsageAvailable: Boolean(mainModelUsage),
      },
    );
  }
  const imageResult = image?.success ? image.data : undefined;
  const failure = result.error ?? imageResult?.error;
  return {
    id: result.id,
    status: result.status,
    metadata: result.metadata ?? {},
    image: imageResult ? { ...imageResult, error: undefined } : undefined,
    imageUsage: toolUsage.success ? toolUsage.data.image_gen : undefined,
    mainModelUsage,
    error: responseFailure(failure),
  };
}

/** Materialize with the verified tool ledger; never substitute mainline tokens. */
export function parseOpenAiImageResponse(
  response: OpenAiImageResponse,
  options: ImageOptions,
): ParsedImageGeneration | OpenAiImageResponseError {
  if (response.error) {
    return response.error;
  }
  if (
    response.status !== "completed" ||
    response.image?.status !== "completed" ||
    !response.image.result
  ) {
    return badResponse();
  }
  const usage = response.imageUsage;
  if (!usage || !response.mainModelUsage) {
    return {
      status: 502,
      body: {
        error: {
          code: "OPENAI_IMAGE_USAGE_UNAVAILABLE",
          message: "OpenAI did not provide verified image-tool token usage",
        },
      },
    };
  }
  const imageBytes = Buffer.from(response.image.result, "base64");
  if (imageBytes.byteLength === 0) {
    return badResponse();
  }
  return {
    model: options.model,
    provider: "openai",
    imageBytes,
    revisedPrompt: response.image.revised_prompt ?? undefined,
    imageSize: response.image.size ?? options.size,
    quality: response.image.quality ?? options.quality,
    background: response.image.background ?? options.background,
    outputFormat: response.image.output_format ?? options.outputFormat,
    outputCompression: options.outputCompression,
    moderation: options.moderation,
    safetyTolerance: undefined,
    billing: [
      {
        category: "tokens.input.text",
        quantity: usage.input_tokens_details.text_tokens,
      },
      {
        category: "tokens.input.image",
        quantity: usage.input_tokens_details.image_tokens,
      },
      {
        category: "tokens.output.image",
        quantity: usage.output_tokens_details.image_tokens,
      },
    ],
    sourceUrl: undefined,
    seed: undefined,
    sourceImageUrls: options.sourceImageUrls,
    maskImageUrl: options.maskImageUrl,
    inputFidelity: options.inputFidelity,
    imagePromptStrength: undefined,
  };
}
