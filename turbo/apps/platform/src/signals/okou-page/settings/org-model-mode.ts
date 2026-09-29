import { command, computed, state } from "ccstate";
import type { OrgModelMode } from "@okouai/api-contracts/contracts/model-providers";
import { updateOrgModelMode$ } from "../../external/org-model-policies.ts";

const internalAutoModelConfirmationOpen$ = state(false);
export const autoModelConfirmationOpen$ = computed((get) => {
  return get(internalAutoModelConfirmationOpen$);
});

export const setAutoModelConfirmationOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalAutoModelConfirmationOpen$, open);
  },
);

/** One user action: persist the mode, then close the confirmation it came from. */
export const switchOrgModelMode$ = command(
  async ({ set }, mode: OrgModelMode, signal: AbortSignal) => {
    await set(updateOrgModelMode$, mode, signal);
    signal.throwIfAborted();
    set(internalAutoModelConfirmationOpen$, false);
  },
);
