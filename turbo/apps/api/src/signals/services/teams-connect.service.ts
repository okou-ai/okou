import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { randomUUID } from "node:crypto";
import type { TeamsConnectStatus } from "@okouai/api-contracts/contracts/teams-connect";
import { command, computed, type Computed } from "ccstate";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import type { TeamsInboundActivity } from "@okouai/api-contracts/contracts/teams-bot";
import { and, eq, isNull, sql, or, exists, notExists } from "drizzle-orm";

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
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { nowDate } from "../../lib/time";

import {
  teamsAccountConnection,
  teamsAccountOwnerCondition,
  teamsWorkspaceIdentityEnabled,
  removeTeamsInstallation$,
} from "./teams-workspace-identity.service";

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;

const L = logger("TeamsConnect");

type TeamsConnectResult =
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly role: "admin" | "member";
      readonly installation: TeamsInstallation;
    };

type TeamsPrepareInstallResult =
  | { readonly kind: "forbidden"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly connectionId: string;
      readonly installation: TeamsInstallation;
    };

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

export function isTeamsInstallationActive(
  installation: TeamsInstallation,
): boolean {
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

const identityConflictMessage =
  "This Teams identity is already connected to a different account or identity. Please use the original account.";

function teamsConnectionValues(
  args: ConnectTeamsInstallationArgs,
  createdAt: Date,
) {
  return {
    id: sql`${randomUUID()}`.mapWith(teamsOrgConnections.id).as("id"),
    teamsUserId: sql`${args.teamsUserId ?? null}`
      .mapWith(nullableDriverValueDecoder(teamsOrgConnections.teamsUserId))
      .as("teams_user_id"),
    teamsAadObjectId: sql`${args.teamsAadObjectId ?? null}`
      .mapWith(nullableDriverValueDecoder(teamsOrgConnections.teamsAadObjectId))
      .as("teams_aad_object_id"),
    teamsTenantId: sql`${args.tenantId}`
      .mapWith(teamsOrgConnections.teamsTenantId)
      .as("teams_tenant_id"),
    orgId: sql`null`
      .mapWith(nullableDriverValueDecoder(teamsOrgConnections.orgId))
      .as("org_id"),
    userId: sql`${args.userId}`
      .mapWith(teamsOrgConnections.userId)
      .as("user_id"),
    teamsUserDisplayName: sql`${args.teamsUserDisplayName ?? null}`
      .mapWith(
        nullableDriverValueDecoder(teamsOrgConnections.teamsUserDisplayName),
      )
      .as("teams_user_display_name"),
    teamsUserPrincipalName: sql`${args.teamsUserPrincipalName ?? null}`
      .mapWith(
        nullableDriverValueDecoder(teamsOrgConnections.teamsUserPrincipalName),
      )
      .as("teams_user_principal_name"),
    dmWelcomeSent: sql`false`
      .mapWith(teamsOrgConnections.dmWelcomeSent)
      .as("dm_welcome_sent"),
    createdAt: sql`${sql.param(createdAt, teamsOrgConnections.createdAt)}`
      .mapWith(teamsOrgConnections.createdAt)
      .as("created_at"),
    updatedAt: sql`${sql.param(createdAt, teamsOrgConnections.updatedAt)}`
      .mapWith(teamsOrgConnections.updatedAt)
      .as("updated_at"),
  };
}

function compatibleTeamsIdentity(args: ConnectTeamsInstallationArgs) {
  return and(
    eq(teamsOrgConnections.userId, args.userId),
    args.teamsUserId
      ? or(
          isNull(teamsOrgConnections.teamsUserId),
          eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
        )
      : undefined,
    args.teamsAadObjectId
      ? or(
          isNull(teamsOrgConnections.teamsAadObjectId),
          eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId),
        )
      : undefined,
  );
}

