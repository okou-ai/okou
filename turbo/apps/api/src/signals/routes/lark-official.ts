import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { larkOfficialContract } from "@okouai/api-contracts/contracts/lark-official";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { larkOfficialAppTickets } from "@okouai/db/schema/lark-official-app-ticket";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { larkOfficialApp } from "../../lib/lark-official-app";
import {
  conflict,
  notConfigured,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  feishuConnectStatus,
  disconnectFeishuConnection$,
} from "../services/feishu-connect.service";
import { buildFeishuOAuthConnectUrl } from "../services/feishu-oauth-state";

const enabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  return isFeatureEnabled(
    FeatureSwitchKey.LarkOfficialBot,
    await get(userFeatureSwitchContext(auth.orgId, auth.userId)),
  );
});
const configured$ = computed(async (get) => {
  const config = larkOfficialApp();
  if (!config) {
    return false;
  }
  const [ticket] = await get(db$)
    .select({ appId: larkOfficialAppTickets.appId })
    .from(larkOfficialAppTickets)
    .where(eq(larkOfficialAppTickets.appId, config.appId))
    .limit(1);
  return Boolean(ticket);
});
const installation$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const [installation] = await get(db$)
    .select()
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, auth.orgId),
        eq(feishuOrgInstallations.platform, "lark"),
        eq(feishuOrgInstallations.installationType, "official"),
      ),
    )
    .limit(1);
  return installation;
});
const disabled = () => {
  return resourceUnavailable("Okou Official Lark bot is not enabled");
};

const status$ = computed(async (get) => {
  if (!(await get(enabled$))) {
    return disabled();
  }
  const auth = get(organizationAuthContext$);
  const status = await get(
    feishuConnectStatus({
      platform: "lark",
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: false,
      installationType: "official",
    }),
  );
  const installation = await get(installation$);
  return {
    status: 200 as const,
    body: {
      isConfigured:
        (await get(configured$)) &&
        (!installation || Boolean(installation.setupCompletedAt)),
      isConnected:
        status.isConnected && Boolean(installation?.setupCompletedAt),
      connectedUserName: status.connectedUserName,
      installationId: status.installationId,
    },
  };
});

const connect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return disabled();
  }
  const config = larkOfficialApp();
  if (!config || !(await get(configured$))) {
    return notConfigured("Okou Official Lark bot is not configured");
  }
  const auth = get(organizationAuthContext$);
  const db = set(writeDb$);
  const [custom] = await db
    .select({ id: feishuOrgInstallations.id })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.appId, config.appId),
        eq(feishuOrgInstallations.installationType, "custom"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (custom) {
    return conflict(
      "The Official app must use a separate identity from custom bots",
    );
  }
  const secrets = await Promise.all([
    encryptPersistentSecretValue(config.appSecret, auth, signal),
    encryptPersistentSecretValue(config.verificationToken, auth, signal),
    encryptPersistentSecretValue(config.encryptKey, auth, signal),
  ]);
  signal.throwIfAborted();
  await db
    .insert(feishuOrgInstallations)
    .values({
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      platform: "lark",
      installationType: "official",
      appId: config.appId,
      botName: "Okou Official",
      encryptedAppSecret: secrets[0],
      encryptedVerificationToken: secrets[1],
      encryptedEncryptKey: secrets[2],
      callbackVerifiedAt: nowDate(),
      setupCompletedAt: nowDate(),
    })
    .onConflictDoNothing({
      target: [
        feishuOrgInstallations.orgId,
        feishuOrgInstallations.platform,
        feishuOrgInstallations.installationType,
      ],
    });
  signal.throwIfAborted();
  const [installation] = await db
    .select()
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, auth.orgId),
        eq(feishuOrgInstallations.platform, "lark"),
        eq(feishuOrgInstallations.installationType, "official"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (
    !installation ||
    installation.appId !== config.appId ||
    !installation.setupCompletedAt
  ) {
    return conflict(
      "The Official bot configuration changed or the app was disabled. Please contact your administrator.",
    );
  }
  return {
    status: 200 as const,
    body: {
      authorizationUrl: buildFeishuOAuthConnectUrl({
        installationId: installation.id,
        orgId: auth.orgId,
        userId: auth.userId,
        platform: "lark",
      }),
    },
  };
});
const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await get(enabled$))) {
    return disabled();
  }
  const installation = await get(installation$);
  signal.throwIfAborted();
  if (!installation) {
    return notFound("Okou Official Lark connection not found");
  }
  const auth = get(organizationAuthContext$);
  await set(
    disconnectFeishuConnection$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      installationId: installation.id,
      platform: "lark",
    },
    signal,
  );
  return { status: 200 as const, body: { success: true as const } };
});

export const larkOfficialRoutes: readonly RouteEntry[] = [
  {
    route: larkOfficialContract.getStatus,
    handler: authRoute(
      { requireOrganization: true, accept: ["session"] },
      status$,
    ),
  },
  {
    route: larkOfficialContract.connect,
    handler: authRoute(
      { requireOrganization: true, accept: ["session"] },
      connect$,
    ),
  },
  {
    route: larkOfficialContract.disconnect,
    handler: authRoute(
      { requireOrganization: true, accept: ["session"] },
      disconnect$,
    ),
  },
];
