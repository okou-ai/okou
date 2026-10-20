import { command, computed, state } from "ccstate";
import { onRef } from "./utils.ts";

// Visibility only: draft secrets remain in their existing form-owned inputs.
const visibleInputs$ = state<ReadonlySet<string>>(new Set());
export const remoteSecretVisibility$ = computed((get) => {
  return get(visibleInputs$);
});
export const toggleRemoteSecret$ = command(({ get, set }, id: string) => {
  const visible = new Set(get(visibleInputs$));
  if (visible.has(id)) {
    visible.delete(id);
  } else {
    visible.add(id);
  }
  set(visibleInputs$, visible);
});
export const mountRemoteSecretInput$ = onRef(
  command(({ get, set }, element: HTMLSpanElement, signal: AbortSignal) => {
    const id = element.querySelector("input")?.id;
    signal.addEventListener("abort", () => {
      if (id && get(visibleInputs$).has(id)) {
        const visible = new Set(get(visibleInputs$));
        visible.delete(id);
        set(visibleInputs$, visible);
      }
    });
  }),
);
