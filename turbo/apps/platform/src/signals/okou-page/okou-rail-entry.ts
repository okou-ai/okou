import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "../external/feature-switch.ts";

/** The rail's chat entry carries the Okou mark and name; New chat composes. */
export const okouRailEntryEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[FeatureSwitchKey.OkouRailEntry] === true;
});
