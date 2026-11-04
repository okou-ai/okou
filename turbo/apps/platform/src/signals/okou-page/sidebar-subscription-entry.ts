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
const internalSidebarSubscriptionFocusReturnPending$ = state(false);

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
        set(internalSidebarSubscriptionFocusReturnPending$, false);
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

export const focusSidebarSubscriptionEntry$ = command(({ get, set }) => {
  if (get(settingsDialogOpen$) || get(accountMenuCodexResetDialog$).open) {
    return;
  }
  if (get(internalSidebarSubscriptionFocusReturnPending$)) {
    // Modal dismissal returns keyboard focus without requesting a new preview.
    set(internalSidebarSubscriptionFocusReturnPending$, false);
    return;
  }
  set(previewSidebarSubscriptionUsage$, true);
});

const prepareSubscriptionDialog$ = command(({ get, set }) => {
  // The popup row unmounts. Let the modal capture the persistent rail entry
  // as its return target before handing focus to the modal.
  get(internalSidebarSubscriptionEntry$)?.focus();
  set(internalSidebarSubscriptionOpen$, false);
  set(internalSidebarSubscriptionFocusReturnPending$, true);
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
