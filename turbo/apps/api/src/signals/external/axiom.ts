import { computed, type Computed } from "ccstate";
import { Axiom } from "@axiomhq/js";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { singleton } from "../../lib/singleton";
import { now } from "../../lib/time";
import {
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
    error,
  });
}

const sessionsAxiomQueryClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_SESSIONS"),
    onError: (error) => {
      logClientError("sessions", error);
    },
  });
});

const telemetryAxiomQueryClient = singleton(() => {
  return new Axiom({
    token: env("AXIOM_TOKEN_TELEMETRY"),
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
  | { readonly configured: false }
  | { readonly configured: true };

type DirectAxiomIngestErrorOptions =
  | {
      readonly reason: "http_status";
      readonly dataset: string;
      readonly status: number;
    }
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

class DirectAxiomIngestError extends Error {
  readonly reason:
    | "http_status"
    | "invalid_response"
    | "partial_ingest"
    | "timeout"
    | "transport_error";
  readonly dataset: string;
  readonly status?: number;
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
    }
    if (options.reason === "partial_ingest") {
      this.expected = options.expected;
      this.ingested = options.ingested;
      this.failed = options.failed;
      this.failureDetailsReturned = options.failureDetailsReturned;
      this.failureDetails = options.failureDetails;
      this.failureDetailsOmitted = options.failureDetailsOmitted;
    }
    if (options.reason === "timeout" || options.reason === "transport_error") {
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

export async function ingestAxiomDirect(
  dataset: string,
  events: readonly Record<string, unknown>[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<DirectAxiomIngestResult> {
  const tokenEnvName = getAxiomTokenEnvNameForDataset(dataset);
  const token = optionalEnv(tokenEnvName);
  if (!token) {
    return { configured: false };
  }

  const body = JSON.stringify(events);
  const requestBytes = Buffer.byteLength(body, "utf8");
  const startedAt = now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  const fetchResult = await settleIncludingAbort(
    fetch(axiomIngestUrl(dataset), {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      signal: requestSignal,
    }),
  );
  if (!fetchResult.ok) {
    if (
      signal.aborted &&
      requestSignal.aborted &&
      requestSignal.reason === signal.reason
    ) {
      throw fetchResult.error;
    }

    const reason =
      timeoutSignal.aborted &&
      requestSignal.aborted &&
      requestSignal.reason === timeoutSignal.reason
        ? "timeout"
        : "transport_error";
    throw new DirectAxiomIngestError(AXIOM_TRANSPORT_ERROR_MESSAGES[reason], {
      reason,
      dataset,
      eventCount: events.length,
      requestBytes,
      timeoutMs,
      elapsedMs: Math.max(0, now() - startedAt),
      cause: fetchResult.error,
    });
  }
  const response = fetchResult.value;

  if (!response.ok) {
    if (response.body) {
      startUntrackedBestEffortCleanup(response.body.cancel());
    }
    throw new DirectAxiomIngestError(
      `Axiom ingest failed with status ${response.status}`,
      {
        reason: "http_status",
        dataset,
        status: response.status,
      },
    );
  }

  const payload: unknown = await response.json();
  if (!isAxiomIngestStatus(payload)) {
    throw new DirectAxiomIngestError(
      "Axiom ingest returned an unexpected response shape",
      { reason: "invalid_response", dataset },
    );
  }
  if (
    payload.failed !== 0 ||
    (payload.failures?.length ?? 0) !== 0 ||
    payload.ingested !== events.length
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
      `Axiom ingest accepted ${payload.ingested} of ${events.length} events with ${payload.failed} failed events and ${payload.failures?.length ?? 0} failure details`,
      {
        reason: "partial_ingest",
        dataset,
        expected: events.length,
        ingested: payload.ingested,
        failed: payload.failed,
        failureDetailsReturned: returnedFailureDetails.length,
        failureDetails,
        failureDetailsOmitted:
          returnedFailureDetails.length - failureDetails.length,
      },
    );
  }

  return { configured: true };
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
        error: result.reason,
      });
    }
  }
}

// Minimal options surface. Fresh-read consumers bypass Axiom's per-request
// cache while waiting for asynchronously ingested terminal data; time bounds
// constrain dataset scans, and `cursor` is used for Axiom-managed pagination.
interface QueryAxiomOptions {
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
  if (options?.cursor !== undefined) {
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
  const result = await client.query(apl, axiomOptions);
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
