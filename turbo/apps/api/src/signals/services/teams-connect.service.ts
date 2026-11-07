import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import type { TeamsConnectStatus } from "@okouai/api-contracts/contracts/teams-connect";
import { command, computed, type Computed } from "ccstate";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { teamsOrgConnections } from "@okouai/db/runtime/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import type { TeamsInboundActivity } from "@okouai/api-contracts/contracts/teams-bot";
import { and, eq, isNull, sql, or } from "drizzle-orm";

import { env } from "../../lib/env";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { logger } from "../../lib/log";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  createTeamsPersonalConversation,
  sendTeamsMessageReply,
  type TeamsAdaptiveCard,
} from "../external/teams-bot-client";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { nowDate } from "../../lib/time";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

import {
  teamsAccountConnection,
  teamsAccountOwnerCondition,
  removeTeamsInstallation$,
} from "./teams-workspace-identity.service";

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;

const L = logger("TeamsConnect");

type TeamsDisconnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly orgId: string;
      readonly userId: string;
    };

type TeamsUninstallResult =
  | { readonly kind: "not_found"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly orgId: string;
      readonly userIds: readonly string[];
    };

type TeamsInstallationActivityResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "upserted"; readonly installation: TeamsInstallation }
  | {
      readonly kind: "removed";
      readonly orgId: string | null;
      readonly userIds: readonly string[];
    };

const installationNotFoundMessage =
  "Teams installation not found. Please install the Teams app first.";
const adminRequiredMessage =
  "Only org admins can connect an unconfigured Teams installation. Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Teams installation. Please switch to the correct organization in the platform sidebar before connecting.";
const connectionNotFoundMessage = "Teams connection not found.";

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function setOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | null | undefined,
): void {
  const normalized = nonEmpty(value);
  if (normalized) {
    params.set(key, normalized);
  }
}

function buildTeamsBrowserConnectUrl(args: {
  readonly tenantId: string;
  readonly tenantName?: string | null;
  readonly teamsUserId?: string | null;
  readonly teamsAadObjectId?: string | null;
  readonly teamsUserDisplayName?: string | null;
  readonly teamsUserPrincipalName?: string | null;
  readonly teamId?: string | null;
  readonly teamName?: string | null;
  readonly serviceUrl?: string | null;
  readonly conversationId?: string | null;
  readonly conversationType?: string | null;
  readonly activityId?: string | null;
  readonly channelId?: string | null;
  readonly threadId?: string | null;
  readonly orgId?: string | null;
  readonly botName?: string | null;
}): string {
  const params = new URLSearchParams({
    tenantId: args.tenantId,
  });
  setOptionalParam(params, "teamsUserId", args.teamsUserId);
  setOptionalParam(params, "teamsAadObjectId", args.teamsAadObjectId);
  setOptionalParam(params, "tenantName", args.tenantName);
  setOptionalParam(params, "teamsUserDisplayName", args.teamsUserDisplayName);
  setOptionalParam(
    params,
    "teamsUserPrincipalName",
    args.teamsUserPrincipalName,
  );
  setOptionalParam(params, "teamId", args.teamId);
  setOptionalParam(params, "teamName", args.teamName);
  setOptionalParam(params, "serviceUrl", args.serviceUrl);
  setOptionalParam(params, "conversationId", args.conversationId);
  setOptionalParam(params, "conversationType", args.conversationType);
  setOptionalParam(params, "activityId", args.activityId);
  setOptionalParam(params, "channelId", args.channelId);
  setOptionalParam(params, "threadId", args.threadId);
  setOptionalParam(params, "orgId", args.orgId);
  setOptionalParam(params, "botName", args.botName);
  return `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.teams}?${params.toString()}`;
}

export function buildTeamsOauthConnectUrl(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly flow?: "connect" | "install";
}): string {
  const url = new URL("/api/teams/oauth/connect", internalApiBaseUrl());
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("userId", args.userId);
  if (args.flow) {
    url.searchParams.set("flow", args.flow);
  }
  return url.toString();
}

