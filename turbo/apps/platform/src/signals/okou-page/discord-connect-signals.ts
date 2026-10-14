import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { ApiError } from "../../lib/api-error.ts";
import { replaceSearchParams$ } from "../route.ts";
import { settle } from "../utils.ts";
import {
  discordOrgData$,
  DiscordPopupBlockedError,
  startDiscordAuthorization$,
} from "./discord.ts";

export const connectDiscordFromWorks$ = command(
  async ({ set }, signal: AbortSignal) => {
    const result = await settle(
      set(startDiscordAuthorization$, null, signal),
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
  async ({ get, set }, guildId: string | null, signal: AbortSignal) => {
    await set(startDiscordAuthorization$, guildId, signal);
    signal.throwIfAborted();
    const data = await get(discordOrgData$);
    signal.throwIfAborted();
    if (!data?.isConnected) {
      return;
    }
    const params = new URLSearchParams({ status: "connected" });
    if (data.guildName) {
      params.set("workspace", data.guildName);
    }
    if (data.guildId) {
      params.set("guild_id", data.guildId);
    }
    set(replaceSearchParams$, params);
  },
);
