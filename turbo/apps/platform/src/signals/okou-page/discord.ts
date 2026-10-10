import { command, computed, state } from "ccstate";
import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/contracts/discord-oauth";
import { i18n } from "../../i18n/index.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { pageVersion$ } from "../page-signal.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { searchParams$ } from "../route.ts";
import { resetSignal, waitLoopUntil, withCleanup } from "../utils.ts";

export const discordAuthorizationFailed$ = computed((get) => {
  return get(searchParams$).get("discord") === "error";
});

export const discordAuthorizationPending$ = computed((get) => {
  return get(searchParams$).get("discord") === "pending";
});

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

export class DiscordPopupBlockedError extends Error {
  constructor() {
    super(
      i18n.t(($) => {
        return $.works.discord.popupBlocked;
      }),
    );
    this.name = "DiscordPopupBlockedError";
  }
}

const resetDiscordAuthorization$ = resetSignal();

export const startDiscordAuthorization$ = command(
  async (
    { get, set },
    flow: "install" | "connect",
    guildId: string | null,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (!get(featureSwitch$)[FeatureSwitchKey.DiscordIntegration]) {
      return;
    }
    const flowSignal = set(resetDiscordAuthorization$, signal);
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ?? false;
    // Preserve the click's browser activation before awaiting authenticated HTTP.
    const popup = window.open(
      "about:blank",
      "_blank",
      standalone ? undefined : "width=600,height=700",
    );
    if (!popup) {
      throw new DiscordPopupBlockedError();
    }
    const closePopup = () => {
      popup.close();
    };
    flowSignal.addEventListener("abort", closePopup, { once: true });
    return await withCleanup(
      (async () => {
        const client = get(apiClient$)(discordOauthContract);
        const result = await accept(
          client.start({
            body: { flow, ...(guildId ? { guildId } : {}) },
            fetchOptions: { signal: flowSignal, credentials: "include" },
          }),
          [200],
          flowSignal,
        );
        flowSignal.throwIfAborted();
        // This proof stays only in this route-owned operation, never in browser
        // storage, a redirect, postMessage, or an OAuth provider request.
        const completionToken = result.body.completionToken;
        const attemptState = new URL(
          result.body.authorizationUrl,
        ).searchParams.get("state");
        if (!attemptState) {
          throw new Error(
            "Discord authorization did not return an attempt state",
          );
        }
        popup.location.href = result.body.authorizationUrl;
        await waitLoopUntil(
          () => {
            return popup.closed;
          },
          250,
          flowSignal,
          { retryTransientErrors: false, testIntervalMs: 10 },
        );
        flowSignal.throwIfAborted();
        // Callback verification alone cannot bind an account. Complete under
        // the current authenticated owner with the original browser's proof.
        await accept(
          client.complete({
            body: { state: attemptState, completionToken },
            fetchOptions: { signal: flowSignal, credentials: "include" },
          }),
          [200],
          flowSignal,
        );
        await set(refreshDiscordOrg$, flowSignal);
      })(),
      () => {
        flowSignal.removeEventListener("abort", closePopup);
        closePopup();
      },
    );
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
