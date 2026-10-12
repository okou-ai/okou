import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";

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
  identity$: Computed<{ readonly orgId: string; readonly userId: string }>,
) {
  const overrides$ = computed(async (get) => {
    const { orgId, userId } = get(identity$);
    const rows = await get(db$)
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, orgId),
          inArray(userFeatureSwitches.userId, [userId, ORG_SENTINEL_USER_ID]),
        ),
      );
    return userFeatureSwitchOverridesFromRows(rows, userId);
  });
  const context$ = computed(async (get) => {
    const { orgId, userId } = get(identity$);
    return { orgId, userId, overrides: await get(overrides$) };
  });
  return computed(async (get) => {
    return isFeatureEnabled(
      FeatureSwitchKey.DiscordIntegration,
      await get(context$),
    );
  });
}
