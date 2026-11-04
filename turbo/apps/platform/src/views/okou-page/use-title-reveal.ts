import type { DOMAttributes } from "react";
import { useSet } from "ccstate-react";
import {
  endTitleReveal$,
  startTitleReveal$,
} from "../../signals/chat-page/title-reveal.ts";

/** Attach to the semantic link or button, not just its title's text hit area. */
export function useTitleReveal(): Pick<
  DOMAttributes<HTMLElement>,
  | "onPointerEnter"
  | "onPointerLeave"
  | "onMouseEnter"
  | "onMouseLeave"
  | "onFocus"
  | "onBlur"
  | "onKeyDown"
> {
  const startReveal = useSet(startTitleReveal$);
  const endReveal = useSet(endTitleReveal$);
  return {
    onPointerEnter: (event) => {
      startReveal(event.currentTarget);
    },
    onPointerLeave: (event) => {
      endReveal(event.currentTarget);
    },
    // Touch can establish sticky :hover through compatibility mouse events
    // after its pointer has already left. An armed title is not sampled twice.
    onMouseEnter: (event) => {
      startReveal(event.currentTarget);
    },
    onMouseLeave: (event) => {
      endReveal(event.currentTarget);
    },
    onFocus: (event) => {
      if (event.currentTarget.matches(":focus-visible")) {
        startReveal(event.currentTarget);
      }
    },
    onBlur: (event) => {
      endReveal(event.currentTarget);
    },
    onKeyDown: (event) => {
      // Keyboard input can make an already mouse-focused control focus-visible
      // without dispatching another focus event.
      if (event.currentTarget.matches(":focus-visible")) {
        startReveal(event.currentTarget);
      }
    },
  };
}
