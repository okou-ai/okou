import { command, computed, state } from "ccstate";
import { integrationsDiscordContract } from "@okouai/api-contracts/client/integrations-discord";
import { discordOauthContract } from "@okouai/api-contracts/client/discord-oauth";
import { i18n } from "../../i18n/index.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { resetSignal, settle, waitLoopUntil, withCleanup } from "../utils.ts";
import { createDiscordOauthResultNotifier } from "./discord-oauth-message.ts";

const reloadVersion$ = state(0);

export const discordOrgData$ = computed(async (get) => {
  // Retain the authenticated owner's status across navigation, like Slack.
  // The route-owned subscription refreshes it on re-entry and live changes.
  get(reloadVersion$);
  await get(runtimeAuthenticatedIdentity$);
  const client = get(apiClient$)(integrationsDiscordContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

const reloadDiscordOrg$ = command(({ set }) => {
  set(reloadVersion$, (version) => {
    return version + 1;
  });
});

// Mutations stay pending until the card has the refreshed status, so the
// previous server choice or connection never reappears after a save.
export const refreshDiscordOrg$ = command(
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

export interface DiscordAuthorizationOptions {
  readonly guildId?: string;
  readonly flow?: "install" | "connect";
}

export const startDiscordAuthorization$ = command(
  async (
    { get, set },
    options: DiscordAuthorizationOptions,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const flowSignal = set(resetDiscordAuthorization$, signal);
    // Preserve the click's browser activation before awaiting authenticated HTTP.
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      throw new DiscordPopupBlockedError();
    }
    const closePopup = () => {
      popup.close();
    };
    let resultAvailable = false;
    let resultNotifier:
      ReturnType<typeof createDiscordOauthResultNotifier> | undefined;
    flowSignal.addEventListener("abort", closePopup, { once: true });
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    return await withCleanup(
      (async () => {
        const client = get(apiClient$)(discordOauthContract);
        const result = await accept(
          client.start({
            body: options,
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
        resultNotifier = createDiscordOauthResultNotifier(
          popup,
          attemptState,
          () => {
            flowSignal.removeEventListener("abort", closePopup);
          },
          flowSignal,
        );
        popup.location.href = result.body.authorizationUrl;
        // Callback verification alone cannot bind an account. Complete under
        // the current authenticated owner with the original browser's proof.
        // Approval-required is the API's pending state, not a failed attempt.
        // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
        const completed = await settle(
          waitLoopUntil(
            async () => {
              const closedBeforeRequest = popup.closed;
              const completion = await accept(
                client.complete({
                  body: { state: attemptState, completionToken },
                  fetchOptions: { signal: flowSignal, credentials: "include" },
                }),
                [200, 409],
                flowSignal,
              );
              flowSignal.throwIfAborted();
              if (
                completion.status === 409 &&
                completion.body.error.code === "DISCORD_OAUTH_APPROVAL_REQUIRED"
              ) {
                // A consent tab can approve and close while an older pending
                // response is in flight. Check once more under the private
                // proof before treating closure as cancellation.
                if (!popup.closed || !closedBeforeRequest) {
                  return false;
                }
                // Closure makes this pending response an expected cancellation.
                // Keep its status/code and use the shared error presentation.
                await accept(
                  Promise.resolve({
                    ...completion,
                    body: {
                      error: {
                        ...completion.body.error,
                        message: i18n.t(($) => {
                          return $.works.discord.cancelled;
                        }),
                      },
                    },
                  }),
                  [200],
                  flowSignal,
                  {
                    expectedErrors: {
                      409: ["DISCORD_OAUTH_APPROVAL_REQUIRED"],
                    },
                  },
                );
              }
              await accept(Promise.resolve(completion), [200], flowSignal);
              return true;
            },
            1000,
            flowSignal,
            { testIntervalMs: 10 },
          ),
          flowSignal,
        );
        flowSignal.throwIfAborted();
        // Let the consent page show either result in place. A document navigation
        // would restart App bootstrap and flash its skeleton a second time.
        resultAvailable = true;
        resultNotifier.notify(completed.ok ? "connected" : "error");
        if (!completed.ok) {
          throw completed.error;
        }
        await set(refreshDiscordOrg$, flowSignal);
      })(),
      () => {
        if (!resultAvailable) {
          flowSignal.removeEventListener("abort", closePopup);
          resultNotifier?.dispose();
          closePopup();
        }
      },
    );
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
  async ({ get, set }, signal: AbortSignal) => {
    // Attach even if the cached read failed, so returning to the page can
    // recover through the subscription's fresh status read.
    set(
      setAblyInvalidationLoop$,
      {
        topic: "discord:changed",
        invalidations: [reloadDiscordOrg$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
    await get(discordOrgData$);
    signal.throwIfAborted();
  },
);
