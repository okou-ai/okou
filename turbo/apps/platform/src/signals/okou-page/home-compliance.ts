import { command, computed, state } from "ccstate";
import { localStorageSignals } from "../external/local-storage.ts";

/**
 * The compliance block under the capability cards. A member can hide it; the
 * choice is kept on this device, like the install banner's.
 */
const { get$: dismissedRaw$, set$: setDismissedRaw$ } = localStorageSignals(
  "home-compliance-dismissed",
);

// Set while a block hidden on this page folds its height away; cleared when the
// fold ends, after which the block is no longer rendered.
const folding$ = state(false);

export const homeComplianceHidden$ = computed((get) => {
  return get(dismissedRaw$) !== null;
});

export const homeComplianceFolding$ = computed((get) => {
  return get(folding$);
});

/** Hide the block for good; `fold` keeps it mounted while it folds away. */
export const hideHomeCompliance$ = command(({ set }, fold: boolean) => {
  set(folding$, fold);
  set(setDismissedRaw$, "1");
});

export const finishHomeComplianceFold$ = command(({ set }) => {
  set(folding$, false);
});
