import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { safeSync } from "../signals/utils";

const downloadPath =
  /^\/api\/(?:runs\/[^/]+\/files\/download|runners\/files\/downloads\/consume)\/?$/u;

/** These bodies contain private path tokens or one-use download credentials. */
export function isRunnerFileDownloadTelemetryUrl(value: string): boolean {
  const parsed = safeSync(() => {
    return new URL(value, "https://telemetry.invalid").pathname;
  });
  if (!("ok" in parsed)) {
    return false;
  }
  // Match invalid Run IDs too, before decoding can reject a malformed escape.
  if (downloadPath.test(parsed.ok)) {
    return true;
  }
  const decoded = safeSync(() => {
    return decodeURI(parsed.ok);
  });
  return "ok" in decoded && downloadPath.test(decoded.ok);
}

export function filterRunnerFileDownloadSentryEvent(
  event: ErrorEvent,
): ErrorEvent | null {
  return event.request?.url &&
    isRunnerFileDownloadTelemetryUrl(event.request.url)
    ? null
    : event;
}

export function filterRunnerFileDownloadSentryBreadcrumb(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  return breadcrumb.data &&
    Object.values(breadcrumb.data).some((value) => {
      return (
        typeof value === "string" && isRunnerFileDownloadTelemetryUrl(value)
      );
    })
    ? null
    : breadcrumb;
}
