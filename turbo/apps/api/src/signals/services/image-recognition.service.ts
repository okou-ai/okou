import { randomUUID } from "node:crypto";

import {
  IMAGE_RECOGNITION_MAX_FILE_BYTES,
  IMAGE_RECOGNITION_MAX_TEXT_CHARS,
  imageRecognitionMimeTypeSchema,
  type ImageRecognitionRequest,
  type ImageRecognitionResponse,
} from "@okouai/api-contracts/contracts/image-recognition";
import { command } from "ccstate";
import { isSpanContextValid, trace } from "@opentelemetry/api";

import { insufficientCredits, notConfigured, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { AgentAuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import {
  generateTextWithUsage,
  isLlmConfigured,
  OpenRouterRequestError,
  type OpenRouterContentPart,
  type OpenRouterUsage,
} from "../external/openrouter";
import {
  openRouterFailureReason,
  type OpenRouterDiagnostics,
  type OpenRouterFailureReason,
} from "../external/openrouter-failure";
import { onRejection, settle } from "../utils";
import {
  resolveArtifactObject$,
  type ResolvedArtifactObject,
} from "./artifact-storage.service";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import {
  checkOpenRouterUsagePricing$,
  recordOpenRouterUsage$,
} from "./openrouter-usage.service";
import { resolveProviderReferenceUrls$ } from "./provider-reference-url.service";

const IMAGE_RECOGNITION_MODEL = "xiaomi/mimo-v2.5";
const IMAGE_RECOGNITION_OPERATION = "image-recognition";
const IMAGE_RECOGNITION_MAX_TOKENS = 8192;

const log = logger("api:image-recognition");
type RecognitionFailureReason =
  | OpenRouterFailureReason
  | "request_cancelled"
  | "operation_cancelled"
  | "not_configured"
  | "output_too_large"
  | "incomplete_usage"
  | "no_usage"
  | "unsettled";

type RecognitionAuth = Extract<AgentAuthContext, { readonly orgId: string }>;

interface RecognitionArgs {
  readonly auth: RecognitionAuth;
  readonly body: ImageRecognitionRequest;
}

function recognitionError<Status extends number>(
  status: Status,
  code: string,
  message: string,
) {
  return {
    status,
    body: { error: { message, code } },
  } as const;
}

function providerError(error: unknown) {
  if (!(error instanceof OpenRouterRequestError)) {
    return recognitionError(
      502,
      "IMAGE_RECOGNITION_FAILED",
      "Image recognition failed to produce a usable response",
    );
  }
  if (
    error.errorType === "invalid_image" ||
    error.errorType === "image_too_small" ||
    error.errorType === "unsupported_image_format"
  ) {
    return recognitionError(
      400,
      "INVALID_IMAGE",
      "The uploaded file is not a valid PNG, JPEG, or WebP image",
    );
  }
  if (error.errorType === "image_too_large") {
    return recognitionError(
      413,
      "IMAGE_TOO_LARGE",
      "The image exceeds the recognition provider's size limit",
    );
  }
  if (
    error.errorType === "image_not_found" ||
    error.errorType === "image_download_failed"
  ) {
    return recognitionError(
      502,
      "IMAGE_UNAVAILABLE",
      "The recognition provider could not read the uploaded image",
    );
  }
  if (error.status === 429 || error.status >= 500) {
    return recognitionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Image recognition is temporarily unavailable",
    );
  }
  return recognitionError(
    502,
    "IMAGE_RECOGNITION_FAILED",
    "Image recognition failed to produce a usable response",
  );
}

function isPositiveSafeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

function hasCompleteRecognitionUsage(
  usage: OpenRouterUsage | undefined,
): boolean {
  if (usage === undefined) {
    return false;
  }
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (
    !isPositiveSafeInteger(promptTokens) ||
    !isPositiveSafeInteger(completionTokens)
  ) {
    return false;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  return (
    cachedTokens === undefined ||
    (Number.isSafeInteger(cachedTokens) &&
      cachedTokens >= 0 &&
      cachedTokens <= promptTokens)
  );
}

function validateArtifact(artifact: ResolvedArtifactObject | null) {
  if (artifact === null) {
    return notFound("Uploaded image not found");
  }
  if (!imageRecognitionMimeTypeSchema.safeParse(artifact.contentType).success) {
    return recognitionError(
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      "Image must be a PNG, JPEG, or WebP file",
    );
  }
  if (artifact.size <= 0) {
    return recognitionError(400, "EMPTY_IMAGE", "Image file must not be empty");
  }
  if (artifact.size > IMAGE_RECOGNITION_MAX_FILE_BYTES) {
    return recognitionError(
      413,
      "IMAGE_TOO_LARGE",
      "Image file must be 20 MB or smaller",
    );
  }
  return artifact;
}

async function emitRecognitionFailure(
  fields: Record<string, unknown>,
): Promise<void> {
  // Keep synchronous logger/exporter failures, including AbortError, inside
  // the promise settled by the recognition boundary.
  await Promise.resolve(log.warn("Image recognition failed", fields));
}

function createRecognitionDiagnostics(
  operationId: string,
  authenticatedRunId: string | undefined,
  clientSignal: AbortSignal,
  signal: AbortSignal,
) {
  const diagnostics: OpenRouterDiagnostics & {
    reason?: RecognitionFailureReason;
  } = { phase: "configuration" };
  const startedAt = now();
  const spanContext = trace.getActiveSpan()?.spanContext();
  const traceId =
    spanContext && isSpanContextValid(spanContext)
      ? spanContext.traceId
      : undefined;
  const runId =
    authenticatedRunId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      authenticatedRunId,
    )
      ? authenticatedRunId
      : undefined;
  const cancellationReason = (error: unknown) => {
    if (signal.aborted && error === signal.reason) {
      return "operation_cancelled";
    }
    return clientSignal.aborted && error === clientSignal.reason
      ? "request_cancelled"
      : undefined;
  };
  // Only this boundary emits the event. Awaiting its settled synchronous
  // write isolates even abort-shaped logger failures; the existing request
  // middleware owns the asynchronous Axiom flush after this command finishes.
  const report = (
    reason: RecognitionFailureReason,
    response?: {
      readonly status: number;
      readonly body: { readonly error: { readonly code: string } };
    },
  ) => {
    const elapsed = now() - startedAt;
    return emitRecognitionFailure({
      type: "image_recognition_failure",
      operation_id: operationId,
      ...(runId === undefined ? {} : { run_id: runId }),
      ...(traceId === undefined ? {} : { trace_id: traceId }),
      phase: diagnostics.phase,
      reason,
      ...(diagnostics.detail === undefined
        ? {}
        : { detail: diagnostics.detail }),
      ...(diagnostics.upstreamStatus === undefined
        ? {}
        : { upstream_status: diagnostics.upstreamStatus }),
      ...(diagnostics.finishReason === undefined
        ? {}
        : { finish_reason: diagnostics.finishReason }),
      ...(diagnostics.nativeFinishReason === undefined
        ? {}
        : { native_finish_reason: diagnostics.nativeFinishReason }),
      ...(diagnostics.completionTokens === undefined
        ? {}
        : { completion_tokens: diagnostics.completionTokens }),
      ...(diagnostics.reasoningTokens === undefined
        ? {}
        : { reasoning_tokens: diagnostics.reasoningTokens }),
      ...(response === undefined
        ? {}
        : {
            public_status: response.status,
            public_code: response.body.error.code,
          }),
      ...(Number.isFinite(elapsed)
        ? {
            duration_ms: Math.min(
              Number.MAX_SAFE_INTEGER,
              Math.max(0, elapsed),
            ),
          }
        : {}),
      request_aborted: clientSignal.aborted,
      operation_aborted: signal.aborted,
    });
  };
  const failed = async <
    T extends {
      readonly status: number;
      readonly body: { readonly error: { readonly code: string } };
    },
  >(
    response: T,
    reason: RecognitionFailureReason,
  ): Promise<T> => {
    await Promise.allSettled([report(reason, response)]);
    return response;
  };
  return {
    diagnostics,
    failed,
    cancellationReason,
    rejected: (error: unknown) => {
      return Promise.allSettled([
        report(
          cancellationReason(error) ??
            diagnostics.reason ??
            openRouterFailureReason(error),
        ),
      ]);
    },
  };
}

const completeImageRecognition$ = command(
  async (
    { set },
    args: {
      readonly auth: RecognitionAuth;
      readonly content: readonly OpenRouterContentPart[];
      readonly operationId: string;
      readonly attempt: ReturnType<typeof createRecognitionDiagnostics>;
    },
    requestSignal: AbortSignal,
    signal: AbortSignal,
  ) => {
    const { diagnostics, failed, cancellationReason } = args.attempt;
    const generated = await settle(
      generateTextWithUsage(
        IMAGE_RECOGNITION_MODEL,
        [{ role: "user", content: args.content }],
        IMAGE_RECOGNITION_MAX_TOKENS,
        { diagnostics },
        requestSignal,
      ),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return await failed(
        providerError(generated.error),
        cancellationReason(generated.error) ??
          openRouterFailureReason(generated.error),
      );
    }
    if (generated.value === null) {
      return await failed(
        notConfigured("Image recognition is not configured"),
        "not_configured",
      );
    }
    if (generated.value.text.length > IMAGE_RECOGNITION_MAX_TEXT_CHARS) {
      return await failed(
        recognitionError(
          502,
          "IMAGE_RECOGNITION_FAILED",
          "Image recognition returned too much text",
        ),
        "output_too_large",
      );
    }
    diagnostics.phase = "usage_validation";
    if (!hasCompleteRecognitionUsage(generated.value.usage)) {
      return await failed(
        recognitionError(
          502,
          "MISSING_PROVIDER_USAGE",
          "Image recognition did not report complete billable usage",
        ),
        "incomplete_usage",
      );
    }

    // Provider work is complete, so a client disconnect must not skip billing.
    diagnostics.phase = "settlement";
    const settlement = await set(
      recordOpenRouterUsage$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: args.auth.runId,
        provider: IMAGE_RECOGNITION_MODEL,
        operation: IMAGE_RECOGNITION_OPERATION,
        operationId: args.operationId,
        usage: generated.value.usage,
      },
      signal,
    );
    signal.throwIfAborted();
    if (settlement.kind === "no-usage") {
      return await failed(
        recognitionError(
          502,
          "MISSING_PROVIDER_USAGE",
          "Image recognition did not report billable usage",
        ),
        "no_usage",
      );
    }
    if (settlement.kind === "unsettled") {
      diagnostics.reason = "unsettled";
      throw new Error("Failed to settle image recognition usage");
    }

    const body: ImageRecognitionResponse = {
      text: generated.value.text,
      metadata: { creditsCharged: settlement.creditsCharged },
    };
    return { status: 200 as const, body };
  },
);

