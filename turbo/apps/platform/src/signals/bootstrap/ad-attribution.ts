import {
  ACQUISITION_ATTRIBUTION_COOKIE,
  SOURCE_TYPES,
  type AdAttributionMetadata,
  type SourceType,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { command } from "ccstate";
import {
  compatibleGoogleAdsAttribution,
  normalizeGoogleAdsAttributionParams,
} from "@okouai/core/google-ads-attribution";
import { registerPostHogAttribution } from "../../lib/posthog.ts";
import { recordImpactAttribution$ } from "./impact-attribution.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";

const AD_ATTRIBUTION_SOURCE_PARAM = "vm0_source";

const STORED_AD_ATTRIBUTION_KEY = "vm0.adAttribution";
const GOOGLE_ANALYTICS_CLIENT_ID_COOKIE = "_ga";
const GOOGLE_ANALYTICS_CLIENT_ID_METADATA_PARAM = "ga_client_id";

const AD_ATTRIBUTION_PARAMS = [
  "source_type",
  "referrer_domain",
  "landing_host",
  "landing_path",
  AD_ATTRIBUTION_SOURCE_PARAM,
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "okou_campaign_id",
  "okou_ad_group_id",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const STRIPE_METADATA_PARAMS = [
  "referrer_domain",
  "landing_host",
  "landing_path",
  AD_ATTRIBUTION_SOURCE_PARAM,
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "okou_campaign_id",
  "okou_ad_group_id",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const STRIPE_CLICK_ID_PRESENT_PARAMS = [
  ["gclid", "gclid_present"],
  ["gbraid", "gbraid_present"],
  ["wbraid", "wbraid_present"],
] as const;

const storedAdAttributionStorage = sessionStorageSignals(
  STORED_AD_ATTRIBUTION_KEY,
);

function collectAttributionParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const attributionParams = new URLSearchParams();
  const normalized = normalizeGoogleAdsAttributionParams(searchParams);

  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of normalized.getAll(param)) {
      attributionParams.append(param, value);
    }
  }

  return attributionParams;
}

function isSourceType(value: string | null): value is SourceType {
  return SOURCE_TYPES.some((candidate) => {
    return candidate === value;
  });
}

function getCookieString(): string {
  if (typeof document === "undefined") {
    return "";
  }
  return document.cookie;
}

function readCookie(name: string, cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

function googleAnalyticsClientIdFromCookie(
  cookieString: string,
): string | undefined {
  const value = readCookie(GOOGLE_ANALYTICS_CLIENT_ID_COOKIE, cookieString);
  if (!value) {
    return undefined;
  }

  const parts = value.split(".");
  if (parts.length < 4 || !/^GA\d+$/.test(parts[0] ?? "")) {
    return undefined;
  }

  const clientId = parts.slice(2).join(".");
  return /^\d+\.\d+$/.test(clientId) ? clientId : undefined;
}

// First-touch attribution forwarded across the www -> app hop in the shared
// registrable-domain cookie. Re-collected through the whitelist so only known
// params are persisted.
function collectAttributionFromCookie(cookieString: string): string {
  const stored = readCookie(ACQUISITION_ATTRIBUTION_COOKIE, cookieString);
  if (!stored) {
    return "";
  }
  return collectAttributionParams(new URLSearchParams(stored)).toString();
}

function registerStoredAttribution(
  storedAttribution: string,
  cookieString: string,
): void {
  const metadata = adAttributionMetadataFromStoredValue(
    storedAttribution,
    cookieString,
  );
  if (!metadata) {
    return;
  }

  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    compatibleGoogleAdsAttribution(metadata),
  )) {
    if (typeof value === "string" && value) {
      properties[key] = value;
    }
  }
  registerPostHogAttribution(properties);
}

export const recordAdAttribution$ = command(
  ({ get, set }, searchParams: URLSearchParams): void => {
    set(recordImpactAttribution$);
    const cookieString = getCookieString();
    const storedAttribution = get(storedAdAttributionStorage.get$);

    // First-touch: once captured this session, never overwrite.
    if (storedAttribution) {
      registerStoredAttribution(storedAttribution, cookieString);
      return;
    }

    // Prefer params on the current URL (an ad pointing straight at the app),
    // otherwise fall back to the shared cookie set by the marketing site.
    const serializedAttribution =
      collectAttributionParams(searchParams).toString() ||
      collectAttributionFromCookie(cookieString);
    if (!serializedAttribution) {
      return;
    }

    set(storedAdAttributionStorage.set$, serializedAttribution);
    registerStoredAttribution(serializedAttribution, cookieString);
  },
);

export const applyStoredAdAttribution$ = command(
  ({ get, set }, url: URL): void => {
    const impact = set(recordImpactAttribution$);
    if (impact) {
      url.searchParams.set("im_ref", impact.clickId);
      url.searchParams.set("im_ref_at", impact.capturedAt);
    }
    const storedAttribution = get(storedAdAttributionStorage.get$);
    if (!storedAttribution) {
      return;
    }

    const attributionParams = collectAttributionParams(
      new URLSearchParams(storedAttribution),
    );
    url.searchParams.delete("vm0_campaign_id");
    url.searchParams.delete("vm0_ad_group_id");
    for (const param of AD_ATTRIBUTION_PARAMS) {
      url.searchParams.delete(param);

      for (const value of attributionParams.getAll(param)) {
        url.searchParams.append(param, value);
      }
    }
  },
);

function adAttributionMetadataFromStoredValue(
  storedAttribution: string | null,
  cookieString: string,
): AdAttributionMetadata | undefined {
  const attributionParams = collectAttributionParams(
    new URLSearchParams(storedAttribution ?? ""),
  );
  const metadata: AdAttributionMetadata = {};

  const sourceType = attributionParams.get("source_type");
  if (isSourceType(sourceType)) {
    metadata.source_type = sourceType;
  }

  for (const param of STRIPE_METADATA_PARAMS) {
    const value = attributionParams.get(param);
    if (value) {
      metadata[param] = value;
    }
  }

  for (const [clickIdParam, metadataParam] of STRIPE_CLICK_ID_PRESENT_PARAMS) {
    const value = attributionParams.get(clickIdParam);
    if (value) {
      metadata[clickIdParam] = value;
      metadata[metadataParam] = "true";
    }
  }

  const gaClientId = googleAnalyticsClientIdFromCookie(cookieString);
  if (gaClientId) {
    metadata[GOOGLE_ANALYTICS_CLIENT_ID_METADATA_PARAM] = gaClientId;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export const readStoredAdAttributionMetadata$ = command(({ get }) => {
  return adAttributionMetadataFromStoredValue(
    get(storedAdAttributionStorage.get$),
    getCookieString(),
  );
});
