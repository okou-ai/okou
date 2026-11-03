import * as Sentry from "@sentry/browser";
import type { BrowserOptions, Contexts, User } from "@sentry/browser";

import { setLogErrorHandler } from "../signals/log.ts";
import { CdpFault } from "../signals/browser/cdp/errors.ts";
import { NativeNavigationFault } from "../signals/browser/navigation/rejection.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";
import { SENTRY_APPLICATION_KEY } from "./sentry-application-key.ts";
import { redactProofUrl } from "./redact-proof-url.ts";

type PlatformSentryRuntime = "page" | "shared-worker";

type SentryTags = Parameters<typeof Sentry.setTags>[0];

interface SentryLoggerContext {
  readonly contexts?: Contexts;
  readonly tags?: SentryTags;
  readonly user?: User;
}

const SENTRY_LOG_CONTEXT = Symbol("okou.sentry-log-context");

interface SentryLogContextArgument {
  readonly [SENTRY_LOG_CONTEXT]: SentryLoggerContext;
}

function isSentryLogContextArgument(
  value: unknown,
): value is SentryLogContextArgument {
  return (
    typeof value === "object" && value !== null && SENTRY_LOG_CONTEXT in value
  );
}

export function sentryLogContext(
  context: SentryLoggerContext,
): SentryLogContextArgument {
  return { [SENTRY_LOG_CONTEXT]: context };
}

function redactDiagnosticUrls<T>(
  data: Record<string, T>,
): Record<string, T | string> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      return [key, typeof value === "string" ? redactProofUrl(value) : value];
    }),
  );
}

export function createPlatformSentryOptions(
  runtime: PlatformSentryRuntime,
): BrowserOptions {
  const runtimeConfig = resolvePlatformRuntimeConfig();

  return {
    dsn: runtimeConfig.sentryDsn ?? undefined,

    // Production telemetry values are present in every build but are only
    // enabled when the serving domain resolves to the production environment.
    enabled: runtimeConfig.sentryDsn !== null,

    environment: runtimeConfig.environment,

    // Without a release every capture reports `<not logged>`, so a filter or
    // fix cannot be verified against the build that produced the events.
    release: __OKOU_APP_VERSION__,

    // Drop page errors only when every frame comes from third-party code;
    // errors containing our application frames still report. Only the page
    // bundle carries the application key: the shared worker is built by a
    // separate Vite worker pipeline that the Sentry plugin does not process,
    // so applying this filter there would drop application errors.
    integrations:
      runtime === "page"
        ? [
            Sentry.thirdPartyErrorFilterIntegration({
              behaviour:
                "drop-error-if-exclusively-contains-third-party-frames",
              filterKeys: [SENTRY_APPLICATION_KEY],
            }),
          ]
        : [],

    initialScope: {
      tags: {
        app: "platform",
        ...(runtime === "shared-worker"
          ? { runtime: "shared-worker", worker: "shared-database" }
          : {}),
      },
    },

    // Only error tracking is needed. Sentry enables Logs by default since 10.71.
    enableLogs: false,
    tracesSampleRate: 0,

    // Preserve native fetch errors for application-level error handling.
    enhanceFetchErrorMessages: false,

    beforeSend(event, hint) {
      const error = hint.originalException;
      if (error instanceof CdpFault && error.request) {
        event.contexts = {
          ...event.contexts,
          browser_cdp: {
            kind: error.kind,
            method: error.request.method,
            ...(error.request.code !== undefined
              ? { code: error.request.code }
              : {}),
          },
        };
      }
      if (event.request?.url) {
        event.request.url = redactProofUrl(event.request.url);
      }
      if (event.request?.headers) {
        event.request.headers = redactDiagnosticUrls(event.request.headers);
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (runtime === "shared-worker" && breadcrumb.category === "console") {
        return null;
      }
      if (breadcrumb.data) {
        breadcrumb.data = redactDiagnosticUrls(breadcrumb.data);
      }
      return breadcrumb;
    },
  };
}

export function captureSentryLogError(
  loggerName: string,
  args: unknown[],
): void {
  const contextArgument = args.find(isSentryLogContextArgument);
  const context = contextArgument?.[SENTRY_LOG_CONTEXT];
  const captureContext = {
    ...context,
    tags: { ...context?.tags, logger: loggerName },
  };
  const capturedArgs = args.filter((arg) => {
    return !isSentryLogContextArgument(arg);
  });
  const error = capturedArgs.find((arg): arg is Error | DOMException => {
    return arg instanceof Error || arg instanceof DOMException;
  });
  if (error) {
    const faults = claimCdpReport(error);
    if (!faults) {
      return;
    }
    const navigation = faults.find((fault) => {
      return fault instanceof NativeNavigationFault;
    });
    Sentry.captureException(error, {
      ...captureContext,
      ...(navigation
        ? {
            contexts: {
              ...captureContext.contexts,
              browser_navigation: {
                method: "Page.navigate",
                reason: navigation.reason,
              },
            },
          }
        : {}),
    });
    return;
  }
  Sentry.captureMessage(capturedArgs.map(String).join(" "), {
    ...captureContext,
    level: "error",
  });
}

/** Keep native refusals local; deduplicate captured faults through wrappers. */
function claimCdpReport(error: Error): readonly CdpFault[] | null {
  const visited = new Set<Error>();
  const faults: CdpFault[] = [];
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    if (current instanceof CdpFault) {
      if (
        current.reported ||
        (current instanceof NativeNavigationFault && current.expected)
      ) {
        return null;
      }
      faults.push(current);
    }
    current = current.cause;
  }
  for (const fault of faults) {
    fault.reported = true;
  }
  return faults;
}

export function setupSentryLogger(): void {
  setLogErrorHandler(captureSentryLogError);
}