export function buildTeamsInstallUrl(tenantId?: string | null): string | null {
  const appId = env("MICROSOFT_TEAMS_BOT_APP_ID");
  if (!appId) {
    return null;
  }
  const url = new URL(`https://teams.microsoft.com/l/app/${appId}`);
  const appTenantId = env("MICROSOFT_TEAMS_APP_TENANT_ID");
  if (appTenantId) {
    url.searchParams.set("installAppPackage", "true");
    url.searchParams.set("appTenantId", appTenantId);
  }
  setOptionalParam(url.searchParams, "tenantId", tenantId);
  return url.toString();
}

function isTeamsInstallationActive(installation: TeamsInstallation): boolean {
  return Boolean(
    installation.serviceUrl || installation.teamsAppId || installation.botId,
  );
}

export function buildTeamsConnectUrlForActivity(args: {
  readonly activity: TeamsInboundActivity;
  readonly installation?: TeamsInstallation | null;
}): string | null {
  if (
    args.activity.kind !== "message" ||
    (args.activity.sender.id.length === 0 &&
      !nonEmpty(args.activity.sender.aadObjectId))
  ) {
    return null;
  }

  return buildTeamsBrowserConnectUrl({
    tenantId: args.activity.tenantId,
    tenantName: args.activity.tenantName,
    teamsUserId: args.activity.sender.id,
    teamsAadObjectId: args.activity.sender.aadObjectId,
    teamsUserDisplayName: args.activity.sender.name,
    teamsUserPrincipalName: args.activity.sender.userPrincipalName,
    teamId: args.activity.teamId,
    teamName: args.activity.teamName,
    serviceUrl: args.activity.serviceUrl,
    conversationId: args.activity.conversationId,
    conversationType: args.activity.conversationType,
    activityId: args.activity.activityId,
    channelId: args.activity.channelId,
    threadId: args.activity.threadId,
    orgId: args.installation?.orgId,
    botName: teamsBotDisplayName(args.installation?.botName),
  });
}

function teamsPermissionStatus(args: {
  readonly installation: TeamsInstallation;
  readonly isAdmin: boolean;
}): {
  readonly permissionMismatch?: boolean;
  readonly reinstallUrl?: string | null;
} {
  if (!args.isAdmin) {
    return {};
  }

  const configuredAppId = env("MICROSOFT_TEAMS_BOT_APP_ID");
  const installedAppId = args.installation.teamsAppId;
  const permissionMismatch = Boolean(
    configuredAppId &&
    installedAppId &&
    configuredAppId.toLowerCase() !== installedAppId.toLowerCase(),
  );

  return {
    permissionMismatch,
    reinstallUrl: permissionMismatch
      ? buildTeamsInstallUrl(args.installation.teamsTenantId)
      : null,
  };
}

function independentTeamsStatus(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
  },
  account: Awaited<
    ReturnType<ReturnType<typeof teamsAccountConnection>["read"]>
  >,
  installation: TeamsInstallation | undefined,
): TeamsConnectStatus {
  const active = installation && isTeamsInstallationActive(installation);
  return {
    workspaceIdentity: true,
    isInstalled: Boolean(active),
    isConnected: Boolean(account),
    isAdmin: args.isAdmin,
    pendingInstallation: Boolean(installation && !active),
    installUrl:
      args.isAdmin && !active
        ? installation
          ? buildTeamsInstallUrl(installation.teamsTenantId)
          : buildTeamsOauthConnectUrl({ ...args, flow: "install" })
        : null,
    connectUrl: account ? null : buildTeamsOauthConnectUrl(args),
    tenantId:
      account?.connection.teamsTenantId ?? installation?.teamsTenantId ?? null,
    tenantName: account
      ? (account.installation?.teamsTenantName ?? null)
      : (installation?.teamsTenantName ?? null),
    teamId: null,
    teamName: null,
    botName: teamsBotDisplayName(installation?.botName),
    linkedAccounts: account
      ? [
          {
            tenantId: account.connection.teamsTenantId,
            teamsUserId: account.connection.teamsUserId,
            teamsAadObjectId: account.connection.teamsAadObjectId,
            displayName: account.connection.teamsUserDisplayName,
            userPrincipalName: account.connection.teamsUserPrincipalName,
          },
        ]
      : [],
    ...(installation
      ? teamsPermissionStatus({ installation, isAdmin: args.isAdmin })
      : {}),
  };
}

