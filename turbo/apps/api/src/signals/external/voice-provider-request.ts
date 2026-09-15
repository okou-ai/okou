import { delay } from "signal-timers";

import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { onRejection, settle, startUntrackedBestEffortCleanup } from "../utils";

const L = logger("VoiceProvider");
const MAX_ATTEMPTS = 3;
// Recovery gets its own deadline after the first rejected request. Do not
// impose this short budget on an otherwise healthy long transcription.
const RECOVERY_BUDGET_MS = 15_000;
const INITIAL_BACKOFF_MS = 1000;

interface VoiceProviderContext {
  readonly provider: "openrouter" | "fal" | "vertex";
  readonly model: string;
  readonly responseSchema?: string;
}

export class VoiceProviderUnavailableError extends Error {
  constructor(readonly status: number) {
    super("Voice provider recovery exhausted");
    this.name = "VoiceProviderUnavailableError";
  }
}

export class VoiceProviderTemporaryResponseError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string | undefined,
  ) {
    super("Voice provider returned a temporary completion error");
    this.name = "VoiceProviderTemporaryResponseError";
  }
}

export function isRetryableVoiceProviderStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const text = value.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined;
}

interface ProviderFailure {
  readonly status: number;
  readonly source: "http" | "completion";
  readonly errorType?: string;
}

function exhausted(
  context: VoiceProviderContext,
  failure: ProviderFailure,
  attempts: number,
): VoiceProviderUnavailableError {
  L.warn("Voice provider recovery exhausted", {
    ...context,
    ...failure,
    attempts,
  });
  return new VoiceProviderUnavailableError(failure.status);
}

/** Recover classified temporary failures at the failed provider step. */
export async function requestVoiceProvider<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  readResponse: (response: Response) => Promise<T>,
  context: VoiceProviderContext,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let response = await request(signal);
  signal.throwIfAborted();
  let deadline: number | undefined;
  let attempts = 1;
  let responseSignal = signal;
  let failure: ProviderFailure = { status: response.status, source: "http" };
  const checkSignal = () => {
    signal.throwIfAborted();
    if (
      deadline !== undefined &&
      (responseSignal.aborted || now() >= deadline)
    ) {
      throw exhausted(context, failure, attempts);
    }
  };
  while (true) {
    if (isRetryableVoiceProviderStatus(response.status)) {
      failure = { status: response.status, source: "http" };
    } else {
      const result = await onRejection(
        settle(readResponse(response), signal),
        checkSignal,
      );
      checkSignal();
      if (result.ok) {
        if (response.ok && attempts > 1) {
          L.debug("Voice provider request recovered", { ...context, attempts });
        }
        return result.value;
      }
      if (!(result.error instanceof VoiceProviderTemporaryResponseError)) {
        throw result.error;
      }
      failure = {
        status: result.error.status,
        source: "completion",
        errorType: result.error.errorType,
      };
    }
    deadline ??= now() + RECOVERY_BUDGET_MS;
    const wait = Math.max(
      INITIAL_BACKOFF_MS * 2 ** (attempts - 1),
      retryAfterMs(response.headers.get("Retry-After")) ?? 0,
    );
    // Stream cancellation is advisory and can remain pending (for example a
    // tee whose other reader is retained). It must not own the recovery budget.
    if (!response.bodyUsed && response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    checkSignal();
    // A provider's long retry delay is not permission to retry earlier.
    if (attempts >= MAX_ATTEMPTS || wait >= deadline - now()) {
      throw exhausted(context, failure, attempts);
    }
    await delay(wait, { signal });
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw exhausted(context, failure, attempts);
    }
    responseSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    attempts += 1;
    response = await onRejection(request(responseSignal), checkSignal);
    checkSignal();
  }
}
