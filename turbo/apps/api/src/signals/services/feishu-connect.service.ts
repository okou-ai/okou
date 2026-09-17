import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { command, computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  FEISHU_OAUTH_SCOPES,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { agents } from "@okouai/db/schema/agent";

import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  fetchFeishuBotInfo,
  fetchFeishuTenantAccessToken,
  getFeishuTenantAccessToken,
} from "../external/feishu-client";
import { tapError } from "../utils";
import { encryptPersistentSecretValue } from "./crypto.utils";
import {
  deleteFeishuInstallationAndCustomConnector$,
  disconnectFeishuCustomConnectorOAuthConnection,
  ensureFeishuCustomConnector$,
  hasFeishuCustomConnectorOAuthConnection,
} from "./feishu-custom-connector.service";
import {
  publishCustomConnectorUserInvalidationAfterCommit,
  type CapturedConnectorClientInvalidationAbort,
} from "./connector-client-invalidation.service";
import {
  feishuCallbackUrl,
  feishuOAuthAppCallbackUrl,
  loadFeishuInstallationConfig,
  type FeishuInstallationConfig,
} from "./feishu-config";
import { buildFeishuOAuthConnectUrl } from "./feishu-oauth-state";

const L = logger("FeishuConnect");

async function loadFeishuInstallations(
  db: ReadonlyDb,
  orgId: string,
  platform: FeishuPlatform,
) {
  return await db
    .select({
      id: feishuOrgInstallations.id,
      appId: feishuOrgInstallations.appId,
      platform: feishuOrgInstallations.platform,
      botName: feishuOrgInstallations.botName,
      botAvatarUrl: feishuOrgInstallations.botAvatarUrl,
      publicBrand: feishuOrgInstallations.publicBrand,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      tenantName: feishuOrgInstallations.feishuTenantName,
      callbackVerifiedAt: feishuOrgInstallations.callbackVerifiedAt,
      setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
      messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
      defaultAgentId: agents.id,
      defaultAgentName: agents.name,
      defaultAgentDisplayName: agents.displayName,
    })
    .from(feishuOrgInstallations)
    .innerJoin(agents, eq(agents.id, feishuOrgInstallations.defaultAgentId))
    .where(
      and(
        eq(feishuOrgInstallations.orgId, orgId),
        eq(feishuOrgInstallations.platform, platform),
      ),
    )
    .orderBy(asc(feishuOrgInstallations.createdAt));
}

type FeishuInstallationRow = Awaited<
  ReturnType<typeof loadFeishuInstallations>
>[number];

async function loadConnectedFeishuUsers(
  db: ReadonlyDb,
  installations: readonly FeishuInstallationRow[],
  orgId: string,
  userId: string,
): Promise<Map<string, string | null>> {
  if (installations.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      installationId: feishuOrgConnections.installationId,
      userName: feishuOrgConnections.feishuUserName,
      connectorId: feishuOrgConnections.connectorId,
      feishuOpenId: feishuOrgConnections.feishuOpenId,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        inArray(
          feishuOrgConnections.installationId,
          installations.map((installation) => {
            return installation.id;
          }),
        ),
        eq(feishuOrgConnections.userId, userId),
      ),
    );
  const connectedRows = await Promise.all(
    rows.map(async (connection) => {
      const connected = await hasFeishuCustomConnectorOAuthConnection(db, {
        orgId,
        userId,
        installationId: connection.installationId,
        memberConnectorId: connection.connectorId,
        feishuOpenId: connection.feishuOpenId,
      });
      return connected ? connection : null;
    }),
  );
  return new Map(
    connectedRows.flatMap((connection) => {
      return connection
        ? [[connection.installationId, connection.userName] as const]
        : [];
    }),
  );
}

