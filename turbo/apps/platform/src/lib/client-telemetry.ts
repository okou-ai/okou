import { Axiom } from "@axiomhq/js";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import type { HttpMethod } from "@okouai/api-contracts/contracts/trpc-contract";
import { recordTemporaryAuthFailure } from "@okouai/core/temporary-auth-diagnostics";

import { logger } from "../signals/log.ts";
import {
  isNonArrayRecord,
  jsonParseOr,
  onRejection,
} from "../signals/utils.ts";
import { resolvePlatformClientTelemetryConfig } from "./platform-host.ts";
import { now, nowDate } from "./time.ts";

// The browser-visible token is a write-only credential whose dataset scope is
// the security boundary for this direct-ingest client.
const AXIOM_CLIENT_TELEMETRY_DATASET = "vm0-client-telemetry-prod";
const CLIENT_TELEMETRY_SERVICE_NAME = "Okou-app";
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const L = logger("ClientTelemetry");

type ClientTelemetryOutcome = "aborted" | "error" | "started" | "success";
type ClientTelemetryStatusCode = "ERROR" | "OK";
type ClientTelemetryAttributeValue = number | string;
type ClientTelemetryAttributes = Readonly<
  Record<string, ClientTelemetryAttributeValue>
>;

interface ClientTelemetryMeasurement {
  readonly startedAt: string;
  readonly startedAtMonotonic: number;
}

type IndexedDbDatabase = "chat" | "voice_drafts";

interface IndexedDbOpenTelemetry {
  readonly event_name: "indexeddb.open";
  readonly database: IndexedDbDatabase;
}

interface IndexedDbTransactionCreateTelemetry {
  readonly event_name: "indexeddb.transaction.create";
  readonly database: IndexedDbDatabase;
  readonly template: string;
  readonly transaction_mode: IDBTransactionMode;
}

interface IndexedDbTransactionTelemetry {
  readonly event_name: "indexeddb.transaction";
  readonly database: IndexedDbDatabase;
  readonly template: string;
  readonly transaction_mode: IDBTransactionMode;
  readonly request_count: number;
}

interface SharedDatabaseQueryTelemetry {
  readonly event_name: "shared_database.query";
  readonly template: string;
}

interface SharedWorkerFailureTelemetry {
  readonly event_name: "shared_worker.failure";
  readonly phase: "error-event";
  readonly script_path: string;
}

interface HttpRequestTelemetry {
  readonly event_name: "http.request";
  readonly method: HttpMethod;
  readonly route: string;
  readonly response_status_code?: number;
}

interface MarketingEventSendTelemetry {
  readonly event_name: "marketing.event.send";
  readonly tag: "onboarding-start" | "checkout-start";
  readonly user_id: string;
  readonly org_id: string;
}

export type ClientTelemetryOperation =
  | IndexedDbOpenTelemetry
  | IndexedDbTransactionCreateTelemetry
  | IndexedDbTransactionTelemetry
  | SharedDatabaseQueryTelemetry
  | SharedWorkerFailureTelemetry
  | HttpRequestTelemetry
  | MarketingEventSendTelemetry;

function runtimeName(): "shared_worker" | "window" {
  return typeof window === "undefined" ? "shared_worker" : "window";
}

function scopeName(operation: ClientTelemetryOperation): string {
  if (operation.event_name === "marketing.event.send") {
    return "okou-app/marketing";
  }
  if (operation.event_name === "shared_worker.failure") {
    return "okou-app/shared-worker";
  }
  if (
    operation.event_name === "indexeddb.open" ||
    operation.event_name === "indexeddb.transaction.create" ||
    operation.event_name === "indexeddb.transaction"
  ) {
    return "okou-app/indexeddb";
  }
  return operation.event_name === "shared_database.query"
    ? "okou-app/shared-worker-query"
    : "okou-app/http";
}

