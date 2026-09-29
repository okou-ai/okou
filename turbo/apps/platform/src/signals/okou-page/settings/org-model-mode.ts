import { command, computed, state } from "ccstate";

const internalAutoModelConfirmationOpen$ = state(false);
export const autoModelConfirmationOpen$ = computed((get) => {
  return get(internalAutoModelConfirmationOpen$);
});

export const setAutoModelConfirmationOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalAutoModelConfirmationOpen$, open);
  },
);
