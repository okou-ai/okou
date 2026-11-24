import { command, computed, state } from "ccstate";

const active$ = state(false);

/** The session includes the closing animation, until the dialog releases it. */
export const settingsDialogSessionActive$ = computed((get) => {
  return get(active$);
});

export const markSettingsDialogSessionStarted$ = command(({ set }) => {
  set(active$, true);
});

export const markSettingsDialogSessionReleased$ = command(({ set }) => {
  set(active$, false);
});
