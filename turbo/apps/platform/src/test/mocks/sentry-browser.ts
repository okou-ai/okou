import type { BrowserOptions } from "@sentry/browser";

import {
  recordSentryBreadcrumb,
  recordSentryException,
  recordSentryInitialization,
  recordSentryMessage,
  recordSentryUser,
} from "./sentry-behavior.ts";

export function addBreadcrumb(
  breadcrumb: Parameters<typeof import("@sentry/browser").addBreadcrumb>[0],
): void {
  recordSentryBreadcrumb(breadcrumb);
}

export function init(options?: BrowserOptions): void {
  recordSentryInitialization("shared-worker", options);
}

export function captureException(
  error: unknown,
  context?: Parameters<typeof import("@sentry/browser").captureException>[1],
): string {
  return recordSentryException(null, error, context);
}

export function captureMessage(
  message: string,
  context?: Parameters<typeof import("@sentry/browser").captureMessage>[1],
): string {
  return recordSentryMessage(null, message, context);
}

export function setUser(
  user: Parameters<typeof import("@sentry/browser").setUser>[0],
): void {
  recordSentryUser(user);
}

export function setTags(): void {}

// The page options register this integration. The mock does not run Sentry's
// event pipeline, so it stays inert and the recorded options remain assertable.
export function thirdPartyErrorFilterIntegration(
  _options: Parameters<
    typeof import("@sentry/browser").thirdPartyErrorFilterIntegration
  >[0],
): ReturnType<
  typeof import("@sentry/browser").thirdPartyErrorFilterIntegration
> {
  return { name: "ThirdPartyErrorsFilter" };
}