/** Installation and identity writes commit together; unique conflicts roll both back. */
const commitTeamsBinding$ = command(
  async (
    { set },
    args: ConnectTeamsInstallationArgs,
    installation: TeamsInstallation | undefined,
    connectionId: string | undefined,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const installed = db.$with("teams_binding_installation").as(
      installation
        ? db
            .update(teamsOrgInstallations)
            .set({
              ...installationMetadataPatch({
                tenantName: args.tenantName,
                teamId: args.teamId,
                teamName: args.teamName,
                serviceUrl: args.serviceUrl,
              }),
              orgId: args.orgId,
              installedByUserId: installation.orgId
                ? installation.installedByUserId
                : args.userId,
            })
            .where(
              and(
                eq(teamsOrgInstallations.teamsTenantId, args.tenantId),
                or(
                  eq(teamsOrgInstallations.orgId, args.orgId),
                  args.orgRole === "admin"
                    ? isNull(teamsOrgInstallations.orgId)
                    : undefined,
                ),
              ),
            )
            .returning()
        : db
            .insert(teamsOrgInstallations)
            .values({
              teamsTenantId: args.tenantId,
              teamsTenantName: args.tenantName,
              orgId: args.orgId,
              installedByUserId: args.userId,
            })
            .returning(),
    );
    const updated = db.$with("teams_binding_updated").as(
      db
        .update(teamsOrgConnections)
        .set({
          teamsUserId: sql`coalesce(${teamsOrgConnections.teamsUserId}, ${args.teamsUserId ?? null})`,
          teamsAadObjectId: sql`coalesce(${teamsOrgConnections.teamsAadObjectId}, ${args.teamsAadObjectId ?? null})`,
          teamsUserDisplayName: args.teamsUserDisplayName,
          teamsUserPrincipalName: args.teamsUserPrincipalName,
          updatedAt: nowDate(),
        })
        .where(
          and(
            connectionId
              ? eq(teamsOrgConnections.id, connectionId)
              : sql`false`,
            compatibleTeamsIdentity(args),
            exists(
              db.select({ tenantId: installed.teamsTenantId }).from(installed),
            ),
          ),
        )
        .returning({ id: teamsOrgConnections.id }),
    );
    const createdAt = nowDate();
    const inserted = db.$with("teams_binding_inserted").as(
      db
        .insert(teamsOrgConnections)
        .select(
          db
            .select(teamsConnectionValues(args, createdAt))
            .from(installed)
            .where(notExists(db.select({ id: updated.id }).from(updated)))
            // Drizzle's typed INSERT SELECT key check includes generated columns;
            // the SQL insert list correctly omits the legacy FK discriminator.
            .getSQL(),
        )
        .returning({ id: teamsOrgConnections.id }),
    );
    // Do not swallow a conflict with DO NOTHING: a rejected identity must roll
    // back the installation claim and metadata in this same statement.
    const result = await settle(
      db
        .with(installed, updated, inserted)
        .select({
          connectionId: sql`coalesce(${updated.id}, ${inserted.id})`.mapWith(
            teamsOrgConnections.id,
          ),
          installation: {
            teamsTenantId: installed.teamsTenantId,
            teamsTenantName: installed.teamsTenantName,
            teamsTeamId: installed.teamsTeamId,
            teamsTeamName: installed.teamsTeamName,
            teamsAppId: installed.teamsAppId,
            botId: installed.botId,
            botName: installed.botName,
            serviceUrl: installed.serviceUrl,
            orgId: installed.orgId,
            installedByUserId: installed.installedByUserId,
            createdAt: installed.createdAt,
            updatedAt: installed.updatedAt,
          },
        })
        .from(installed)
        .leftJoin(updated, sql`true`)
        .leftJoin(inserted, sql`true`),
    );
    signal.throwIfAborted();
    return result;
  },
);