export function teamsConnectStatus(
  args$: Computed<{
    readonly orgId: string;
    readonly userId: string;
    readonly isAdmin: boolean;
  }>,
): Computed<Promise<TeamsConnectStatus>> {
  const account$ = teamsAccountConnection(args$);
  return computed(async (get) => {
    const args = get(args$);
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);

    return independentTeamsStatus(args, await get(account$), installation);
  });
}

function buildTeamsWelcomeCard(
  installation: TeamsInstallation,
): TeamsAdaptiveCard {
  const { assistantName } = BRAND_PRESENTATION;
  const mentionName = teamsBotDisplayName(installation.botName);
  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: `You're connected to ${assistantName}! 🎉\nMention \`@${mentionName}\` in any channel or send a DM to start chatting with your agent.`,
        wrap: true,
      },
    ],
  };
}

async function resolveTeamsWelcomeConversationId(
  args: {
    readonly tenantId: string;
    readonly serviceUrl: string;
    readonly teamsUserId: string | undefined;
    readonly teamsUserDisplayName: string | undefined;
    readonly botId: string | null;
    readonly botName: string | null;
  },
  signal: AbortSignal,
): Promise<string | undefined> {
  if (args.teamsUserId && args.botId) {
    const conversation = await createTeamsPersonalConversation(
      {
        serviceUrl: args.serviceUrl,
        tenantId: args.tenantId,
        botId: args.botId,
        botName: args.botName,
        teamsUserId: args.teamsUserId,
        teamsUserDisplayName: args.teamsUserDisplayName,
      },
      signal,
    );
    signal.throwIfAborted();
    if (conversation.kind === "ok") {
      return conversation.conversationId;
    }
    L.warn("Failed to create Teams personal welcome conversation", {
      tenantId: args.tenantId,
      status: conversation.status,
      error: conversation.error,
    });
  }

  return undefined;
}

const notifyTeamsConnect$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly installation: TeamsInstallation;
      readonly tenantId: string;
      readonly serviceUrl: string | undefined;
      readonly teamsUserId: string | undefined;
      readonly teamsUserDisplayName: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [connection] = await writeDb
      .select({
        dmWelcomeSent: teamsOrgConnections.dmWelcomeSent,
        teamsUserId: teamsOrgConnections.teamsUserId,
        teamsAadObjectId: teamsOrgConnections.teamsAadObjectId,
      })
      .from(teamsOrgConnections)
      .where(eq(teamsOrgConnections.id, args.connectionId))
      .limit(1);
    signal.throwIfAborted();

    if (!connection || connection.dmWelcomeSent || !args.serviceUrl) {
      return;
    }

    const conversationId = await resolveTeamsWelcomeConversationId(
      {
        tenantId: args.tenantId,
        serviceUrl: args.serviceUrl,
        // Microsoft accepts the verified AAD object ID for personal chats.
        teamsUserId:
          args.teamsUserId ??
          connection.teamsUserId ??
          connection.teamsAadObjectId ??
          undefined,
        teamsUserDisplayName: args.teamsUserDisplayName,
        botId: args.installation.botId,
        botName: args.installation.botName,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!conversationId) {
      return;
    }

    const sendResult = await sendTeamsMessageReply(
      {
        serviceUrl: args.serviceUrl,
        conversationId,
        tenantId: args.tenantId,
        text: `You're connected to ${BRAND_PRESENTATION.assistantName}!`,
        card: buildTeamsWelcomeCard(args.installation),
      },
      signal,
    );
    signal.throwIfAborted();

    if (sendResult.kind === "teams-error") {
      L.warn("Failed to send Teams connect welcome", {
        tenantId: args.tenantId,
        conversationId,
        status: sendResult.status,
        error: sendResult.error,
      });
      return;
    }

    await writeDb
      .update(teamsOrgConnections)
      .set({ dmWelcomeSent: true, updatedAt: nowDate() })
      .where(eq(teamsOrgConnections.id, args.connectionId));
    signal.throwIfAborted();
  },
);

