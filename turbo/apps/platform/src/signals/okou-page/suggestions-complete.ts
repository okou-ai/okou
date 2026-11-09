import { command } from "ccstate";
import { playSuggestionConfetti } from "../../lib/suggestion-confetti.ts";
import { onRef } from "../utils.ts";

export const playSuggestionConfettiOnRef$ = onRef(
  command((_context, canvas: HTMLCanvasElement, signal: AbortSignal) => {
    playSuggestionConfetti(canvas, signal);
  }),
);
