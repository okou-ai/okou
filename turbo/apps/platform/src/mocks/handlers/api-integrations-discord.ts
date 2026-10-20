import { integrationsDiscordContract } from "@okouai/api-contracts/contracts/integrations-discord";
import { mockApi } from "../msw-contract.ts";

export const apiIntegrationsDiscordHandlers = [
  mockApi(integrationsDiscordContract.getStatus, ({ respond }) => {
    return respond(200, {
      isAvailable: true,
      isConnected: false,
      isAdmin: true,
      guildId: null,
      guildName: null,
      discordUserId: null,
      defaultAgentId: null,
      defaultAgentName: null,
      contextMode: "mentions_only",
      onboarding: "oauth",
      dmSelectionConnectionId: null,
      dmBindings: [],
    });
  }),
];
