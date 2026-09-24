import * as Sentry from "@sentry/electron/main";
import type { ComputerUseNativeRuntimeErrorContext } from "./computer-use-native";
import type { DesktopAuthRestoreFailure } from "./desktop-auth-session";
import type { ComputerUsePermissionRecoveryDiagnostic } from "./computer-use-runtime-controller";

declare const __DESKTOP_VERSION__: string;
declare const __DESKTOP_SENTRY_DSN__: string;
declare const __DESKTOP_SENTRY_ENVIRONMENT__: string;

const sentryDsn = process.env.SENTRY_DSN_DESKTOP ?? __DESKTOP_SENTRY_DSN__;
const sentryRelease = `desktop@${__DESKTOP_VERSION__}`;
const sentryEnvironment =
  process.env.SENTRY_ENVIRONMENT ?? __DESKTOP_SENTRY_ENVIRONMENT__;

if (sentryDsn) {
  process.env.OKOU_DESKTOP_SENTRY_DSN = sentryDsn;
  process.env.OKOU_DESKTOP_SENTRY_RELEASE = sentryRelease;
  process.env.OKOU_DESKTOP_SENTRY_ENVIRONMENT = sentryEnvironment;

  Sentry.init({
    dsn: sentryDsn,
    enableLogs: false,
    release: sentryRelease,
    environment: sentryEnvironment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    shutdownTimeout: 500,
    attachScreenshot: false,
    initialScope: {
      tags: {
        app: "desktop",
        component: "electron-main",
      },
    },
  });
}

export function captureDesktopNativeHelperError(
  error: Error,
  context: ComputerUseNativeRuntimeErrorContext,
): void {
  if (!sentryDsn) {
    return;
  }

  Sentry.withScope((scope) => {
    const pendingRequestCount = context.pendingRequestCount ?? 0;
    const queuedRequestCount = context.queuedRequestCount ?? 0;
    const impact =
      pendingRequestCount > 0 ? "request_interrupted" : "no_active_request";
    scope.setTags({
      app: "desktop",
      component: "computer-use-helper",
      nativeHelperMode: context.mode,
      nativeHelperStage: context.stage,
      nativeHelperRequestKind: context.requestKind,
      nativeHelperTerminationReason:
        context.terminationReason ?? "not_applicable",
      nativeHelperSignal: context.signal ?? "none",
      nativeHelperExitCode: context.exitCode ?? "none",
      nativeHelperImpact: impact,
      nativeHelperHasQueuedRequests: queuedRequestCount > 0,
    });
    scope.setFingerprint([
      "{{ default }}",
      `mode:${context.mode}`,
      `stage:${context.stage}`,
      `termination:${context.terminationReason ?? "not_applicable"}`,
      `signal:${context.signal ?? "none"}`,
      `exit:${context.exitCode ?? "none"}`,
    ]);
    scope.setContext("computerUseHelper", {
      helperPath: context.helperPath,
      exitCode: context.exitCode,
      signal: context.signal,
      stderr: context.stderr,
      terminationReason: context.terminationReason,
      pendingRequestCount: context.pendingRequestCount,
      queuedRequestCount: context.queuedRequestCount,
      processSequence: context.processSequence,
      requestSequence: context.requestSequence,
      elapsedMs: context.elapsedMs,
      helperUptimeMs: context.helperUptimeMs,
      timerDelayMs: context.timerDelayMs,
      exitKnown: context.exitKnown,
      phases: context.phases,
      stderrBytes: context.stderrBytes,
    });
    Sentry.captureException(error);
  });
}

/** Known hidden-window stalls and socket disconnects are intentionally silent;
 * recovery remains fail-closed and other unavailable failures stay visible.
 */
function isSuppressedDesktopAuthRestoreCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (
    cause.message === "Desktop auth session restore timed out" ||
    cause.message === "Desktop auth window timed out"
  )
    return true;
  if (!(cause instanceof TypeError) || cause.message !== "fetch failed")
    return false;
  return (
    cause.cause instanceof Error &&
    (cause.cause.message ===
      "Client network socket disconnected before secure TLS connection was established" ||
      cause.cause.message === "other side closed")
  );
}

export function captureDesktopSessionRestoreFailure(failure: {
  readonly classification: DesktopAuthRestoreFailure;
  readonly cause: unknown;
}): void {
  if (
    !sentryDsn ||
    failure.classification !== "unavailable" ||
    isSuppressedDesktopAuthRestoreCause(failure.cause)
  ) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTags({
      app: "desktop",
      component: "auth-session",
      authRestoreClassification: failure.classification,
    });
    scope.setFingerprint([
      "{{ default }}",
      `authRestore:${failure.classification}`,
    ]);
    Sentry.captureException(
      failure.cause instanceof Error
        ? failure.cause
        : new Error("Desktop session restore was unavailable"),
    );
  });
}

export function captureDesktopNativePermissionRecovery(
  diagnostic: ComputerUsePermissionRecoveryDiagnostic,
): void {
  if (!sentryDsn) return;
  Sentry.addBreadcrumb({
    category: "computer-use-helper",
    message: "Native permission recovery",
    level: diagnostic.outcome === "failed" ? "warning" : "info",
    data: { ...diagnostic },
  });
}
