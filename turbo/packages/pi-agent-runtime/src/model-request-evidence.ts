import type { Api } from "@earendil-works/pi-ai";

const APIS = [
  "openai-codex-responses",
  "openai-responses",
  "openai-completions",
] as const;
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const ENCODINGS = ["identity", "zstd", "gzip", "br", "deflate"] as const;

export type ModelRequestEvidence = {
  api?: (typeof APIS)[number];
  inputItems?: number;
  tools?: number;
  instructionsBytes?: number;
  reasoningEffort?: (typeof REASONING_EFFORTS)[number];
  /** Bytes actually passed to fetch, which may already be compressed. */
  wireBodyBytes?: number;
  contentEncoding?: (typeof ENCODINGS)[number] | "other";
};

export type ModelResponseEvidence = {
  requestId?: string;
  cfRay?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Summarize the effective SDK payload, never its content or arbitrary keys. */
export function modelPayloadEvidence(
  payload: unknown,
  api: Api,
): ModelRequestEvidence | undefined {
  const knownApi = APIS.find((value) => {
    return value === api;
  });
  if (knownApi === undefined) return undefined;
  const body = record(payload);
  if (!body) return undefined;
  const input = knownApi === "openai-completions" ? body.messages : body.input;
  const inputItems = Array.isArray(input)
    ? input.length
    : knownApi !== "openai-completions" && typeof input === "string"
      ? 1
      : undefined;
  const tools =
    body.tools === undefined
      ? 0
      : Array.isArray(body.tools)
        ? body.tools.length
        : undefined;
  const effort = record(body.reasoning)?.effort ?? body.reasoning_effort;
  const reasoningEffort = REASONING_EFFORTS.find((value) => {
    return value === effort;
  });
  return {
    api: knownApi,
    ...(inputItems === undefined ? {} : { inputItems }),
    ...(tools === undefined ? {} : { tools }),
    ...(knownApi !== "openai-completions" &&
    (body.instructions === undefined || typeof body.instructions === "string")
      ? {
          instructionsBytes: Buffer.byteLength(body.instructions ?? "", "utf8"),
        }
      : {}),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** Do not clone or consume a Request/stream to measure diagnostic bytes. */
export function modelWireEvidence(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): ModelRequestEvidence {
  const body = init?.body;
  const wireBodyBytes =
    typeof body === "string"
      ? Buffer.byteLength(body, "utf8")
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : undefined;
  if (wireBodyBytes === undefined) return {};
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const encoding = headers.get("content-encoding")?.toLowerCase().trim();
  const contentEncoding =
    encoding === undefined
      ? "identity"
      : (ENCODINGS.find((value) => {
          return value === encoding;
        }) ?? "other");
  return { wireBodyBytes, contentEncoding };
}

/** Accept only known opaque IDs, not arbitrary provider-controlled header text. */
export function modelResponseEvidence(
  headers: Headers,
): ModelResponseEvidence | undefined {
  const requestId = headers.get("x-request-id");
  const cfRay = headers.get("cf-ray");
  const evidence = {
    ...(requestId !== null &&
    /^(?:req_[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$/u.test(
      requestId,
    )
      ? { requestId }
      : {}),
    ...(cfRay !== null && /^[0-9a-fA-F]{16}(?:-[A-Z]{3})?$/u.test(cfRay)
      ? { cfRay }
      : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}
