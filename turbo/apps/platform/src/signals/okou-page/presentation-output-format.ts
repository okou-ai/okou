import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";

export const presentationOutputFormat$ = computed(async (get) => {
  const switches = await get(featureSwitches$);
  if (!switches[FeatureSwitchKey.PresentationOutputFormat]) {
    return undefined;
  }
  const { presentationFormat } = await get(userPreferences$);
  if (presentationFormat === undefined) {
    throw new Error("Presentation format preference is unavailable");
  }
  return presentationFormat;
});