function statusCode(
  operation: ClientTelemetryOperation,
  outcome: ClientTelemetryOutcome,
): ClientTelemetryStatusCode | undefined {
  if (
    outcome === "aborted" ||
    outcome === "started" ||
    (operation.event_name === "http.request" &&
      operation.response_status_code !== undefined &&
      operation.response_status_code >= 400 &&
      operation.response_status_code < 500)
  ) {
    return undefined;
  }
  return outcome === "success" ? "OK" : "ERROR";
}

function operationName(operation: ClientTelemetryOperation): string {
  if (
    operation.event_name === "shared_worker.failure" ||
    operation.event_name === "marketing.event.send"
  ) {
    return operation.event_name;
  }
  if (operation.event_name === "http.request") {
    return `${operation.method} ${operation.route}`;
  }
  if (operation.event_name === "indexeddb.open") {
    return `${operation.database}.open`;
  }
  if (operation.event_name === "indexeddb.transaction.create") {
    return `${operation.template}.transaction.create`;
  }
  return operation.template;
}

function operationAttributes(
  operation: ClientTelemetryOperation,
): ClientTelemetryAttributes {
  if (operation.event_name === "marketing.event.send") {
    return {
      "okou.marketing.event.tag": operation.tag,
      "okou.marketing.event.user_id": operation.user_id,
      "okou.marketing.event.org_id": operation.org_id,
    };
  }
  if (operation.event_name === "shared_worker.failure") {
    return {
      "okou.shared_worker.failure.phase": operation.phase,
      "okou.shared_worker.script_path": operation.script_path,
    };
  }
  if (operation.event_name === "indexeddb.open") {
    return {
      "db.namespace": operation.database,
      "db.system": "indexeddb",
    };
  }
  if (operation.event_name === "indexeddb.transaction.create") {
    return {
      "db.namespace": operation.database,
      "db.system": "indexeddb",
      "okou.db.transaction.mode": operation.transaction_mode,
    };
  }
  if (operation.event_name !== "indexeddb.transaction") {
    return {};
  }
  return {
    "db.namespace": operation.database,
    "db.system": "indexeddb",
    "okou.db.request.count": operation.request_count,
    "okou.db.transaction.mode": operation.transaction_mode,
  };
}

function httpAttributes(
  operation: ClientTelemetryOperation,
): ClientTelemetryAttributes {
  if (operation.event_name !== "http.request") {
    return {};
  }
  return {
    "attributes.http.request.method": operation.method,
    "attributes.http.route": operation.route,
    ...(operation.response_status_code === undefined
      ? {}
      : {
          "attributes.http.response.status_code":
            operation.response_status_code,
        }),
  };
}

function createTelemetryClientCache(): (token: string) => Axiom {
  let cached:
    | {
        readonly client: Axiom;
        readonly token: string;
      }
    | undefined;

  return (token) => {
    if (cached?.token === token) {
      return cached.client;
    }
    const client = new Axiom({
      token,
      onError(error) {
        L.warn("Axiom client telemetry failed", { error });
      },
    });
    cached = { client, token };
    return client;
  };
}

const telemetryClient = createTelemetryClientCache();

export function clientTelemetryOutcomeForError(
  error: unknown,
): ClientTelemetryOutcome {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
    ? "aborted"
    : "error";
}

export function startClientTelemetryMeasurement(): ClientTelemetryMeasurement {
  return {
    startedAt: nowDate().toISOString(),
    startedAtMonotonic: performance.now(),
  };
}

export function recordClientTelemetry(
  measurement: ClientTelemetryMeasurement,
  operation: ClientTelemetryOperation,
  outcome: ClientTelemetryOutcome,
): void {
  const config = resolvePlatformClientTelemetryConfig();
  if (!config.token) {
    return;
  }
  const client = telemetryClient(config.token);
  const duration = Math.round(
    Math.max(0, performance.now() - measurement.startedAtMonotonic) *
      NANOSECONDS_PER_MILLISECOND,
  );
  const resolvedStatusCode = statusCode(operation, outcome);

  client.ingest(AXIOM_CLIENT_TELEMETRY_DATASET, [
    {
      _time: measurement.startedAt,
      "attributes.custom": {
        "okou.client.outcome": outcome,
        "okou.client.runtime": runtimeName(),
        ...operationAttributes(operation),
      },
      duration,
      kind: "client",
      name: operationName(operation),
      ...httpAttributes(operation),
      "resource.deployment.environment.name": config.environment,
      "scope.name": scopeName(operation),
      "service.name": CLIENT_TELEMETRY_SERVICE_NAME,
      "service.version": __OKOU_APP_VERSION__,
      ...(resolvedStatusCode === undefined
        ? {}
        : { "status.code": resolvedStatusCode }),
    },
  ]);
}

