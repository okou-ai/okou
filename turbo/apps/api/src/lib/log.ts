import {
  EVENT,
  Logger as AxiomLogger,
  AxiomJSTransport,
} from "@axiomhq/logging";
import { Axiom } from "@axiomhq/js";

import { formatMessage, extractFields } from "@okouai/core/log-utils";

import { env } from "./env";
import { singleton } from "./singleton";

type LogMethod = (...args: unknown[]) => void;

enum Level {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
  Fatal = "fatal",
}

const LOG_LEVEL_PRIORITY: Readonly<Record<Level, number>> = {
  [Level.Debug]: 0,
  [Level.Info]: 1,
  [Level.Warn]: 2,
  [Level.Error]: 3,
  [Level.Fatal]: 4,
};

interface Logger {
  readonly debug: LogMethod;
  readonly info: LogMethod;
  readonly warn: LogMethod;
  readonly error: LogMethod;
  readonly fatal: LogMethod;
  readonly shouldLog: (level: Level) => boolean;
  level: Level;
}

class LoggerRegistry {
  private readonly store = new Map<string, Logger>();

  get(name: string): Logger | undefined {
    return this.store.get(name);
  }

  set(name: string, loggerInstance: Logger): void {
    this.store.set(name, loggerInstance);
  }
}

const loggerRegistry = singleton(() => {
  return new LoggerRegistry();
});

function parseDebugPatterns(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((pattern) => {
      return pattern.trim();
    })
    .filter((pattern) => {
      return pattern.length > 0;
    });
}

const debugPatterns = singleton(() => {
  return parseDebugPatterns(env("OKOU_DEBUG"));
});

function matchesDebugPattern(name: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith(":*")) {
    return name.startsWith(pattern.slice(0, -1));
  }

  return name === pattern;
}

function isDebugEnabled(name: string): boolean {
  return debugPatterns().some((pattern) => {
    return matchesDebugPattern(name, pattern);
  });
}

function getInitialLevel(name: string): Level {
  return isDebugEnabled(name) ? Level.Debug : Level.Info;
}

function formatArgs(
  level: Level,
  name: string,
  args: unknown[],
): [string, ...unknown[]] {
  const prefix = `[${level.toUpperCase()}][${name}]`;
  if (args.length === 0) {
    return [prefix];
  }

  if (typeof args[0] === "string") {
    return [`${prefix} ${args[0]}`, ...args.slice(1)];
  }

  return [prefix, ...args];
}

function writeLog(...args: unknown[]): void {
  console.log(...args);
}

function writeError(...args: unknown[]): void {
  console.error(...args);
}

// ── Axiom integration ────────────────────────────────────────────────────

function reportAxiomLogDeliveryError(dataset: string, error: Error): void {
  if (error.name === "TimeoutError") {
    console.warn("Axiom application log delivery timed out", {
      client: "telemetry",
      dataset,
      failureKind: "timeout",
      error,
    });
    return;
  }

  writeError("Axiom application log delivery failed", {
    client: "telemetry",
    dataset,
    failureKind: "transport_error",
    error,
  });
}

const getAxiomLogger = singleton((): AxiomLogger | null => {
  const token = env("AXIOM_TOKEN_TELEMETRY");
  if (!token) {
    return null;
  }

  const dataset = `vm0-web-logs-${env("AXIOM_DATASET_SUFFIX")}`;
  const axiom = new Axiom({
    token,
    onError: (error) => {
      reportAxiomLogDeliveryError(dataset, error);
    },
  });
  // State the threshold the SDK would otherwise apply implicitly: `L.debug`
  // records are dropped here and never reach the dataset, whatever `OKOU_DEBUG`
  // selects for console output. A signal that must be observable in production
  // has to be emitted at info or above.
  return new AxiomLogger({
    logLevel: "info",
    transports: [
      new AxiomJSTransport({
        axiom,
        dataset,
      }),
    ],
  });
});

type UsageUnderbillingClass = "confirmed" | "risk";

interface UsageUnderbillingRootFields {
  readonly type: "usage_underbilling";
  readonly reason: string;
  readonly underbilling_class: UsageUnderbillingClass;
  readonly component: string;
}

