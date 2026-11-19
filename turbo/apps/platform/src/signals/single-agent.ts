import { computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitches$ } from "./external/feature-switch.ts";

export const singleAgentEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[FeatureSwitchKey.SingleAgent];
});
