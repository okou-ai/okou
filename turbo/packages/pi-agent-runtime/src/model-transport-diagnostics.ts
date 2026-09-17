/** Only these content-free runtime values may cross the model failure boundary. */
const ERROR_NAMES = [
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
] as const;
const ERROR_CODES = [
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
] as const;

export interface PiModelTransportFailure {
  readonly phase: "request" | "response_body";
  readonly signalAborted: boolean;
  readonly errorName?: (typeof ERROR_NAMES)[number];
  readonly errorCode?: (typeof ERROR_CODES)[number];
  readonly causeCode?: (typeof ERROR_CODES)[number];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function allowed<T extends string>(value: unknown, values: readonly T[]) {
  return values.find((candidate) => {
    return candidate === value;
  });
}

/** Inspect at most four causes; never retain arbitrary names, messages or objects. */
export function modelTransportFailure(
  error: unknown,
  phase: PiModelTransportFailure["phase"],
  signalAborted: boolean,
): PiModelTransportFailure {
  const outer = record(error);
  const errorName = allowed(outer?.name, ERROR_NAMES);
  const errorCode = allowed(outer?.code, ERROR_CODES);
  let cause = outer?.cause;
  let causeCode: PiModelTransportFailure["causeCode"];
  for (let depth = 0; depth < 4 && cause !== undefined; depth++) {
    const nested = record(cause);
    causeCode = allowed(nested?.code, ERROR_CODES);
    if (causeCode) break;
    cause = nested?.cause;
  }
  return {
    phase,
    signalAborted,
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

/** Re-project runtime metadata so persisted/provider diagnostics cannot leak prose. */
export function parseModelTransportFailure(
  value: unknown,
): PiModelTransportFailure | undefined {
  const details = record(value);
  if (
    !details ||
    (details.phase !== "request" && details.phase !== "response_body") ||
    typeof details.signalAborted !== "boolean"
  )
    return undefined;
  const errorName = allowed(details.errorName, ERROR_NAMES);
  const errorCode = allowed(details.errorCode, ERROR_CODES);
  const causeCode = allowed(details.causeCode, ERROR_CODES);
  return {
    phase: details.phase,
    signalAborted: details.signalAborted,
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(causeCode ? { causeCode } : {}),
  };
}

/** One reader, no tee or eager pump; cancellation and errors retain their owner. */
export function observeModelResponseBody(
  response: Response,
  observe: (error: unknown) => void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await reader.read();
          if (cancelled) return;
          if (result.done) {
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(result.value);
        } catch (error) {
          if (cancelled) return;
          observe(error);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