function conflictsWithTeamsIdentity(
  existing: typeof teamsOrgConnections.$inferSelect,
  args: ConnectTeamsInstallationArgs,
): boolean {
  return Boolean(
    existing.userId !== args.userId ||
    (args.teamsUserId &&
      existing.teamsUserId &&
      args.teamsUserId !== existing.teamsUserId) ||
    (args.teamsAadObjectId &&
      existing.teamsAadObjectId &&
      args.teamsAadObjectId !== existing.teamsAadObjectId),
  );
}

const persistTeamsBinding$ = command(
  async (
    { set },
    args: ConnectTeamsInstallationArgs,
    installation: TeamsInstallation | undefined,
    signal: AbortSignal,
  ): Promise<TeamsPrepareInstallResult> => {
    if (!args.teamsUserId && !args.teamsAadObjectId) {
      throw new Error("Teams connection requires a Teams user identity");
    }
    const db = set(writeDb$);
    const identities = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          or(
            args.teamsUserId
              ? eq(teamsOrgConnections.teamsUserId, args.teamsUserId)
              : undefined,
            args.teamsAadObjectId
              ? eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId)
              : undefined,
          ),
        ),
      );
    signal.throwIfAborted();
    const [existing] = identities;
    if (
      identities.length > 1 ||
      (existing && conflictsWithTeamsIdentity(existing, args))
    ) {
      return { kind: "forbidden", message: identityConflictMessage };
    }

    const result = await set(
      commitTeamsBinding$,
      args,
      installation,
      existing?.id,
      signal,
    );
    if (result.ok) {
      const [bound] = result.value;
      return bound
        ? { kind: "ok", ...bound }
        : { kind: "forbidden", message: orgMismatchMessage };
    }
    if (
      ![
        "idx_teams_org_connections_user_tenant",
        "idx_teams_org_connections_aad_tenant",
        "teams_org_installations_pkey",
        "idx_teams_org_installations_org_unique",
      ].some((constraint) => {
        return isUniqueViolation(result.error, constraint);
      })
    ) {
      throw result.error;
    }
    // A fresh snapshot resolves an insert race only when every supplied identity
    // belongs to this caller in the requested org. Never transfer the winner.
    const [winner] = await db
      .select({
        connectionId: teamsOrgConnections.id,
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
          eq(teamsOrgConnections.userId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          eq(teamsOrgInstallations.orgId, args.orgId),
          args.teamsUserId
            ? eq(teamsOrgConnections.teamsUserId, args.teamsUserId)
            : undefined,
          args.teamsAadObjectId
            ? eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId)
            : undefined,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return winner
      ? { kind: "ok", ...winner }
      : { kind: "forbidden", message: identityConflictMessage };
  },
);

type TeamsEnvironment = NonNullable<TeamsConnectStatus["environment"]>;

interface ConnectedTeamsStatusFields {
  readonly defaultAgentName: string | null;
  readonly environment: TeamsEnvironment;
}

function emptyTeamsEnvironment(): TeamsEnvironment {
  return {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  };
}

