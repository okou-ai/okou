import { command, computed, state } from "ccstate";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { pageVersion$ } from "../page-signal.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";

const reloadVersion$ = state(0);

export const discordOrgData$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.DiscordIntegration]) {
    return null;
  }
  get(pageVersion$);
  get(reloadVersion$);
  await get(runtimeAuthenticatedIdentity$);
  const client = get(apiClient$)(integrationsDiscordContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

export const reloadDiscordOrg$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});

// Mutations stay pending until the card has the refreshed status, so the
// previous server choice or connection never reappears after a save.
const refreshDiscordOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reloadDiscordOrg$);
    await get(discordOrgData$);
    signal.throwIfAborted();
  },
);

const uninstallDialogOpen$ = state(false);
export const showDiscordUninstallDialog$ = computed((get) => {
  return get(uninstallDialogOpen$);
});
export const setShowDiscordUninstallDialog$ = command(
  ({ set }, open: boolean) => {
    set(uninstallDialogOpen$, open);
  },
);

export const disconnectDiscordOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsDiscordContract);
    await accept(client.disconnect({ fetchOptions: { signal } }), [200]);
    signal.throwIfAborted();
    await set(refreshDiscordOrg$, signal);
  },
);

export const uninstallDiscordOrg$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsDiscordContract);
    await accept(
      client.disconnect({
        query: { action: "uninstall" },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    await set(refreshDiscordOrg$, signal);
    set(setShowDiscordUninstallDialog$, false);
  },
);

export const selectDiscordDmBinding$ = command(
  async ({ get, set }, connectionId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(integrationsDiscordContract);
    await accept(
      client.setDmSelection({
        body: { connectionId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    await set(refreshDiscordOrg$, signal);
  },
);

export const watchDiscordConnection$ = command(
  ({ get, set }, signal: AbortSignal) => {
    set(setShowDiscordUninstallDialog$, false);
    if (!get(featureSwitch$)[FeatureSwitchKey.DiscordIntegration]) {
      return;
    }
    set(
      setAblyInvalidationLoop$,
      {
        topic: "discord:changed",
        invalidations: [reloadDiscordOrg$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);