/** Deliver pending welcomes only through the account's own workspace bot. */
export const notifyPendingTeamsConnectWelcomes$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly tenantId: string;
      readonly userId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const rows = await set(writeDb$)
      .select({
        connection: teamsOrgConnections,
        installation: teamsOrgInstallations,
      })
      .from(teamsOrgConnections)
      .innerJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          eq(teamsOrgInstallations.orgId, args.orgId),
          eq(teamsOrgConnections.orgId, args.orgId),
          args.userId ? eq(teamsOrgConnections.userId, args.userId) : undefined,
          eq(teamsOrgConnections.dmWelcomeSent, false),
        ),
      );
    signal.throwIfAborted();
    for (const { connection, installation } of rows) {
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        args.orgId,
        connection.userId,
        "shared",
        signal,
      );
      if (membership.kind !== "member") {
        continue;
      }
      const result = await settle(
        set(
          notifyTeamsConnect$,
          {
            connectionId: connection.id,
            installation,
            tenantId: args.tenantId,
            serviceUrl: installation.serviceUrl ?? undefined,
            teamsUserId: connection.teamsUserId ?? undefined,
            teamsUserDisplayName: connection.teamsUserDisplayName ?? undefined,
          },
          signal,
        ),
        signal,
      );
      if (!result.ok) {
        L.warn("Failed to deliver pending Teams connect welcome", {
          connectionId: connection.id,
          error: result.error,
        });
      }
    }
  },
);

/** Install authority and personal identity have separate lifecycles. */
export const prepareTeamsBotInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly orgRole: "admin" | "member";
      readonly tenantId: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.orgRole !== "admin") {
      return { kind: "forbidden", message: adminRequiredMessage } as const;
    }
    const db = set(writeDb$);
    const saved = await settle(
      db
        .insert(teamsOrgInstallations)
        .values({
          teamsTenantId: args.tenantId,
          orgId: args.orgId,
          installedByUserId: args.userId,
        })
        .onConflictDoUpdate({
          target: teamsOrgInstallations.teamsTenantId,
          set: {
            orgId: args.orgId,
            installedByUserId: args.userId,
            updatedAt: nowDate(),
          },
          setWhere: or(
            isNull(teamsOrgInstallations.orgId),
            eq(teamsOrgInstallations.orgId, args.orgId),
          ),
        })
        .returning(),
      signal,
    );
    if (!saved.ok) {
      if (
        isUniqueViolation(saved.error, "idx_teams_org_installations_org_unique")
      ) {
        return { kind: "forbidden", message: orgMismatchMessage } as const;
      }
      throw saved.error;
    }
    const [installation] = saved.value;
    return installation
      ? ({ kind: "ok", installation } as const)
      : ({ kind: "forbidden", message: orgMismatchMessage } as const);
  },
);

export const disconnectTeamsConnection$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<TeamsDisconnectResult> => {
    const writeDb = set(writeDb$);
    const [account] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .leftJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(teamsAccountOwnerCondition(args))
      .limit(2);
    signal.throwIfAborted();
    if (account) {
      await writeDb
        .delete(teamsOrgConnections)
        .where(eq(teamsOrgConnections.id, account.id));
      signal.throwIfAborted();
      return { kind: "ok", orgId: args.orgId, userId: args.userId };
    }

    return { kind: "not_found", message: connectionNotFoundMessage };
  },
);

export const uninstallTeamsInstallation$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<TeamsUninstallResult> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: installationNotFoundMessage };
    }

    const connections = await writeDb
      .select({ userId: teamsOrgConnections.userId })
      .from(teamsOrgConnections)
      .where(eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId));
    signal.throwIfAborted();

    await set(removeTeamsInstallation$, installation.teamsTenantId, signal);

    return {
      kind: "ok",
      orgId: args.orgId,
      userIds: connections.map((connection) => {
        return connection.userId;
      }),
    };
  },
);

