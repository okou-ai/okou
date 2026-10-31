import { discordSnowflakeSchema } from "@okouai/api-contracts/validators/integrations-discord-read";
import { enum as zEnum } from "zod";

// Presentation only. These values never authorize approval or completion.
const discordCallbackErrorSchema = zEnum([
  "cancelled",
  "unavailable",
  "forbidden",
  "provider_error",
  "invalid_authorization",
  "guild_unverified",
  "bot_missing",
  "invalid_state",
]);

export function discordConnectParams(
  params: URLSearchParams,
  statusKey: "status" | "discord" = "status",
): URLSearchParams {
  const clean = new URLSearchParams();
  const status = params.get(statusKey);
  if (status === "connected" || status === "pending" || status === "error") {
    clean.set("status", status);
  }
  const error = discordCallbackErrorSchema.safeParse(
    params.get("discord_error"),
  );
  if (error.success) {
    clean.set("discord_error", error.data);
  }
  const guildId = params.get("guild_id");
  if (guildId !== null) {
    if (discordSnowflakeSchema.safeParse(guildId).success) {
      clean.set("guild_id", guildId);
    } else {
      clean.set("status", "error");
      clean.set("discord_error", "invalid_state");
    }
  }
  return clean;
}
