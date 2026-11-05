import { command, state } from "ccstate";
import { animationFrame } from "signal-timers";
import { onRef } from "../utils.ts";

interface SuggestionList {
  readonly element: HTMLElement;
  readonly signal: AbortSignal;
  /** The slide each row is playing, so a newer move starts where it is. */
  readonly moves: Map<HTMLElement, Animation>;
}

const suggestionList$ = state<SuggestionList | null>(null);

function suggestionRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter((child): child is HTMLElement => {
    return (
      child instanceof HTMLElement && child.dataset.suggestionRow !== undefined
    );
  });
}

/** The Feed list owns the slides of its rows and cancels them on detach. */
export const suggestionListRef$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    const list: SuggestionList = { element, signal, moves: new Map() };
    set(suggestionList$, list);
    signal.addEventListener(
      "abort",
      () => {
        for (const animation of list.moves.values()) {
          animation.cancel();
        }
        if (get(suggestionList$) === list) {
          set(suggestionList$, null);
        }
      },
      { once: true },
    );
  }),
);

/**
 * Run immediately before a change that moves Feed rows. Each row's position is
 * recorded now; on the next frame, after the change is committed, every row
 * that moved slides from there into its new place.
 */
export const slideSuggestionRows$ = command(({ get }) => {
  const list = get(suggestionList$);
  if (!list || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const before = new Map(
    suggestionRows(list.element).map((row) => {
      return [row.dataset.suggestionRow, row.getBoundingClientRect().top];
    }),
  );
  animationFrame(
    () => {
      for (const row of suggestionRows(list.element)) {
        const top = before.get(row.dataset.suggestionRow);
        if (top === undefined) {
          continue;
        }
        // The recorded position already includes an unfinished slide.
        list.moves.get(row)?.cancel();
        list.moves.delete(row);
        const offset = top - row.getBoundingClientRect().top;
        if (Math.abs(offset) < 1) {
          continue;
        }
        const animation = row.animate(
          [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
          { duration: 360, easing: "cubic-bezier(0.2, 0, 0, 1)" },
        );
        list.moves.set(row, animation);
        animation.addEventListener(
          "finish",
          () => {
            if (list.moves.get(row) === animation) {
              list.moves.delete(row);
            }
          },
          { once: true },
        );
      }
    },
    { signal: list.signal },
  );
});