export const publishTeamsChanged$ = command(
  async (
    { get },
    args: {
      readonly orgId?: string | null;
      readonly userIds?: readonly string[];
      readonly payload?: unknown;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const userIds = new Set(args.userIds ?? []);

    if (args.orgId) {
      const db = get(db$);
      const admins = await db
        .select({ userId: orgMembersCache.userId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, args.orgId),
            eq(orgMembersCache.role, "admin"),
          ),
        );
      signal.throwIfAborted();
      for (const admin of admins) {
        userIds.add(admin.userId);
      }
    }

    if (userIds.size === 0) {
      return;
    }

    await publishUserSignal([...userIds], "teams:changed", args.payload);
    signal.throwIfAborted();
  },
);

function activityRecipient(activity: TeamsInboundActivity): {
  readonly id: string | null;
  readonly name: string | null;
} {
  if (activity.kind === "message") {
    return {
      id: activity.recipient?.id ?? null,
      name: activity.recipient?.name ?? null,
    };
  }
  if (
    activity.kind === "conversation_update" ||
    activity.kind === "installation_update" ||
    activity.kind === "bot_removed"
  ) {
    return {
      id: activity.recipient?.id ?? null,
      name: activity.recipient?.name ?? null,
    };
  }
  return { id: null, name: null };
}

export const recordTeamsInstallationActivity$ = command(
  async (
    { set },
    args: { readonly activity: TeamsInboundActivity },
    signal: AbortSignal,
  ): Promise<TeamsInstallationActivityResult> => {
    const { activity } = args;
    if (activity.kind === "unsupported") {
      return { kind: "ignored" };
    }

    const writeDb = set(writeDb$);

    if (activity.kind === "bot_removed") {
      const [installation] = await writeDb
        .select()
        .from(teamsOrgInstallations)
        .where(eq(teamsOrgInstallations.teamsTenantId, activity.tenantId))
        .limit(1);
      signal.throwIfAborted();

      if (!installation) {
        return { kind: "removed", orgId: null, userIds: [] };
      }

      const connections = await writeDb
        .select({ userId: teamsOrgConnections.userId })
        .from(teamsOrgConnections)
        .where(eq(teamsOrgConnections.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

      await set(removeTeamsInstallation$, activity.tenantId, signal);

      return {
        kind: "removed",
        orgId: installation.orgId,
        userIds: connections.map((connection) => {
          return connection.userId;
        }),
      };
    }

    const recipient = activityRecipient(activity);
    const [installation] = await writeDb
      .insert(teamsOrgInstallations)
      .values({
        teamsTenantId: activity.tenantId,
        teamsTenantName: activity.tenantName,
        teamsTeamId: activity.teamId,
        teamsTeamName: activity.teamName,
        teamsAppId: activity.teamsAppId,
        botId: recipient.id,
        botName: recipient.name,
        serviceUrl: activity.serviceUrl,
      })
      .onConflictDoUpdate({
        target: teamsOrgInstallations.teamsTenantId,
        set: {
          teamsTenantName: sql`coalesce(excluded.teams_tenant_name, ${teamsOrgInstallations.teamsTenantName})`,
          teamsTeamId: sql`coalesce(excluded.teams_team_id, ${teamsOrgInstallations.teamsTeamId})`,
          teamsTeamName: sql`coalesce(excluded.teams_team_name, ${teamsOrgInstallations.teamsTeamName})`,
          teamsAppId: sql`coalesce(excluded.teams_app_id, ${teamsOrgInstallations.teamsAppId})`,
          botId: sql`coalesce(excluded.bot_id, ${teamsOrgInstallations.botId})`,
          botName: sql`coalesce(excluded.bot_name, ${teamsOrgInstallations.botName})`,
          serviceUrl: sql`coalesce(excluded.service_url, ${teamsOrgInstallations.serviceUrl})`,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!installation) {
      throw new Error("Failed to upsert Teams installation");
    }

    return { kind: "upserted", installation };
  },
);
