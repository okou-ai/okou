import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { eq } from "drizzle-orm";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import { webUrl } from "../../lib/web-url";
import type { Db } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";

export interface FeishuInstallationConfig {
  readonly id: string;
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly appId: string;
  readonly platform: FeishuPlatform;
  readonly botOpenId: string | null;
  readonly encryptedAppSecret: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly callbackVerified: boolean;
}

export async function loadFeishuInstallationConfig(
  db: Db,
  installationId: string,
): Promise<FeishuInstallationConfig | null> {
  const [installation] = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      platform: feishuOrgInstallations.platform,
      botOpenId: feishuOrgInstallations.botOpenId,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
      encryptedVerificationToken:
        feishuOrgInstallations.encryptedVerificationToken,
      encryptedEncryptKey: feishuOrgInstallations.encryptedEncryptKey,
      callbackVerifiedAt: feishuOrgInstallations.callbackVerifiedAt,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.id, installationId))
    .limit(1);
  if (!installation || !(await isFeishuInstallationEnabled(db, installation))) {
    return null;
  }
  const context = { orgId: installation.orgId };
  const [appSecret, verificationToken, encryptKey] = await Promise.all([
    decryptPersistentSecretValue(installation.encryptedAppSecret, context),
    decryptPersistentSecretValue(
      installation.encryptedVerificationToken,
      context,
    ),
    decryptPersistentSecretValue(installation.encryptedEncryptKey, context),
  ]);
  return {
    id: installation.id,
    orgId: installation.orgId,
    ownerUserId: installation.ownerUserId,
    appId: installation.appId,
    platform: installation.platform,
    botOpenId: installation.botOpenId,
    encryptedAppSecret: installation.encryptedAppSecret,
    appSecret,
    verificationToken,
    encryptKey,
    callbackVerified: Boolean(installation.callbackVerifiedAt),
  };
}

/**
 * The event subscription URL an operator registers in their own Feishu Open
 * Platform app. The configured callback origin determines the hostname;
 * the path and installation ID remain provider-compatible.
 */
export function feishuCallbackUrl(installationId: string): string {
  return new URL(
    `/api/webhooks/feishu/events/${encodeURIComponent(installationId)}`,
    env("FEISHU_CALLBACK_BASE_URL"),
  ).toString();
}

/**
 * The redirect URI for the OAuth branch that does not hand off to the frontend,
 * reached only when `callbackTarget` is absent. The Feishu console holds
 * `feishuOAuthAppCallbackUrl()` instead, so nothing outside this service pins
 * this path. It uses the neutral path declared by its contract.
 */
export function feishuOAuthCallbackUrl(): string {
  return new URL(
    "/api/integrations/feishu/oauth/callback",
    env("FEISHU_CALLBACK_BASE_URL"),
  ).toString();
}

export function feishuOAuthAppCallbackUrl(
  platform: FeishuPlatform = "feishu",
): string {
  return new URL(
    FEISHU_PLATFORMS[platform].callbackPath,
    env("APP_URL"),
  ).toString();
}

/**
 * App callback URI used by the legacy signed-state completion path.
 * The signed state format remains compatible with historical states.
 */
export function legacyFeishuOAuthAppCallbackUrl(): string {
  return new URL("/connectors/feishu/callback", env("APP_URL")).toString();
}

export function feishuOAuthConnectUrl(state: string): string {
  const url = new URL("/api/feishu/oauth/connect", apiBackendUrl() ?? webUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

export function feishuBotOpenUrl(
  appId: string,
  platform: FeishuPlatform = "feishu",
): string {
  const url = new URL(
    "/client/bot/open",
    FEISHU_PLATFORMS[platform].appLinkOrigin,
  );
  url.searchParams.set("appId", appId);
  return url.toString();
}

export function buildFeishuChatOpenUrl(
  chatId: string,
  platform: FeishuPlatform = "feishu",
): string {
  const url = new URL(
    "/client/chat/open",
    FEISHU_PLATFORMS[platform].appLinkOrigin,
  );
  url.searchParams.set("openChatId", chatId);
  return url.toString();
}

export async function isFeishuInstallationEnabled(
  db: Db,
  installation: {
    readonly platform: FeishuPlatform;
    readonly orgId: string;
    readonly ownerUserId: string | null;
  },
): Promise<boolean> {
  if (installation.platform === "feishu") {
    return true;
  }
  if (!installation.ownerUserId) {
    return false;
  }
  const context = await loadUserFeatureSwitchContext(
    db,
    installation.orgId,
    installation.ownerUserId,
  );
  return isFeatureEnabled(FEISHU_PLATFORMS.lark.featureSwitch, context);
}
