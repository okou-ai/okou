import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { safeSync } from "../signals/utils";

export const DISCORD_OAUTH_CALLBACK_PATH =
  "/api/integrations/discord/oauth/callback";

/** Match only credential-bearing Discord OAuth traffic, including relative URLs. */
export function isDiscordOauthTelemetryUrl(value: string): boolean {
  const parsed = safeSync(() => {
    return new URL(value, "https://telemetry.invalid");
  });
  if (!("ok" in parsed)) {
    return false;
  }
  const url = parsed.ok;
  return (
    /^\/api\/integrations\/discord\/oauth\/(?:start|callback|approve|complete)\/?$/u.test(
      url.pathname,
    ) ||
    (url.hostname === "discord.com" &&
      (url.pathname === "/oauth2/authorize" ||
        url.pathname === "/api/v10/oauth2/token")) ||
    new URLSearchParams(url.hash.slice(1)).has("approval_proof")
  );
}

/** Drop sensitive SDK events before transport, not merely after safe error formatting. */
export function filterDiscordOauthSentryEvent(
  event: ErrorEvent,
): ErrorEvent | null {
  if (event.request?.url && isDiscordOauthTelemetryUrl(event.request.url)) {
    return null;
  }
  return event;
}

/** SDK HTTP breadcrumbs can contain full outgoing/callback URLs. Never retain them. */
export function filterDiscordOauthSentryBreadcrumb(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  if (
    breadcrumb.data &&
    Object.values(breadcrumb.data).some((value) => {
      return typeof value === "string" && isDiscordOauthTelemetryUrl(value);
    })
  ) {
    return null;
  }
  return breadcrumb;
}
