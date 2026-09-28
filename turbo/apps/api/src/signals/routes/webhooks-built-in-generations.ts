import { command } from "ccstate";
import { webhookBuiltInGenerationFalContract } from "@okouai/api-contracts/contracts/webhooks";

import { request$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { safeJsonParse } from "../utils";
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
  builtInGenerationIsPrivate,
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJob$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "../services/built-in-generation.service";
import {
  completeRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "../services/run-built-in-admission.service";
import { verifyBuiltInGenerationProviderWebhookToken } from "../services/built-in-generation-provider-webhooks.service";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";

const L = logger("BuiltInGenerationWebhooks");

const falWebhookPathParams$ = pathParamsOf(
  webhookBuiltInGenerationFalContract.post,
);
const falWebhookQuery$ = queryOf(webhookBuiltInGenerationFalContract.post);
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

interface FalWebhookPayload {
  readonly status: string | undefined;
  readonly body: unknown;
  readonly providerHttpStatus: number | undefined;
}

function falProviderHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "string") {
    return undefined;
  }
  const match = /^(?:Invalid|Unexpected) status code: ([1-5]\d{2})$/u.exec(
    error,
  );
  // JavaScript's $ also matches before a final newline; require the full value.
  return match?.[0] === error ? Number(match[1]) : undefined;
}

function falPayloadBody(payload: unknown): FalWebhookPayload | null {
  if (!isRecord(payload)) {
    return null;
  }
  const body = payload.payload ?? payload.data ?? payload.response ?? payload;
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    body,
    providerHttpStatus: falProviderHttpStatus(payload.error),
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
const FAL_PROVIDER_FAILURE_TYPES = [
  "downstream_service_error",
  "downstream_service_unavailable",
] as const;
const FAL_PROVIDER_FAILURE_STATUSES: ReadonlySet<number> = Object.freeze(
  new Set([429, 500, 502, 503, 504]),
);

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
  readonly providerHttpStatus?: number;
  readonly providerErrorType?: string;
}

function normalizeFalFailureMessage(message: string): string {
  return message.trim().replace(/\s+/gu, " ");
}

interface FalFailureDiagnostic {
  readonly message: string | undefined;
  readonly providerErrorType: string | undefined;
  readonly location: readonly (string | number)[] | undefined;
}