export const imageRecognition$ = command(
  async ({ get, set }, args: RecognitionArgs, signal: AbortSignal) => {
    const clientSignal = get(requestSignal$);
    const requestSignal = AbortSignal.any([signal, clientSignal]);
    requestSignal.throwIfAborted();

    const resolved = await set(
      resolveArtifactObject$,
      { userId: args.auth.userId, id: args.body.fileId },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    const artifact = validateArtifact(resolved);
    if ("status" in artifact) {
      return artifact;
    }

    if (!isLlmConfigured()) {
      return notConfigured("Image recognition is not configured");
    }
    const hasCredits = await set(
      checkBillableOperationCredits$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        runId: args.auth.runId,
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (!hasCredits) {
      return insufficientCredits();
    }
    const missingPricing = await set(
      checkOpenRouterUsagePricing$,
      {
        provider: IMAGE_RECOGNITION_MODEL,
        operation: IMAGE_RECOGNITION_OPERATION,
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if (missingPricing.length > 0) {
      return notConfigured("Image recognition pricing is not configured");
    }

    const references = await set(
      resolveProviderReferenceUrls$,
      {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        urls: [artifact.url],
      },
      requestSignal,
    );
    signal.throwIfAborted();
    requestSignal.throwIfAborted();
    if ("status" in references) {
      return references;
    }
    const [providerImageUrl] = references;
    if (!providerImageUrl) {
      throw new Error("Expected a resolved image recognition URL");
    }
    const content: OpenRouterContentPart[] = [
      { type: "text", text: args.body.prompt },
      { type: "image_url", image_url: { url: providerImageUrl } },
    ];
    const operationId = randomUUID();
    const attempt = createRecognitionDiagnostics(
      operationId,
      args.auth.runId,
      clientSignal,
      signal,
    );
    return await onRejection(
      set(
        completeImageRecognition$,
        { auth: args.auth, content, operationId, attempt },
        requestSignal,
        signal,
      ),
      attempt.rejected,
    );
  },
);
