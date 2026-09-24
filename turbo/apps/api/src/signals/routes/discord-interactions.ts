import { discordInteractionsContract } from "@okouai/api-contracts/contracts/discord-interactions";

import type { RouteEntry } from "../route-entry";
import { handleDiscordInteractions$ } from "../services/discord-interactions.service";

export const discordInteractionsRoutes: readonly RouteEntry[] = [
  {
    route: discordInteractionsContract.post,
    handler: handleDiscordInteractions$,
  },
];
