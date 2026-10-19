import type { BrowserOptions } from "@sentry/browser";
import { createStore, state } from "ccstate";

type CaptureExceptionContext = Parameters<
  typeof import("@sentry/browser").captureException
>[1];
type CaptureMessageContext = Parameters<
  typeof import("@sentry/browser").captureMessage
>[1];
type SentryUser = Parameters<typeof import("@sentry/react").setUser>[0];
type SentryBreadcrumb = Parameters<
  typeof import("@sentry/browser").addBreadcrumb
>[0];

type SentryRuntime = "page" | "shared-worker";

interface SentryInitialization {
  readonly options: BrowserOptions | undefined;
  readonly runtime: SentryRuntime;
}

interface SentryExceptionReport {
  readonly context: CaptureExceptionContext;
  readonly error: unknown;
  readonly runtime: SentryRuntime;
  readonly type: "exception";
}

interface SentryMessageReport {
  readonly context: CaptureMessageContext;
  readonly message: string;
  readonly runtime: SentryRuntime;
  readonly type: "message";
}

export interface SentryMock {
  readonly breadcrumbs: SentryBreadcrumb[];
  readonly initializations: SentryInitialization[];
  readonly reports: (SentryExceptionReport | SentryMessageReport)[];
  readonly users: SentryUser[];
}

interface SentryBehavior extends SentryMock {
  captureRuntime: SentryRuntime;
}

const activeBehavior$ = state<SentryBehavior | null>(null);
const behaviorStore = createStore();

export function mockSentry(signal: AbortSignal): SentryMock {
  const behavior: SentryBehavior = {
    captureRuntime: "page",
    breadcrumbs: [],
    initializations: [],
    reports: [],
    users: [],
  };
  behaviorStore.set(activeBehavior$, behavior);
  signal.addEventListener(
    "abort",
    () => {
      if (behaviorStore.get(activeBehavior$) === behavior) {
        behaviorStore.set(activeBehavior$, null);
      }
    },
    { once: true },
  );
  return behavior;
}

export function recordSentryBreadcrumb(breadcrumb: SentryBreadcrumb): void {
  const breadcrumbs = behaviorStore.get(activeBehavior$)?.breadcrumbs;
  if (breadcrumbs) {
    breadcrumbs.push(breadcrumb);
    if (breadcrumbs.length > 100) {
      breadcrumbs.shift();
    }
  }
}

export function recordSentryInitialization(
  runtime: SentryRuntime,
  options?: BrowserOptions,
): void {
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    return;
  }
  behavior.captureRuntime = runtime;
  behavior.initializations.push({ options, runtime });
}

export function recordSentryException(
  runtime: SentryRuntime | null,
  error: unknown,
  context?: CaptureExceptionContext,
): string {
  const behavior = behaviorStore.get(activeBehavior$);
  if (behavior) {
    behavior.reports.push({
      context,
      error,
      runtime: runtime ?? behavior.captureRuntime,
      type: "exception",
    });
  }
  return runtime === "shared-worker"
    ? "test-worker-sentry-event"
    : "test-page-sentry-event";
}

export function recordSentryMessage(
  runtime: SentryRuntime | null,
  message: string,
  context?: CaptureMessageContext,
): string {
  const behavior = behaviorStore.get(activeBehavior$);
  if (behavior) {
    behavior.reports.push({
      context,
      message,
      runtime: runtime ?? behavior.captureRuntime,
      type: "message",
    });
  }
  return runtime === "shared-worker"
    ? "test-worker-sentry-event"
    : "test-page-sentry-event";
}

export function recordSentryUser(user: SentryUser): void {
  behaviorStore.get(activeBehavior$)?.users.push(user);
}
