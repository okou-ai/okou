import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { safeSync } from "../signals/utils";

/** All callback versions carry identity/proof, even when context is invalid. */
export function isTelegramAuthTelemetryUrl(value: string): boolean {
  const parsed = safeSync(() => {
    const url = new URL(value, "https://telemetry.invalid");
    // Hono also accepts percent-encoded path characters. Decode once, without
    // turning encoded separators into a different route.
    return decodeURI(url.pathname);
  });
  return (
    "ok" in parsed &&
    /^\/api\/integrations\/telegram\/auth-callback\/?$/u.test(parsed.ok)
  );
}

/** Drop the whole callback event: proof can also occur in request/error data. */
export function filterTelegramAuthSentryEvent<
  T extends Pick<ErrorEvent, "request">,
>(event: T): T | null {
  return event.request?.url && isTelegramAuthTelemetryUrl(event.request.url)
    ? null
    : event;
}

/** Do not let callback HTTP breadcrumbs escape on a later unrelated event. */
export function filterTelegramAuthSentryBreadcrumb<
  T extends Pick<Breadcrumb, "data">,
>(breadcrumb: T): T | null {
  return breadcrumb.data &&
    Object.values(breadcrumb.data).some((value) => {
      return typeof value === "string" && isTelegramAuthTelemetryUrl(value);
    })
    ? null
    : breadcrumb;
}
