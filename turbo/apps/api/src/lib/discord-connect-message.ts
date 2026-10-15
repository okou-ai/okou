import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import type { DiscordAccountMessage } from "./discord-interaction-messages";
import { env } from "./env";

export function discordConnectMessage(
  guildId?: string | null,
): DiscordAccountMessage {
  const url = new URL(INTEGRATION_SETTINGS_PATHS.discord, env("APP_URL"));
  if (guildId) {
    url.searchParams.set("guild_id", guildId);
  }
  return {
    content: `Please connect your account to use ${BRAND_PRESENTATION.assistantName} from Discord.`,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: "Connect", url: url.toString() },
        ],
      },
    ],
  };
}
