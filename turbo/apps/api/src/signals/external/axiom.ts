import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";
import { serializeError } from "@okouai/core/log-utils";
import { delay } from "signal-timers";
import { decodeHTML } from "entities";

import { createAxiomFetch } from "../../lib/axiom-fetch";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import {
  awaitWithSignal,
  safeJsonParse,
  settleIncludingAbort,
  startUntrackedBestEffortCleanup,
} from "../utils";
import {
  getAxiomTokenEnvNameForApl,
  getAxiomTokenEnvNameForDataset,
} from "./axiom-datasets";

const AXIOM_API_ORIGIN = "https://api.axiom.co";
const AXIOM_QUERY_TIMEOUT_MS = 120_000;
const AXIOM_INGEST_FAILURE_DETAIL_LIMIT = 3;
const AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH = 512;
const AXIOM_ERROR_BODY_MAX_BYTES = 4096;
const AXIOM_ERROR_BODY_TIMEOUT_MS = 200;
const AXIOM_TRACE_ATTEMPT_TIMEOUT_MS = 5000;
const AXIOM_TRACE_RETRY_DELAY_MS = 100;
const AXIOM_TRANSPORT_ERROR_MESSAGES = {
  timeout: "Axiom ingest timed out",
  transport_error: "Axiom ingest transport failed",
} as const;

const L = logger("api:axiom");

type AxiomClientName = "sessions" | "telemetry";

function logClientError(
  client: AxiomClientName,
  error: Error,
  dataset?: string,
): void {
  L.error("Axiom client operation failed", {
    client,
    ...(dataset === undefined ? {} : { dataset }),
    failureKind: error.name === "TimeoutError" ? "timeout" : "transport_error",
    api_commit_sha: env("GIT_COMMIT_SHA"),
    error: serializeError(error),
  });
}

const sessionsAxiomQueryClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_SESSIONS"),
    fetch: createAxiomFetch(),
    onError: (error) => {
      logClientError("sessions", error);
    },
  });
});

const telemetryAxiomQueryClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_TELEMETRY"),
    fetch: createAxiomFetch(),
    onError: (error) => {
      logClientError("telemetry", error);
    },
  });
});

const axiomIngestClients = singleton(() => {
  return {
    sessions: new Map<string, Axiom>(),
    telemetry: new Map<string, Axiom>(),
  };
});

export function getDatasetName(base: string): string {
  return `vm0-${base}-${env("AXIOM_DATASET_SUFFIX")}`;
}

function axiomClientForApl(apl: string): Axiom {
  const tokenEnvName = getAxiomTokenEnvNameForApl(apl);
  if (tokenEnvName === "AXIOM_TOKEN_SESSIONS") {
    return sessionsAxiomQueryClient();
  }
  return telemetryAxiomQueryClient();
}

function axiomClientForDataset(dataset: string): Axiom | null {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  const token = optionalEnv(tokenEnvName);
  if (!token) {
    return null;
  }

  const clientName: AxiomClientName =
    tokenEnvName === "AXIOM_TOKEN_SESSIONS" ? "sessions" : "telemetry";
  const clients = axiomIngestClients()[clientName];
  const existing = clients.get(dataset);
  if (existing) {
    return existing;
  }

  const client = new Axiom({
    token,
    fetch: createAxiomFetch(),
    onError: (error) => {
      logClientError(clientName, error, dataset);
    },
  });
  clients.set(dataset, client);
  return client;
}

export function ingestToAxiom(
  dataset: string,
  events: readonly Record<string, unknown>[],
): boolean {
  const client = axiomClientForDataset(dataset);
  if (!client) {
    return false;
  }
  client.ingest(dataset, [...events]);
  return true;
}

interface AxiomIngestFailure {
  readonly timestamp: string;
  readonly error: string;
}

interface AxiomIngestStatus {
  readonly ingested: number;
  readonly failed: number;
  readonly failures?: readonly AxiomIngestFailure[];
  readonly processedBytes: number;
  readonly blocksCreated?: number;
  readonly walLength?: number;
}

