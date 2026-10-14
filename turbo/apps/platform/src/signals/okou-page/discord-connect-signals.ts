import { command } from "ccstate";
import { navigateTo$, pathname$, replaceSearchParams$ } from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { discordOrgData$, startDiscordAuthorization$ } from "./discord.ts";

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
    if (get(pathname$) === ROUTES.settingsDiscord) {
      set(replaceSearchParams$, params);
    } else {
      await set(
        navigateTo$,
        ROUTES.settingsDiscord,
        { searchParams: params },
        signal,
      );
    }
  },
);
