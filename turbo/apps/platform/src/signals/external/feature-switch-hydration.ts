import { computed } from "ccstate";
import { rootSignal$ } from "../root-signal.ts";
import { createDeferredPromise } from "../utils.ts";

// eslint-disable-next-line ccstate/no-computed-signal -- migrate this computed away from AbortSignal ownership
export const initialFeatureSwitchHydrationDeferred$ = computed((get) => {
  return createDeferredPromise<void>(get(rootSignal$));
});

/**
 * Resolves after the first authoritative feature-switch read for this app
 * lifetime. Consumers that turn a switch into immutable parsed state await
 * this boundary instead of committing repository defaults permanently.
 */
export const initialFeatureSwitchHydration$ = computed((get) => {
  return get(initialFeatureSwitchHydrationDeferred$).promise;
});
