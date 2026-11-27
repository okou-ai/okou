import * as Sentry from "@sentry/react";
import {
  createPlatformSentryOptions,
  setupSentryLogger,
} from "./sentry-config.ts";

// Initialize Sentry synchronously so that global error/unhandledrejection
// handlers are installed before the app bootstraps. Errors during bootstrap
// (route resolution, signal evaluation) would be missed with deferred init.
export function initSentry(): void {
  Sentry.init(createPlatformSentryOptions());
  setupSentryLogger();
}

export function setSentryUser(userId: string) {
  Sentry.setUser({ id: userId });
}

export function clearSentryUser() {
  Sentry.setUser(null);
}

export { Sentry };
