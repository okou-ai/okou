import {
  INTEGRATION_SETTINGS_PATHS,
  INTEGRATION_OAUTH_CALLBACK_PATHS,
} from "@okouai/core/integration-routes";
import { url as zUrl } from "zod";

const diagnosticUrlSchema = zUrl();
const oauthCallbackPaths = [
  ...Object.values(INTEGRATION_OAUTH_CALLBACK_PATHS),
  "/api/integrations/slack/oauth/callback",
  "/api/integrations/teams/oauth/callback",
  "/api/github/app/setup/callback",
] as const;

function parseUrl(value: string): URL | null {
  // Diagnostic values include ordinary text; supported Safari lacks URL.parse.
  // Navigation breadcrumbs use relative URLs. This parsing base is never emitted.
  const parsed = diagnosticUrlSchema.safeParse(
    value.startsWith("/") && !value.startsWith("//")
      ? `https://redaction.invalid${value}`
      : value,
  );
  return parsed.success ? new URL(parsed.data) : null;
}

function diagnosticUrl(url: URL, original: string): string {
  return original.startsWith("/")
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}

function redactAuthorizationUrl(value: string): string {
  const url = parseUrl(value);
  if (!url) {
    return value;
  }
  const pathname = url.pathname.toLowerCase().replace(/\/$/u, "");
  const keys = oauthCallbackPaths.some((path) => {
    return path === pathname;
  })
    ? ["code", "state"]
    : pathname === INTEGRATION_SETTINGS_PATHS.telegram ||
        pathname === "/telegram/connect"
      ? ["sig", "ts", "tgUser", "tgUserName", "tgDisplayName"]
      : [];
  let changed = false;
  for (const key of keys) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "[redacted]");
      changed = true;
    }
  }
  return changed ? diagnosticUrl(url, value) : value;
}

function redactRedirectParams(params: URLSearchParams): URLSearchParams {
  return new URLSearchParams(
    [...params].map(([key, value]) => {
      return [
        key,
        key === "redirect_url" ? redactAuthorizationUrl(value) : value,
      ];
    }),
  );
}

/** Diagnostic copies only. Never use this to construct browser navigation. */
export function redactProofUrl(value: string): string {
  const direct = redactAuthorizationUrl(value);
  if (direct !== value) {
    return direct;
  }
  const url = parseUrl(value);
  if (!url || !/^\/sign-(?:in|up)(?:\/|$)/u.test(url.pathname)) {
    return value;
  }
  const search = redactRedirectParams(url.searchParams);
  let changed = search.toString() !== url.searchParams.toString();
  if (changed) {
    url.search = search.toString();
  }
  // Clerk can move redirect_url into #/?redirect_url=... on the auth page.
  const queryIndex = url.hash.indexOf("?");
  if (queryIndex !== -1) {
    const original = new URLSearchParams(url.hash.slice(queryIndex + 1));
    const params = redactRedirectParams(original);
    if (params.toString() !== original.toString()) {
      url.hash = `${url.hash.slice(0, queryIndex + 1)}${params}`;
      changed = true;
    }
  }
  return changed ? diagnosticUrl(url, value) : value;
}