function falFailureDetailDiagnostics(
  detail: unknown,
): (FalFailureDiagnostic | null)[] {
  if (detail === undefined) {
    return [];
  }
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
  return entries.map((entry) => {
    if (!isRecord(entry)) {
      return null;
    }
    // Return only constants used by the business rules. Unknown/malformed types
    // remain evidence against classifying the whole envelope from its status.
    const providerErrorType =
      FAL_PROVIDER_FAILURE_TYPES.find((type) => {
        return type === entry.type;
      }) ??
      FAL_STRUCTURED_FAILURE_RULES.find((rule) => {
        return rule.providerErrorType === entry.type;
      })?.providerErrorType;
    if (entry.type !== undefined && providerErrorType === undefined) {
      return null;
    }
    const location =
      Array.isArray(entry.loc) &&
      entry.loc.every((segment) => {
        return typeof segment === "string" || typeof segment === "number";
      })
        ? entry.loc
        : undefined;
    return {
      message:
        typeof entry.msg === "string"
          ? normalizeFalFailureMessage(entry.msg)
          : undefined,
      providerErrorType,
      location,
    };
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
// webhook contract. Keep all three input fields exact: content_policy_violation
// is used for both input and generated-output moderation.
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
];

const FAL_PROVIDER_UNAVAILABLE_FAILURE: FalGenerationFailure = Object.freeze({
  error: {
    message: "The image generation provider is temporarily unavailable.",
    code: "GENERATION_PROVIDER_UNAVAILABLE",
  },
  // Existing metadata only; neither type nor status establishes retryability.
  retryPolicy: "retry_once",
  userInput: false,
});

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

function classifyFalFailureDiagnostic(
  diagnostic: FalFailureDiagnostic | null,
): FalGenerationFailure | undefined {
  if (!diagnostic) {
    return undefined;
  }
  if (diagnostic.message === FAL_OUTPUT_SAFETY_FILTER_MESSAGE) {
    if (
      diagnostic.providerErrorType !== undefined &&
      diagnostic.providerErrorType !== "content_policy_violation"
    ) {
      return undefined;
    }
    return {
      error: {
        message: FAL_OUTPUT_SAFETY_FILTER_MESSAGE,
        code: "GENERATION_OUTPUT_SAFETY_BLOCKED",
      },
      retryPolicy: "manual_once",
      userInput: true,
    };
  }
  // Only these two documented provider types are independent of prose/location.
  if (
    FAL_PROVIDER_FAILURE_TYPES.some((type) => {
      return type === diagnostic.providerErrorType;
    })
  ) {
    return FAL_PROVIDER_UNAVAILABLE_FAILURE;
  }
  const diagnosticLocation = diagnostic.location;
  const rule = FAL_STRUCTURED_FAILURE_RULES.find((candidate) => {
    return (
      candidate.providerErrorType === diagnostic.providerErrorType &&
      normalizeFalFailureMessage(candidate.message) === diagnostic.message &&
      diagnosticLocation !== undefined &&
      candidate.locations.some((location) => {
        return falFailureLocationMatches(diagnosticLocation, location);
      })
    );
  });
  return rule
    ? {
        error: rule.error,
        retryPolicy: rule.retryPolicy,
        userInput: rule.userInput,
      }
    : undefined;
}

function falGenerationFailure(
  type: BuiltInGenerationWebhookJob["type"],
  payload: FalWebhookPayload,
): FalGenerationFailure {
  if (type !== "image") {
    return {
      error: failError("Generation failed"),
      retryPolicy: "retry_once",
      userInput: false,
    };
  }
  const diagnostics = isRecord(payload.body)
    ? falFailureDetailDiagnostics(payload.body.detail)
    : [null];
  const classifications = diagnostics.map(classifyFalFailureDiagnostic);
  const firstClassification = classifications[0];
  const providerErrorType = diagnostics[0]?.providerErrorType;
  const evidence = {
    providerHttpStatus: payload.providerHttpStatus,
    providerErrorType: diagnostics.every((diagnostic) => {
      return diagnostic?.providerErrorType === providerErrorType;
    })
      ? providerErrorType
      : undefined,
  };
  // Specific, consistent detail wins over the outer reported status, including
  // Fal's 422 wrapper. Never choose the first entry of a mixed/unknown failure.
  if (
    firstClassification &&
    classifications.every((failure) => {
      return failure?.error.code === firstClassification.error.code;
    })
  ) {
    return { ...firstClassification, ...evidence };
  }
  // Some endpoints omit structured details. Only the exact reported status is
  // available here; it says nothing about transport, quota ownership or retries.
  if (
    diagnostics.length === 0 &&
    payload.providerHttpStatus !== undefined &&
    FAL_PROVIDER_FAILURE_STATUSES.has(payload.providerHttpStatus)
  ) {
    return { ...FAL_PROVIDER_UNAVAILABLE_FAILURE, ...evidence };
  }
  return {
    error: {
      message: "Image generation failed.",
      code: "GENERATION_FAILED",
    },
    retryPolicy: "retry_once",
    userInput: false,
    ...evidence,
  };
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
        billingRunId: args.job.billingRunId,
        billingContext: args.job.billingContext,
        orgId: args.job.orgId,
        userId: args.job.userId,
        runId: args.job.runId ?? undefined,
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
          providerHttpStatus: failure.providerHttpStatus,
          providerErrorType: failure.providerErrorType,
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
    L.debug("Fal built-in generation webhook ignored unsupported job type", {
      generationId: job.id,
      type: job.type,
      visualKey: query.visualKey,
    });
    return okResponse();
  },
);

export const webhooksBuiltInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: webhookBuiltInGenerationFalContract.post,
    handler: postFalBuiltInGenerationWebhook$,
  },
];