function toFeishuInstallationStatus(
  installation: FeishuInstallationRow,
  connectedUserNameByInstallationId: ReadonlyMap<string, string | null>,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
): FeishuInstallationStatus {
  return {
    id: installation.id,
    platform: installation.platform,
    publicBrand: installation.publicBrand,
    isConnected: connectedUserNameByInstallationId.has(installation.id),
    connectedUserName:
      connectedUserNameByInstallationId.get(installation.id) ?? null,
    appId: installation.appId,
    botName: installation.botName,
    botAvatarUrl: installation.botAvatarUrl,
    callbackUrl: feishuCallbackUrl(installation.id),
    oauthRedirectUrl: feishuOAuthAppCallbackUrl(installation.platform),
    oauthScopes: [...FEISHU_OAUTH_SCOPES],
    connectUrl: installation.setupCompletedAt
      ? buildFeishuOAuthConnectUrl({
          installationId: installation.id,
          platform: installation.platform,
          orgId: args.orgId,
          userId: args.userId,
        })
      : null,
    callbackVerified: Boolean(installation.callbackVerifiedAt),
    setupCompleted: Boolean(installation.setupCompletedAt),
    messageReceived: Boolean(installation.messageReceivedAt),
    tenantKey: installation.tenantKey,
    tenantName: installation.tenantName,
    defaultAgentId: installation.defaultAgentId,
    defaultAgentName:
      installation.defaultAgentDisplayName ??
      installation.defaultAgentName ??
      null,
  };
}

function feishuStatusResponse(
  installations: readonly FeishuInstallationStatus[],
  args: {
    readonly isAdmin: boolean;
    readonly publicBrand: PublicBrand;
    readonly platform?: FeishuPlatform;
    readonly preferredInstallationId?: string;
  },
): FeishuConnectStatus {
  const installation =
    installations.find((candidate) => {
      return candidate.id === args.preferredInstallationId;
    }) ?? installations[0];
  if (!installation) {
    return {
      publicBrand: args.publicBrand,
      platform: args.platform ?? "feishu",
      isInstalled: false,
      isConnected: false,
      connectedUserName: null,
      isAdmin: args.isAdmin,
      appId: null,
      botName: null,
      botAvatarUrl: null,
      callbackUrl: null,
      oauthRedirectUrl: null,
      oauthScopes: [...FEISHU_OAUTH_SCOPES],
      connectUrl: null,
      callbackVerified: false,
      messageReceived: false,
      tenantKey: null,
      tenantName: null,
      defaultAgentId: null,
      defaultAgentName: null,
      installationId: null,
      installations: [],
    };
  }
  return {
    publicBrand: args.publicBrand,
    platform: args.platform ?? "feishu",
    isInstalled: true,
    isConnected: installation.isConnected,
    connectedUserName: installation.connectedUserName ?? null,
    isAdmin: args.isAdmin,
    appId: installation.appId,
    botName: installation.botName,
    botAvatarUrl: installation.botAvatarUrl,
    callbackUrl: installation.callbackUrl,
    oauthRedirectUrl: installation.oauthRedirectUrl ?? null,
    oauthScopes: [...FEISHU_OAUTH_SCOPES],
    connectUrl: installation.connectUrl ?? null,
    callbackVerified: installation.callbackVerified,
    messageReceived: installation.messageReceived,
    tenantKey: installation.tenantKey,
    tenantName: installation.tenantName,
    defaultAgentId: installation.defaultAgentId,
    defaultAgentName: installation.defaultAgentName,
    installationId: installation.id,
    installations: [...installations],
  };
}

export const feishuConnectStatus = (args: {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly platform?: FeishuPlatform;
  readonly isAdmin: boolean;
  readonly preferredInstallationId?: string;
}) => {
  return computed(async (get) => {
    const db = get(db$);
    const rows = await loadFeishuInstallations(
      db,
      args.orgId,
      args.platform ?? "feishu",
    );
    const connectedUsers = await loadConnectedFeishuUsers(
      db,
      rows,
      args.orgId,
      args.userId,
    );
    const installations = rows.map((installation) => {
      return toFeishuInstallationStatus(installation, connectedUsers, {
        orgId: args.orgId,
        userId: args.userId,
      });
    });
    return feishuStatusResponse(installations, args);
  });
};

interface ConfigureFeishuArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly platform?: FeishuPlatform;
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly defaultAgentId: string;
  readonly installationId?: string;
  readonly createNew?: boolean;
}

