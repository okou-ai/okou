import { discordGatewayContract } from "@okouai/api-contracts/contracts/discord-gateway";

import type { RouteEntry } from "../route-entry";
import { handleDiscordGateway$ } from "../services/discord-gateway.service";

export const discordGatewayRoutes: readonly RouteEntry[] = [
  {
    route: discordGatewayContract.post,
    handler: handleDiscordGateway$,
  },
];
