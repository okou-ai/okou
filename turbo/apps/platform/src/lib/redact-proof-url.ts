import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { z } from "zod";

const diagnosticUrlSchema = z.url();

function parseUrl(value: string): URL | null {
  // Diagnostic values include ordinary text; supported Safari lacks URL.parse.
  const parsed = diagnosticUrlSchema.safeParse(value);
  return parsed.success ? new URL(parsed.data) : null;
}

function redactTelegramUrl(value: string): string {
  const url = parseUrl(value);
  const pathname = url?.pathname.toLowerCase().replace(/\/$/u, "");
  if (
    !url ||
    (pathname !== INTEGRATION_SETTINGS_PATHS.telegram &&
      pathname !== "/telegram/connect")
  ) {
    return value;
  }
  let changed = false;
  for (const key of ["sig", "ts", "tgUser", "tgUserName", "tgDisplayName"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.set(key, "[redacted]");
      changed = true;
    }
  }
  return changed ? url.href : value;
}

function redactRedirectParams(params: URLSearchParams): URLSearchParams {
  return new URLSearchParams(
    [...params].map(([key, value]) => {
      return [key, key === "redirect_url" ? redactTelegramUrl(value) : value];
    }),
  );
}

/** Diagnostic copies only. Never use this to construct browser navigation. */
export function redactProofUrl(value: string): string {
  const direct = redactTelegramUrl(value);
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
  return changed ? url.href : value;
}
