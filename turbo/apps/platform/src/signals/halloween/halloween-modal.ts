import { command } from "ccstate";
import { onRef } from "../utils.ts";
import { initializeHalloween$ } from "./halloween.ts";
import { halloweenModalEntrance$ } from "./halloween-motion.ts";

export const mountHalloweenModal$ = onRef(
  command(async ({ set }, element: HTMLElement, signal: AbortSignal) => {
    set(halloweenModalEntrance$, element, signal);
    await set(initializeHalloween$, signal);
  }),
);
