import { z } from "zod";

import { safeJsonParse } from "../utils";
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

const tokenCount = z.number().int().nonnegative();
const mainModelUsageSchema = z
  .object({
    input_tokens: tokenCount,
    input_tokens_details: z.object({ cached_tokens: tokenCount }),
    output_tokens: tokenCount,
  })
  .refine((usage) => {
    return usage.input_tokens_details.cached_tokens <= usage.input_tokens;
  });

const imageSchema = z.object({
  type: z.literal("image_generation_call"),
  id: z.string().min(1),
  status: z.enum(["in_progress", "completed", "generating", "failed"]),
  result: z.string().nullable(),
  action: z.enum(["generate", "edit", "auto"]).nullish(),
  background: z.enum(["transparent", "opaque", "auto"]).nullish(),
  output_format: z.enum(["png", "webp", "jpeg"]).nullish(),
  quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]).nullish(),
  revised_prompt: z.string().nullish(),
  size: z.string().nullish(),
  error: z.unknown().optional(),
});

const responseSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "queued",
    "in_progress",
    "completed",
    "failed",
    "cancelled",
    "incomplete",
  ]),
  metadata: z.object({ generation_id: z.string().min(1).optional() }).nullish(),
  output: z.array(z.unknown()),
  usage: mainModelUsageSchema.nullish(),
  error: z.unknown().optional(),
});

export interface OpenAiImageResponse {
  readonly id: string;
  readonly status: z.infer<typeof responseSchema>["status"];
  readonly metadata: { readonly generation_id?: string };
  readonly image: z.infer<typeof imageSchema> | undefined;
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

const providerFailureSchema = z.object({
  type: z.string().nullish(),
  code: z.string().nullish(),
  moderation_details: z
    .object({
      moderation_stage: z.enum(["input", "output", "unknown"]).optional(),
    })
    .nullish(),
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
  const parsed = z.object({ error: z.unknown() }).safeParse(body);
  const diagnostic = z
    .object({
      error: z.object({
        code: z.enum([
          "model_not_found",
          "unsupported_parameter",
          "invalid_value",
          "missing_required_parameter",
          "rate_limit_exceeded",
          "insufficient_quota",
          "unrecognized",
        ]),
        param: z
          .enum([
            "model",
            "background",
            "store",
            "tools",
            "tools[0].model",
            "tools[0].action",
            "max_tool_calls",
            "tool_choice",
          ])
          .nullish(),
      }),
    })
    .safeParse(body);
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
  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: headers(apiKey),
    signal,
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
  });
  if (!response.ok) {
    return readFailure(response, signal);
  }
  // JSON/transport/shape errors after POST remain uncertain: never resubmit.
  const body: unknown = await response.json();
  signal.throwIfAborted();
  const parsed = z.object({ id: z.string().min(1) }).safeParse(body);
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
  const response = await fetch(
    `${RESPONSES_URL}/${encodeURIComponent(responseId)}`,
    {
      method: "DELETE",
      headers: headers(apiKey),
      signal,
    },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error("OpenAI image response cleanup is temporarily unavailable");
  }
  await response.arrayBuffer();
  signal.throwIfAborted();
}

function responseFailure(error: unknown): OpenAiImageResponseError | undefined {
  return error ? classifyFailure(400, error) : undefined;
}

export async function retrieveOpenAiImageResponse(
  responseId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<OpenAiImageResponse | OpenAiImageResponseError> {
  const response = await fetch(
    `${RESPONSES_URL}/${encodeURIComponent(responseId)}`,
    {
      method: "GET",
      headers: headers(apiKey),
      signal,
    },
  );
  if (!response.ok) {
    // A transient GET is retrievable later, not a terminal generation failure.
    if (response.status === 429) {
      throw new Error(
        "OpenAI image response retrieval is temporarily unavailable",
      );
    }
    return readFailure(response, signal);
  }
  const body: unknown = await response.json();
  signal.throwIfAborted();
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success || parsed.data.id !== responseId) {
    return badResponse();
  }
  const result = parsed.data;
  const images = result.output.filter((item) => {
    const type = z.object({ type: z.string() }).safeParse(item);
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
  const usage = result.usage;
  if (result.status === "completed" && image?.success) {
    const rawImage = z.record(z.string(), z.unknown()).parse(images[0]);
    const rawResponse = z.record(z.string(), z.unknown()).parse(body);
    logger("OpenAiImageResponses").warn(
      "Completed image response accounting contract",
      {
        generationId: result.metadata?.generation_id,
        imageHasUsage: Object.hasOwn(rawImage, "usage"),
        responseHasToolUsage: Object.hasOwn(rawResponse, "tool_usage"),
        mainModelUsageAvailable: Boolean(usage),
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
    mainModelUsage: usage
      ? {
          inputTokens: usage.input_tokens,
          cachedInputTokens: usage.input_tokens_details.cached_tokens,
          outputTokens: usage.output_tokens,
        }
      : undefined,
    error: responseFailure(failure),
  };
}

/**
 * Materialize only once image-tool token accounting is established.
 *
 * The official OpenAPI ImageGenToolCall and installed OpenAI 7.19.0
 * ResponseOutputItem.ImageGenerationCall contain no usage field. ImageGenUsage
 * is documented for the Images API, not this Responses output item. Inferring
 * that schema's placement here, estimating from main-model usage, or billing
 * zero would silently mischarge users. A provider-verified usage contract is
 * required before this path may return ParsedImageGeneration.
 */
export function parseOpenAiImageResponse(
  response: OpenAiImageResponse,
  _options: ImageOptions,
): ParsedImageGeneration | OpenAiImageResponseError {
  if (response.error) {
    return response.error;
  }
  if (
    response.status !== "completed" ||
    !response.image?.result ||
    !response.mainModelUsage
  ) {
    return badResponse();
  }
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
