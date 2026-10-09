import { command, computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env } from "../../lib/env";
import {
  loadUserFeatureSwitchContext$,
  userFeatureSwitchContext,
} from "./feature-switches.service";

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

export const discordIntegrationEnabledForOwner$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      orgId,
      userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.DiscordIntegration, context);
  },
);

export function discordIntegrationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  const context$ = userFeatureSwitchContext(orgId, userId);
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.DiscordIntegration,
      await get(context$),
    );
  });
}
