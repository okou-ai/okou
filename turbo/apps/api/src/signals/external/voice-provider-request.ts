import { accept, HttpStatusError } from "@okouai/connectors/accept";
import { delay } from "signal-timers";

import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { settle, startUntrackedBestEffortCleanup } from "../utils";

const L = logger("VoiceProvider");
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1000;

interface VoiceProviderContext {
  readonly model: string;
  readonly responseSchema?: string;
}

export class VoiceProviderUnavailableError extends Error {
  constructor(readonly status: number) {
    super("Voice provider recovery exhausted");
    this.name = "VoiceProviderUnavailableError";
  }
}

function isRetryableVoiceProviderStatus(status: number): boolean {
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

function exhausted(
  context: VoiceProviderContext,
  status: number,
  attempts: number,
): VoiceProviderUnavailableError {
  L.warn("Voice provider recovery exhausted", {
    ...context,
    status,
    source: "http",
    attempts,
  });
  return new VoiceProviderUnavailableError(status);
}

/** Recover classified temporary failures at the failed provider step. */
export async function requestVoiceProvider<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  readResponse: (response: Response) => Promise<T>,
  context: VoiceProviderContext,
  signal: AbortSignal,
): Promise<T> {
  for (let attempts = 1; ; attempts += 1) {
    signal.throwIfAborted();
    const result = await settle(accept(request(signal), [200]), signal);
    let response: Response;
    if (result.ok) {
      response = result.value;
    } else if (result.error instanceof HttpStatusError) {
      response = result.error.response;
      if (response.ok) {
        throw result.error;
      }
    } else {
      throw result.error;
    }
    if (!isRetryableVoiceProviderStatus(response.status)) {
      const value = await readResponse(response);
      signal.throwIfAborted();
      if (result.ok && attempts > 1) {
        L.debug("Voice provider request recovered", { ...context, attempts });
      }
      return value;
    }
    const wait = Math.max(
      INITIAL_BACKOFF_MS * 2 ** (attempts - 1),
      retryAfterMs(response.headers.get("Retry-After")) ?? 0,
    );
    // A failed provider response is no longer consumed by the caller.
    if (!response.bodyUsed && response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    if (attempts >= MAX_ATTEMPTS) {
      throw exhausted(context, response.status, attempts);
    }
    await delay(wait, { signal });
  }
}
