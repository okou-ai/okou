import { command } from "ccstate";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";

/** Dispatch terminal effects. */
export const dispatchCompleteSideEffects$ = command(
  async (
    { set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(dispatchCompleteSideEffectsCore$, input, signal);
    signal.throwIfAborted();
  },
);
