interface AxiomRequestDetails {
  readonly origin: string;
  readonly endpoint: string;
  readonly method: string;
  readonly elapsedMs: number;
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

// Instrument the SDK's existing fetch boundary without changing its retry,
// cancellation or response-body ownership. Never retain headers or payloads.
export const axiomFetch: typeof fetch = async (...args) => {
  const startedAt = performance.now();
  const [result] = await Promise.allSettled([fetch(...args)]);
  if (result.status === "fulfilled") {
    return result.value;
  }
  const [input, init] = args;
  const url = new URL(input instanceof Request ? input.url : input);
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  throw new AxiomRequestTransportError(result.reason, {
    origin: url.origin,
    endpoint: url.pathname,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    elapsedMs: Math.max(0, performance.now() - startedAt),
    requestBytes: requestBodyBytes(init?.body),
    aborted: signal?.aborted ?? false,
  });
};
