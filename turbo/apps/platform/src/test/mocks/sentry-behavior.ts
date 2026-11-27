import type { BrowserOptions } from "@sentry/react";
import { createStore, state } from "ccstate";

type CaptureExceptionContext = Parameters<
  typeof import("@sentry/react").captureException
>[1];
type CaptureMessageContext = Parameters<
  typeof import("@sentry/react").captureMessage
>[1];
type SentryUser = Parameters<typeof import("@sentry/react").setUser>[0];
type SentryBreadcrumb = Parameters<
  typeof import("@sentry/react").addBreadcrumb
>[0];

interface SentryInitialization {
  readonly options: BrowserOptions | undefined;
}

interface SentryExceptionReport {
  readonly context: CaptureExceptionContext;
  readonly error: unknown;
  readonly type: "exception";
}

interface SentryMessageReport {
  readonly context: CaptureMessageContext;
  readonly message: string;
  readonly type: "message";
}

export interface SentryMock {
  readonly breadcrumbs: SentryBreadcrumb[];
  readonly initializations: SentryInitialization[];
  readonly reports: (SentryExceptionReport | SentryMessageReport)[];
  readonly users: SentryUser[];
}

const activeBehavior$ = state<SentryMock | null>(null);
const behaviorStore = createStore();

export function mockSentry(signal: AbortSignal): SentryMock {
  const behavior: SentryMock = {
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

export function recordSentryInitialization(options?: BrowserOptions): void {
  const behavior = behaviorStore.get(activeBehavior$);
  if (!behavior) {
    return;
  }
  behavior.initializations.push({ options });
}

export function recordSentryException(
  error: unknown,
  context?: CaptureExceptionContext,
): string {
  const behavior = behaviorStore.get(activeBehavior$);
  if (behavior) {
    behavior.reports.push({
      context,
      error,
      type: "exception",
    });
  }
  return "test-page-sentry-event";
}

export function recordSentryMessage(
  message: string,
  context?: CaptureMessageContext,
): string {
  const behavior = behaviorStore.get(activeBehavior$);
  if (behavior) {
    behavior.reports.push({
      context,
      message,
      type: "message",
    });
  }
  return "test-page-sentry-event";
}

export function recordSentryUser(user: SentryUser): void {
  behaviorStore.get(activeBehavior$)?.users.push(user);
}
