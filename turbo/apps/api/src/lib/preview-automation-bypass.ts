import { env } from "./env";
import { safeUriComponentDecode } from "../signals/utils";

export const VERCEL_PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

export function previewAutomationBypassSecret(): string | undefined {
  if (env("ENV") !== "preview") {
    return undefined;
  }
  return env("VERCEL_AUTOMATION_BYPASS_SECRET");
}

function unquoteCookieValue(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

export function cookieHeaderValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  for (const cookie of cookieHeader?.split(";") ?? []) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = cookie.slice(0, separatorIndex).trim();
    if (key !== name) {
      continue;
    }
    return unquoteCookieValue(cookie.slice(separatorIndex + 1).trim());
  }
  return undefined;
}

export function requestHasPreviewAutomationBypassHeaderOrCookie(
  request: Request,
  secret: string,
): boolean {
  if (request.headers.get(VERCEL_PROTECTION_BYPASS_HEADER)?.trim() === secret) {
    return true;
  }
  const cookieValue = cookieHeaderValue(
    request.headers.get("cookie") ?? undefined,
    VERCEL_PROTECTION_BYPASS_HEADER,
  );
  return (
    cookieValue === secret ||
    safeUriComponentDecode(cookieValue ?? "") === secret
  );
}