export type ConfigureFeishuResult =
  | {
      readonly kind: "ok";
      readonly installationId: string;
      readonly connectorConfigurationChanged: boolean;
    }
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_identity_mismatch" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

type PreparedFeishuInstallation =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "changed";
      readonly connectorConfigurationChanged: boolean;
      readonly callbackConfigurationChanged: boolean;
      readonly encryptedAppSecret: string;
      readonly encryptedVerificationToken: string;
      readonly encryptedEncryptKey: string;
      readonly encryptedTenantAccessToken: string;
      readonly tokenExpiresAt: Date;
    };

function feishuInstallationCredentialsMatch(
  input: ConfigureFeishuArgs,
  existing: FeishuInstallationConfig,
): boolean {
  return (
    input.appId === existing.appId &&
    input.appSecret === existing.appSecret &&
    input.verificationToken === existing.verificationToken &&
    input.encryptKey === existing.encryptKey
  );
}

async function prepareFeishuInstallation(
  input: ConfigureFeishuArgs,
  existing: FeishuInstallationConfig | null,
  signal: AbortSignal,
): Promise<PreparedFeishuInstallation> {
  if (existing && feishuInstallationCredentialsMatch(input, existing)) {
    return { kind: "unchanged" };
  }
  const tenantToken = await fetchFeishuTenantAccessToken(
    {
      appId: input.appId,
      platform: input.platform ?? "feishu",
      appSecret: input.appSecret,
    },
    signal,
  );
  const context = {
    orgId: input.orgId,
    userId: input.userId,
  };
  const [
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
  ] = await Promise.all([
    existing && input.appSecret === existing.appSecret
      ? Promise.resolve(existing.encryptedAppSecret)
      : encryptPersistentSecretValue(input.appSecret, context),
    encryptPersistentSecretValue(input.verificationToken, context),
    encryptPersistentSecretValue(input.encryptKey, context),
    encryptPersistentSecretValue(tenantToken.token, context),
  ]);
  signal.throwIfAborted();
  return {
    kind: "changed",
    connectorConfigurationChanged:
      !existing || input.appSecret !== existing.appSecret,
    callbackConfigurationChanged:
      !existing ||
      input.verificationToken !== existing.verificationToken ||
      input.encryptKey !== existing.encryptKey,
    encryptedAppSecret,
    encryptedVerificationToken,
    encryptedEncryptKey,
    encryptedTenantAccessToken,
    tokenExpiresAt: new Date(
      nowDate().getTime() + tenantToken.expiresInSeconds * 1000,
    ),
  };
}

async function persistFeishuInstallation(
  args: {
    readonly db: Pick<Db, "insert" | "update">;
    readonly input: ConfigureFeishuArgs;
    readonly prepared: PreparedFeishuInstallation;
    readonly targetInstallationId: string | undefined;
  },
  signal: AbortSignal,
): Promise<ConfigureFeishuResult> {
  if (args.targetInstallationId) {
    await args.db
      .update(feishuOrgInstallations)
      .set({
        defaultAgentId: args.input.defaultAgentId,
        ...(args.prepared.kind === "changed"
          ? {
              encryptedAppSecret: args.prepared.encryptedAppSecret,
              encryptedVerificationToken:
                args.prepared.encryptedVerificationToken,
              encryptedEncryptKey: args.prepared.encryptedEncryptKey,
              defaultAgentId: args.input.defaultAgentId,
              encryptedTenantAccessToken:
                args.prepared.encryptedTenantAccessToken,
              tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
              ...(args.prepared.callbackConfigurationChanged
                ? { callbackVerifiedAt: null }
                : {}),
            }
          : {}),
        updatedAt: nowDate(),
      })
      .where(eq(feishuOrgInstallations.id, args.targetInstallationId));
    signal.throwIfAborted();
    return {
      kind: "ok",
      installationId: args.targetInstallationId,
      connectorConfigurationChanged:
        args.prepared.kind === "changed" &&
        args.prepared.connectorConfigurationChanged,
    };
  }
  if (args.prepared.kind === "unchanged") {
    throw new Error("A new Feishu installation requires credentials");
  }
  const [created] = await args.db
    .insert(feishuOrgInstallations)
    .values({
      orgId: args.input.orgId,
      ownerUserId: args.input.userId,
      appId: args.input.appId,
      platform: args.input.platform ?? "feishu",
      encryptedAppSecret: args.prepared.encryptedAppSecret,
      encryptedVerificationToken: args.prepared.encryptedVerificationToken,
      encryptedEncryptKey: args.prepared.encryptedEncryptKey,
      defaultAgentId: args.input.defaultAgentId,
      publicBrand: args.input.publicBrand,
      encryptedTenantAccessToken: args.prepared.encryptedTenantAccessToken,
      tenantAccessTokenExpiresAt: args.prepared.tokenExpiresAt,
    })
    .onConflictDoNothing({
      target: feishuOrgInstallations.appId,
    })
    .returning({ id: feishuOrgInstallations.id });
  signal.throwIfAborted();
  return created
    ? {
        kind: "ok",
        installationId: created.id,
        connectorConfigurationChanged: true,
      }
    : { kind: "app_in_use" };
}

