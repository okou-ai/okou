import { createHash } from "node:crypto";

import { httpInstrumentationMiddleware } from "@hono/otel";
import * as Sentry from "@sentry/node";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_PRODUCT_HEADER,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
  desktopProductFromClientHeader,
} from "@okouai/api-contracts/contracts/client-headers";
import { serializeError } from "@okouai/core/log-utils";
// oxlint-disable-next-line no-restricted-imports -- app factory owns the Hono instance
import { Hono, type Context, type Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { matchedRoutes } from "hono/route";

import { corsMiddleware } from "./lib/cors";
import { env } from "./lib/env";
import { flushLogs, logger } from "./lib/log";
import {
  cookieHeaderValue,
  previewAutomationBypassSecret,
  requestHasPreviewAutomationBypassHeaderOrCookie,
  VERCEL_PROTECTION_BYPASS_HEADER,
} from "./lib/preview-automation-bypass";
import { now } from "./lib/time";
import { isSupportedWebClientVersion } from "./lib/web-client-compatibility";
import { waitUntil } from "./signals/context/wait-until";
import { honoSignalHandler } from "./signals/context/route";
import {
  flushAxiom,
  getDatasetName,
  ingestToAxiom,
} from "./signals/external/axiom";
import type { RouteEntry } from "./signals/route-entry";
import { configureChatRunFinishedEventDispatcher } from "./signals/services/chat-run-finished-event-registration.service";
import { configureOfficialWorkflowReconciliationDispatcher } from "./signals/services/official-workflow-reconciliation-registration.service";
import { configurePiApiFirstTurnDispatcher } from "./signals/services/pi-api-first-turn-registration.service";
import type { UsagePricingResolution } from "./signals/context/usage-pricing-resolution";
import type { SystemSkillStorageResolution } from "./signals/context/system-skill-storage-resolution";
import {
  isAbortError,
  normalizeThrown,
  safeSync,
  safeUrlParse,
} from "./signals/utils";

const L = logger("App");

const AUTH_PATHS = ["/sign-in", "/sign-up"] as const;
const PREVIEW_AUTOMATION_BYPASS_ERROR = "Preview automation bypass required";
const BYPASS_FINGERPRINT_LENGTH = 12;
const UNHANDLED_REQUEST_ERROR_TYPE = "unhandled_request_error" as const;
const REQUEST_LOG_DATASET = "request-log";
const ERROR_CHAIN_MAX_DEPTH = 32;
const ERROR_SUMMARY_MAX_LENGTH = 240;
const ERROR_SUMMARY_SOURCE_MAX_LENGTH = 4096;

interface UnhandledRequestErrorLogFields {
  readonly type: typeof UNHANDLED_REQUEST_ERROR_TYPE;
  readonly errorSummary: string;
  readonly method: string;
  readonly route?: string;
  readonly errorCode?: string;
  readonly error: Record<string, unknown>;
}

interface ClientHeaderLogFields {
  readonly x_client_version?: string;
  readonly x_client_type?: string;
  readonly x_client_product?: string;
  readonly x_client_session_id?: string;
  readonly x_client_request_id?: string;
}

interface AxiomRequestLogEvent
  extends ClientHeaderLogFields, Record<string, unknown> {
  readonly _time: string;
  readonly method: string;
  readonly status: number;
  readonly host: string;
  readonly path_template: string;
  readonly request_time_ms: number;
  readonly body_bytes_sent?: number;
  readonly remote_addr?: string;
  readonly user_agent?: string;
}

type ErrorWithCode = Error & { readonly code?: unknown };

function shouldCaptureError(error: unknown): boolean {
  return !(error instanceof HTTPException) || error.status >= 500;
}

function captureError(error: unknown): void {
  if (shouldCaptureError(error)) {
    Sentry.captureException(error);
  }
}

function redirectToApp(context: Context): Response {
  const incoming = new URL(context.req.url);
  const target = new URL(
    `${incoming.pathname}${incoming.search}`,
    env("APP_URL"),
  );
  return context.redirect(target.toString());
}

function readErrorValue(read: () => unknown): unknown {
  const result = safeSync(read);
  return "ok" in result ? result.ok : undefined;
}

function summarySource(value: string): string | undefined {
  const source = value.slice(0, ERROR_SUMMARY_SOURCE_MAX_LENGTH).trim();
  return source || undefined;
}

function readNonErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = readErrorValue(() => {
      return (error as { readonly message?: unknown }).message;
    });
    if (typeof message === "string") {
      const source = summarySource(message);
      if (source) {
        return source;
      }
    }
  }
  const value = readErrorValue(() => {
    return String(error);
  });
  if (typeof value === "string") {
    const source = summarySource(value);
    if (source) {
      return source;
    }
  }
  return "unknown error";
}