interface UnhandledRequestErrorRootFields {
  readonly type: "unhandled_request_error";
  readonly errorSummary: string;
  readonly method: string;
  readonly route?: string;
  readonly errorCode?: string;
}

interface ProviderUnavailableRootFields {
  readonly type: "provider_unavailable";
  readonly provider: "clerk";
  readonly provider_status: number | null;
  readonly failure_class:
    | "transient_read_exhausted"
    | "transport_read_exhausted";
  readonly method: string;
  readonly route: string;
}

type DesktopUpdateManifestOutcome =
  | "retry_recovered"
  | "served_stale"
  | "unavailable";

interface DesktopUpdateManifestRootFields {
  readonly type: "desktop_update_manifest_upstream";
  readonly outcome: DesktopUpdateManifestOutcome;
  readonly provider: "github_release_asset";
  readonly provider_status?: number;
  readonly failure_class: "transient_read" | "transient_read_exhausted";
  readonly attempts: number;
  readonly stale_age_ms?: number;
  readonly line: string;
  readonly method?: string;
  readonly route?: string;
}

function isDesktopUpdateManifestOutcome(
  value: unknown,
): value is DesktopUpdateManifestOutcome {
  return (
    value === "retry_recovered" ||
    value === "served_stale" ||
    value === "unavailable"
  );
}

function isDesktopUpdateManifestFailureClass(
  value: unknown,
): value is DesktopUpdateManifestRootFields["failure_class"] {
  return value === "transient_read" || value === "transient_read_exhausted";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isOptionalNonNegativeInteger(value: unknown): value is number {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 0);
}

function isOptionalUpstreamStatus(value: unknown): value is number {
  return (
    value === undefined ||
    (Number.isInteger(value) && Number(value) >= 400 && Number(value) <= 599)
  );
}

function isOptionalString(value: unknown): value is string {
  return value === undefined || typeof value === "string";
}

function usageUnderbillingRootFields(
  fields: Record<string, unknown>,
): UsageUnderbillingRootFields | null {
  const type = fields.type;
  const reason = fields.reason;
  const underbillingClass = fields.underbilling_class;
  const component = fields.component;

  if (
    type !== "usage_underbilling" ||
    typeof reason !== "string" ||
    (underbillingClass !== "confirmed" && underbillingClass !== "risk") ||
    typeof component !== "string"
  ) {
    return null;
  }

  return {
    type,
    reason,
    underbilling_class: underbillingClass,
    component,
  };
}

function unhandledRequestErrorRootFields(
  fields: Record<string, unknown>,
): UnhandledRequestErrorRootFields | null {
  const type = fields.type;
  const errorSummary = fields.errorSummary;
  const method = fields.method;
  const route = fields.route;
  const errorCode = fields.errorCode;

  if (
    type !== "unhandled_request_error" ||
    typeof errorSummary !== "string" ||
    typeof method !== "string" ||
    (route !== undefined && typeof route !== "string") ||
    (errorCode !== undefined && typeof errorCode !== "string")
  ) {
    return null;
  }

  return {
    type,
    errorSummary,
    method,
    ...(route ? { route } : {}),
    ...(errorCode ? { errorCode } : {}),
  };
}

function providerUnavailableRootFields(
  fields: Record<string, unknown>,
): ProviderUnavailableRootFields | null {
  const type = fields.type;
  const provider = fields.provider;
  const providerStatus = fields.provider_status;
  const failureClass = fields.failure_class;
  const method = fields.method;
  const route = fields.route;

  if (
    type !== "provider_unavailable" ||
    provider !== "clerk" ||
    typeof method !== "string" ||
    typeof route !== "string"
  ) {
    return null;
  }

  if (
    !(
      (providerStatus === null &&
        failureClass === "transport_read_exhausted") ||
      (typeof providerStatus === "number" &&
        Number.isInteger(providerStatus) &&
        providerStatus >= 500 &&
        providerStatus <= 599 &&
        failureClass === "transient_read_exhausted")
    )
  ) {
    return null;
  }

  return {
    type,
    provider,
    provider_status: providerStatus,
    failure_class: failureClass,
    method,
    route,
  };
}

