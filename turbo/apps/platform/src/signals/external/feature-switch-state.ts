import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

const defaultFeatureSwitchState = getAllFeatureStates({});
const internalFeatureSwitchState$ = state<Record<
  FeatureSwitchKey,
  boolean
> | null>(null);

export const appliedFeatureSwitchState$ = computed((get) => {
  return get(internalFeatureSwitchState$);
});

export const featureSwitchState$ = computed((get) => {
  return get(appliedFeatureSwitchState$) ?? defaultFeatureSwitchState;
});

export const setFeatureSwitchState$ = command(
  ({ set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(internalFeatureSwitchState$, switches);
  },
);