function errorCause(error: Error): Error | undefined {
  const cause = readErrorValue(() => {
    return error.cause;
  });
  return cause instanceof Error ? cause : undefined;
}

function errorMessage(error: Error): string | undefined {
  const message = readErrorValue(() => {
    return error.message;
  });
  return typeof message === "string" ? message : undefined;
}

function errorName(error: Error): string | undefined {
  const name = readErrorValue(() => {
    return error.name;
  });
  return typeof name === "string" ? name : undefined;
}

function errorCode(error: Error): unknown {
  return readErrorValue(() => {
    return (error as ErrorWithCode).code;
  });
}

function errorChain(error: Error): readonly Error[] {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let current: Error | undefined = error;
  while (
    current &&
    !seen.has(current) &&
    chain.length < ERROR_CHAIN_MAX_DEPTH
  ) {
    chain.push(current);
    seen.add(current);
    current = errorCause(current);
  }
  return chain;
}

function sourceErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return readNonErrorMessage(error);
  }
  const chain = errorChain(error);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const current = chain[index];
    const message = current ? errorMessage(current) : undefined;
    if (message) {
      const source = summarySource(message);
      if (source) {
        return source;
      }
    }
  }
  const name = errorName(error);
  return name ? (summarySource(name) ?? "unknown error") : "unknown error";
}

