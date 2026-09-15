import { command, computed, state } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

const internalFeatureSwitchState$ = state<Record<FeatureSwitchKey, boolean>>(
  getAllFeatureStates({}),
);

const featureSwitchListeners$ = state<ReadonlySet<() => void>>(new Set());

/** Keep imperative DOM consumers subscribed only for their mounted lifetime. */
export const observeFeatureSwitchChanges$ = command(
  ({ get, set }, listener: () => void, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(
      featureSwitchListeners$,
      new Set([...get(featureSwitchListeners$), listener]),
    );
    signal.addEventListener(
      "abort",
      () => {
        const remaining = new Set(get(featureSwitchListeners$));
        remaining.delete(listener);
        set(featureSwitchListeners$, remaining);
      },
      { once: true },
    );
  },
);

export const featureSwitchState$ = computed((get) => {
  return get(internalFeatureSwitchState$);
});

export const setFeatureSwitchState$ = command(
  ({ get, set }, switches: Record<FeatureSwitchKey, boolean>) => {
    set(internalFeatureSwitchState$, switches);
    for (const listener of get(featureSwitchListeners$)) {
      listener();
    }
  },
);