type FeishuInstallationTargetResult =
  | {
      readonly kind: "target";
      readonly installationId: string | undefined;
    }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "app_in_use" }
  | { readonly kind: "installation_exists" };

async function resolveFeishuInstallationTarget(
  db: Pick<Db, "select">,
  args: ConfigureFeishuArgs,
  signal: AbortSignal,
): Promise<FeishuInstallationTargetResult> {
  const [appOwner] = await db
    .select({
      id: feishuOrgInstallations.id,
      orgId: feishuOrgInstallations.orgId,
      platform: feishuOrgInstallations.platform,
    })
    .from(feishuOrgInstallations)
    .where(eq(feishuOrgInstallations.appId, args.appId))
    .limit(1);
  signal.throwIfAborted();
  if (
    appOwner &&
    (appOwner.orgId !== args.orgId ||
      appOwner.platform !== (args.platform ?? "feishu"))
  ) {
    return { kind: "app_in_use" };
  }
  if (args.installationId && appOwner && appOwner.id !== args.installationId) {
    return { kind: "app_in_use" };
  }
  let targetInstallationId =
    args.installationId ?? (args.createNew ? undefined : appOwner?.id);
  if (!targetInstallationId) {
    const [existingInstallation] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
        ),
      )
      .orderBy(asc(feishuOrgInstallations.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (existingInstallation && args.createNew) {
      return { kind: "installation_exists" };
    }
    targetInstallationId = existingInstallation?.id;
  }
  if (targetInstallationId) {
    const [installation] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, targetInstallationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { kind: "installation_not_found" };
    }
  }
  return { kind: "target", installationId: targetInstallationId };
}

