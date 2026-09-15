import { command, state } from "ccstate";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { clearPostHogAttribution } from "../../lib/posthog.ts";

const sessionKeys = [
  "okou.impactAttribution",
  "vm0.adAttribution",
  "vm0.signupAttributionRecorded",
  "vm0.googleAdsSignupConversionRecorded",
  "vm0.googleAdsAdsmarchSignupConversionRecorded",
  "vm0.googleAdsOnboardingStartConversionRecorded",
  "vm0.googleAdsCheckoutStartConversionRecorded",
  "vm0.googleAdsAdsmarchOnboardingStartConversionRecorded",
  "vm0.googleAdsAdsmarchCheckoutStartConversionRecorded",
].map(sessionStorageSignals);
const localKeys = [
  "googleAds.18407336975.paidInOnboardingConversion",
  "googleAds.18407336975.paidAfterOnboardingConversion",
  "googleAds.18407336975.conversionMilestones",
].map(localStorageSignals);
const cleared$ = state(false);
export const clearLegacyAcquisition$ = command(({ get, set }) => {
  if (get(cleared$)) {
    return;
  }
  for (const storage of [...sessionKeys, ...localKeys]) {
    set(storage.clear$);
  }
  clearPostHogAttribution();
  set(cleared$, true);
});