type DirectAxiomIngestResult =
  { readonly configured: false } | { readonly configured: true };

interface AxiomHttpErrorResponse {
  readonly upstreamRequestId?: string;
  readonly responseContentType?: string;
  readonly responseBodySummary?: string;
  readonly responseBodyTruncated?: boolean;
}

interface AxiomHttpIngestErrorOptions extends AxiomHttpErrorResponse {
  readonly reason: "http_status";
  readonly dataset: string;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly eventCount: number;
  readonly requestBytes: number;
  readonly timeoutMs: number;
  readonly elapsedMs: number;
}

type DirectAxiomIngestErrorOptions =
  | AxiomHttpIngestErrorOptions
  | {
      readonly reason: "invalid_response";
      readonly dataset: string;
    }
  | {
      readonly reason: "partial_ingest";
      readonly dataset: string;
      readonly expected: number;
      readonly ingested: number;
      readonly failed: number;
      readonly failureDetailsReturned: number;
      readonly failureDetails: readonly AxiomIngestFailure[];
      readonly failureDetailsOmitted: number;
    }
  | {
      readonly reason: "timeout" | "transport_error";
      readonly dataset: string;
      readonly eventCount: number;
      readonly requestBytes: number;
      readonly timeoutMs: number;
      readonly elapsedMs: number;
      readonly cause: unknown;
    };

export class DirectAxiomIngestError extends Error {
  readonly reason:
    | "http_status"
    | "invalid_response"
    | "partial_ingest"
    | "timeout"
    | "transport_error";
  readonly dataset: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly expected?: number;
  readonly ingested?: number;
  readonly failed?: number;
  readonly failureDetailsReturned?: number;
  readonly failureDetails?: readonly AxiomIngestFailure[];
  readonly failureDetailsOmitted?: number;
  readonly eventCount?: number;
  readonly requestBytes?: number;
  readonly timeoutMs?: number;
  readonly elapsedMs?: number;
  readonly upstreamRequestId?: string;
  readonly responseContentType?: string;
  readonly responseBodySummary?: string;
  readonly responseBodyTruncated?: boolean;

