interface AxiomRequestDetails {
  readonly origin: string;
  readonly endpoint: string;
  readonly method: string;
  readonly elapsedMs: number;
  readonly attemptElapsedMs: number;
  readonly attempt: number;
  readonly requestBytes: number | undefined;
  readonly aborted: boolean;
}

class AxiomRequestTransportError extends Error {
  readonly request: AxiomRequestDetails;

  constructor(cause: unknown, request: AxiomRequestDetails) {
    super(cause instanceof Error ? cause.message : "Axiom SDK request failed", {
      cause,
    });
    // The SDK callback uses the original name to distinguish timeouts.
    this.name = cause instanceof Error ? cause.name : "Error";
    this.request = request;
  }
}

function requestBodyBytes(body: RequestInit["body"]): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }
  if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    return body.byteLength;
  }
  if (body instanceof Blob) {
    return body.size;
  }
  return undefined;
}

interface AxiomRequestAttempt {
  readonly startedAt: number;
  readonly attempt: number;
}

// The SDK creates one timeout signal per operation and reuses it across retries.
// Keep timing with that signal so an immediately aborted final attempt cannot
// hide the original wait. The client owns this adapter; keys are weak and values
// retain neither signals nor request headers/payloads.
export function createAxiomFetch(): typeof fetch {
  const requests = new WeakMap<AbortSignal, AxiomRequestAttempt>();
  return async (...args) => {
    const attemptStartedAt = performance.now();
    const [input, init] = args;
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const previous = signal ? requests.get(signal) : undefined;
    const request = {
      startedAt: previous?.startedAt ?? attemptStartedAt,
      attempt: (previous?.attempt ?? 0) + 1,
    };
    if (signal) {
      requests.set(signal, request);
    }

    const [result] = await Promise.allSettled([fetch(...args)]);
    if (result.status === "fulfilled") {
      return result.value;
    }
    const finishedAt = performance.now();
    const url = new URL(input instanceof Request ? input.url : input);
    throw new AxiomRequestTransportError(result.reason, {
      origin: url.origin,
      endpoint: url.pathname,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      elapsedMs: Math.max(0, finishedAt - request.startedAt),
      attemptElapsedMs: Math.max(0, finishedAt - attemptStartedAt),
      attempt: request.attempt,
      requestBytes: requestBodyBytes(init?.body),
      aborted: signal?.aborted ?? false,
    });
  };
}
