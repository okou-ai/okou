import { command, computed, state } from "ccstate";

import { onRef } from "../../utils.ts";
import { observeRail, type RailTravel } from "../rail-travel.ts";

/**
 * Whether the directory's category row can still travel. The row is one modal
 * at a time, so a single value is enough; the composer keeps a keyed record
 * because it can show several rails at once.
 *
 * A row that has never reported is assumed to fit, which keeps both pagers off
 * a row short enough to show every category.
 */
const internalCategoryRailTravel$ = state<RailTravel>({
  canScrollBack: false,
  canScrollForward: false,
});

export const connectorCategoryRailTravel$ = computed((get) => {
  return get(internalCategoryRailTravel$);
});

export const setConnectorCategoryRailTravel$ = command(
  ({ get, set }, travel: RailTravel) => {
    const current = get(internalCategoryRailTravel$);
    if (
      current.canScrollBack === travel.canScrollBack &&
      current.canScrollForward === travel.canScrollForward
    ) {
      return;
    }
    set(internalCategoryRailTravel$, travel);
  },
);

/** Owns the row's observers for as long as the dialog holds it. */
export const bindConnectorCategoryRail$ = onRef(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    observeRail(element, signal, (travel) => {
      set(setConnectorCategoryRailTravel$, travel);
    });
  }),
);
