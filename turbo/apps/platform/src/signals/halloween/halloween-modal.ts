import { command } from "ccstate";
import { onRef } from "../utils.ts";
import { halloweenModalEntrance$ } from "./halloween-motion.ts";

export const mountHalloweenModal$ = onRef(
  command(({ set }, element: HTMLElement, signal: AbortSignal) => {
    set(halloweenModalEntrance$, element, signal);
  }),
);