// Temporary #36177 diagnostics. Decoded claims are unverified observations;
// they never affect authentication and no claim values leave the client.
function authTokenClaims(token: string | null): Record<string, unknown> | null {
  const payload = token?.split(".")[1]?.replace(/=+$/u, "");
  if (
    !payload ||
    payload.length > 16_384 ||
    payload.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(payload)
  ) {
    return null;
  }
  const claims = jsonParseOr<unknown>(
    atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
    null,
  );
  return isNonArrayRecord(claims) ? claims : null;
}

export function recordClientAuthFailure(request: {
  readonly headers: Headers;
  readonly method: HttpMethod;
  readonly route: string;
  readonly startedAt: number;
}): void {
  const timestamp = now();

  // Telemetry is best effort, including SDK construction/ingestion failures.
  // Always let callers observe the original 401.
  recordTemporaryAuthFailure(timestamp, () => {
    const config = resolvePlatformClientTelemetryConfig();
    if (!config.token) {
      return;
    }
    const authorization = request.headers.get("Authorization");
    const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
    const claims = authTokenClaims(token);
    const expiresAt =
      typeof claims?.exp === "number" && Number.isFinite(claims.exp)
        ? claims.exp
        : null;
    const org = claims?.o;
    const hasOrg =
      (typeof claims?.org_id === "string" && claims.org_id.length > 0) ||
      (typeof org === "object" &&
        org !== null &&
        "id" in org &&
        typeof org.id === "string" &&
        org.id.length > 0);

    telemetryClient(config.token).ingest(AXIOM_CLIENT_TELEMETRY_DATASET, [
      {
        _time: new Date(timestamp).toISOString(),
        level: "info",
        source: "client",
        fields: {
          type: "temporary_auth_failure",
          runtime: runtimeName(),
          requestId: request.headers.get(CLIENT_REQUEST_ID_HEADER),
          clientSessionId: request.headers.get(CLIENT_SESSION_ID_HEADER),
          clientVersion: request.headers.get(CLIENT_VERSION_HEADER),
          method: request.method,
          route: request.route,
          status: 401,
          has_bearer_token: token !== null,
          jwt_decoded: claims !== null,
          token_has_org: claims === null ? null : hasOrg,
          token_ttl_at_request_seconds:
            expiresAt === null
              ? null
              : Math.floor(expiresAt - request.startedAt / 1000),
          token_ttl_at_response_seconds:
            expiresAt === null
              ? null
              : Math.floor(expiresAt - timestamp / 1000),
        },
        "resource.deployment.environment.name": config.environment,
        "service.name": CLIENT_TELEMETRY_SERVICE_NAME,
        "service.version": __OKOU_APP_VERSION__,
      },
    ]);
  });
}

export async function flushClientTelemetry(): Promise<void> {
  const config = resolvePlatformClientTelemetryConfig();
  if (config.token) {
    await telemetryClient(config.token).flush();
  }
}

export async function observeClientOperation<TResult>(
  operation: ClientTelemetryOperation,
  execute: () => Promise<TResult>,
): Promise<TResult> {
  const measurement = startClientTelemetryMeasurement();
  const result = await onRejection(execute, (error) => {
    recordClientTelemetry(
      measurement,
      operation,
      clientTelemetryOutcomeForError(error),
    );
  });
  recordClientTelemetry(measurement, operation, "success");
  return result;
}
