import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
import { onRef, resetSignal } from "../utils.ts";

type ModelPickerCategory = "chat" | "image" | "video";

type ModelPickerMenuPage =
  | { readonly kind: "overview" }
  | { readonly kind: "models"; readonly category: ModelPickerCategory };

/** Which side of the root panel the flyout has room to open towards. */
type ModelPickerFlyoutSide = "left" | "right";

const FLYOUT_PANEL_WIDTH = 258;
const FLYOUT_VIEWPORT_MARGIN = 8;

/**
 * How long a pointer has to rest on a type row before its panel opens. A
 * pointer crossing the rail on its way somewhere else passes each row in far
 * less than this, so only a row the user stops on swaps the panel.
 */
const FLYOUT_HOVER_INTENT_MS = 200;

/** One navigation state per composer, including split chats. */
export function createModelPickerMenuSignals() {
  const internalPage$ = state<ModelPickerMenuPage>({ kind: "overview" });
  const page$ = computed((get) => {
    return get(internalPage$);
  });
  const reset$ = command(({ set }) => {
    set(internalPage$, { kind: "overview" });
    // Closing the picker drops a swap the pointer scheduled on its way out.
    set(resetHoverIntent$);
    set(internalFlyoutCategory$, "chat");
  });
  const showModels$ = command(({ set }, category: ModelPickerCategory) => {
    set(internalPage$, { kind: "models", category });
  });
  const focusPanelRef$ = onRef(
    command((_context, element: HTMLElement, _signal: AbortSignal) => {
      element
        .querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    }),
  );

  // The flyout keeps its own category rather than reusing the drill-in page:
  // hovering a type must not push a navigation entry the user has to unwind.
  const internalFlyoutCategory$ = state<ModelPickerCategory>("chat");
  const flyoutCategory$ = computed((get) => {
    return get(internalFlyoutCategory$);
  });
  // Hovering schedules the swap rather than performing it. The owner stays in
  // the domain instead of inside debounceCommand because leaving a row has to
  // cancel a pending swap without scheduling a replacement to supersede it.
  const resetHoverIntent$ = resetSignal();

  const setFlyoutCategory$ = command(
    ({ set }, category: ModelPickerCategory) => {
      // A click or keyboard move is already deliberate: it takes effect now and
      // drops whatever the pointer was in the middle of scheduling.
      set(resetHoverIntent$);
      set(internalFlyoutCategory$, category);
    },
  );

  /** Swap the panel only once the pointer has settled on the row. */
  const hoverFlyoutCategory$ = command(
    async (
      { set },
      category: ModelPickerCategory,
      parentSignal: AbortSignal,
    ) => {
      const signal = set(resetHoverIntent$, parentSignal);
      await delay(FLYOUT_HOVER_INTENT_MS, { signal });
      signal.throwIfAborted();
      set(internalFlyoutCategory$, category);
    },
  );

  /** The pointer left before it settled, so the row it grazed never opens. */
  const cancelFlyoutCategoryHover$ = command(({ set }) => {
    set(resetHoverIntent$);
  });

  const internalFlyoutSide$ = state<ModelPickerFlyoutSide>("left");
  const flyoutSide$ = computed((get) => {
    return get(internalFlyoutSide$);
  });
  /**
   * Open the panel towards a side it actually fits on. Measured from the
   * anchored root, so the root itself never moves when the panel flips, and
   * measured after the popover has been positioned -- on mount the root is
   * still at its pre-collision position and would pick the wrong side.
   */
  const flyoutRootRef$ = onRef(
    command(({ set }, element: HTMLElement, signal: AbortSignal) => {
      let frame = 0;
      const measure = () => {
        const box = element.getBoundingClientRect();
        const roomRight =
          window.innerWidth - box.right - FLYOUT_VIEWPORT_MARGIN;
        const roomLeft = box.left - FLYOUT_VIEWPORT_MARGIN;
        set(
          internalFlyoutSide$,
          roomRight >= FLYOUT_PANEL_WIDTH
            ? "right"
            : roomLeft >= FLYOUT_PANEL_WIDTH
              ? "left"
              : roomRight >= roomLeft
                ? "right"
                : "left",
        );
      };
      // Two frames: the first lets the popover commit its collision-adjusted
      // position, the second measures the box it settled on.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(measure);
      });
      window.addEventListener("resize", measure);
      signal.addEventListener("abort", () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener("resize", measure);
        // The rail cancels a scheduled swap on mouseleave, but an unmounted row
        // never sends one: closing the picker while the pointer rests on a row
        // would otherwise swap the category of a menu that is already gone.
        set(resetHoverIntent$);
      });
    }),
  );

  /** Land on the current model, not on whatever renders first. */
  const focusFlyoutPanelRef$ = onRef(
    command((_context, element: HTMLElement, _signal: AbortSignal) => {
      const selected = element.querySelector<HTMLButtonElement>(
        '[role="option"][aria-selected="true"]',
      );
      (
        selected ?? element.querySelector<HTMLButtonElement>('[role="option"]')
      )?.focus();
    }),
  );

  return {
    page$,
    reset$,
    showModels$,
    focusPanelRef$,
    flyoutCategory$,
    setFlyoutCategory$,
    hoverFlyoutCategory$,
    cancelFlyoutCategoryHover$,
    flyoutSide$,
    flyoutRootRef$,
    focusFlyoutPanelRef$,
  };
}

export type ModelPickerMenuSignals = ReturnType<
  typeof createModelPickerMenuSignals
>;
