import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";

export const onboardingCapabilitiesEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.OnboardingCapabilities];
});
