import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { ApiError } from "../../lib/api-error.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { replacePathSilently$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { settle } from "../utils.ts";
import {
  discordOrgData$,
  DiscordPopupBlockedError,
  startDiscordAuthorization$,
  type DiscordAuthorizationOptions,
} from "./discord.ts";

export const connectDiscordFromWorks$ = command(
  async (
    { set },
    options: DiscordAuthorizationOptions,
    signal: AbortSignal,
  ) => {
    const result = await settle(
      set(startDiscordAuthorization$, options, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      // API errors already use the shared error toast. Browser failures need
      // the same feedback without adding an authorization panel to the card.
      if (!(result.error instanceof ApiError)) {
        toast.error(
          result.error instanceof DiscordPopupBlockedError
            ? result.error.message
            : i18n.t(($) => {
                return $.works.discord.authorizationError;
              }),
        );
      }
      throw result.error;
    }
  },
);

export const connectDiscordAccount$ = command(
  async (
    { get, set },
    options: DiscordAuthorizationOptions,
    signal: AbortSignal,
  ) => {
    await set(startDiscordAuthorization$, options, signal);
    signal.throwIfAborted();
    const data = await get(discordOrgData$);
    signal.throwIfAborted();
    if (!data.isConnected) {
      return;
    }
    const params = new URLSearchParams({ status: "connected" });
    if (data.guildName) {
      params.set("workspace", data.guildName);
    }
    if (data.guildId) {
      params.set("guild_id", data.guildId);
    }
    // Both entry points use the same page. Preserve its operation lifetime so
    // a queued result can still reach a consent tab that is finishing bootstrap.
    set(replacePathSilently$, ROUTES.settingsDiscord, undefined, params);
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.works.discord.connectTitle;
      }),
    );
  },
);
