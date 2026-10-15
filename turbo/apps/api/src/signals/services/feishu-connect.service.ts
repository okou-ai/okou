import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { command, computed } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  FEISHU_OAUTH_SCOPES,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";

import { logger } from "../../lib/log";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  fetchFeishuBotInfo,
  getFeishuTenantAccessToken,
} from "../external/feishu-client";
import { tapError } from "../utils";
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
import { feishuCallbackUrl, feishuOAuthAppCallbackUrl } from "./feishu-config";
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
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, feishuOrgInstallations.orgId))
    .leftJoin(agents, eq(agents.id, orgMetadata.defaultAgentId))
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0161; new non-billing transactions are prohibited.
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
      readonly setupCompleted?: boolean;
    },
    signal: AbortSignal,
  ): Promise<UpdateFeishuInstallationResult> => {
    const db = set(writeDb$);
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