  constructor(message: string, options: DirectAxiomIngestErrorOptions) {
    super(
      message,
      options.reason === "timeout" || options.reason === "transport_error"
        ? { cause: options.cause }
        : undefined,
    );
    this.name = "DirectAxiomIngestError";
    this.reason = options.reason;
    this.dataset = options.dataset;
    if (options.reason === "http_status") {
      this.status = options.status;
      this.retryAfterMs = options.retryAfterMs;
      this.upstreamRequestId = options.upstreamRequestId;
      this.responseContentType = options.responseContentType;
      this.responseBodySummary = options.responseBodySummary;
      this.responseBodyTruncated = options.responseBodyTruncated;
    }
    if (options.reason === "partial_ingest") {
      this.expected = options.expected;
      this.ingested = options.ingested;
      this.failed = options.failed;
      this.failureDetailsReturned = options.failureDetailsReturned;
      this.failureDetails = options.failureDetails;
      this.failureDetailsOmitted = options.failureDetailsOmitted;
    }
    if (
      options.reason === "http_status" ||
      options.reason === "timeout" ||
      options.reason === "transport_error"
    ) {
      this.eventCount = options.eventCount;
      this.requestBytes = options.requestBytes;
      this.timeoutMs = options.timeoutMs;
      this.elapsedMs = options.elapsedMs;
    }
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isAxiomIngestFailure(value: unknown): value is AxiomIngestFailure {
  return (
    isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.error === "string"
  );
}

function isAxiomIngestStatus(value: unknown): value is AxiomIngestStatus {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonNegativeInteger(value.ingested) &&
    isNonNegativeInteger(value.failed) &&
    isNonNegativeInteger(value.processedBytes) &&
    (value.blocksCreated === undefined ||
      isNonNegativeInteger(value.blocksCreated)) &&
    (value.walLength === undefined || isNonNegativeInteger(value.walLength)) &&
    (value.failures === undefined ||
      (Array.isArray(value.failures) &&
        value.failures.every(isAxiomIngestFailure)))
  );
}

function boundedAxiomIngestFailureError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  if (normalized.length <= AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, AXIOM_INGEST_FAILURE_ERROR_MAX_LENGTH - 3)}...`;
}

function axiomIngestUrl(dataset: string): string {
  return new URL(
    `/v1/datasets/${encodeURIComponent(dataset)}/ingest`,
    AXIOM_API_ORIGIN,
  ).toString();
}

interface PreparedAxiomIngest {
  readonly dataset: string;
  readonly token: string;
  readonly body: string;
  readonly eventCount: number;
  readonly requestBytes: number;
}

function prepareAxiomIngest(
  dataset: string,
  events: readonly Record<string, unknown>[],
): PreparedAxiomIngest | null {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  const token = optionalEnv(tokenEnvName);
  if (!token) {
    return null;
  }
  const body = JSON.stringify(events);
  return {
    dataset,
    token,
    body,
    eventCount: events.length,
    requestBytes: Buffer.byteLength(body, "utf8"),
  };
}

function axiomRetryAfterMs(value: string | null): number | undefined {
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

function sanitizedAxiomErrorDetail(
  value: string,
  request: PreparedAxiomIngest,
): string {
  // Remove raw and HTML-escaped request echoes before normalizing their text.
  const decoded = decodeHTML(
    value.replaceAll(request.body, "[redacted telemetry payload]"),
  ).replaceAll(request.body, "[redacted telemetry payload]");
  const normalized = Array.from(
    decoded.replace(/<[^>]*>/gu, " "),
    (character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    },
  ).join("");
  const redacted = normalized
    .replaceAll(request.token, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/giu, "[redacted authorization]")
    .replace(
      /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|secret|token)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/giu,
      "$1=[redacted]",
    )
    .replace(/\bhttps?:\/\/[^\s<>"]+/giu, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]");
  return boundedAxiomIngestFailureError(redacted);
}

function axiomErrorResponseMessage(text: string): string | undefined {
  const payload = safeJsonParse(text);
  if (typeof payload === "string") {
    return payload;
  }
  if (isRecord(payload)) {
    if (typeof payload.message === "string") {
      return payload.message;
    }
    if (typeof payload.error === "string") {
      return payload.error;
    }
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }
    return undefined;
  }
  // Proxies can return text/HTML. Do not dump malformed JSON or echoed objects.
  const firstCharacter = text.trimStart()[0];
  return payload === undefined &&
    firstCharacter !== "[" &&
    firstCharacter !== "{"
    ? text
    : undefined;
}

async function axiomErrorResponseBody(
  response: Response,
  request: PreparedAxiomIngest,
  signal: AbortSignal,
): Promise<AxiomHttpErrorResponse> {
  if (!response.body) {
    return {};
  }
  const reader = response.body.getReader();
  const readSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(AXIOM_ERROR_BODY_TIMEOUT_MS),
  ]);
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  // The HTTP status is already known. Optional diagnostics must not replace it.
  const read = async (): Promise<AxiomHttpErrorResponse> => {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), readSignal);
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > AXIOM_ERROR_BODY_MAX_BYTES) {
        return { responseBodyTruncated: true };
      }
      chunks.push(value);
    }
    const message = axiomErrorResponseMessage(
      Buffer.concat(chunks).toString("utf8"),
    );
    return {
      responseBodySummary:
        message === undefined
          ? undefined
          : sanitizedAxiomErrorDetail(message, request),
    };
  };
  const result = await settleIncludingAbort(read()).finally(() => {
    startUntrackedBestEffortCleanup(reader.cancel());
    reader.releaseLock();
  });
  return result.ok ? result.value : {};
}

async function axiomHttpErrorDetails(
  response: Response,
  request: PreparedAxiomIngest,
  timing: { readonly timeoutMs: number; readonly startedAt: number },
  signal: AbortSignal,
): Promise<AxiomHttpIngestErrorOptions> {
  const details = await axiomErrorResponseBody(response, request, signal);
  const requestId =
    response.headers.get("x-axiom-request-id") ??
    response.headers.get("x-request-id");
  const contentType = response.headers.get("content-type");
  return {
    reason: "http_status",
    dataset: request.dataset,
    status: response.status,
    retryAfterMs: axiomRetryAfterMs(response.headers.get("Retry-After")),
    eventCount: request.eventCount,
    requestBytes: request.requestBytes,
    timeoutMs: timing.timeoutMs,
    elapsedMs: Math.max(0, now() - timing.startedAt),
    upstreamRequestId: requestId
      ? sanitizedAxiomErrorDetail(requestId, request).slice(0, 128)
      : undefined,
    responseContentType: contentType
      ? sanitizedAxiomErrorDetail(contentType, request).slice(0, 128)
      : undefined,
    ...details,
  };
}

async function ingestAxiomRequest(
  request: PreparedAxiomIngest,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const { dataset, token, body, eventCount, requestBytes } = request;
  const startedAt = now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);

  const transportError = (error: unknown): DirectAxiomIngestError => {
    if (
      signal.aborted &&
      requestSignal.aborted &&
      requestSignal.reason === signal.reason
    ) {
      throw error;
    }

    const reason =
      timeoutSignal.aborted &&
      requestSignal.aborted &&
      requestSignal.reason === timeoutSignal.reason
        ? "timeout"
        : "transport_error";
    return new DirectAxiomIngestError(AXIOM_TRANSPORT_ERROR_MESSAGES[reason], {
      reason,
      dataset,
      eventCount,
      requestBytes,
      timeoutMs,
      elapsedMs: Math.max(0, now() - startedAt),
      cause: error,
    });
  };
  const fetchResult = await settleIncludingAbort(
    awaitWithSignal(
      fetch(axiomIngestUrl(dataset), {
        method: "POST",
        // Workers do not support "error". Reject non-2xx below without
        // forwarding the ingest token or payload to a redirect destination.
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal: requestSignal,
      }),
      requestSignal,
    ),
  );
  if (!fetchResult.ok) {
    throw transportError(fetchResult.error);
  }
  const response = fetchResult.value;

  if (!response.ok) {
    const details = await axiomHttpErrorDetails(
      response,
      request,
      { timeoutMs, startedAt },
      requestSignal,
    );
    signal.throwIfAborted();
    throw new DirectAxiomIngestError(
      `Axiom ingest failed with status ${response.status}`,
      details,
    );
  }

  const readResult = await settleIncludingAbort(
    awaitWithSignal(response.json(), requestSignal),
  );
  if (!readResult.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    if (requestSignal.aborted || !(readResult.error instanceof SyntaxError)) {
      throw transportError(readResult.error);
    }
    throw new DirectAxiomIngestError("Axiom ingest returned invalid JSON", {
      reason: "invalid_response",
      dataset,
    });
  }
  signal.throwIfAborted();
  const payload: unknown = readResult.value;
  if (!isAxiomIngestStatus(payload)) {
    throw new DirectAxiomIngestError(
      "Axiom ingest returned an unexpected response shape",
      { reason: "invalid_response", dataset },
    );
  }
  if (
    payload.failed !== 0 ||
    (payload.failures?.length ?? 0) !== 0 ||
    payload.ingested !== eventCount
  ) {
    const returnedFailureDetails = payload.failures ?? [];
    const failureDetails = returnedFailureDetails
      .slice(0, AXIOM_INGEST_FAILURE_DETAIL_LIMIT)
      .map((failure) => {
        return {
          timestamp: failure.timestamp,
          error: boundedAxiomIngestFailureError(failure.error),
        };
      });
    throw new DirectAxiomIngestError(
      `Axiom ingest accepted ${payload.ingested} of ${eventCount} events with ${payload.failed} failed events and ${payload.failures?.length ?? 0} failure details`,
      {
        reason: "partial_ingest",
        dataset,
        expected: eventCount,
        ingested: payload.ingested,
        failed: payload.failed,
        failureDetailsReturned: returnedFailureDetails.length,
        failureDetails,
        failureDetailsOmitted:
          returnedFailureDetails.length - failureDetails.length,
      },
    );
  }
}

/** Required telemetry retains one attempt and its caller-owned deadline. */
export async function ingestAxiomDirect(
  dataset: string,
  events: readonly Record<string, unknown>[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DirectAxiomIngestResult> {
  signal.throwIfAborted();
  const request = prepareAxiomIngest(dataset, events);
  if (!request) {
    return { configured: false };
  }
  await ingestAxiomRequest(request, timeoutMs, signal);
  return { configured: true };
}

/** Replay only optional traces: delivery is ambiguous and readers deduplicate. */
export async function ingestAxiomTrace(
  dataset: string,
  events: readonly Record<string, unknown>[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DirectAxiomIngestResult> {
  signal.throwIfAborted();
  const startedAt = now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const operationSignal = AbortSignal.any([signal, timeoutSignal]);
  const request = prepareAxiomIngest(dataset, events);
  if (!request) {
    return { configured: false };
  }
  const remainingMs = () => {
    return timeoutMs - (now() - startedAt);
  };
  const checkDeadline = () => {
    signal.throwIfAborted();
    if (timeoutSignal.aborted || remainingMs() <= 0) {
      throw new DirectAxiomIngestError("Axiom ingest timed out", {
        reason: "timeout",
        dataset,
        eventCount: request.eventCount,
        requestBytes: request.requestBytes,
        timeoutMs,
        elapsedMs: Math.max(0, now() - startedAt),
        cause: timeoutSignal.reason,
      });
    }
  };
  for (let attempt = 1; ; attempt += 1) {
    checkDeadline();
    const result = await settleIncludingAbort(
      ingestAxiomRequest(
        request,
        Math.min(AXIOM_TRACE_ATTEMPT_TIMEOUT_MS, remainingMs()),
        operationSignal,
      ),
    );
    checkDeadline();
    if (result.ok) {
      return { configured: true };
    }
    const { error } = result;
    const retryable =
      error instanceof DirectAxiomIngestError &&
      (error.reason === "timeout" ||
        error.reason === "transport_error" ||
        (error.reason === "http_status" &&
          error.status !== undefined &&
          [429, 500, 502, 503, 504].includes(error.status)));
    if (!retryable || attempt >= 2) {
      throw error;
    }
    const waitMs = Math.max(
      AXIOM_TRACE_RETRY_DELAY_MS +
        Math.floor(Math.random() * (AXIOM_TRACE_RETRY_DELAY_MS + 1)),
      error.retryAfterMs ?? 0,
    );
    if (waitMs >= remainingMs()) {
      throw error;
    }
    const waited = await settleIncludingAbort(
      delay(waitMs, { signal: operationSignal }),
    );
    checkDeadline();
    if (!waited.ok) {
      throw waited.error;
    }
  }
}

interface FlushAxiomOptions {
  readonly client?: "all" | AxiomClientName;
}

export async function flushAxiom(
  options: FlushAxiomOptions = {},
): Promise<void> {
  const selectedClient = options.client ?? "all";
  const flushes: {
    readonly client: AxiomClientName;
    readonly dataset: string;
    readonly promise: Promise<void>;
  }[] = [];
  const clients = axiomIngestClients();

  if (
    (selectedClient === "all" || selectedClient === "sessions") &&
    optionalEnv("AXIOM_TOKEN_SESSIONS")
  ) {
    for (const [dataset, client] of clients.sessions) {
      flushes.push({
        client: "sessions",
        dataset,
        promise: client.flush(),
      });
    }
  }
  if (
    (selectedClient === "all" || selectedClient === "telemetry") &&
    optionalEnv("AXIOM_TOKEN_TELEMETRY")
  ) {
    for (const [dataset, client] of clients.telemetry) {
      flushes.push({
        client: "telemetry",
        dataset,
        promise: client.flush(),
      });
    }
  }

  const results = await Promise.allSettled(
    flushes.map((flush) => {
      return flush.promise;
    }),
  );
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      L.error("Axiom client flush failed", {
        client: flushes[index]?.client ?? "unknown",
        dataset: flushes[index]?.dataset ?? "unknown",
        api_commit_sha: env("GIT_COMMIT_SHA"),
        error: serializeError(result.reason),
      });
    }
  }
}

// Minimal options surface. Fresh-read consumers bypass Axiom's per-request
// cache while waiting for asynchronously ingested terminal data; time bounds
// constrain dataset scans, and `cursor` is used for Axiom-managed pagination.
interface QueryAxiomOptions {
  readonly format?: "tabular";
  readonly noCache?: boolean;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly cursor?: string;
}

interface AxiomQueryMatch {
  readonly _time: string;
  readonly data: Record<string, unknown>;
}

interface AxiomQueryResult {
  readonly matches?: readonly AxiomQueryMatch[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAxiomQueryMatch(value: unknown): value is AxiomQueryMatch {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value._time === "string" && isRecord(value.data);
}

function isAxiomQueryResult(value: unknown): value is AxiomQueryResult {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.matches === undefined ||
    (Array.isArray(value.matches) && value.matches.every(isAxiomQueryMatch))
  );
}

function axiomAplQueryUrl(options: QueryAxiomOptions): string {
  const url = new URL("/v1/datasets/_apl", AXIOM_API_ORIGIN);
  url.searchParams.set("format", "legacy");
  if (options.noCache === true) {
    url.searchParams.set("nocache", "true");
  }
  return url.toString();
}

function mapAxiomMatches<T>(result: AxiomQueryResult): readonly T[] {
  return (
    result.matches?.map((m) => {
      return { ...m.data, _time: m._time } as T;
    }) ?? []
  );
}

async function queryAxiomDirectWithCursor<T>(
  apl: string,
  options: QueryAxiomOptions & { readonly cursor: string },
): Promise<readonly T[]> {
  const response = await fetch(axiomAplQueryUrl(options), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env(getAxiomTokenEnvNameForApl(apl))}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      apl,
      cursor: options.cursor,
    }),
    signal: AbortSignal.timeout(AXIOM_QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Axiom query failed with status ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isAxiomQueryResult(payload)) {
    throw new Error("Axiom query returned an unexpected response shape");
  }

  return mapAxiomMatches<T>(payload);
}

async function queryAxiomDirect<T = Record<string, unknown>>(
  apl: string,
  options?: QueryAxiomOptions,
): Promise<readonly T[]> {
  if (options?.cursor !== undefined && options.format !== "tabular") {
    return queryAxiomDirectWithCursor<T>(apl, {
      ...options,
      cursor: options.cursor,
    });
  }

  const client = axiomClientForApl(apl);
  const axiomOptions =
    options !== undefined
      ? {
          ...(options.noCache === undefined
            ? {}
            : { noCache: options.noCache }),
          ...(options.startTime === undefined
            ? {}
            : { startTime: options.startTime }),
          ...(options.endTime === undefined
            ? {}
            : { endTime: options.endTime }),
        }
      : undefined;
  if (options?.format === "tabular") {
    const result = await client.query(apl, {
      ...axiomOptions,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      format: "tabular",
    });
    if (result.status.isPartial) {
      throw new Error("Axiom query returned partial results");
    }
    return result.tables.flatMap((table) => {
      return [...table.events()];
    }) as readonly T[];
  }
  const result = await client.query(apl, {
    ...axiomOptions,
    format: "legacy",
  });
  return mapAxiomMatches<T>(result);
}

export function queryAxiom<T = Record<string, unknown>>(
  apl: string,
  options?: QueryAxiomOptions,
): Computed<Promise<readonly T[]>> {
  return computed((): Promise<readonly T[]> => {
    return queryAxiomDirect<T>(apl, options);
  });
}