function truncateSummary(summary: string): string {
  if (summary.length <= ERROR_SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, ERROR_SUMMARY_MAX_LENGTH - 3)}...`;
}

function replaceControlCharacters(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code <= 31 || code === 127 ? " " : char;
  }
  return result;
}

function sanitizeErrorSummary(error: unknown): string {
  const source = sourceErrorMessage(error);
  if (/^response validation failed:/i.test(source)) {
    return "response validation failed";
  }

  const summary = replaceControlCharacters(source)
    .replace(/\bhttps?:\/\/[^\s]+/gi, "[url]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "[id]",
    )
    .replace(
      /\b(?:user|org)_(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{9,}\b/g,
      "[id]",
    )
    .replace(
      /\bAuthorization\b\s*[:=]\s*["']?(?:Bearer|Basic|Digest|Token)\s+[^,\s"']+/gi,
      "Authorization=[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_\s-]?key|access[_\s-]?token|refresh[_\s-]?token|id[_\s-]?token|client[_\s-]?secret|authorization|password|secret|token)\b\s*[:=]\s*["']?[^,\s"']+/gi,
      "$1=[redacted]",
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, "[hash]")
    .replace(/\b\d{8,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();

  return truncateSummary(summary || "unknown error");
}

function structuredErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  for (const current of errorChain(error)) {
    const code = errorCode(current);
    if (typeof code === "number" && Number.isFinite(code)) {
      return String(code);
    }
    if (typeof code === "string") {
      const normalized = code.trim();
      if (/^[A-Za-z0-9_.:-]{1,80}$/.test(normalized)) {
        return normalized;
      }
    }
  }
  return undefined;
}

function isTemplateRoute(path: string): boolean {
  return path !== "*" && path !== "/*";
}

function requestRouteTemplate(context: Context): string | undefined {
  const result = safeSync(() => {
    return matchedRoutes(context);
  });
  if (!("ok" in result)) {
    return undefined;
  }
  const routes = result.ok;
  for (let index = routes.length - 1; index >= 0; index -= 1) {
    const path = routes[index]?.path;
    if (path && isTemplateRoute(path)) {
      return path;
    }
  }
  return undefined;
}

function presentHeaderValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function requestHeader(context: Context, name: string): string | undefined {
  return presentHeaderValue(context.req.raw.headers.get(name));
}

function requestHasPreviewAutomationBypass(
  context: Context,
  secret: string,
): boolean {
  if (
    requestHasPreviewAutomationBypassHeaderOrCookie(context.req.raw, secret)
  ) {
    return true;
  }
  const url = safeUrlParse(context.req.url);
  return url?.searchParams.get(VERCEL_PROTECTION_BYPASS_HEADER) === secret;
}

function isCorsPreflightRequest(context: Context): boolean {
  return (
    context.req.method === "OPTIONS" &&
    Boolean(requestHeader(context, "origin")) &&
    Boolean(requestHeader(context, "access-control-request-method"))
  );
}

// External server-to-server webhook callers cannot present the Vercel bypass
// secret, so the preview automation guard must let their paths through even on
// protected preview/staging deployments. This covers every third-party and
// runner webhook (Stripe/Clerk/GitHub/... and `/api/webhooks/agent/*`). Each of
// these endpoints authenticates its own requests (webhook signatures, runner
// auth tokens), so exempting them from the preview guard does not widen access.
// Browser-driven OAuth callbacks are intentionally excluded: they carry the
// bypass cookie and stay behind the guard.
function isPreviewAutomationBypassExemptPath(context: Context): boolean {
  return context.req.path.startsWith("/api/webhooks/");
}

function bypassFingerprint(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, BYPASS_FINGERPRINT_LENGTH);
}

function previewAutomationBypassDebug(context: Context, secret: string) {
  const url = safeUrlParse(context.req.url);
  return {
    expected: bypassFingerprint(secret),
    header: bypassFingerprint(
      requestHeader(context, VERCEL_PROTECTION_BYPASS_HEADER),
    ),
    query: bypassFingerprint(
      url?.searchParams.get(VERCEL_PROTECTION_BYPASS_HEADER) ?? undefined,
    ),
    cookie: bypassFingerprint(
      cookieHeaderValue(
        requestHeader(context, "cookie"),
        VERCEL_PROTECTION_BYPASS_HEADER,
      ),
    ),
    cookieHeaderPresent: Boolean(requestHeader(context, "cookie")),
  };
}

async function previewAutomationBypassMiddleware(
  context: Context,
  next: Next,
): Promise<Response | void> {
  const secret = previewAutomationBypassSecret();
  if (
    !secret ||
    isCorsPreflightRequest(context) ||
    isPreviewAutomationBypassExemptPath(context) ||
    requestHasPreviewAutomationBypass(context, secret)
  ) {
    await next();
    return;
  }

  return context.json(
    {
      error: PREVIEW_AUTOMATION_BYPASS_ERROR,
      debug: previewAutomationBypassDebug(context, secret),
    },
    403,
  );
}

function clientHeaderLogFields(context: Context): ClientHeaderLogFields {
  const clientVersion = requestHeader(context, CLIENT_VERSION_HEADER);
  const clientType = requestHeader(context, CLIENT_TYPE_HEADER);
  const clientProduct =
    clientType === CLIENT_TYPE_DESKTOP
      ? desktopProductFromClientHeader(
          requestHeader(context, CLIENT_PRODUCT_HEADER),
        )
      : undefined;
  const clientSessionId = requestHeader(context, CLIENT_SESSION_ID_HEADER);
  const clientRequestId = requestHeader(context, CLIENT_REQUEST_ID_HEADER);

  return {
    ...(clientVersion ? { x_client_version: clientVersion } : {}),
    ...(clientType ? { x_client_type: clientType } : {}),
    ...(clientProduct ? { x_client_product: clientProduct } : {}),
    ...(clientSessionId ? { x_client_session_id: clientSessionId } : {}),
    ...(clientRequestId ? { x_client_request_id: clientRequestId } : {}),
  };
}

async function webClientCompatibilityMiddleware(
  context: Context,
  next: Next,
): Promise<Response | void> {
  const clientType = requestHeader(context, CLIENT_TYPE_HEADER);
  const clientVersion = requestHeader(context, CLIENT_VERSION_HEADER);
  if (
    clientType === CLIENT_TYPE_APP &&
    clientVersion &&
    !isSupportedWebClientVersion(clientVersion)
  ) {
    return context.json(
      { error: "Client update required" },
      CLIENT_FORCE_UPGRADE_STATUS,
      {
        "Cache-Control": "no-store",
      },
    );
  }

  await next();
}

function requestPathname(context: Context): string {
  const url = safeUrlParse(context.req.url);
  return url?.pathname ?? context.req.path;
}

function requestHost(context: Context): string {
  const headerHost = requestHeader(context, "host");
  if (headerHost) {
    return headerHost;
  }
  return safeUrlParse(context.req.url)?.host ?? "";
}

function firstForwardedAddress(value: string | undefined): string | undefined {
  return presentHeaderValue(value?.split(",")[0] ?? null);
}

function requestRemoteAddress(context: Context): string | undefined {
  return (
    firstForwardedAddress(requestHeader(context, "x-forwarded-for")) ??
    requestHeader(context, "x-real-ip") ??
    requestHeader(context, "cf-connecting-ip")
  );
}

function responseBodyBytes(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function axiomRequestLogEvent(
  context: Context,
  startedAt: number,
): AxiomRequestLogEvent {
  const response = context.res;
  const bodyBytes = responseBodyBytes(response);
  const remoteAddress = requestRemoteAddress(context);
  const userAgent = requestHeader(context, "user-agent");

  return {
    _time: new Date(startedAt).toISOString(),
    method: context.req.method,
    status: response.status,
    host: requestHost(context),
    path_template: requestRouteTemplate(context) ?? requestPathname(context),
    request_time_ms: Math.max(0, now() - startedAt),
    ...(bodyBytes !== undefined ? { body_bytes_sent: bodyBytes } : {}),
    ...(remoteAddress ? { remote_addr: remoteAddress } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
    ...clientHeaderLogFields(context),
  };
}

function scheduleAxiomRequestLog(context: Context, startedAt: number): void {
  const ingested = safeSync(() => {
    return ingestToAxiom(getDatasetName(REQUEST_LOG_DATASET), [
      axiomRequestLogEvent(context, startedAt),
    ]);
  });
  if (!("ok" in ingested) || !ingested.ok) {
    return;
  }

  const flushed = safeSync(() => {
    return flushAxiom({ client: "telemetry" });
  });
  if ("ok" in flushed) {
    waitUntil(Promise.resolve(flushed.ok));
  }
}

function unhandledRequestErrorLogFields(
  error: unknown,
  context: Context,
): UnhandledRequestErrorLogFields {
  const route = requestRouteTemplate(context);
  const errorCode = structuredErrorCode(error);
  const download = context.get("webDownloadFailure");
  return {
    type: UNHANDLED_REQUEST_ERROR_TYPE,
    errorSummary: sanitizeErrorSummary(error),
    method: context.req.method,
    ...(route ? { route } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(download ? { download } : {}),
    ...clientHeaderLogFields(context),
    error: serializeError(error),
  };
}

function handleError(error: unknown, context: Context): Response {
  if (isAbortError(error)) {
    return context.json({ error: "Internal server error" }, 500);
  }

  captureError(error);

  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  const fields = unhandledRequestErrorLogFields(error, context);
  L.error(`Unhandled request error: ${fields.errorSummary}`, fields);
  return context.json({ error: "Internal server error" }, 500);
}

interface CreateAppWithRoutesOptions {
  readonly signal: AbortSignal;
  readonly routes: readonly RouteEntry[];
  readonly usagePricingResolution?: UsagePricingResolution;
  readonly systemSkillStorageResolution?: SystemSkillStorageResolution;
}

export function createAppWithRoutes({
  routes,
  signal,
  usagePricingResolution,
  systemSkillStorageResolution,
}: CreateAppWithRoutesOptions): Hono {
  configureChatRunFinishedEventDispatcher();
  configureOfficialWorkflowReconciliationDispatcher();
  configurePiApiFirstTurnDispatcher();
  const app = new Hono();
  app.onError(handleError);

  app.use("*", (_context, next) => {
    return normalizeThrown(next);
  });

  // OpenTelemetry: each request gets a SERVER span named after its matched
  // route template (e.g. `GET /api/chat-threads/:threadId`). Child spans
  // (db queries, outbound fetches) parent to it via standard context
  // propagation; correlate them to a route by their `trace_id`, not by
  // copying `http.route` onto each child span.
  app.use("*", httpInstrumentationMiddleware({ serviceName: "vm0-api" }));

  app.use("*", async (c, next) => {
    const startedAt = now();
    await next();
    scheduleAxiomRequestLog(c, startedAt);
  });

  app.use("*", previewAutomationBypassMiddleware);

  // Browser cross-origin requests (e.g. https://app.okou.ai -> api.okou.ai). Must
  // run before the route handlers so OPTIONS preflight short-circuits without
  // matching a registered method, and so registered route responses receive
  // Access-Control-Allow-Origin without relying on the legacy web proxy.
  app.use("*", corsMiddleware);
  app.use("/mcp", bodyLimit({ maxSize: 64 * 1024 }));

  // Flush buffered Axiom logs after the response is sent so logging doesn't
  // add latency to the user-visible request.
  app.use("*", async (c, next) => {
    await next();
    waitUntil(flushLogs());
  });

  app.use("*", webClientCompatibilityMiddleware);

  for (const path of AUTH_PATHS) {
    app.get(path, redirectToApp);
    app.get(`${path}/*`, redirectToApp);
  }

  // A route is registered at the path its contract declares. Registration
  // uniqueness is asserted against the production route table in
  // `__tests__/route-registration.test.ts`, not here — test apps deliberately
  // compose overlapping route slices.
  for (const entry of routes) {
    const { route } = entry;
    const routeHandler = honoSignalHandler(
      entry.handler,
      route,
      signal,
      usagePricingResolution,
      systemSkillStorageResolution,
    );
    app.on(route.method, route.path, routeHandler);
  }

  app.notFound((context) => {
    return context.json({ error: "Not found" }, 404);
  });

  return app;
}
