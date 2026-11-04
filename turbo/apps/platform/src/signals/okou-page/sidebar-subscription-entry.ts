import { command, computed, state } from "ccstate";
import { onRef } from "../utils.ts";
import { refreshThirdPartySubscriptionsIfStale$ } from "../external/third-party-subscriptions.ts";
import {
  openSettingsDialogAt$,
  settingsDialogOpen$,
} from "./settings/settings-dialog.ts";
import {
  accountMenuCodexResetDialog$,
  setAccountMenuCodexResetDialog$,
} from "./settings/personal-model-providers.ts";

const internalSidebarSubscriptionOpen$ = state(false);
const internalSidebarSubscriptionEntry$ = state<HTMLButtonElement | null>(null);

export const sidebarSubscriptionOpen$ = computed((get) => {
  return (
    get(internalSidebarSubscriptionOpen$) &&
    !get(settingsDialogOpen$) &&
    !get(accountMenuCodexResetDialog$).open
  );
});

export const setSidebarSubscriptionEntry$ = onRef(
  command(({ set }, element: HTMLButtonElement, signal: AbortSignal) => {
    set(internalSidebarSubscriptionEntry$, element);
    signal.addEventListener(
      "abort",
      () => {
        set(internalSidebarSubscriptionEntry$, null);
        set(internalSidebarSubscriptionOpen$, false);
      },
      { once: true },
    );
  }),
);

export const previewSidebarSubscriptionUsage$ = command(
  ({ get, set }, open: boolean) => {
    if (get(settingsDialogOpen$) || get(accountMenuCodexResetDialog$).open) {
      return;
    }
    set(internalSidebarSubscriptionOpen$, open);
    if (open) {
      set(refreshThirdPartySubscriptionsIfStale$);
    }
  },
);

const prepareSubscriptionDialog$ = command(({ get, set }) => {
  // The popup row unmounts. Let the modal capture the persistent rail entry
  // as its return target before handing focus to the modal.
  get(internalSidebarSubscriptionEntry$)?.focus();
  set(internalSidebarSubscriptionOpen$, false);
});

export const openSidebarSubscriptionUsageDialog$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(prepareSubscriptionDialog$);
    await set(openSettingsDialogAt$, "model", signal);
  },
);

export const openSidebarSubscriptionResetDialog$ = command(
  ({ set }, resetCredits: number | null) => {
    set(prepareSubscriptionDialog$);
    set(setAccountMenuCodexResetDialog$, { open: true, resetCredits });
  },
);
