import { command, computed, state } from "ccstate";
import type { UsagePackManagementResponse } from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import { reloadBillingStatus$, usagePackManagementAsync$ } from "../billing.ts";
import { isOrgAdmin$ } from "../../org.ts";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { reloadPersonalModelProviders$ } from "../../external/personal-model-providers.ts";
import { resetSignal } from "../../utils.ts";
import { reloadConnectorCatalogDiagnostics$ } from "./connector-catalog-diagnostics.ts";
import { reloadBuiltInModelCooldownDiagnostics$ } from "./built-in-model-cooldown-diagnostics.ts";
import { retryEmailSubscription$ } from "./email-subscription.ts";
import { reloadIndexedDbDiagnosticsFromWorker$ } from "../../shared-database.ts";
import {
  billingPlansStandalone$,
  billingSubPage$,
  clearBillingScrollTarget$,
  clearPendingLogo$,
  initProfileName$,
  requestBuyCreditsScroll$,
  resetDeleteConfirm$,
  setBillingPlansStandalone$,
  setBillingSubPage$,
} from "./workspace-settings-state.ts";
import {
  managedUsagePackSelection,
  resetUsagePackPricing$,
  setMemberUsageSelections$,
  setSelectedUsagePackPlan$,
} from "./usage-pack-pricing-state.ts";

// `usage` is the credit balance surface and keeps its id so existing
// `?settings=usage` links stay valid; `usage-records` is the usage history that
// used to live at the bottom of it.
export const SETTINGS_SECTIONS = [
  "preference",
  "chat",
  "model",
  "debug",
  "general",
  "people",
  "billing",
  "usage",
  "usage-records",
  "invoices",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// `usage` stays visible to everyone. The rendered label and detail UI depend
// on org role and feature switches.
const ADMIN_ONLY_SETTINGS_SECTIONS_LIST = [
  "general",
  "people",
  "billing",
  "invoices",
] as const satisfies readonly SettingsSection[];

function isAdminOnlySettingsSection(section: SettingsSection): boolean {
  return (
    ADMIN_ONLY_SETTINGS_SECTIONS_LIST as readonly SettingsSection[]
  ).includes(section);
}

export function resolveAvailableSettingsSection(
  section: SettingsSection,
  options: {
    readonly isAdmin: boolean;
    readonly chatPreferenceEnabled: boolean;
  },
): SettingsSection {
  if (
    (!options.isAdmin && isAdminOnlySettingsSection(section)) ||
    (!options.chatPreferenceEnabled && section === "chat")
  ) {
    return "preference";
  }
  return section;
}

const internalSettingsDialogOpen$ = state(false);
const internalSettingsVisit$ = state(0);

export const settingsVisit$ = computed((get) => {
  return get(internalSettingsVisit$);
});

const internalSettingsDialogSignal$ = state<AbortSignal | null>(null);
const resetSettingsDialogSignal$ = resetSignal();
const resetSettingsActionSignal$ = resetSignal();
const internalSettingsActionSignal$ = state<AbortSignal | null>(null);
const internalSettingsDialogSessionActive$ = state(false);

// Actions stop at dismissal; the dialog session survives its closing animation.
export { internalSettingsActionSignal$ as settingsActionSignal$ };

export const settingsDialogOpen$ = computed((get) => {
  return get(internalSettingsDialogOpen$);
});

export const settingsDialogSessionActive$ = computed((get) => {
  return get(internalSettingsDialogSessionActive$);
});

export { internalSettingsDialogSignal$ as settingsDialogSignal$ };

const internalActiveSection$ = state<SettingsSection>("preference");

export const settingsActiveSection$ = computed((get) => {
  return get(internalActiveSection$);
});

export const setSettingsActiveSection$ = command(
  ({ get, set }, section: SettingsSection) => {
    if (section === "debug" && get(internalActiveSection$) !== "debug") {
      set(reloadConnectorCatalogDiagnostics$);
      set(reloadBuiltInModelCooldownDiagnostics$);
      set(reloadIndexedDbDiagnosticsFromWorker$);
    }
    set(internalActiveSection$, section);
    if (section !== "billing") {
      set(clearBillingScrollTarget$);
      set(resetUsagePackPricing$);
    }
    if (section === "model") {
      set(reloadPersonalModelProviders$);
    }
    const params = new URLSearchParams(get(searchParams$));
    if (params.get("settings") !== section) {
      params.set("settings", section);
      set(updateSearchParams$, params);
    }
  },
);

export const openSettingsBillingPlans$ = command(({ get, set }) => {
  set(internalActiveSection$, "billing");
  set(setBillingSubPage$, true);
  set(clearBillingScrollTarget$);

  const params = new URLSearchParams(get(searchParams$));
  params.set("settings", "billing");
  params.set("billingView", "plans");
  set(updateSearchParams$, params);
});

const openSettingsUsagePackPlan$ = command(
  (
    { set },
    management: UsagePackManagementResponse,
    targetTier: UsagePackManagementResponse["tier"],
  ) => {
    set(openSettingsBillingPlans$);
    set(
      setMemberUsageSelections$,
      Object.fromEntries(
        management.allocations.map((allocation) => {
          return [
            allocation.memberId,
            managedUsagePackSelection(allocation),
          ] as const;
        }),
      ),
    );
    set(setSelectedUsagePackPlan$, targetTier);
  },
);

const openSettingsMemberUsagePacks$ = command(
  ({ set }, management: UsagePackManagementResponse) => {
    set(openSettingsUsagePackPlan$, management, management.tier);
  },
);

export const openSettingsUsagePackConfiguration$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const management = await get(usagePackManagementAsync$);
    signal.throwIfAborted();
    if (!management) {
      set(openSettingsBillingPlans$);
      return;
    }
    set(openSettingsMemberUsagePacks$, management);
  },
);

