import {
  HOSTED_SITE_ACCESS_PATH,
  HOSTED_SITE_AUTH_START_PATH,
  hostedSiteReturnPathSchema,
  type HostedSiteAccessReason,
} from "@okouai/api-contracts/contracts/hosted-site-access";
import { resolveEditableHostedSiteDomain } from "./platform-host.ts";
import { ApiError } from "./api-error.ts";
import { i18n } from "../i18n/index.ts";

export function hostedSiteAccessTitle(reason: HostedSiteAccessReason): string {
  switch (reason) {
    case "authenticate": {
      return i18n.t(($) => {
        return $.artifacts.access.websiteAuthenticationTitle;
      });
    }
    case "expired": {
      return i18n.t(($) => {
        return $.artifacts.access.sessionExpiredTitle;
      });
    }
    case "unavailable": {
      return i18n.t(($) => {
        return $.artifacts.access.websiteUnavailableTitle;
      });
    }
    case "denied": {
      return i18n.t(($) => {
        return $.artifacts.access.websiteTitle;
      });
    }
  }
}

export function hostedSiteRecoveryReason(
  error: unknown,
): HostedSiteAccessReason {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return "authenticate";
    }
    if (error.status === 403 || error.status === 404) {
      return "denied";
    }
  }
  return "unavailable";
}

export function hostedSiteRecoveryTarget(value: string | null): URL | null {
  if (!value || !URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const domain = resolveEditableHostedSiteDomain();
  const label = url.hostname.endsWith(`.${domain}`)
    ? url.hostname.slice(0, -domain.length - 1)
    : "";
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(label) ||
    /^(?:pv|ps|sh)-/u.test(label) ||
    !hostedSiteReturnPathSchema.safeParse(`${url.pathname}${url.search}`)
      .success
  ) {
    return null;
  }
  return url;
}

export function hostedSiteRecoveryUrl(
  siteUrl: string | null,
  reason: HostedSiteAccessReason,
): string {
  const url = new URL(HOSTED_SITE_ACCESS_PATH, location.origin);
  const target = hostedSiteRecoveryTarget(siteUrl);
  if (target) {
    url.searchParams.set("url", target.href);
  }
  url.searchParams.set("reason", reason);
  return url.href;
}

export function hostedSiteSignInUrl(target: URL): string {
  const url = new URL(HOSTED_SITE_AUTH_START_PATH, target.origin);
  url.searchParams.set("returnTo", `${target.pathname}${target.search}`);
  return url.href;
}
