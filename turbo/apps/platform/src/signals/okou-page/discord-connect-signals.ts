import { command } from "ccstate";
import { replaceSearchParams$ } from "../route.ts";
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
    set(replaceSearchParams$, params);
  },
);