function inactiveTeamsStatus(args: {
  readonly installation: TeamsInstallation | undefined;
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly linkedAccounts: NonNullable<TeamsConnectStatus["linkedAccounts"]>;
}): TeamsConnectStatus {
  return {
    linkedAccounts: args.linkedAccounts,
    pendingInstallation: Boolean(args.installation),
    isInstalled: false,
    isConnected: false,
    isAdmin: args.isAdmin,
    installUrl: buildTeamsInstallUrl(args.installation?.teamsTenantId),
    connectUrl: args.isAdmin
      ? buildTeamsOauthConnectUrl({
          orgId: args.orgId,
          userId: args.userId,
        })
      : null,
  };
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

function activeTeamsStatus(args: {
  readonly installation: TeamsInstallation;
  readonly connection: typeof teamsOrgConnections.$inferSelect | undefined;
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
  readonly connectedFields: ConnectedTeamsStatusFields | null;
  readonly linkedAccounts: NonNullable<TeamsConnectStatus["linkedAccounts"]>;
}): TeamsConnectStatus {
  const status: TeamsConnectStatus = {
    linkedAccounts: args.linkedAccounts,
    pendingInstallation: false,
    isInstalled: true,
    isConnected: Boolean(args.connection),
    isAdmin: args.isAdmin,
    installUrl: null,
    connectUrl: args.connection
      ? null
      : buildTeamsOauthConnectUrl({
          orgId: args.orgId,
          userId: args.userId,
        }),
    tenantId: args.installation.teamsTenantId,
    tenantName: args.installation.teamsTenantName,
    teamId: args.installation.teamsTeamId,
    teamName: args.installation.teamsTeamName,
    botName: teamsBotDisplayName(args.installation.botName),
    defaultAgentName: args.connectedFields?.defaultAgentName ?? null,
    ...teamsPermissionStatus({
      installation: args.installation,
      isAdmin: args.isAdmin,
    }),
  };
  if (!args.connectedFields) {
    return status;
  }
  return {
    ...status,
    environment: args.connectedFields.environment,
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
  const enabled$ = teamsWorkspaceIdentityEnabled(args$);
  const account$ = teamsAccountConnection(args$);
  return computed(async (get) => {
    const args = get(args$);
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (await get(enabled$)) {
      return independentTeamsStatus(args, await get(account$), installation);
    }

    const connections = installation
      ? await db
          .select()
          .from(teamsOrgConnections)
          .where(
            and(
              eq(teamsOrgConnections.userId, args.userId),
              eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId),
            ),
          )
      : [];
    const linkedAccounts = connections.map((connection) => {
      return {
        tenantId: connection.teamsTenantId,
        teamsUserId: connection.teamsUserId,
        teamsAadObjectId: connection.teamsAadObjectId,
        displayName: connection.teamsUserDisplayName,
        userPrincipalName: connection.teamsUserPrincipalName,
      };
    });
    if (!installation || !isTeamsInstallationActive(installation)) {
      return inactiveTeamsStatus({ ...args, installation, linkedAccounts });
    }
    const [connection] = connections;
    let connectedFields: ConnectedTeamsStatusFields | null = null;
    if (connection) {
      const [metadata] = await db
        .select({ defaultAgentId: orgMetadata.defaultAgentId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1);
      const composeId = metadata?.defaultAgentId ?? null;
      let defaultAgentName: string | null = null;
      if (composeId) {
        const [agent] = await db
          .select({ name: agents.name, displayName: agents.displayName })
          .from(agents)
          .where(eq(agents.id, composeId))
          .limit(1);
        defaultAgentName = agent?.displayName ?? agent?.name ?? null;
      }
      connectedFields = {
        defaultAgentName,
        environment: emptyTeamsEnvironment(),
      };
    }

    return activeTeamsStatus({
      ...args,
      installation,
      connection,
      connectedFields,
      linkedAccounts,
    });
  });
}

function installationMetadataPatch(args: {
  readonly tenantName?: string | null;
  readonly teamId?: string | null;
  readonly teamName?: string | null;
  readonly teamsAppId?: string | null;
  readonly botId?: string | null;
  readonly botName?: string | null;
  readonly serviceUrl?: string | null;
}): Partial<typeof teamsOrgInstallations.$inferInsert> {
  return {
    ...(nonEmpty(args.tenantName) ? { teamsTenantName: args.tenantName } : {}),
    ...(nonEmpty(args.teamId) ? { teamsTeamId: args.teamId } : {}),
    ...(nonEmpty(args.teamName) ? { teamsTeamName: args.teamName } : {}),
    ...(nonEmpty(args.teamsAppId) ? { teamsAppId: args.teamsAppId } : {}),
    ...(nonEmpty(args.botId) ? { botId: args.botId } : {}),
    ...(nonEmpty(args.botName) ? { botName: args.botName } : {}),
    ...(nonEmpty(args.serviceUrl) ? { serviceUrl: args.serviceUrl } : {}),
    updatedAt: nowDate(),
  };
}

type ConnectTeamsInstallationArgs = {
  readonly userId: string;
  readonly orgId: string;
  readonly orgRole: "admin" | "member";
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly teamsUserId?: string;
  readonly teamsAadObjectId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly serviceUrl?: string;
  readonly conversationId?: string;
  readonly conversationType?: string;
  readonly activityId?: string;
  readonly channelId?: string;
  readonly threadId?: string;
};

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
    readonly conversationId: string | undefined;
    readonly conversationType: string | undefined;
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

  return args.conversationType === "personal" ? args.conversationId : undefined;
}

const notifyTeamsConnect$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly installation: TeamsInstallation;
      readonly orgId: string;
      readonly tenantId: string;
      readonly serviceUrl: string | undefined;
      readonly conversationId: string | undefined;
      readonly conversationType: string | undefined;
      readonly teamsUserId: string | undefined;
      readonly teamsUserDisplayName: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [connection] = await writeDb
      .select({ dmWelcomeSent: teamsOrgConnections.dmWelcomeSent })
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
        teamsUserId: args.teamsUserId,
        teamsUserDisplayName: args.teamsUserDisplayName,
        botId: args.installation.botId,
        botName: args.installation.botName,
        conversationId: args.conversationId,
        conversationType: args.conversationType,
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

const finalizeTeamsConnection$ = command(
  async (
    { set },
    args: {
      readonly connectionId: string;
      readonly connectArgs: ConnectTeamsInstallationArgs;
      readonly installation: TeamsInstallation;
      readonly role: "admin" | "member";
    },
    signal: AbortSignal,
  ): Promise<Extract<TeamsConnectResult, { readonly kind: "ok" }>> => {
    const { connectArgs } = args;
    const connectionId = args.connectionId;

    await set(
      notifyTeamsConnect$,
      {
        connectionId,
        installation: args.installation,
        orgId: connectArgs.orgId,
        tenantId: connectArgs.tenantId,
        serviceUrl:
          connectArgs.serviceUrl ?? args.installation.serviceUrl ?? undefined,
        conversationId: connectArgs.conversationId,
        conversationType: connectArgs.conversationType,
        teamsUserId: connectArgs.teamsUserId,
        teamsUserDisplayName: connectArgs.teamsUserDisplayName,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      kind: "ok",
      connectionId,
      role: args.role,
      installation: args.installation,
    };
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

export const prepareTeamsInstallation$ = command(
  async (
    { set },
    args: ConnectTeamsInstallationArgs,
    signal: AbortSignal,
  ): Promise<TeamsPrepareInstallResult> => {
    if (args.orgRole !== "admin") {
      return { kind: "forbidden", message: adminRequiredMessage };
    }

    const writeDb = set(writeDb$);
    const [existingForOrg] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (existingForOrg && existingForOrg.teamsTenantId !== args.tenantId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }

    const [existingForTenant] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
      .limit(1);
    signal.throwIfAborted();

    if (existingForTenant?.orgId && existingForTenant.orgId !== args.orgId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }

    return set(persistTeamsBinding$, args, existingForTenant, signal);
  },
);

export const connectTeamsInstallation$ = command(
  async (
    { set },
    args: ConnectTeamsInstallationArgs,
    signal: AbortSignal,
  ): Promise<TeamsConnectResult> => {
    const writeDb = set(writeDb$);
    const [installation] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, args.tenantId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: installationNotFoundMessage };
    }

    if (installation.orgId === null && args.orgRole !== "admin") {
      return { kind: "forbidden", message: adminRequiredMessage };
    }
    if (installation.orgId !== null && installation.orgId !== args.orgId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }
    const bound = await set(persistTeamsBinding$, args, installation, signal);
    if (bound.kind === "forbidden") {
      return bound;
    }
    return set(
      finalizeTeamsConnection$,
      {
        connectionId: bound.connectionId,
        connectArgs: args,
        installation: bound.installation,
        role: args.orgRole,
      },
      signal,
    );
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
