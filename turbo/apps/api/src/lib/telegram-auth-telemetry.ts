import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { safeSync } from "../signals/utils";

// Bot API methods and file downloads authenticate in the URL path. Exclude
// the entire request before an SDK can retain its name, URL or breadcrumb.
export const TELEGRAM_BOT_TELEMETRY_URL =
  /^https?:\/\/api\.telegram\.org(?::\d+)?\/(?:file\/)?bot/iu;
const EMBEDDED_TELEGRAM_BOT_URL =
  /https?:\/\/api\.telegram\.org(?::\d+)?\/(?:file\/)?bot/iu;

/** Fail closed if a telemetry payload cannot be inspected before export. */
export function containsTelegramBotTelemetryUrl(value: unknown): boolean {
  const serialized = safeSync(() => {
    return JSON.stringify(value);
  });
  return (
    !("ok" in serialized) ||
    typeof serialized.ok !== "string" ||
    EMBEDDED_TELEGRAM_BOT_URL.test(serialized.ok)
  );
}

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

/** Drop credential-bearing events, including parent errors with upstream URLs. */
export function filterTelegramSentryEvent<
  T extends Pick<ErrorEvent, "request">,
>(event: T): T | null {
  if (event.request?.url && isTelegramAuthTelemetryUrl(event.request.url)) {
    return null;
  }
  // A parent request's exception, extra data or retained breadcrumb can also
  // carry the outgoing URL. Sentry normalizes event data before beforeSend.
  return containsTelegramBotTelemetryUrl(event) ? null : event;
}

/** Do not retain credential-bearing HTTP breadcrumbs on unrelated events. */
export function filterTelegramSentryBreadcrumb<
  T extends Pick<Breadcrumb, "data">,
>(breadcrumb: T): T | null {
  return breadcrumb.data &&
    Object.values(breadcrumb.data).some((value) => {
      return (
        typeof value === "string" &&
        (isTelegramAuthTelemetryUrl(value) ||
          TELEGRAM_BOT_TELEMETRY_URL.test(value))
      );
    })
    ? null
    : breadcrumb;
}
