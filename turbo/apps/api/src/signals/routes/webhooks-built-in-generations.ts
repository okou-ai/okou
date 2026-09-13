import {
  INTRO_VIDEO_RENDER_TASK,
  recordIntroVideoRenderCallback$,
  loadIntroVideoRenderJob$,
} from "../services/intro-video-render.service";
import { command } from "ccstate";
import {
  webhookBuiltInGenerationBytePlusContract,
  webhookBuiltInGenerationFalContract,
  webhookBuiltInGenerationHeyGenContract,
  webhookBuiltInGenerationJoggAiContract,
  webhookBuiltInGenerationMiniMaxContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse, tapError } from "../utils";
import {
  downloadFalImage,
  getFalImageBillableUnits,
  getMissingImagePricing,
  imagePricing$,
  parseFalImageResult,
  parseImageOptions,
  recordGeneratedImage$,
  type ImageOptions,
  type ImagePricing,
} from "../services/image-generation.service";
import {
  builtInGenerationPublicBrand,
  builtInGenerationIsPrivate,
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJobByProviderJobId$,
  getBuiltInGenerationWebhookJob$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "../services/built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/run-built-in-admission.service";
import {
  verifyBuiltInGenerationProviderWebhookToken,
  verifyJoggAiWebhookSignature,
} from "../services/built-in-generation-provider-webhooks.service";
import {
  bytePlusBuiltInGenerationError,
  downloadBytePlusVideo,
  downloadFalVideo,
  downloadMiniMaxVideo,
  getMissingVideoPricing,
  miniMaxBuiltInGenerationError,
  parseBytePlusVideoResult,
  parseFalVideoResult,
  parseMiniMaxVideoResult,
  parseVideoOptions,
  recordGeneratedVideo$,
  type VideoPricing,
  videoPricing$,
} from "../services/video-generation.service";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import {
  avatarVideoPricing$,
  downloadJoggAiAvatarVideo,
  isAvatarVideoErrorResponse,
  parseAvatarVideoOptions,
  parseJoggAiWebhookPayload,
  recordGeneratedAvatarVideo$,
} from "../services/avatar-video.service";
import {
  downloadHeyGenAvatarVideo,
  getHeyGenAvatarVideoStatus,
  isHeyGenErrorResponse,
  parseHeyGenVideoAgentCallback,
  type HeyGenAvatarVideoStatus,
} from "../services/heygen.service";
import {
  reconcileIntroVideoAgentJob$,
  loadIntroVideoAgentJob$,
  recordIntroVideoAgentIdentity$,
} from "../services/intro-video-agent.service";
import {
  introVideoPresenterPricing$,
  isIntroVideoPresenterErrorResponse,
  parseIntroVideoPresenterOptions,
  parsedIntroVideoPresenterGeneration,
  recordGeneratedIntroVideoPresenter$,
} from "../services/intro-video-presenter.service";

const L = logger("BuiltInGenerationWebhooks");

const falWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationFalContract.post,
);
const falWebhookQuery$ = queryOf(webhookBuiltInGenerationFalContract.post);
const bytePlusWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationBytePlusContract.post,
);
const bytePlusWebhookQuery$ = queryOf(
  webhookBuiltInGenerationBytePlusContract.post,
);
const miniMaxWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationMiniMaxContract.post,
);
const miniMaxWebhookQuery$ = queryOf(
  webhookBuiltInGenerationMiniMaxContract.post,
);
const heyGenWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationHeyGenContract.post,
);
const heyGenWebhookQuery$ = queryOf(
  webhookBuiltInGenerationHeyGenContract.post,
);
interface GenerationErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

type ProviderWebhookResponse =
  | {
      readonly status: 200;
      readonly body: "OK";
    }
  | {
      readonly status: 400 | 401 | 503;
      readonly body: {
        readonly error: string;
      };
    };

type MiniMaxWebhookResponse =
  | ProviderWebhookResponse
  | {
      readonly status: 200;
      readonly body: { readonly challenge: string };
    };

function okResponse(): ProviderWebhookResponse {
  return { status: 200, body: "OK" };
}

