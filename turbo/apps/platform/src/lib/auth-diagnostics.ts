import {
  collectTemporaryAuthDiagnostic,
  recordTemporaryAuthFailure,
} from "@okouai/core/temporary-auth-diagnostics";
import {
  authTokenDiagnostics,
  clientTelemetryOutcomeForError,
  recordClientTelemetry,
  type ClientTelemetryOutcome,
} from "./client-telemetry.ts";
import { getClientSessionId } from "../signals/client-headers.ts";
import { onRejection } from "../signals/utils.ts";
import { now } from "./time.ts";

/** Invocation-local metadata only; never store a token or SDK identity here. */
export interface AuthDiagnosticContext {
  readonly operationId?: string;
  readonly readBrowserContext?: () => {
    readonly visibility: "visible" | "hidden";
    readonly iosLike: boolean;
    readonly displayMode: "standalone" | "browser";
  };
  readonly realtimeInstanceId?: string;
  readonly ablyAuthId?: string;
  readonly connectionId?: string;
  readonly phase?: "preferred" | "broadcast";
  // A provider sets its own attempt; only the selected provider copies it to
  // the caller's context. Concurrent and late responses cannot overwrite it.
  tokenAttemptId?: string;
}

export type AuthTokenProvider = (
  diagnostic?: AuthDiagnosticContext,
  signal?: AbortSignal,
) => Promise<string | null>;

interface AuthDiagnosticMeasurement {
  readonly wall: number;
  readonly monotonic: number;
}

interface AuthDiagnosticEvent {
  readonly stage:
    | "token_read_started"
    | "token_read_finished"
    | "clerk_sdk_started"
    | "clerk_sdk_finished"
    | "clerk_no_session"
    | "tab_token_requested"
    | "tab_token_received"
    | "tab_token_read_finished"
    | "tab_token_reply"
    | "worker_token_received"
    | "worker_token_selected"
    | "http_send_invoked"
    | "http_finished"
    | "page_visibility"
    | "ably_auth_started"
    | "ably_auth_api_finished"
    | "ably_auth_callback"
    | "ably_token_exchange_started"
    | "ably_token_exchange_finished"
    | "ably_connection"
    | "ably_channel";
  readonly context?: AuthDiagnosticContext;
  readonly token?: string | null;
  readonly measurement?: AuthDiagnosticMeasurement;
  readonly outcome?: ClientTelemetryOutcome;
  readonly ownerAborted?: boolean;
  readonly accepted?: boolean;
  readonly skipCache?: boolean;
  readonly requestId?: string;
  readonly exchangeAttemptId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
  readonly source?: "initial" | "visibilitychange" | "pageshow" | "pagehide";
  readonly previousState?: string;
  readonly state?: string;
  readonly retryInMs?: number;
  readonly reasonCode?: number;
  readonly reasonStatusCode?: number;
  readonly reason?: unknown;
  readonly scope?: "credential" | "user" | "org" | "run-output";
  readonly resumed?: boolean;
}

/** This clock is diagnostic only and may never fail the operation being read. */
export function startAuthDiagnosticMeasurement():
  AuthDiagnosticMeasurement | undefined {
  return collectTemporaryAuthDiagnostic(now, (timestamp) => {
    return { wall: timestamp, monotonic: performance.now() };
  });
}

export function createAuthDiagnosticId(): string | undefined {
  return collectTemporaryAuthDiagnostic(now, () => {
    return crypto.randomUUID();
  });
}

function browserContext(
  context: AuthDiagnosticContext | undefined,
): Readonly<Record<string, string | number>> {
  const browser = context?.readBrowserContext?.();
  if (!browser) {
    return {};
  }
  return {
    "okou.auth.visibility": browser.visibility,
    "okou.auth.ios_like": browser.iosLike ? 1 : 0,
    "okou.auth.display_mode": browser.displayMode,
  };
}

function diagnosticProperty(value: unknown, property: string): unknown {
  return typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, property)?.value
    : undefined;
}

function diagnosticNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function diagnosticStatus(error: unknown): number | undefined {
  const status = diagnosticNumber(diagnosticProperty(error, "statusCode"));
  return status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

function diagnosticErrorType(error: unknown): string {
  const status = diagnosticStatus(error);
  if (status === 408) {
    return "http_408";
  }
  if (status !== undefined && status >= 500) {
    return "http_5xx";
  }
  if (status !== undefined && status >= 400) {
    return "http_4xx";
  }
  return "unknown";
}

/** Fixed numeric fields and allowlisted categories only. A bounded walk also
 * handles cyclic provider causes without reading messages, stacks or bodies.
 */
function diagnosticReason(reason: unknown) {
  return collectTemporaryAuthDiagnostic(now, () => {
    if (reason === undefined || reason === null) {
      return {};
    }
    let cause = diagnosticProperty(reason, "cause");
    let depth = 0;
    let leaf: unknown;
    const visited = new Set<unknown>([reason]);
    while (
      typeof cause === "object" &&
      cause !== null &&
      !visited.has(cause) &&
      depth < 4
    ) {
      visited.add(cause);
      leaf = cause;
      depth++;
      cause = diagnosticProperty(cause, "cause");
    }
    return {
      reason_code: diagnosticNumber(diagnosticProperty(reason, "code")),
      reason_status_code: diagnosticStatus(reason),
      reason_type: diagnosticErrorType(reason),
      reason_cause_depth: depth,
      reason_cause_code: diagnosticNumber(diagnosticProperty(leaf, "code")),
      reason_cause_status_code: diagnosticStatus(leaf),
      reason_cause_type: depth ? diagnosticErrorType(leaf) : undefined,
    };
  });
}

/** Passive point records: _time is the observed callback time, not its start.
 * Collection and transport are best effort and expire with the auth probe.
 * No flushing, await, token validation decision, or recovery happens here.
 */
export function recordAuthDiagnostic(event: AuthDiagnosticEvent): void {
  collectTemporaryAuthDiagnostic(now, (timestamp) => {
    let credentialAttributes: Record<string, string | number> =
      event.token === undefined
        ? {}
        : {
            "okou.auth.token_present": event.token === null ? 0 : 1,
            "okou.auth.jwt_decoded": 0,
          };
    // Invalid base64 must yield unknown expiry, not erase the milestone.
    recordTemporaryAuthFailure(timestamp, () => {
      if (event.token !== undefined) {
        credentialAttributes = authTokenDiagnostics(event.token, timestamp);
      }
    });
    const attributes: Record<string, string | number> = {
      "okou.auth.schema_version": 1,
      "okou.auth.stage": event.stage,
      "okou.auth.event_at_ms": timestamp,
      "okou.auth.client_session_id": getClientSessionId(),
      ...browserContext(event.context),
      ...credentialAttributes,
    };
    const context = event.context;
    const fields = {
      operation_id: context?.operationId,
      realtime_instance_id: context?.realtimeInstanceId,
      ably_auth_id: context?.ablyAuthId,
      connection_id: context?.connectionId,
      token_attempt_id: context?.tokenAttemptId,
      provider_phase: context?.phase,
      http_request_id: event.requestId,
      exchange_attempt_id: event.exchangeAttemptId,
      method: event.method,
      route: event.route,
      status: event.status,
      source: event.source,
      previous_state: event.previousState,
      state: event.state,
      retry_in_ms: event.retryInMs,
      reason_code: event.reasonCode,
      reason_status_code: event.reasonStatusCode,
      channel_scope: event.scope,
      ...diagnosticReason(event.reason),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        attributes[`okou.auth.${key}`] = value;
      }
    }
    for (const [key, value] of Object.entries({
      owner_aborted: event.ownerAborted,
      accepted: event.accepted,
      skip_cache: event.skipCache,
      resumed: event.resumed,
    })) {
      if (value !== undefined) {
        attributes[`okou.auth.${key}`] = value ? 1 : 0;
      }
    }
    if (event.measurement) {
      attributes["okou.auth.started_at_ms"] = event.measurement.wall;
      attributes["okou.auth.elapsed_wall_ms"] =
        timestamp - event.measurement.wall;
      attributes["okou.auth.elapsed_monotonic_ms"] =
        performance.now() - event.measurement.monotonic;
    }
    recordClientTelemetry(
      {
        startedAt: new Date(timestamp).toISOString(),
        startedAtMonotonic: performance.now(),
      },
      { event_name: "auth.lifecycle", attributes },
      event.outcome ?? "success",
    );
  });
}

export async function observeAuthTokenRead(
  execute: () => Promise<string | null>,
  context: AuthDiagnosticContext,
  request: { readonly method: string; readonly route: string },
  signal?: AbortSignal,
): Promise<string | null> {
  const measurement = startAuthDiagnosticMeasurement();
  recordAuthDiagnostic({
    stage: "token_read_started",
    context,
    ...request,
    outcome: "started",
  });
  // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: temporary 401 token-read diagnostics.
  const token = await onRejection(execute, (error) => {
    recordAuthDiagnostic({
      stage: "token_read_finished",
      context,
      ...request,
      measurement,
      outcome: clientTelemetryOutcomeForError(error),
      ownerAborted: signal?.aborted,
    });
  });
  recordAuthDiagnostic({
    stage: "token_read_finished",
    context,
    ...request,
    measurement,
    token,
    ownerAborted: signal?.aborted,
  });
  return token;
}

export async function observeAuthHttpRequest<
  T extends { readonly status: number },
>(
  execute: () => Promise<T>,
  context: AuthDiagnosticContext,
  request: {
    readonly requestId?: string;
    readonly method: string;
    readonly route: string;
    readonly token: string | null;
  },
): Promise<T> {
  const measurement = startAuthDiagnosticMeasurement();
  recordAuthDiagnostic({
    stage: "http_send_invoked",
    context,
    ...request,
    outcome: "started",
  });
  // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: temporary 401 HTTP diagnostics.
  const response = await onRejection(execute, (error) => {
    recordAuthDiagnostic({
      stage: "http_finished",
      context,
      ...request,
      measurement,
      outcome: clientTelemetryOutcomeForError(error),
    });
  });
  recordAuthDiagnostic({
    stage: "http_finished",
    context,
    ...request,
    measurement,
    status: response.status,
    outcome: response.status >= 400 ? "error" : "success",
  });
  return response;
}

/** Observe the SDK promise itself, including completion after the owner aborts.
 * The returned promise stays consumed by the existing cancellation race.
 */
export async function observeClerkToken(
  execute: () => Promise<string | null>,
  context: AuthDiagnosticContext | undefined,
  skipCache: boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  const measurement = startAuthDiagnosticMeasurement();
  recordAuthDiagnostic({
    stage: "clerk_sdk_started",
    context,
    skipCache,
    outcome: "started",
  });
  // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: temporary 401 Clerk SDK diagnostics.
  const token = await onRejection(execute, (error) => {
    recordAuthDiagnostic({
      stage: "clerk_sdk_finished",
      context,
      skipCache,
      measurement,
      ownerAborted: signal?.aborted,
      outcome: clientTelemetryOutcomeForError(error),
    });
  });
  recordAuthDiagnostic({
    stage: "clerk_sdk_finished",
    context,
    skipCache,
    measurement,
    token,
    ownerAborted: signal?.aborted,
  });
  return token;
}
