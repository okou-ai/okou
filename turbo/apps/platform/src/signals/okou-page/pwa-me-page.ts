import { command, computed } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { clerk$, currentUserInfo$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { bestEffort } from "../utils.ts";
import { reloadAccountMenuCreditBalances$ } from "./billing.ts";
import {
  accountMenuSubscriptionUsageRows,
  reloadAccountMenuSubscriptionUsageRows$,
} from "./account-menu-subscriptions.ts";
import { personalConfiguredProviders$ } from "./settings/personal-model-providers.ts";

// Settings can change providers while Me stays mounted behind the dialog.
// Derive the page rows from that live resource instead of the menu's snapshot.
export const pwaMeSubscriptionUsageRows$ = computed(async (get) => {
  return accountMenuSubscriptionUsageRows(
    await get(personalConfiguredProviders$),
  );
});

/** The Me page replaces opening the account menu as the usage refresh boundary. */
export const initializePwaMePage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const [clerk, user] = await Promise.all([
      get(clerk$),
      get(currentUserInfo$),
    ]);
    signal.throwIfAborted();
    const cacheKey = clerk.session?.id ?? user?.id ?? null;
    const subscriptionsEnabled =
      get(featureSwitch$)[FeatureSwitchKey.SidebarSubscriptionUsage] ?? false;

    await Promise.all([
      set(reloadAccountMenuCreditBalances$, signal),
      subscriptionsEnabled
        ? bestEffort(
            set(reloadAccountMenuSubscriptionUsageRows$, cacheKey, signal),
            signal,
          )
        : Promise.resolve(),
    ]);
  },
);
