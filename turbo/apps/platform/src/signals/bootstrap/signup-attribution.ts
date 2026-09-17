import { compatibleGoogleAdsAttribution } from "@okouai/core/google-ads-attribution";
import {
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
  GOOGLE_ADS_LEGACY_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";
import { command } from "ccstate";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import { accept } from "../../lib/accept.ts";
import { capturePaidOnboardingEvent } from "../../lib/posthog.ts";
import { now } from "../../lib/time.ts";
import { apiClient$ } from "../api-client.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import {
  createAttributionRequest,
  readAttributionContext$,
  type AttributionContext,
} from "./attribution-request.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_ADSMARCH_SIGNUP_SEND_TO,
  GOOGLE_ADS_SIGNUP_SEND_TO,
} from "./google-ads-conversion.ts";

import {
  invalidateGoogleAdsAccount$,
  resolveGoogleAdsAccount$,
} from "./google-ads-account.ts";

const SIGNUP_ATTRIBUTION_RECORDED_KEY = "vm0.signupAttributionRecorded";
const SIGNUP_CONVERSION_RECORDED_KEY = "vm0.googleAdsSignupConversionRecorded";
const ADSMARCH_SIGNUP_CONVERSION_RECORDED_KEY =
  "vm0.googleAdsAdsmarchSignupConversionRecorded";
const SIGNUP_CONVERSION_VALUE_USD = 1;
const SIGNUP_CONVERSION_MAX_USER_AGE_MS = 30 * 60 * 1000;
const signupAttributionRecordedStorage = sessionStorageSignals(
  SIGNUP_ATTRIBUTION_RECORDED_KEY,
);
const signupConversionRecordedStorage = sessionStorageSignals(
  SIGNUP_CONVERSION_RECORDED_KEY,
);
const adsmarchSignupConversionRecordedStorage = sessionStorageSignals(
  ADSMARCH_SIGNUP_CONVERSION_RECORDED_KEY,
);

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function isRecentlyCreatedUser(user: {
  readonly createdAt?: unknown;
}): boolean {
  const createdAtMs = timestampMs(user.createdAt);
  if (createdAtMs === null) {
    return false;
  }
  const ageMs = now() - createdAtMs;
  return ageMs >= 0 && ageMs <= SIGNUP_CONVERSION_MAX_USER_AGE_MS;
}

const submitSignupAttribution$ = command(
  async ({ get, set }, context: AttributionContext, signal: AbortSignal) => {
    const client = get(apiClient$)(acquisitionAttributionContract, {
      getTokenGuard: context.getTokenGuard,
    });
    const result = await accept(
      client.recordSignup({
        body: {
          attribution: context.attribution ?? { source_type: "unknown" },
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    context.assertCurrent();
    // The check can establish a first touch after an earlier ownership read.
    set(invalidateGoogleAdsAccount$);
    if (result.body.recorded && context.user) {
      const attribution: AdAttributionMetadata = context.attribution ?? {
        source_type: "unknown",
      };
      const attributionFingerprint = `${context.user.id}:${JSON.stringify(attribution)}`;
      set(signupAttributionRecordedStorage.set$, attributionFingerprint);
      capturePaidOnboardingEvent("SignupAttributionRecorded", {
        landing_host: window.location.host,
        landing_path: window.location.pathname,
        source_type: attribution.source_type ?? "unknown",
        ...compatibleGoogleAdsAttribution({
          okou_campaign_id: attribution.okou_campaign_id,
          okou_ad_group_id: attribution.okou_ad_group_id,
        }),
      });
    }
    return result.body;
  },
);

const signupRequest = createAttributionRequest(submitSignupAttribution$, () => {
  return true;
});

export const recordSignupAttribution$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const context = await set(readAttributionContext$, signal);
    const user = context.user;
    if (!user) {
      return;
    }
    const recentlyCreatedUser = isRecentlyCreatedUser(user);
    const attribution: AdAttributionMetadata | undefined =
      context.attribution ??
      (recentlyCreatedUser ? { source_type: "unknown" } : undefined);
    if (!attribution) {
      return;
    }
    const result = await set(signupRequest.request$, context, signal);
    const attributionFingerprint = `${user.id}:${JSON.stringify(attribution)}`;
    // A completed no-op check is not permission to send a signup conversion.
    const recorded =
      get(signupAttributionRecordedStorage.get$) === attributionFingerprint;
    let googleAdsAccountId = result.googleAdsAccountId;

    if (recorded && recentlyCreatedUser) {
      googleAdsAccountId ??= await set(resolveGoogleAdsAccount$, signal);
      context.assertCurrent();
      const config =
        googleAdsAccountId === GOOGLE_ADS_LEGACY_ACCOUNT_ID
          ? {
              sendTo: GOOGLE_ADS_SIGNUP_SEND_TO,
              storage: signupConversionRecordedStorage,
              transactionId: undefined,
            }
          : googleAdsAccountId === GOOGLE_ADS_ADSMARCH_ACCOUNT_ID
            ? {
                sendTo: GOOGLE_ADS_ADSMARCH_SIGNUP_SEND_TO,
                storage: adsmarchSignupConversionRecordedStorage,
                transactionId: user.id,
              }
            : null;
      if (!config) {
        return;
      }
      const conversionFired = fireGoogleAdsConversion({
        accountId: googleAdsAccountId,
        sendTo: config.sendTo,
        dedupeValue: user.id,
        value: SIGNUP_CONVERSION_VALUE_USD,
        storedDedupeValue: get(config.storage.get$),
        transactionId: config.transactionId,
      });
      if (conversionFired) {
        set(config.storage.set$, user.id);
      }
    }
  },
);
