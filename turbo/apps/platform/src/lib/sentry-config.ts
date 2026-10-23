import * as Sentry from "@sentry/browser";
import type { BrowserOptions, Contexts, User } from "@sentry/browser";

import { setLogErrorHandler } from "../signals/log.ts";
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

    beforeSend(event) {
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
    Sentry.captureException(error, captureContext);
    return;
  }
  Sentry.captureMessage(capturedArgs.map(String).join(" "), {
    ...captureContext,
    level: "error",
  });
}

export function setupSentryLogger(): void {
  setLogErrorHandler(captureSentryLogError);
}