function desktopUpdateManifestRootFields(
  fields: Record<string, unknown>,
): DesktopUpdateManifestRootFields | null {
  const type = fields.type;
  const outcome = fields.outcome;
  const provider = fields.provider;
  const providerStatus = fields.provider_status;
  const failureClass = fields.failure_class;
  const attempts = fields.attempts;
  const staleAgeMs = fields.stale_age_ms;
  const line = fields.line;
  const method = fields.method;
  const route = fields.route;

  if (
    type !== "desktop_update_manifest_upstream" ||
    !isDesktopUpdateManifestOutcome(outcome) ||
    provider !== "github_release_asset" ||
    !isOptionalUpstreamStatus(providerStatus) ||
    !isDesktopUpdateManifestFailureClass(failureClass) ||
    !isPositiveInteger(attempts) ||
    !isOptionalNonNegativeInteger(staleAgeMs) ||
    typeof line !== "string" ||
    !isOptionalString(method) ||
    !isOptionalString(route)
  ) {
    return null;
  }

  return {
    type,
    outcome,
    provider,
    ...(providerStatus === undefined
      ? {}
      : { provider_status: providerStatus }),
    failure_class: failureClass,
    attempts,
    ...(staleAgeMs === undefined ? {} : { stale_age_ms: staleAgeMs }),
    line,
    ...(method === undefined ? {} : { method }),
    ...(route === undefined ? {} : { route }),
  };
}

function rootEventFields(
  fields: Record<string, unknown>,
):
  | UsageUnderbillingRootFields
  | UnhandledRequestErrorRootFields
  | ProviderUnavailableRootFields
  | DesktopUpdateManifestRootFields
  | null {
  return (
    usageUnderbillingRootFields(fields) ??
    unhandledRequestErrorRootFields(fields) ??
    providerUnavailableRootFields(fields) ??
    desktopUpdateManifestRootFields(fields)
  );
}

function logToAxiom(level: Level, name: string, args: unknown[]): void {
  const alog = getAxiomLogger();
  if (!alog) {
    return;
  }

  const message = formatMessage(args);
  const fields = extractFields(args);
  const eventRootFields = rootEventFields(fields);
  const data = {
    [EVENT]: {
      source: "api",
      ...eventRootFields,
    },
    ...fields,
    context: name,
  };

  switch (level) {
    case Level.Debug: {
      alog.debug(message, data);
      break;
    }
    case Level.Info: {
      alog.info(message, data);
      break;
    }
    case Level.Warn: {
      alog.warn(message, data);
      break;
    }
    case Level.Error:
    case Level.Fatal: {
      alog.error(message, data);
      break;
    }
  }
}

export async function flushLogs(): Promise<void> {
  const axiomLogger = getAxiomLogger();
  if (!axiomLogger) {
    return;
  }
  await axiomLogger.flush()?.catch((error: unknown) => {
    writeError("Failed to flush Axiom logs", error);
  });
}

// ── Logger creation ──────────────────────────────────────────────────────

function createLogger(name: string): Logger {
  const loggerInstance: Logger = {
    level: getInitialLevel(name),
    shouldLog(level: Level): boolean {
      return (
        LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[loggerInstance.level]
      );
    },
    debug: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Debug)) {
        writeLog(...formatArgs(Level.Debug, name, args));
      }
      logToAxiom(Level.Debug, name, args);
    },
    info: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Info)) {
        writeLog(...formatArgs(Level.Info, name, args));
      }
      logToAxiom(Level.Info, name, args);
    },
    warn: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Warn)) {
        writeLog(...formatArgs(Level.Warn, name, args));
      }
      logToAxiom(Level.Warn, name, args);
    },
    error: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Error)) {
        writeError(...formatArgs(Level.Error, name, args));
      }
      logToAxiom(Level.Error, name, args);
    },
    fatal: (...args: unknown[]) => {
      if (loggerInstance.shouldLog(Level.Fatal)) {
        writeError(...formatArgs(Level.Fatal, name, args));
      }
      logToAxiom(Level.Fatal, name, args);
    },
  };

  return loggerInstance;
}

export function logger(name: string): Logger {
  const registry = loggerRegistry();
  const existing = registry.get(name);
  if (existing) {
    return existing;
  }

  const loggerInstance = createLogger(name);
  registry.set(name, loggerInstance);
  return loggerInstance;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function __resetForTest(): void {
  debugPatterns.reset();
  getAxiomLogger.reset();
  loggerRegistry.reset();
}