export const openSettingsUsagePackUpgrade$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const management = await get(usagePackManagementAsync$);
    signal.throwIfAborted();
    if (!management) {
      set(openSettingsBillingPlans$);
      return;
    }
    set(openSettingsUsagePackPlan$, management, "team");
  },
);

const releaseSettingsDialogSession$ = command(({ set }) => {
  set(internalSettingsDialogSignal$, null);
  set(internalSettingsDialogSessionActive$, false);
  set(clearPendingLogo$);
  set(resetDeleteConfirm$);
  set(resetUsagePackPricing$);
  // The billing sub-page belongs to the session, not to the tab: a closed
  // dialog must not reopen on the plans page the next time it is opened.
  set(setBillingSubPage$, false);
  set(internalSettingsDialogOpen$, false);
});

export const closeSettingsModal$ = command(({ get, set }) => {
  set(resetSettingsActionSignal$);
  set(internalSettingsDialogOpen$, false);

  const params = new URLSearchParams(get(searchParams$));
  if (params.has("settings") || params.has("billingView")) {
    params.delete("settings");
    params.delete("billingView");
    set(updateSearchParams$, params);
  }
});

export const completeSettingsModalClose$ = command(({ get, set }) => {
  if (get(internalSettingsDialogOpen$)) {
    return;
  }
  set(resetSettingsDialogSignal$);
  set(releaseSettingsDialogSession$);
  set(clearBillingScrollTarget$);
});

/**
 * Dismiss the billing plans surface. A standalone upgrade flow was launched
 * from outside Settings, so dismissing it closes the whole dialog and returns
 * to the launching screen; a flow reached from inside Settings goes back to the
 * billing tab.
 */
export const dismissBillingPlans$ = command(({ get, set }) => {
  if (get(billingPlansStandalone$)) {
    set(closeSettingsModal$);
    return;
  }
  set(resetUsagePackPricing$);
  set(setBillingSubPage$, false);
});