function jsonError(
  message: string,
  status: 400 | 401 | 503,
): ProviderWebhookResponse {
  return { status, body: { error: message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorResponse(value: unknown): value is GenerationErrorResponse {
  if (!isRecord(value) || !isRecord(value.body)) {
    return false;
  }
  return isRecord(value.body.error);
}

function admissionForJob(
  job: BuiltInGenerationWebhookJob,
): RunBuiltInAdmission | null {
  const internal = readBuiltInGenerationRequestInternal(job.request);
  return internal.admissionId ? { id: internal.admissionId } : null;
}

const completeAdmissionForJob$ = command(
  async (
    { set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly status: "completed" | "failed";
    },
  ): Promise<void> => {
    await set(completeRunBuiltInAdmission$, {
      admission: admissionForJob(args.job),
      status: args.status,
    });
  },
);

function parseJobImageOptions(job: BuiltInGenerationWebhookJob): ImageOptions {
  const options = parseImageOptions(job.request);
  if (isErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function parseJobVideoOptions(job: BuiltInGenerationWebhookJob) {
  const options = parseVideoOptions(job.request);
  if (isErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function parseJobAvatarVideoOptions(job: BuiltInGenerationWebhookJob) {
  const options = parseAvatarVideoOptions(job.request);
  if (isAvatarVideoErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function parseJobIntroVideoPresenterOptions(job: BuiltInGenerationWebhookJob) {
  const options = parseIntroVideoPresenterOptions(job.request);
  if (isIntroVideoPresenterErrorResponse(options)) {
    throw new Error(options.body.error.message);
  }
  return options;
}

function failError(message: string, code = "INTERNAL_SERVER_ERROR") {
  return { message, code };
}

function activeImagePricing(
  pricing: ImagePricing,
  options: ImageOptions,
): ImagePricing | GenerationErrorResponse {
  const missing = getMissingImagePricing(pricing, options.model);
  if (missing.length > 0) {
    return {
      status: 503,
      body: {
        error: {
          message: "Image generation pricing is not configured",
          code: "NOT_CONFIGURED",
        },
      },
    };
  }
  return pricing;
}

function activeVideoPricing(
  pricing: VideoPricing,
  job: BuiltInGenerationWebhookJob,
): VideoPricing | GenerationErrorResponse {
  const options = parseJobVideoOptions(job);
  if (getMissingVideoPricing(pricing, options).length > 0) {
    return {
      status: 503,
      body: {
        error: {
          message: "Video generation pricing is not configured",
          code: "NOT_CONFIGURED",
        },
      },
    };
  }
  return pricing;
}

interface FalWebhookPayload {
  readonly status: string | undefined;
  readonly body: unknown;
}

function falPayloadBody(payload: unknown): FalWebhookPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  const body =
    isRecord(payload.payload) || Array.isArray(payload.payload)
      ? payload.payload
      : isRecord(payload.data) || Array.isArray(payload.data)
        ? payload.data
        : isRecord(payload.response) || Array.isArray(payload.response)
          ? payload.response
          : payload;
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    body,
  };
}

const FAL_OUTPUT_SAFETY_FILTER_MESSAGE =
  "The generated image was blocked by the safety filter.";
const FAL_INPUT_SAFETY_FILTER_MESSAGE =
  "The content could not be processed because it contained material flagged by a content checker.";
const FAL_INPUT_MEDIA_DOWNLOAD_MESSAGE =
  "Failed to download the file. Please check if the URL is accessible and try again.";
const FAL_INPUT_MEDIA_LOAD_MESSAGE =
  "Failed to load the image. Please ensure the image file is not corrupted and is in a supported format.";
const FAL_INVALID_IMAGE_URL_SCHEME_MESSAGES = [
  "Value error, Invalid URL scheme ':' in image URL. Only http://, https://, and data: URLs are supported. Browser-only URLs like blob: cannot be used.",
  "Value error, Invalid URL scheme 'file:' in image URL. Only http://, https://, and data: URLs are supported. Browser-only URLs like blob: cannot be used.",
] as const;
const FAL_INVALID_REQUEST_MESSAGE =
  "Could not generate images with the given prompts and images. Please try again with different inputs.";
const FAL_INVALID_ASPECT_RATIO_MESSAGE =
  "Input should be 'auto', '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16', '4:1', '1:4', '8:1' or '1:8'";
const FAL_MISSING_FIELD_MESSAGE = "Field required";
const FAL_PROMPT_TOO_SHORT_MESSAGE = "String should have at least 3 characters";
const FAL_DOWNSTREAM_UNAVAILABLE_MESSAGE = "Downstream service unavailable";
const FAL_DOWNSTREAM_ERROR_MESSAGE = "Downstream service error";

type FalGenerationFailureRetryPolicy =
  | "manual_once"
  | "after_input_change"
  | "retry_once";

interface FalGenerationFailure {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
  readonly retryPolicy: FalGenerationFailureRetryPolicy;
  /** A failure the caller resolves by changing the request, not an operator. */
  readonly userInput: boolean;
}

function normalizeFalFailureMessage(message: string): string {
  return message.trim().replace(/\s+/gu, " ");
}

interface FalFailureDiagnostic {
  readonly message: string;
  readonly providerErrorType: string | undefined;
  readonly location: readonly (string | number)[] | undefined;
}

function falFailureDetailDiagnostics(detail: unknown): FalFailureDiagnostic[] {
  if (typeof detail === "string") {
    return [
      {
        message: normalizeFalFailureMessage(detail),
        providerErrorType: undefined,
        location: undefined,
      },
    ];
  }
  const entries = Array.isArray(detail) ? detail : [detail];
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.msg !== "string") {
      return [];
    }
    const location =
      Array.isArray(entry.loc) &&
      entry.loc.every((segment) => {
        return typeof segment === "string" || typeof segment === "number";
      })
        ? entry.loc
        : undefined;
    return [
      {
        message: normalizeFalFailureMessage(entry.msg),
        providerErrorType:
          typeof entry.type === "string" ? entry.type : undefined,
        location,
      },
    ];
  });
}

interface FalStructuredFailureRule {
  readonly providerErrorType: string;
  readonly message: string;
  readonly locations: readonly string[];
  readonly retryPolicy: Exclude<FalGenerationFailureRetryPolicy, "manual_once">;
  readonly error: FalGenerationFailure["error"];
  readonly userInput: boolean;
}

// These tuples are an allowlist of sanitized diagnostics observed in Fal's
// webhook contract. Keep all three fields exact: provider type alone is not a
// safe classifier because content_policy_violation is used for both input and
// generated-output moderation.
const FAL_STRUCTURED_FAILURE_RULES: readonly FalStructuredFailureRule[] = [
  {
    providerErrorType: "content_policy_violation",
    message: FAL_INPUT_SAFETY_FILTER_MESSAGE,
    locations: ["body.prompt", "body.image"],
    retryPolicy: "after_input_change",
    error: {
      message:
        "The prompt or reference image was blocked by the safety filter.",
      code: "GENERATION_INPUT_SAFETY_REJECTED",
    },
    userInput: true,
  },
  {
    providerErrorType: "file_download_error",
    message: FAL_INPUT_MEDIA_DOWNLOAD_MESSAGE,
    locations: [
      "body.image_urls",
      "body.input.image_urls",
      "body.image_url",
      "body.input.image_url",
    ],
    retryPolicy: "after_input_change",
    error: {
      message:
        "An input image could not be downloaded by the generation provider.",
      code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
    },
    userInput: true,
  },
  {
    providerErrorType: "image_load_error",
    message: FAL_INPUT_MEDIA_LOAD_MESSAGE,
    locations: ["body.image_urls", "body.input.image_urls", "body.image_url"],
    retryPolicy: "after_input_change",
    error: {
      message: "An input image could not be read by the generation provider.",
      code: "GENERATION_INPUT_MEDIA_INVALID",
    },
    userInput: true,
  },
  ...FAL_INVALID_IMAGE_URL_SCHEME_MESSAGES.map(
    (message): FalStructuredFailureRule => {
      return {
        providerErrorType: "value_error",
        message,
        locations: ["body.image_urls"],
        retryPolicy: "after_input_change",
        error: {
          message:
            "An input image could not be downloaded by the generation provider.",
          code: "GENERATION_INPUT_MEDIA_UNREACHABLE",
        },
        userInput: true,
      };
    },
  ),
  {
    providerErrorType: "invalid_request",
    message: FAL_INVALID_REQUEST_MESSAGE,
    locations: ["prompt"],
    retryPolicy: "after_input_change",
    error: {
      message: "The image generation request contains invalid parameters.",
      code: "GENERATION_INVALID_PARAMETERS",
    },
    userInput: true,
  },
  {
    providerErrorType: "literal_error",
    message: FAL_INVALID_ASPECT_RATIO_MESSAGE,
    locations: ["body.aspect_ratio"],
    retryPolicy: "after_input_change",
    error: {
      message: "The image generation request contains invalid parameters.",
      code: "GENERATION_INVALID_PARAMETERS",
    },
    userInput: true,
  },
  {
    providerErrorType: "missing",
    message: FAL_MISSING_FIELD_MESSAGE,
    locations: ["body.image_urls"],
    retryPolicy: "after_input_change",
    error: {
      message: "The image generation request contains invalid parameters.",
      code: "GENERATION_INVALID_PARAMETERS",
    },
    userInput: true,
  },
  {
    providerErrorType: "string_too_short",
    message: FAL_PROMPT_TOO_SHORT_MESSAGE,
    locations: ["body.prompt"],
    retryPolicy: "after_input_change",
    error: {
      message: "The image generation request contains invalid parameters.",
      code: "GENERATION_INVALID_PARAMETERS",
    },
    userInput: true,
  },
  {
    providerErrorType: "downstream_service_unavailable",
    message: FAL_DOWNSTREAM_UNAVAILABLE_MESSAGE,
    locations: ["body"],
    retryPolicy: "retry_once",
    error: {
      message: "The image generation provider is temporarily unavailable.",
      code: "GENERATION_PROVIDER_UNAVAILABLE",
    },
    userInput: false,
  },
  {
    providerErrorType: "downstream_service_error",
    message: FAL_DOWNSTREAM_ERROR_MESSAGE,
    locations: ["body"],
    retryPolicy: "retry_once",
    error: {
      message: "The image generation provider is temporarily unavailable.",
      code: "GENERATION_PROVIDER_UNAVAILABLE",
    },
    userInput: false,
  },
];

function falFailureLocationMatches(
  location: readonly (string | number)[],
  expected: string,
): boolean {
  const expectedSegments = expected.split(".");
  return (
    location.length >= expectedSegments.length &&
    expectedSegments.every((segment, index) => {
      return location[index] === segment;
    }) &&
    location.slice(expectedSegments.length).every((segment) => {
      return typeof segment === "number";
    })
  );
}

function falGenerationFailure(
  type: BuiltInGenerationWebhookJob["type"],
  payload: FalWebhookPayload,
): FalGenerationFailure {
  const diagnostics = isRecord(payload.body)
    ? falFailureDetailDiagnostics(payload.body.detail)
    : [];
  const outputSafetyBlocked =
    type === "image" &&
    diagnostics.some((diagnostic) => {
      return (
        diagnostic.message ===
        normalizeFalFailureMessage(FAL_OUTPUT_SAFETY_FILTER_MESSAGE)
      );
    });
  if (outputSafetyBlocked) {
    return {
      error: {
        message: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
        code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
      },
      retryPolicy: "manual_once",
      userInput: true,
    };
  }
  if (type === "image") {
    for (const diagnostic of diagnostics) {
      const diagnosticLocation = diagnostic.location;
      const rule = FAL_STRUCTURED_FAILURE_RULES.find((candidate) => {
        return (
          candidate.providerErrorType === diagnostic.providerErrorType &&
          normalizeFalFailureMessage(candidate.message) ===
            diagnostic.message &&
          diagnosticLocation !== undefined &&
          candidate.locations.some((location) => {
            return falFailureLocationMatches(diagnosticLocation, location);
          })
        );
      });
      if (rule) {
        return {
          error: rule.error,
          retryPolicy: rule.retryPolicy,
          userInput: rule.userInput,
        };
      }
    }
  }
  if (type !== "image") {
    return {
      error: failError("Generation failed"),
      retryPolicy: "retry_once",
      userInput: false,
    };
  }
  return {
    error: {
      message: "Image generation failed.",
      code: "GENERATION_FAILED",
    },
    retryPolicy: "retry_once",
    userInput: false,
  };
}

function bytePlusPayloadBody(payload: unknown): {
  readonly status: string | undefined;
  readonly body: unknown;
} | null {
  if (!isRecord(payload)) {
    return null;
  }
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    body: payload,
  };
}

function miniMaxPayloadBody(payload: unknown): {
  readonly status: string;
  readonly body: Record<string, unknown>;
} | null {
  if (!isRecord(payload) || !isRecord(payload.task)) {
    return null;
  }
  const status = payload.task.status;
  if (typeof status !== "string" || status.length === 0) {
    return null;
  }
  return { status, body: payload.task };
}

const PROVIDER_FAILURE_DETAIL_KEYS = [
  "reason",
  "failure_reason",
  "failureReason",
  "error",
  "error_message",
  "errorMessage",
  "message",
  "msg",
  "detail",
  "description",
  "status_message",
  "statusMessage",
  "err_msg",
  "code",
  "error_code",
  "errorCode",
  "logs",
] as const;

function providerFailureLogKey(key: string): string {
  switch (key) {
    case "failure_reason": {
      return "failureReason";
    }
    case "error_message": {
      return "errorMessage";
    }
    case "err_msg": {
      return "errorMessage";
    }
    case "msg": {
      return "message";
    }
    case "status_message": {
      return "statusMessage";
    }
    case "error_code": {
      return "errorCode";
    }
    default: {
      return key;
    }
  }
}

function truncateProviderFailureDetail(value: string): string {
  const maxLength = 1000;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

const MAX_PROVIDER_FAILURE_DETAIL_DEPTH = 5;

function scalarProviderFailureDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed
      ? truncateProviderFailureDetail(redactPresignedUrls(trimmed))
      : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function stringifyProviderFailureDetail(
  value: unknown,
  depth = 0,
): string | undefined {
  const scalar = scalarProviderFailureDetail(value);
  if (scalar) {
    return scalar;
  }
  if (depth >= MAX_PROVIDER_FAILURE_DETAIL_DEPTH) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        return stringifyProviderFailureDetail(item, depth + 1);
      })
      .filter((item): item is string => {
        return Boolean(item);
      })
      .join("\n");
    return text ? truncateProviderFailureDetail(text) : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of PROVIDER_FAILURE_DETAIL_KEYS) {
    const detail = stringifyProviderFailureDetail(value[key], depth + 1);
    if (detail) {
      return detail;
    }
  }
  // Deliberately no JSON.stringify fallback: an unrecognized object is the
  // provider echoing our request back, and serializing it put user prompts and
  // reference image URLs into production logs.
  return undefined;
}

export function providerFailureDetailsForLog(
  payload: unknown,
): Record<string, string> {
  if (!isRecord(payload)) {
    return {};
  }
  const details: Record<string, string> = {};
  for (const source of [
    payload,
    payload.payload,
    payload.data,
    payload.response,
  ]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const key of PROVIDER_FAILURE_DETAIL_KEYS) {
      const value = stringifyProviderFailureDetail(source[key]);
      if (value) {
        details[providerFailureLogKey(key)] ??= value;
      }
    }
  }
  return details;
}

const handleFalImageCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobImageOptions(args.job);
    const falResult = parseFalImageResult(args.payload);
    if (isErrorResponse(falResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const falBillableUnits = await getFalImageBillableUnits(
      options,
      readBuiltInGenerationRequestInternal(args.job.request)
        .providerResponseUrl,
      env("FAL_KEY"),
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(falBillableUnits)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falBillableUnits.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadFalImage(
      falResult,
      options,
      falBillableUnits,
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const imagePricing = await get(imagePricing$);
    signal.throwIfAborted();
    const pricing = activeImagePricing(imagePricing, options);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedImage$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "image",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleBytePlusVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobVideoOptions(args.job);
    const videoPricing = await get(videoPricing$);
    signal.throwIfAborted();
    const pricing = activeVideoPricing(videoPricing, args.job);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const bytePlusResult = parseBytePlusVideoResult(args.payload);
    if (isErrorResponse(bytePlusResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: bytePlusResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadBytePlusVideo(
      bytePlusResult,
      options,
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "video",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleMiniMaxVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobVideoOptions(args.job);
    const miniMaxResult = parseMiniMaxVideoResult(args.payload);
    if (isErrorResponse(miniMaxResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: miniMaxResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    const videoPricing = await get(videoPricing$);
    signal.throwIfAborted();
    const pricing = activeVideoPricing(videoPricing, args.job);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    const generation = await downloadMiniMaxVideo(
      miniMaxResult,
      options,
      signal,
    );
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }

    const result = await set(
      recordGeneratedVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "video",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleFalVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobVideoOptions(args.job);
    const videoPricing = await get(videoPricing$);
    signal.throwIfAborted();
    const pricing = activeVideoPricing(videoPricing, args.job);
    if (isErrorResponse(pricing)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: pricing.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const falResult = parseFalVideoResult(
      args.payload,
      readBuiltInGenerationRequestInternal(args.job.request).providerJobId,
    );
    if (isErrorResponse(falResult)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: falResult.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadFalVideo(falResult, options, signal);
    signal.throwIfAborted();
    if (isErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "video",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleJoggAiAvatarVideoCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly payload: Extract<
        ReturnType<typeof parseJoggAiWebhookPayload>,
        { readonly kind: "completed" }
      >;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobAvatarVideoOptions(args.job);
    const pricing = await get(avatarVideoPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.job.id,
          error: failError(
            "JoggAI avatar video pricing is not configured",
            "NOT_CONFIGURED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const generation = await downloadJoggAiAvatarVideo(
      args.payload,
      options,
      signal,
    );
    signal.throwIfAborted();
    if (isAvatarVideoErrorResponse(generation)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: generation.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedAvatarVideo$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation,
        usageIdempotency: {
          generationId: args.job.id,
          scope: "avatar-video",
        },
      },
      signal,
    );
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    signal.throwIfAborted();
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const handleHeyGenIntroVideoPresenterCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: BuiltInGenerationWebhookJob;
      readonly status: Extract<
        HeyGenAvatarVideoStatus,
        { readonly kind: "completed" }
      >;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = parseJobIntroVideoPresenterOptions(args.job);
    if (!args.job.runId) {
      throw new Error("Expected a run-bound Intro Video presenter job");
    }
    const pricing = await get(introVideoPresenterPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: args.job.id,
          error: failError(
            "HeyGen Intro Video presenter pricing is not configured",
            "NOT_CONFIGURED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const downloaded = await downloadHeyGenAvatarVideo(args.status, signal);
    if (isHeyGenErrorResponse(downloaded)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: downloaded.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, {
        job: args.job,
        status: "failed",
      });
      signal.throwIfAborted();
      return;
    }
    const result = await set(
      recordGeneratedIntroVideoPresenter$,
      {
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        pricing,
        generation: parsedIntroVideoPresenterGeneration({
          ...downloaded,
          options,
        }),
        usageIdempotency: {
          generationId: args.job.id,
          scope: "intro-video-presenter",
        },
      },
      signal,
    );
    await set(
      completeBuiltInGenerationJob$,
      { generationId: args.job.id, result },
      signal,
    );
    await set(completeAdmissionForJob$, {
      job: args.job,
      status: "completed",
    });
    signal.throwIfAborted();
  },
);

const postFalBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const params = get(falWebhookPathParams$);
    const query = get(falWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "fal",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("Fal built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    const payload = falPayloadBody(parsed);
    if (!payload) {
      L.warn("Fal built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }
    L.debug("Fal built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("Fal built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    const status = payload.status?.toUpperCase();
    if (status === "ERROR" || status === "FAILED") {
      const failure = falGenerationFailure(job.type, payload);
      const transitioned = await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: failure.error,
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      // A failure the caller caused is already carried by the job's public
      // error code; only a provider-side failure is actionable by an operator.
      if (transitioned && !failure.userInput) {
        L.warn("Fal built-in generation webhook reported failed generation", {
          provider: "fal",
          generationId: job.id,
          type: job.type,
          providerStatus: status,
          publicErrorCode: failure.error.code,
          retryPolicy: failure.retryPolicy,
        });
      }
      return okResponse();
    }

    if (job.type === "image") {
      await set(
        handleFalImageCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("Fal built-in generation image webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }
    if (job.type === "video") {
      await set(
        handleFalVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("Fal built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }
    L.debug("Fal built-in generation webhook ignored unsupported job type", {
      generationId: job.id,
      type: job.type,
      visualKey: query.visualKey,
    });
    return okResponse();
  },
);

const postBytePlusBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const params = get(bytePlusWebhookPathParams$);
    const query = get(bytePlusWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "byteplus",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("BytePlus built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    const payload = bytePlusPayloadBody(parsed);
    if (!payload) {
      L.warn("BytePlus built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }

    const status = payload.status?.toLowerCase();
    L.debug("BytePlus built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });

    if (status === "queued" || status === "running") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("BytePlus built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (status === "failed" || status === "expired") {
      const failureDetails = providerFailureDetailsForLog(parsed);
      L.warn(
        "BytePlus built-in generation webhook reported failed generation",
        {
          generationId: job.id,
          type: job.type,
          status: payload.status,
          visualKey: query.visualKey,
          ...failureDetails,
        },
      );
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: bytePlusBuiltInGenerationError(parsed),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    if (status && status !== "succeeded") {
      L.debug("BytePlus built-in generation webhook ignored status", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (job.type === "video") {
      await set(
        handleBytePlusVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("BytePlus built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    L.debug(
      "BytePlus built-in generation webhook ignored unsupported job type",
      {
        generationId: job.id,
        type: job.type,
        visualKey: query.visualKey,
      },
    );
    return okResponse();
  },
);

const postMiniMaxBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<MiniMaxWebhookResponse> => {
    const params = get(miniMaxWebhookPathParams$);
    const query = get(miniMaxWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "minimax",
        generationId: params.generationId,
        visualKey: query.visualKey,
        token: query.token,
      })
    ) {
      L.warn("MiniMax built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid token", 401);
    }

    const request = get(request$);
    const rawBody = await request.text();
    signal.throwIfAborted();
    const parsed = safeJsonParse(rawBody);
    if (isRecord(parsed) && typeof parsed.challenge === "string") {
      return { status: 200, body: { challenge: parsed.challenge } };
    }

    const payload = miniMaxPayloadBody(parsed);
    if (!payload) {
      L.warn("MiniMax built-in generation webhook rejected invalid payload", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return jsonError("Invalid payload", 400);
    }

    const status = payload.status.toLowerCase();
    L.debug("MiniMax built-in generation webhook received", {
      generationId: params.generationId,
      visualKey: query.visualKey,
      status: payload.status,
    });
    if (status === "queued" || status === "running") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("MiniMax built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (status === "failed" || status === "cancelled" || status === "expired") {
      const failureDetails = providerFailureDetailsForLog(payload.body);
      L.warn("MiniMax built-in generation webhook reported failed generation", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
        ...failureDetails,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: miniMaxBuiltInGenerationError(payload.body),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    if (status !== "succeeded") {
      L.debug("MiniMax built-in generation webhook ignored status", {
        generationId: job.id,
        type: job.type,
        status: payload.status,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    if (job.type === "video") {
      await set(
        handleMiniMaxVideoCompletion$,
        { job, payload: payload.body },
        signal,
      );
      L.debug("MiniMax built-in generation video webhook processed", {
        generationId: job.id,
        visualKey: query.visualKey,
      });
      return okResponse();
    }

    L.debug(
      "MiniMax built-in generation webhook ignored unsupported job type",
      {
        generationId: job.id,
        type: job.type,
        visualKey: query.visualKey,
      },
    );
    return okResponse();
  },
);

const postJoggAiBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const webhookSecret = env("JOGGAI_WEBHOOK_SECRET");
    if (!webhookSecret) {
      L.error("JoggAI webhook signing secret is not configured");
      return jsonError("Webhook is not configured", 503);
    }

    const request = get(request$);
    const signature = request.header("x-webhook-signature");
    const rawBody = await request.text();
    signal.throwIfAborted();
    if (
      !signature ||
      !verifyJoggAiWebhookSignature({
        body: rawBody,
        secret: webhookSecret,
        signature,
      })
    ) {
      L.warn("JoggAI built-in generation webhook rejected invalid signature");
      return jsonError("Invalid signature", 401);
    }

    const parsed = safeJsonParse(rawBody);
    const payload = parseJoggAiWebhookPayload(parsed);
    if (isAvatarVideoErrorResponse(payload)) {
      L.warn("JoggAI built-in generation webhook rejected invalid payload", {
        reason: payload.body.error.message,
      });
      return jsonError(payload.body.error.message, 400);
    }
    if (payload.kind === "pending") {
      return okResponse();
    }

    const job = await set(
      getBuiltInGenerationWebhookJobByProviderJobId$,
      { provider: "joggai", providerJobId: payload.videoId },
      signal,
    );
    if (!job) {
      L.debug("JoggAI built-in generation webhook ignored inactive job", {
        providerVideoId: payload.videoId,
      });
      return okResponse();
    }

    if (payload.kind === "failed") {
      L.warn("JoggAI built-in generation webhook reported failure", {
        generationId: job.id,
        providerVideoId: payload.videoId,
        providerMessage: payload.message,
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: failError(
            "JoggAI avatar video generation failed",
            "JOGGAI_GENERATION_FAILED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    waitUntil(
      tapError(
        set(handleJoggAiAvatarVideoCompletion$, { job, payload }, signal),
        (error) => {
          L.error("JoggAI built-in generation webhook processing failed", {
            generationId: job.id,
            providerVideoId: payload.videoId,
            error,
          });
        },
      ),
    );
    L.debug("JoggAI built-in generation webhook accepted", {
      generationId: job.id,
      providerVideoId: payload.videoId,
    });
    return okResponse();
  },
);

const handleHeyGenIntroVideoAgentWebhook$ = command(
  async (
    { get, set },
    job: BuiltInGenerationWebhookJob,
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const internal = readBuiltInGenerationRequestInternal(job.request);
    if (!internal.providerSessionId || !internal.providerJobId) {
      const rawBody = await get(request$).text();
      signal.throwIfAborted();
      const hints = parseHeyGenVideoAgentCallback(
        safeJsonParse(rawBody),
        job.id,
      );
      if (hints) {
        if (
          (internal.providerSessionId &&
            hints.sessionId &&
            internal.providerSessionId !== hints.sessionId) ||
          (internal.providerJobId &&
            hints.videoId &&
            internal.providerJobId !== hints.videoId)
        ) {
          return jsonError("Video Agent callback identity mismatch", 400);
        }
        const recorded = await set(
          recordIntroVideoAgentIdentity$,
          {
            generationId: job.id,
            ...(hints.sessionId ? { sessionId: hints.sessionId } : {}),
            ...(hints.videoId ? { videoId: hints.videoId } : {}),
          },
          signal,
        );
        if (!recorded) {
          return jsonError("Video Agent callback identity mismatch", 400);
        }
      }
    }
    await set(reconcileIntroVideoAgentJob$, job.id, signal);
    const updated = await set(loadIntroVideoAgentJob$, job.id, signal);
    return updated?.status === "completed" || updated?.status === "failed"
      ? okResponse()
      : jsonError("Video Agent generation is still pending", 503);
  },
);

const handleHeyGenCloudRenderWebhook$ = command(
  async (
    { get, set },
    id: string,
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const raw = await get(request$).text();
    signal.throwIfAborted();
    await set(recordIntroVideoRenderCallback$, id, safeJsonParse(raw), signal);
    const updated = await set(loadIntroVideoRenderJob$, id, signal);
    return updated?.status === "completed" || updated?.status === "failed"
      ? okResponse()
      : jsonError("Cloud render is still pending", 503);
  },
);

const postHeyGenBuiltInGenerationWebhook$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<ProviderWebhookResponse> => {
    const params = get(heyGenWebhookPathParams$);
    const query = get(heyGenWebhookQuery$);
    if (
      !verifyBuiltInGenerationProviderWebhookToken({
        provider: "heygen",
        generationId: params.generationId,
        visualKey: undefined,
        token: query.token,
      })
    ) {
      L.warn("HeyGen built-in generation webhook rejected invalid token", {
        generationId: params.generationId,
      });
      return jsonError("Invalid token", 401);
    }

    const job = await set(
      getBuiltInGenerationWebhookJob$,
      params.generationId,
      signal,
    );
    if (!job) {
      L.debug("HeyGen built-in generation webhook ignored inactive job", {
        generationId: params.generationId,
      });
      return okResponse();
    }
    const internal = readBuiltInGenerationRequestInternal(job.request);
    if (
      internal.provider === "heygen" &&
      internal.providerTask === INTRO_VIDEO_RENDER_TASK
    ) {
      return await set(handleHeyGenCloudRenderWebhook$, job.id, signal);
    }
    if (
      internal.provider === "heygen" &&
      internal.providerTask === "intro-video-agent"
    ) {
      return await set(handleHeyGenIntroVideoAgentWebhook$, job, signal);
    }
    if (
      internal.provider !== "heygen" ||
      internal.providerTask !== "intro-video-presenter" ||
      !internal.providerJobId
    ) {
      L.warn("HeyGen built-in generation webhook found an invalid job", {
        generationId: job.id,
      });
      return jsonError("Invalid generation job", 400);
    }
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      return jsonError("Webhook is not configured", 503);
    }
    const status = await getHeyGenAvatarVideoStatus(
      internal.providerJobId,
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(status)) {
      if (status.status === 503) {
        return jsonError(status.body.error.message, 503);
      }
      L.warn("HeyGen built-in generation webhook received invalid status", {
        generationId: job.id,
        providerVideoId: internal.providerJobId,
        providerMessage: status.body.error.message,
      });
      await set(
        failBuiltInGenerationJob$,
        { generationId: job.id, error: status.body.error },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }
    if (status.kind === "pending") {
      return jsonError("Generation is still pending", 503);
    }
    if (status.kind === "failed") {
      L.warn("HeyGen built-in generation webhook reported failure", {
        generationId: job.id,
        providerVideoId: internal.providerJobId,
        providerMessage: redactPresignedUrls(status.message),
      });
      await set(
        failBuiltInGenerationJob$,
        {
          generationId: job.id,
          error: failError(
            "HeyGen Intro Video presenter generation failed",
            "HEYGEN_GENERATION_FAILED",
          ),
        },
        signal,
      );
      await set(completeAdmissionForJob$, { job, status: "failed" });
      signal.throwIfAborted();
      return okResponse();
    }

    waitUntil(
      tapError(
        set(
          handleHeyGenIntroVideoPresenterCompletion$,
          { job, status },
          signal,
        ),
        (error) => {
          L.error("HeyGen built-in generation webhook processing failed", {
            generationId: job.id,
            providerVideoId: internal.providerJobId,
            error,
          });
        },
      ),
    );
    return okResponse();
  },
);

export const webhooksBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: webhookBuiltInGenerationFalContract.post,
    handler: postFalBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationBytePlusContract.post,
    handler: postBytePlusBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationMiniMaxContract.post,
    handler: postMiniMaxBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationJoggAiContract.post,
    handler: postJoggAiBuiltInGenerationWebhook$,
  },
  {
    route: webhookBuiltInGenerationHeyGenContract.post,
    handler: postHeyGenBuiltInGenerationWebhook$,
  },
];
