import {
  feishuDisconnectCleanupPlan,
  feishuDisconnectInstallationFilter,
  feishuDisconnectMemberPlan,
  type FeishuDisconnectArgs,
} from "./feishu-disconnect-plan";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { variables } from "@okouai/db/schema/variable";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
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
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  fetchFeishuBotInfo,
  FeishuApiError,
  resolveFeishuRequestCredentials,
  feishuTokenUpdateValues,
} from "../external/feishu-client";
import { tapError } from "../utils";
import {
  deleteFeishuInstallationAndCustomConnector$,
  ensureManagedFeishuConnector$,
  feishuOAuthMemberReadPlan,
  feishuOAuthMemberFromRows,
  feishuOAuthInstallationReadPlan,
  feishuOAuthAccountReadPlan,
  feishuOAuthAccountFromRows,
  feishuOAuthCredentialReadPlan,
} from "./feishu-custom-connector.service";
import {
  feishuCallbackUrl,
  feishuOAuthAppCallbackUrl,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";
import { buildFeishuOAuthConnectUrl } from "./feishu-oauth-state";

const L = logger("FeishuConnect");

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

function feishuStatusInstallationReadPlan(args: {
  readonly orgId: string;
  readonly platform?: FeishuPlatform;
}) {
  return {
    columns: {
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
    },
    condition: and(
      eq(feishuOrgInstallations.orgId, args.orgId),
      eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
    ),
  };
}

type FeishuStatusInstallationRow = Pick<
  typeof feishuOrgInstallations.$inferSelect,
  | "id"
  | "appId"
  | "platform"
  | "botName"
  | "botAvatarUrl"
  | "callbackVerifiedAt"
  | "setupCompletedAt"
  | "messageReceivedAt"
> & {
  readonly tenantKey: typeof feishuOrgInstallations.$inferSelect.feishuTenantKey;
  readonly tenantName: typeof feishuOrgInstallations.$inferSelect.feishuTenantName;
  readonly defaultAgentId: typeof agents.$inferSelect.id | null;
  readonly defaultAgentName: typeof agents.$inferSelect.name | null;
  readonly defaultAgentDisplayName:
    typeof agents.$inferSelect.displayName | null;
};

function feishuInstallationStatusFromRow(
  installation: FeishuStatusInstallationRow,
  connectedUserNameByInstallationId: ReadonlyMap<string, string | null>,
  args: { readonly orgId: string; readonly userId: string },
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

function feishuStatusMemberReadPlan(
  installations: readonly { readonly id: string }[],
  userId: string,
) {
  return {
    columns: {
      installationId: feishuOrgConnections.installationId,
      userName: feishuOrgConnections.feishuUserName,
      connectorId: feishuOrgConnections.connectorId,
      feishuOpenId: feishuOrgConnections.feishuOpenId,
    },
    condition: and(
      inArray(
        feishuOrgConnections.installationId,
        installations.map((installation) => {
          return installation.id;
        }),
      ),
      eq(feishuOrgConnections.userId, userId),
    ),
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
    const installationPlan = feishuStatusInstallationReadPlan(args);
    const installations = await db
      .select(installationPlan.columns)
      .from(feishuOrgInstallations)
      .leftJoin(
        orgMetadata,
        eq(orgMetadata.orgId, feishuOrgInstallations.orgId),
      )
      .leftJoin(agents, eq(agents.id, orgMetadata.defaultAgentId))
      .where(installationPlan.condition)
      .orderBy(asc(feishuOrgInstallations.createdAt));
    const orgId = args.orgId;
    const userId = args.userId;
    let connectedUserNameByInstallationId: Map<string, string | null>;
    if (installations.length === 0) {
      connectedUserNameByInstallationId = new Map();
    } else {
      const memberPlan = feishuStatusMemberReadPlan(installations, userId);
      const rows = await db
        .select(memberPlan.columns)
        .from(feishuOrgConnections)
        .where(memberPlan.condition);
      const connectedRows = await Promise.all(
        rows.map(async (connection) => {
          const connected = await (async () => {
            const scope = {
              orgId,
              userId,
              installationId: connection.installationId,
              memberConnectorId: connection.connectorId,
              feishuOpenId: connection.feishuOpenId,
            };
            return (
              (await (async () => {
                const memberPlan = feishuOAuthMemberReadPlan(scope);
                const memberRows = memberPlan.needsRead
                  ? await db
                      .select(memberPlan.columns)
                      .from(feishuOrgConnections)
                      .where(memberPlan.condition)
                      .limit(2)
                  : [];
                const member = feishuOAuthMemberFromRows(scope, memberRows);
                if (!member) {
                  return null;
                }
                const installationPlan = feishuOAuthInstallationReadPlan(scope);
                const [installation] = await db
                  .select(installationPlan.columns)
                  .from(feishuOrgInstallations)
                  .where(installationPlan.condition)
                  .limit(1);
                const customConnectorId = installation?.customConnectorId;
                if (!customConnectorId) {
                  return null;
                }
                const accountScope = { ...scope, ...member, customConnectorId };
                const accountPlan = feishuOAuthAccountReadPlan(accountScope);
                const [exactRows, defaultRows] = await Promise.all([
                  accountPlan.exactWhere
                    ? db
                        .select(accountPlan.columns)
                        .from(connectors)
                        .where(accountPlan.exactWhere)
                    : [],
                  accountPlan.defaultWhere
                    ? db
                        .select(accountPlan.columns)
                        .from(connectors)
                        .where(accountPlan.defaultWhere)
                    : [],
                ]);
                const accountId = feishuOAuthAccountFromRows(accountPlan, {
                  exactRows,
                  defaultRows,
                });
                if (accountId === null) {
                  return null;
                }
                const credentialPlan = feishuOAuthCredentialReadPlan({
                  ...accountScope,
                  memberConnectorId: accountId,
                });
                const [matchedConnection] = await db
                  .select(credentialPlan.columns)
                  .from(connectors)
                  .innerJoin(orgCustomConnectors, credentialPlan.connectorJoin)
                  .innerJoin(secrets, credentialPlan.secretJoin)
                  .where(credentialPlan.condition)
                  .limit(1);
                return matchedConnection?.id ?? null;
              })()) !== null
            );
          })();
          return connected ? connection : null;
        }),
      );
      connectedUserNameByInstallationId = new Map(
        connectedRows.flatMap((connection) => {
          return connection
            ? [[connection.installationId, connection.userName] as const]
            : [];
        }),
      );
    }
    const statuses = installations.map((installation) => {
      return feishuInstallationStatusFromRow(
        installation,
        connectedUserNameByInstallationId,
        args,
      );
    });
    return feishuStatusResponse(statuses, args);
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
  async ({ set }, args: FeishuDisconnectArgs, signal: AbortSignal) => {
    const db = set(writeDb$);
    const installations = await db
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(feishuDisconnectInstallationFilter(args));
    signal.throwIfAborted();
    if (installations.length === 0) {
      return false;
    }
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0161; new non-billing transactions are prohibited.
    const rows = await db.transaction(async (tx) => {
      const scope = args;
      await (async () => {
        const p = feishuOAuthInstallationReadPlan(scope);
        const q = tx.select(p.columns).from(p.from).where(p.condition);
        const [installation] = await q.for("update", { of: p.from }).limit(1);
        signal.throwIfAborted();
        if (!installation?.customConnectorId) {
          return;
        }
        const memberConnectorId = await (async () => {
          const m = feishuOAuthMemberReadPlan(scope);
          const mq = tx.select(m.columns).from(m.from).where(m.condition);
          const members = m.needsRead ? await mq.limit(2) : [];
          const member = feishuOAuthMemberFromRows(scope, members);
          if (!member) {
            return null;
          }
          const iq = tx.select(p.columns).from(p.from).where(p.condition);
          const [installed] = await iq.limit(1);
          if (!installed?.customConnectorId) {
            return null;
          }
          const accountScope = {
            ...scope,
            ...member,
            customConnectorId: installed.customConnectorId,
          };
          const a = feishuOAuthAccountReadPlan(accountScope);
          const [exactRows, defaultRows] = await Promise.all([
            a.exactWhere
              ? tx.select(a.columns).from(connectors).where(a.exactWhere)
              : [],
            a.defaultWhere
              ? tx.select(a.columns).from(connectors).where(a.defaultWhere)
              : [],
          ]);
          const accountId = feishuOAuthAccountFromRows(a, {
            exactRows,
            defaultRows,
          });
          if (accountId === null) {
            return null;
          }
          const c = feishuOAuthCredentialReadPlan({
            ...accountScope,
            memberConnectorId: accountId,
          });
          const query = tx.select(c.columns).from(connectors);
          const [matched] = await query
            .innerJoin(orgCustomConnectors, c.connectorJoin)
            .innerJoin(secrets, c.secretJoin)
            .where(c.condition)
            .limit(1);
          return matched?.id ?? null;
        })();
        signal.throwIfAborted();
        if (!memberConnectorId) {
          return;
        }
        const d = feishuDisconnectCleanupPlan({
          ...scope,
          customConnectorId: installation.customConnectorId,
          memberConnectorId,
        });
        const account = tx.select(d.columns).from(connectors).where(d.account);
        const [connection] = await account.for("update").limit(1);
        signal.throwIfAborted();
        if (!connection) {
          return;
        }
        await tx.delete(secrets).where(d.secret);
        signal.throwIfAborted();
        await tx.delete(variables).where(d.variable);
        signal.throwIfAborted();
        await tx.execute(d.defer);
        const deleted = await tx
          .delete(connectors)
          .where(d.connector)
          .returning(d.columns);
        if (deleted.length > 0) {
          await tx.delete(chatThreadConnectorSelections).where(d.selection);
        }
        await tx.execute(d.immediate);
        if (deleted.length > 0) {
          const affected = tx
            .select(d.cursorColumns)
            .from(workflowAutomations)
            .where(d.cursor);
          await tx
            .delete(googleFormsAutomationCursors)
            .where(
              inArray(googleFormsAutomationCursors.automationId, affected),
            );
        }
        signal.throwIfAborted();
      })();
      const removal = feishuDisconnectMemberPlan(args, installations);
      const deleted = await tx
        .delete(feishuOrgConnections)
        .where(removal.condition)
        .returning(removal.columns);
      signal.throwIfAborted();
      return deleted;
    });
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

type UpdateFeishuInstallationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "installation_not_found" }
  | { readonly kind: "bot_identity_mismatch" };

interface UpdateFeishuInstallationAgentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly platform?: FeishuPlatform;
  readonly setupCompleted?: boolean;
}

function feishuInstallationAgentUpdateValues(
  args: UpdateFeishuInstallationAgentArgs,
  botInfo: Awaited<ReturnType<typeof fetchFeishuBotInfo>> | undefined,
) {
  return {
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
  };
}

function feishuInstallationAgentUpdateCondition(
  args: UpdateFeishuInstallationAgentArgs,
) {
  return and(
    eq(feishuOrgInstallations.id, args.installationId),
    eq(feishuOrgInstallations.orgId, args.orgId),
    eq(feishuOrgInstallations.platform, args.platform ?? "feishu"),
  );
}

export const updateFeishuInstallationAgent$ = command(
  async (
    { set },
    args: UpdateFeishuInstallationAgentArgs,
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
            const botPlatform = installation.platform;
            const setupArgs = {
              installationId: args.installationId,
            };
            const setupSignal = signal;
            const setupRead = (async () => {
              const [installation] = await db
                .select()
                .from(feishuOrgInstallations)
                .where(eq(feishuOrgInstallations.id, setupArgs.installationId))
                .limit(1);
              setupSignal.throwIfAborted();
              if (!installation) {
                throw new Error("Bot installation not found");
              }
              if (
                !(await (async () => {
                  const plan =
                    feishuInstallationAvailabilityReadPlan(installation);
                  if (plan.kind === "resolved") {
                    return plan.enabled;
                  }
                  const rows = await db
                    .select(plan.columns)
                    .from(userFeatureSwitches)
                    .where(plan.condition);
                  return feishuInstallationEnabledFromRows(plan.scope, rows);
                })())
              ) {
                throw new FeishuApiError(
                  "Lark integration is not enabled",
                  403,
                );
              }
              const credentials = await resolveFeishuRequestCredentials(
                installation,
                setupSignal,
              );
              if (credentials.refreshedToken) {
                await db
                  .update(feishuOrgInstallations)
                  .set(feishuTokenUpdateValues(credentials.refreshedToken))
                  .where(
                    eq(feishuOrgInstallations.id, setupArgs.installationId),
                  );
                setupSignal.throwIfAborted();
              }
              return credentials.context;
            })();
            const setupToken = await (async () => {
              return (await setupRead).token;
            })();
            return await fetchFeishuBotInfo(
              {
                platform: botPlatform,
                tenantAccessToken: setupToken,
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
      .set(feishuInstallationAgentUpdateValues(args, botInfo))
      .where(feishuInstallationAgentUpdateCondition(args))
      .returning({ id: feishuOrgInstallations.id });
    signal.throwIfAborted();
    if (rows.length === 0) {
      return { kind: "installation_not_found" };
    }
    if (args.setupCompleted) {
      await set(
        ensureManagedFeishuConnector$,
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
