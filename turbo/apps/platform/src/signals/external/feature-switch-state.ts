import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

const internalFeatureSwitchState$ = state<Record<FeatureSwitchKey, boolean>>(
  getAllFeatureStates({}),
);

export const featureSwitchState$ = computed((get) => {
  return get(internalFeatureSwitchState$);
});

const listeners$ = state<ReadonlySet<() => void>>(new Set());

export const registerFeatureSwitchListener$ = command(
  ({ get, set }, listener: () => void, signal: AbortSignal): void => {
    signal.throwIfAborted();
    set(listeners$, new Set([...get(listeners$), listener]));
    signal.addEventListener(
      "abort",
      () => {
        const remaining = new Set(get(listeners$));
        remaining.delete(listener);
        set(listeners$, remaining);
      },
      { once: true },
    );
  },
);

export const setFeatureSwitchState$ = command(
  ({ get, set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(internalFeatureSwitchState$, switches);
    for (const listener of get(listeners$)) {
      listener();
    }
  },
);
