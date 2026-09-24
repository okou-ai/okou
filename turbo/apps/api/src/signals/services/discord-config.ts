import { computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env } from "../../lib/env";
import type { ReadonlyDb } from "../external/db";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchContext,
} from "./feature-switches.service";

export interface DiscordAppConfig {
  readonly applicationId: string;
  readonly botToken: string;
  readonly publicKey: string;
  readonly gatewaySecret: string;
  readonly messageContentEnabled: boolean;
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
    messageContentEnabled: env("DISCORD_MESSAGE_CONTENT_ENABLED") === "true",
  };
}

export async function discordIntegrationEnabledForOwnerInDb(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  userId: string,
): Promise<boolean> {
  return isFeatureEnabled(
    FeatureSwitchKey.DiscordIntegration,
    await loadUserFeatureSwitchContext(db, orgId, userId),
  );
}

export function discordIntegrationEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.DiscordIntegration,
      await get(userFeatureSwitchContext(orgId, userId)),
    );
  });
}
