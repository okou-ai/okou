import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "./external/feature-switch.ts";

export const proactiveSettingsInMyOkou$ = computed(async (get) => {
  const features = await get(featureSwitches$);
  return features[FeatureSwitchKey.AgentSuggestion];
});
