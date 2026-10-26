import { env } from "../../lib/env";

export interface DiscordAppConfig {
  readonly applicationId: string;
  readonly botToken: string;
  readonly publicKey: string;
  readonly gatewaySecret: string;
}

/** App-wide configuration; binding material must never contain credentials. */
export function getDiscordAppConfig(): DiscordAppConfig | null {
  const applicationId = env("DISCORD_APPLICATION_ID");
  const botToken = env("DISCORD_BOT_TOKEN");
  const publicKey = env("DISCORD_PUBLIC_KEY");
  const gatewaySecret = env("DISCORD_GATEWAY_SECRET");
  if (!applicationId || !botToken || !publicKey || !gatewaySecret) {
    return null;
  }
  return {
    applicationId,
    botToken,
    publicKey,
    gatewaySecret,
  };
}
