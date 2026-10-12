import { computed } from "ccstate";
import { discordClient } from "../external/discord-client";
import { getDiscordAppConfig } from "./discord-config";
import {
  discordApiFailure,
  type DiscordFailureResponse,
} from "./discord-api-response";

type DiscordMessageContentCapability =
  | { readonly kind: "available"; readonly enabled: boolean }
  | { readonly kind: "denied"; readonly response: DiscordFailureResponse };

/** A fresh provider snapshot for each authorization/status graph, never a global cache. */
export function discordMessageContentCapability() {
  return computed(async (): Promise<DiscordMessageContentCapability> => {
    const config = getDiscordAppConfig();
    if (!config) {
      return {
        kind: "denied",
        response: {
          status: 503,
          body: {
            error: {
              code: "DISCORD_NOT_CONFIGURED",
              message: "The Discord application is not configured.",
            },
          },
        },
      };
    }
    const result = await discordClient.fetchDiscordCurrentApplication(config);
    if (result.kind !== "ok") {
      return { kind: "denied", response: discordApiFailure(result) };
    }
    return { kind: "available", enabled: result.data.messageContentEnabled };
  });
}
