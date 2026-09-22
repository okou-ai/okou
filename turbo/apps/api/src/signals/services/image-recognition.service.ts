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
import type { ResolvedArtifactObject } from "./artifact-storage.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import {
  checkOpenRouterUsagePricing$,
  recordOpenRouterUsage$,
} from "./openrouter-usage.service";
import { resolveProviderReferenceUrls$ } from "./provider-reference-url.service";

const IMAGE_RECOGNITION_MODEL = "xiaomi/mimo-v2.5";
const IMAGE_RECOGNITION_OPERATION = "image-recognition";
const IMAGE_RECOGNITION_MAX_TOKENS = 8192;

/**
 * Reasoning control for `IMAGE_RECOGNITION_MODEL`, recorded the way
 * `AUXILIARY_TEXT_MAX_TOKENS` records `FAST_PATH_MODEL`. From
 * `GET /api/v1/models` and its `/endpoints` detail, checked 2026-09-21: the
 * model reports `reasoning: { mandatory: false }` with no `supported_efforts`,
 * no `default_effort` and no `supports_max_tokens`, and each of its six
 * provider endpoints lists `reasoning` and `include_reasoning` among the
 * supported parameters but never `reasoning_effort`. An omitted
 * `supported_efforts` is documented as a model that exposes no effort
 * selection, so the `effort: "low"` that run summaries send to
 * `FAST_PATH_MODEL` has nothing to select here and would be dropped rather
 * than honored; `mandatory: false` is exactly what leaves the remaining
 * control, the on/off switch, valid to send.
 *
 * Recognition reads back what an image already contains, and thinking is drawn
 * from the same `max_tokens` budget as the visible answer, so a model that
 * thinks first spends both wall clock and budget before emitting any answer at
 * all. Turning it off leaves the whole ceiling to the answer. `exclude: true`
 * is not the same lever: it keeps both costs and only hides the tokens.
 */
const IMAGE_RECOGNITION_REASONING = { enabled: false } as const;

/**
 * Total budget for one provider attempt, covering connect, headers and the
 * body read together. Without it the attempt inherits undici's 300 s
 * `bodyTimeout`, which is a per-chunk inactivity window rather than a bound on
 * the attempt, and which starts only once response headers arrive.
 *
 * Measured over 09-11 -> 09-14 in `vm0-traces-prod`, successful recognitions
 * ran p50 31.5 s and p90 126 s, and the slowest success completed in 299.45 s.
 * This is the smallest whole-second budget that still contains that slowest
 * success, so an attempt that cannot finish ends as a deliberate
 * `upstream_timeout` without turning any request that succeeds today into a
 * failure. It does not make a slow attempt succeed; the reasoning switch above
 * is what keeps attempts away from the ceiling.
 */
const IMAGE_RECOGNITION_PROVIDER_DEADLINE_MS = 300_000;

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
  deadlineSignal: AbortSignal,
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
  // Classification for a failed provider attempt, where the deadline is the
  // only signal our own budget owns. An attempt it ended is an upstream
  // timeout, never a caller's decision, so it answers exactly the failures a
  // caller did not cause. Both caller signals keep precedence by identity, so
  // a real cancellation racing the deadline still reports itself.
  const providerFailureReason = (
    error: unknown,
  ): RecognitionFailureReason | undefined => {
    return (
      cancellationReason(error) ??
      (deadlineSignal.aborted ? "upstream_timeout" : undefined)
    );
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
    providerFailureReason,
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
    providerSignal: AbortSignal,
    signal: AbortSignal,
  ) => {
    const { diagnostics, failed, providerFailureReason } = args.attempt;
    const generated = await settle(
      generateTextWithUsage(
        IMAGE_RECOGNITION_MODEL,
        [{ role: "user", content: args.content }],
        IMAGE_RECOGNITION_MAX_TOKENS,
        { diagnostics, reasoning: IMAGE_RECOGNITION_REASONING },
        providerSignal,
      ),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return await failed(
        providerError(generated.error),
        providerFailureReason(generated.error) ??
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

    const resolved = await get(
      uploadedArtifactObject({
        userId: args.auth.userId,
        orgId: args.auth.orgId,
        id: args.body.fileId,
      }),
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
    // The budget starts with the attempt itself, after admission and reference
    // resolution, and composes into the existing chain so a client disconnect
    // and an operation abort keep the meaning they already have.
    const deadlineSignal = AbortSignal.timeout(
      IMAGE_RECOGNITION_PROVIDER_DEADLINE_MS,
    );
    const providerSignal = AbortSignal.any([requestSignal, deadlineSignal]);
    const attempt = createRecognitionDiagnostics(
      operationId,
      args.auth.runId,
      clientSignal,
      signal,
      deadlineSignal,
    );
    return await onRejection(
      set(
        completeImageRecognition$,
        { auth: args.auth, content, operationId, attempt },
        providerSignal,
        signal,
      ),
      attempt.rejected,
    );
  },
);