export const setSettingsDialogOpen$ = command(
  async ({ get, set }, open: boolean, pageSignal: AbortSignal) => {
    if (!open) {
      set(closeSettingsModal$);
      return;
    }

    set(retryEmailSubscription$);
    if (!get(internalSettingsDialogOpen$)) {
      set(internalSettingsVisit$, (visit) => {
        return visit + 1;
      });
      set(
        internalSettingsActionSignal$,
        set(resetSettingsActionSignal$, pageSignal),
      );
    }
    if (get(internalSettingsDialogSessionActive$)) {
      set(internalSettingsDialogOpen$, true);
      set(setSettingsActiveSection$, get(internalActiveSection$));
      return;
    }

    const modalSignal = set(resetSettingsDialogSignal$, pageSignal);
    modalSignal.addEventListener(
      "abort",
      () => {
        set(releaseSettingsDialogSession$);
      },
      { once: true },
    );
    set(internalSettingsDialogSignal$, modalSignal);
    set(internalSettingsDialogSessionActive$, true);
    // A plans sub-page that is already open when the session starts was opened
    // by an entry point outside Settings, so that flow owns the whole dialog.
    set(setBillingPlansStandalone$, get(billingSubPage$));
    set(reloadBillingStatus$);
    if (get(internalActiveSection$) === "debug") {
      set(reloadConnectorCatalogDiagnostics$);
      set(reloadBuiltInModelCooldownDiagnostics$);
      set(reloadIndexedDbDiagnosticsFromWorker$);
    }
    set(internalSettingsDialogOpen$, true);
    await set(initProfileName$, modalSignal);
    pageSignal.throwIfAborted();
    modalSignal.throwIfAborted();
    const params = new URLSearchParams(get(searchParams$));
    const section = get(internalActiveSection$);
    if (section === "model") {
      set(reloadPersonalModelProviders$);
    }
    if (params.get("settings") !== section) {
      params.set("settings", section);
      set(updateSearchParams$, params);
    }
  },
);

export const openSettingsBillingPlansDialog$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(openSettingsBillingPlans$);
    await set(setSettingsDialogOpen$, true, signal);
  },
);

/**
 * Open the dialog directly on a target section. Used by entry-point components
 * (account dropdown, org switcher) to deep-link into a specific area.
 */
export const openSettingsDialogAt$ = command(
  async ({ set }, section: SettingsSection, signal: AbortSignal) => {
    set(internalActiveSection$, section);
    set(clearBillingScrollTarget$);
    await set(setSettingsDialogOpen$, true, signal);
  },
);

function isSettingsSection(value: string): value is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Check URL for `?settings=<section>` and auto-open the matching settings
 * surface.
 * Valid settings params stay in the URL while the dialog is open; closing the
 * dialog clears them.
 */
export const checkUnifiedSettingsParam$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const params = get(searchParams$);
    const value = params.get("settings");
    const billingView = params.get("billingView");
    if (!value) {
      set(clearBillingScrollTarget$);
      return;
    }
    if (!isSettingsSection(value)) {
      set(clearBillingScrollTarget$);
      const next = new URLSearchParams(get(searchParams$));
      next.delete("settings");
      next.delete("billingView");
      set(updateSearchParams$, next);
      return;
    }

    const section = value;
    const opensBillingPlans = section === "billing" && billingView === "plans";
    const opensBuyCredits = section === "billing" && billingView === "credits";
    const isAdmin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    if (!isAdmin && (opensBillingPlans || opensBuyCredits)) {
      set(setBillingSubPage$, false);
      set(clearBillingScrollTarget$);
      const next = new URLSearchParams(get(searchParams$));
      next.delete("settings");
      next.delete("billingView");
      set(updateSearchParams$, next);
      return;
    }

    const resolved = resolveAvailableSettingsSection(section, {
      isAdmin,
      chatPreferenceEnabled:
        get(featureSwitch$)[FeatureSwitchKey.ChatPreference] ?? false,
    });
    set(internalActiveSection$, resolved);
    set(setBillingSubPage$, opensBillingPlans && resolved === "billing");
    if (opensBuyCredits && resolved === "billing") {
      set(requestBuyCreditsScroll$);
    } else {
      set(clearBillingScrollTarget$);
    }
    await set(setSettingsDialogOpen$, true, signal);
  },
);