export const configureFeishuInstallation$ = command(
  async (
    { set },
    args: ConfigureFeishuArgs,
    signal: AbortSignal,
  ): Promise<ConfigureFeishuResult> => {
    const db = set(writeDb$);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, args.defaultAgentId),
          eq(agents.orgId, args.orgId),
          or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "agent_not_found" };
    }
    const preflight = await resolveFeishuInstallationTarget(db, args, signal);
    if (preflight.kind !== "target") {
      return preflight;
    }
    const existing = preflight.installationId
      ? await loadFeishuInstallationConfig(db, preflight.installationId)
      : null;
    signal.throwIfAborted();
    if (existing && existing.appId !== args.appId) {
      return { kind: "app_identity_mismatch" };
    }
    const prepared = await prepareFeishuInstallation(args, existing, signal);
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('feishu_installation:' || ${args.orgId}))`,
      );
      signal.throwIfAborted();
      const target = await resolveFeishuInstallationTarget(tx, args, signal);
      if (target.kind !== "target") {
        return target;
      }
      if (target.installationId) {
        const [lockedInstallation] = await tx
          .select({ appId: feishuOrgInstallations.appId })
          .from(feishuOrgInstallations)
          .where(
            and(
              eq(feishuOrgInstallations.id, target.installationId),
              eq(feishuOrgInstallations.orgId, args.orgId),
              eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        if (!lockedInstallation) {
          return { kind: "installation_not_found" } as const;
        }
        if (lockedInstallation.appId !== args.appId) {
          return { kind: "app_identity_mismatch" } as const;
        }
      }
      if (
        prepared.kind === "unchanged" &&
        target.installationId !== preflight.installationId
      ) {
        throw new Error("Feishu installation changed during configuration");
      }
      return await persistFeishuInstallation(
        {
          db: tx,
          input: args,
          prepared,
          targetInstallationId: target.installationId,
        },
        signal,
      );
    });
    signal.throwIfAborted();
    if (result.kind === "ok") {
      await set(
        ensureFeishuCustomConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          installationId: result.installationId,
          configurationChanged: result.connectorConfigurationChanged,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return result;
  },
);

export const removeFeishuInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly installationId: string;
      readonly platform?: FeishuPlatform;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return installation
      ? await set(deleteFeishuInstallationAndCustomConnector$, args, signal)
      : false;
  },
);

export const disconnectFeishuConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly installationId: string;
      readonly platform?: FeishuPlatform;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const installations = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
          eq(feishuOrgInstallations.id, args.installationId),
        ),
      );
    signal.throwIfAborted();
    if (installations.length === 0) {
      return false;
    }
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const rows = await db.transaction(async (tx) => {
      await disconnectFeishuCustomConnectorOAuthConnection(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          installationId: args.installationId,
        },
        signal,
      );
      const deleted = await tx
        .delete(feishuOrgConnections)
        .where(
          and(
            inArray(
              feishuOrgConnections.installationId,
              installations.map((installation) => {
                return installation.id;
              }),
            ),
            eq(feishuOrgConnections.userId, args.userId),
          ),
        )
        .returning({ id: feishuOrgConnections.id });
      signal.throwIfAborted();
      return deleted;
    });
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (rows.length === 0) {
      signal.throwIfAborted();
      return false;
    }
    await publishCustomConnectorUserInvalidationAfterCommit(
      args.userId,
      signal,
      postCommitAbort,
    );
    return true;
  },
);

type UpdateFeishuInstallationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "bot_identity_mismatch" };

export const updateFeishuInstallationAgent$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly installationId: string;
      readonly platform?: FeishuPlatform;
      readonly defaultAgentId: string;
      readonly setupCompleted?: boolean;
    },
    signal: AbortSignal,
  ): Promise<UpdateFeishuInstallationResult> => {
    const db = set(writeDb$);
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, args.defaultAgentId),
          eq(agents.orgId, args.orgId),
          or(eq(agents.visibility, "public"), eq(agents.owner, args.userId)),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return { kind: "agent_not_found" };
    }
    const [installation] = await db
      .select({
        botOpenId: feishuOrgInstallations.botOpenId,
        platform: feishuOrgInstallations.platform,
      })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      return { kind: "installation_not_found" };
    }
    const botInfo = args.setupCompleted
      ? await tapError(
          (async () => {
            return await fetchFeishuBotInfo(
              {
                platform: installation.platform,
                tenantAccessToken: await getFeishuTenantAccessToken(
                  {
                    db,
                    installationId: args.installationId,
                  },
                  signal,
                ),
              },
              signal,
            );
          })(),
          (error) => {
            L.warn("Failed to load Feishu bot profile", {
              error,
              installationId: args.installationId,
            });
          },
        )
      : undefined;
    signal.throwIfAborted();
    if (
      botInfo &&
      installation.botOpenId &&
      installation.botOpenId !== botInfo.openId
    ) {
      return { kind: "bot_identity_mismatch" };
    }
    const rows = await db
      .update(feishuOrgInstallations)
      .set({
        defaultAgentId: args.defaultAgentId,
        ...(args.setupCompleted
          ? {
              ...(botInfo
                ? {
                    botOpenId: botInfo.openId,
                    botName: botInfo.name,
                    botAvatarUrl: botInfo.avatarUrl,
                  }
                : {}),
              setupCompletedAt: nowDate(),
            }
          : {}),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
          eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
        ),
      )
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    if (rows.length === 0) {
      return { kind: "installation_not_found" };
    }
    if (args.setupCompleted) {
      await set(
        ensureFeishuCustomConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          installationId: args.installationId,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return { kind: "ok" };
  },
);
