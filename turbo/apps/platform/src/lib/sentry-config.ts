import { isDesktopAuthFlow } from "./desktop-auth-flow.ts";
import * as Sentry from "@sentry/browser";
import type { BrowserOptions, Contexts, User } from "@sentry/browser";

import { setLogErrorHandler } from "../signals/log.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";
import { SENTRY_APPLICATION_KEY } from "./sentry-application-key.ts";

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

    // Tagging only: this applies `third_party_code` and never drops an event,
    // so Sentry-side triage can separate user-agent and extension captures from
    // our own frames. Only the page bundle carries the application key: the
    // shared worker is built by a separate Vite worker pipeline that the Sentry
    // plugin does not process, so tagging its frames as third-party would be
    // wrong.
    integrations:
      runtime === "page"
        ? [
            Sentry.thirdPartyErrorFilterIntegration({
              behaviour: "apply-tag-if-exclusively-contains-third-party-frames",
              filterKeys: [SENTRY_APPLICATION_KEY],
            }),
          ]
        : [],

    initialScope: {
      tags: {
        app: "platform",
        public_brand: runtimeConfig.publicBrand,
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

    // The desktop auth pages carry one-time codes and tickets in their URLs, so
    // their breadcrumbs stay local. This is a credential boundary, not noise
    // suppression, and Sentry-side filtering cannot replace it because the
    // event would have to reach Sentry to be dropped. Shared worker console
    // breadcrumbs are dropped for payload size only.
    beforeBreadcrumb(breadcrumb) {
      if (runtime === "page" && isDesktopAuthFlow()) {
        return null;
      }
      return runtime === "shared-worker" && breadcrumb.category === "console"
        ? null
        : breadcrumb;
    },

    // Noise filtering lives in Sentry (inbound filters and discarded issues) so
    // that a suppressed signature keeps a visible `filtered` counter instead of
    // disappearing into an undifferentiated client discard. The only client
    // rule left is the desktop auth credential boundary above.
    beforeSend(event) {
      return runtime === "page" && isDesktopAuthFlow() ? null : event;
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
