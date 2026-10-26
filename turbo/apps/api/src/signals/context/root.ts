import { command, computed, state } from "ccstate";

interface SignalHolder {
  readonly signal: AbortSignal;
}

const innerRootSignal$ = state<SignalHolder | undefined>(undefined);

export const rootSignal$ = computed((get) => {
  const holder = get(innerRootSignal$);
  if (!holder) {
    throw new Error("API root signal is not initialized");
  }
  return holder.signal;
});

export const setRootSignal$ = command(({ set }, signal: AbortSignal) => {
  set(innerRootSignal$, { signal });
});
