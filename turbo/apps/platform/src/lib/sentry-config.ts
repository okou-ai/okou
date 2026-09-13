import { isDesktopAuthFlow } from "./desktop-auth-flow.ts";
import * as Sentry from "@sentry/browser";
import type {
  BrowserOptions,
  Contexts,
  ErrorEvent,
  User,
} from "@sentry/browser";
import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";

import { setLogErrorHandler } from "../signals/log.ts";
import { SharedDatabaseHttpError } from "../shared-database/http-error.ts";
import { ApiError } from "./api-error.ts";
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

const EXPECTED_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  // Ably already owns reconnect, resubscribe, and catch-up.
  "Connection to server unavailable",
  "Channel attach timed out",
  // Some browser/SDK paths stringify the original permission error.
  "NotAllowedError: Permission denied",
  "NotAllowedError: Permission denied by system",
  "NotAllowedError: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
  // WebKit's native media controls, outside application recording code.
  "this.mediaController.media.addEventListener is not a function",
  "this.mediaController.media.addEventListener is not a function. (In 'this.mediaController.media.addEventListener(eventType,this,true)', 'this.mediaController.media.addEventListener' is undefined)",
]);

// WebKit runs its own <video> controls script inside the page and lets its
// exceptions escape to window.onerror. HTMLVideoElement.webkitEnterFullscreen()
// throws a message-less InvalidStateError while a fullscreen transition is
// already in flight, and the controls call it unguarded, so rapid taps on an
// inline video report an error no application code can observe or prevent.
// Each condition has two spellings because the SDK keeps a DOMException's bare
// message when it carries a stack and prefixes the name when it does not.
// Production has shown the prefixed fullscreen value and the bare ranges value;
// the opposite spelling of each is kept for the other WebKit capture shape.
const USER_AGENT_MEDIA_CONTROLS_MESSAGES: ReadonlySet<string> = new Set([
  "InvalidStateError: The object is in an invalid state.",
  "The object is in an invalid state.",
  "ReferenceError: Can't find variable: EmptyRanges",
  "Can't find variable: EmptyRanges",
]);

const GLOBAL_ONERROR_MECHANISM = "auto.browser.global_handlers.onerror";

// Narrow to the exact user-agent condition: an unhandled global capture that
// matches a known media-controls message and whose frames are exclusively
// third-party, as tagged by thirdPartyErrorFilterIntegration. The same message
// raised from our own bundle keeps an application frame and still reports.
function isUserAgentMediaControlsCapture(event: ErrorEvent): boolean {
  const values = event.exception?.values;
  if (values === undefined || event.tags?.third_party_code !== true) {
    return false;
  }
  return values.some((value) => {
    const mechanism = value.mechanism;
    return (
      mechanism?.handled === false &&
      mechanism.type.startsWith(GLOBAL_ONERROR_MECHANISM) &&
      value.value !== undefined &&
      USER_AGENT_MEDIA_CONTROLS_MESSAGES.has(value.value)
    );
  });
}

function isExpectedErrorDescription(
  name: string | undefined,
  message: string | undefined,
): boolean {
  return (
    name === "NotAllowedError" ||
    // Axiom telemetry and the refresh dialog own this browser failure.
    name === "SharedDatabaseWorkerLoadError" ||
    (message !== undefined && EXPECTED_ERROR_MESSAGES.has(message))
  );
}

function isExpectedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (
    (error instanceof Error || error instanceof DOMException) &&
    !seen.has(error)
  ) {
    seen.add(error);
    if (
      (error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500) ||
      (error instanceof SharedDatabaseHttpError &&
        (error.status === 401 ||
          error.status === CLIENT_FORCE_UPGRADE_STATUS)) ||
      isExpectedErrorDescription(error.name, error.message)
    ) {
      return true;
    }
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
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

    // Only the page bundle carries the application key: the shared worker is
    // built by a separate Vite worker pipeline that the Sentry plugin does not
    // process, so tagging its frames as third-party code would be wrong.
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

    beforeBreadcrumb(breadcrumb) {
      if (runtime === "page" && isDesktopAuthFlow()) {
        return null;
      }
      return runtime === "shared-worker" && breadcrumb.category === "console"
        ? null
        : breadcrumb;
    },

    // Filter out expected errors
    beforeSend(event, hint) {
      if (runtime === "page" && isDesktopAuthFlow()) {
        return null;
      }
      // Filter out 4xx client errors that are expected
      const statusCode = event.contexts?.response?.status_code;
      if (
        typeof statusCode === "number" &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
        return null;
      }

      // Only the page runtime renders <video>; the worker keeps every capture.
      if (runtime === "page" && isUserAgentMediaControlsCapture(event)) {
        return null;
      }

      // Preserve classification through logger wrappers and MessagePort errors.
      if (
        isExpectedError(hint?.originalException) ||
        isExpectedErrorDescription(undefined, event.message) ||
        event.exception?.values?.some((exception) => {
          return isExpectedErrorDescription(exception.type, exception.value);
        })
      ) {
        return null;
      }

      return event;
    },

    // Ignore common client-side errors
    ignoreErrors: [
      // Network errors
      "Failed to fetch",
      "NetworkError",
      "Load failed",
      // User navigation
      "AbortError",
      // Browser extensions
      "ResizeObserver loop",
      // Clerk SDK - session cleared by Mobile Safari ITP (third-party noise)
      "Unable to authenticate the request",
      // Expected authentication failures surfaced to the request caller.
      "Not authenticated",
      "Authentication required",
      // 404 for stale agent references (deleted agents, cross-org bookmarks,
      // pinned IDs that no longer resolve). Surfaced to users as a toast and
      // not actionable in Sentry.
      "Agent not found",
      // Expected API errors surfaced as toasts — not actionable in Sentry
      "Credits depleted",
      "Insufficient credits",
      // Third-party scripts (we don't use axios — any AxiosError is external noise)
      "AxiosError",
      // Ably SDK internal rejections — when the WebSocket connection closes
      // during an in-flight channel attach, Ably's internal promises reject
      // before our try/catch in realtime.ts can suppress them.
      "Connection closed",
    ],

    // Filter out errors from browser extension and third-party scripts
    denyUrls: [
      /inpage\.js/,
      /chrome-extension:\/\//,
      /moz-extension:\/\//,
      // Termly compliance/cookie consent script
      /app\.termly\.io/,
      /resource-blocker/,
    ],
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
