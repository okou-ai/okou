import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PresentationOutputFormat } from "@okouai/core/presentation-output-format";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { userPreferences$ } from "./settings/user-preferences.ts";

export const presentationOutputFormatEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[
    FeatureSwitchKey.PresentationOutputFormat
  ];
});

export const presentationFormatPreference$ = computed(
  async (get): Promise<PresentationOutputFormat | null | undefined> => {
    if (!(await get(presentationOutputFormatEnabled$))) {
      return undefined;
    }
    return (await get(userPreferences$)).presentationFormat;
  },
);
