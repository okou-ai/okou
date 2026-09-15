import {
  GOOGLE_ADS_ADSMARCH_ACCOUNT_ID,
  GOOGLE_ADS_LEGACY_ACCOUNT_ID,
} from "@okouai/core/google-ads-account";

// Google Ads website-tag conversions. The gtag base snippet lives in
// `apps/platform/src/lib/google-ads.ts`; these are the event snippets for the
// conversion actions that Google Ads uses as bidding signals. Legacy
// `UPLOAD_CLICKS` actions remain server-only; the adsmarch website actions can
// also receive a server-side Data Manager fallback with the same transaction ID.

export const GOOGLE_ADS_SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
export const GOOGLE_ADS_ONBOARDING_START_SEND_TO =
  "AW-18144854014/GVKdCLbQ9LscEP7_kcxD";
export const GOOGLE_ADS_CHECKOUT_START_SEND_TO =
  "AW-18144854014/EEovCKmuvbscEP7_kcxD";
export const GOOGLE_ADS_ADSMARCH_SIGNUP_SEND_TO =
  "AW-18407336975/8mCZCLORrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_ONBOARDING_START_SEND_TO =
  "AW-18407336975/xkGcCLaRrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_CHECKOUT_START_SEND_TO =
  "AW-18407336975/hWi8CPWRrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_PAID_IN_ONBOARDING_SEND_TO =
  "AW-18407336975/M7QYCPiRrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_PAID_AFTER_ONBOARDING_SEND_TO =
  "AW-18407336975/ePWuCPuRrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_FREE_TRIAL_COMPLETED_SEND_TO =
  "AW-18407336975/kS5jCP6RrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_FIRST_RUN_COMPLETED_SEND_TO =
  "AW-18407336975/uEoeCIGSrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_SECOND_RUN_COMPLETED_SEND_TO =
  "AW-18407336975/0S04CISSrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_ONE_CONNECTOR_CONNECTED_SEND_TO =
  "AW-18407336975/QpfCCIeSrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_TWO_CONNECTORS_CONNECTED_SEND_TO =
  "AW-18407336975/DFtNCIqSrOccEI_YpslE";
export const GOOGLE_ADS_ADSMARCH_MULTI_DAY_RUN_COMPLETED_SEND_TO =
  "AW-18407336975/ZGzhCI2SrOccEI_YpslE";

type GoogleTag = (
  command: "event",
  eventName: "conversion",
  params: {
    readonly send_to: string;
    readonly value: number;
    readonly currency: "USD";
    readonly transaction_id?: string;
  },
) => void;

type WindowWithGoogleTag = Window & {
  readonly gtag?: GoogleTag;
};

/**
 * Fire a Google Ads conversion unless the caller already persisted the same
 * dedupe value. Returns whether the event fired so the caller can persist it.
 */
export function fireGoogleAdsConversion(args: {
  readonly accountId: string | null;
  readonly sendTo: string;
  readonly dedupeValue: string;
  readonly value: number;
  readonly storedDedupeValue: string | null;
  readonly transactionId?: string;
}): boolean {
  const tagId =
    args.accountId === GOOGLE_ADS_LEGACY_ACCOUNT_ID
      ? "AW-18144854014"
      : args.accountId === GOOGLE_ADS_ADSMARCH_ACCOUNT_ID
        ? "AW-18407336975"
        : null;
  if (!tagId || !args.sendTo.startsWith(`${tagId}/`)) {
    return false;
  }
  if (args.storedDedupeValue === args.dedupeValue) {
    return false;
  }

  const gtag =
    typeof window === "undefined"
      ? undefined
      : (window as WindowWithGoogleTag).gtag;
  if (typeof gtag !== "function") {
    return false;
  }

  gtag("event", "conversion", {
    send_to: args.sendTo,
    value: args.value,
    currency: "USD",
    ...(args.transactionId === undefined
      ? {}
      : { transaction_id: args.transactionId }),
  });
  return true;
}
