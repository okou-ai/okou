import { command } from "ccstate";
import { playSuggestionFireworks } from "../../lib/suggestion-fireworks.ts";
import { onRef } from "../utils.ts";

export const playSuggestionFireworksOnRef$ = onRef(
  command((_context, canvas: HTMLCanvasElement, signal: AbortSignal) => {
    playSuggestionFireworks(canvas, signal);
  }),
);
