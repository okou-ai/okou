import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

const internalFeatureSwitchState$ = state<Record<FeatureSwitchKey, boolean>>(
  getAllFeatureStates({}),
);

export const featureSwitchState$ = computed((get) => {
  return get(internalFeatureSwitchState$);
});

export const setFeatureSwitchState$ = command(
  ({ set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(internalFeatureSwitchState$, switches);
  },
);
