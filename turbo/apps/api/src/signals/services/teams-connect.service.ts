import { command, computed, type Computed } from "ccstate";
import { guaranteedConnectorProvidedBindingNames } from "@okouai/api-contracts/contracts/connector-schemas";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { teamsUserAgentPreferences } from "@okouai/db/schema/teams-user-agent-preference";
import type { TeamsInboundActivity } from "@okouai/api-contracts/contracts/teams-bot";
import { and, eq, isNull, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { internalApiBaseUrl } from "../../lib/internal-api-url";
import { logger } from "../../lib/log";
import {
  OFFICIAL_TEAMS_PUBLIC_BRAND,
  teamsBotDisplayName,
} from "../../lib/teams-official-app";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import {
  createTeamsPersonalConversation,
  sendTeamsMessageReply,
  type TeamsAdaptiveCard,
} from "../external/teams-bot-client";
import { nowDate } from "../../lib/time";
import { userConfiguredAgentEnvironmentRequirements } from "./agent-execution-config";
import { builtinConnectorList } from "./connector-data.service";
import { userSecrets, userVariables } from "./user-data.service";

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
  return `${env("APP_URL")}/settings/teams?${params.toString()}`;
}

function buildTeamsOauthConnectUrl(args: {
  readonly orgId: string;
  readonly userId: string;
}): string {
  const url = new URL("/api/teams/oauth/connect", internalApiBaseUrl());
  url.searchParams.set("orgId", args.orgId);
  url.searchParams.set("userId", args.userId);
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

async function upsertTeamsConnection(
  writeDb: Db,
  args: {
    readonly teamsUserId?: string;
    readonly teamsAadObjectId?: string;
    readonly teamsTenantId: string;
    readonly userId: string;
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
  },
): Promise<string> {
  if (!args.teamsUserId && !args.teamsAadObjectId) {
    throw new Error("Teams connection requires a Teams user identity");
  }

  if (args.teamsAadObjectId) {
    const [existingByAad] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId),
          eq(teamsOrgConnections.teamsTenantId, args.teamsTenantId),
        ),
      )
      .limit(1);

    if (existingByAad) {
      if (args.teamsUserId) {
        await writeDb
          .update(teamsOrgConnections)
          .set({
            teamsUserId: args.teamsUserId,
            teamsUserDisplayName: args.teamsUserDisplayName,
            teamsUserPrincipalName: args.teamsUserPrincipalName,
            updatedAt: nowDate(),
          })
          .where(eq(teamsOrgConnections.id, existingByAad.id));
      }
      return existingByAad.id;
    }
  }

  if (args.teamsUserId) {
    const [existingByTeamsUser] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
          eq(teamsOrgConnections.teamsTenantId, args.teamsTenantId),
        ),
      )
      .limit(1);

    if (existingByTeamsUser) {
      await writeDb
        .update(teamsOrgConnections)
        .set({
          teamsAadObjectId: args.teamsAadObjectId,
          teamsUserDisplayName: args.teamsUserDisplayName,
          teamsUserPrincipalName: args.teamsUserPrincipalName,
          updatedAt: nowDate(),
        })
        .where(eq(teamsOrgConnections.id, existingByTeamsUser.id));
      return existingByTeamsUser.id;
    }
  }

  const [connection] = await writeDb
    .insert(teamsOrgConnections)
    .values({
      teamsUserId: args.teamsUserId,
      teamsAadObjectId: args.teamsAadObjectId,
      teamsTenantId: args.teamsTenantId,
      userId: args.userId,
      teamsUserDisplayName: args.teamsUserDisplayName,
      teamsUserPrincipalName: args.teamsUserPrincipalName,
    })
    .onConflictDoNothing()
    .returning({ id: teamsOrgConnections.id });

  if (connection) {
    return connection.id;
  }

  if (args.teamsAadObjectId) {
    const [existingByAad] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId),
          eq(teamsOrgConnections.teamsTenantId, args.teamsTenantId),
        ),
      )
      .limit(1);
    if (existingByAad) {
      return existingByAad.id;
    }
  }

  if (args.teamsUserId) {
    const [existingByTeamsUser] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
          eq(teamsOrgConnections.teamsTenantId, args.teamsTenantId),
        ),
      )
      .limit(1);
    if (existingByTeamsUser) {
      return existingByTeamsUser.id;
    }
  }

  throw new Error("Teams connection upsert did not return a row");
}

async function resolveDefaultComposeId(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: ReadonlyDb,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedAgentId: teamsUserAgentPreferences.selectedAgentId })
    .from(teamsUserAgentPreferences)
    .where(
      and(
        eq(teamsUserAgentPreferences.userId, userId),
        eq(teamsUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedAgentId ?? null;
}

async function resolveEffectiveComposeId(
  db: ReadonlyDb,
  userId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(db, userId, orgId);
  if (override) {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, override), eq(agents.orgId, orgId)))
      .limit(1);
    if (agent?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(db, orgId);
}

async function getTeamsAgentName(
  db: ReadonlyDb,
  composeId: string,
): Promise<string | undefined> {
  const [agent] = await db
    .select({ name: agents.name, displayName: agents.displayName })
    .from(agents)
    .where(eq(agents.id, composeId))
    .limit(1);
  return agent?.displayName ?? agent?.name;
}

interface TeamsEnvironment {
  readonly requiredSecrets: readonly string[];
  readonly requiredVars: readonly string[];
  readonly missingSecrets: readonly string[];
  readonly missingVars: readonly string[];
}

type ConnectorProvidedBindings = Parameters<
  typeof guaranteedConnectorProvidedBindingNames
>[0]["bindings"];

interface ConnectedTeamsStatusFields {
  readonly defaultAgentName: string | null;
  readonly environment: TeamsEnvironment;
}

interface TeamsConnectStatus {
  readonly isInstalled: boolean;
  readonly isConnected: boolean;
  readonly isAdmin: boolean;
  readonly installUrl?: string | null;
  readonly connectUrl?: string | null;
  readonly tenantId?: string | null;
  readonly tenantName?: string | null;
  readonly teamId?: string | null;
  readonly teamName?: string | null;
  readonly botName?: string | null;
  readonly defaultAgentName?: string | null;
  readonly permissionMismatch?: boolean | null;
  readonly reinstallUrl?: string | null;
  readonly environment?: TeamsEnvironment;
}

function emptyTeamsEnvironment(): TeamsEnvironment {
  return {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  };
}

async function resolveTeamsEnvironment(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly loadUserSecretNames: () => Promise<readonly string[]>;
  readonly loadUserVarNames: () => Promise<readonly string[]>;
  readonly loadConnectorBindings: () => Promise<ConnectorProvidedBindings>;
}): Promise<TeamsEnvironment> {
  const [meta] = await args.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);

  if (!meta?.defaultAgentId) {
    return emptyTeamsEnvironment();
  }

  const [agent] = await args.db
    .select({ name: agents.name })
    .from(agents)
    .where(
      and(eq(agents.id, meta.defaultAgentId), eq(agents.orgId, args.orgId)),
    )
    .limit(1);

  if (!agent) {
    return emptyTeamsEnvironment();
  }

  const { secrets: requiredSecrets, vars: requiredVars } =
    userConfiguredAgentEnvironmentRequirements(agent.name);
  const [userSecretNames, userVarNames, connectorBindings] = await Promise.all([
    args.loadUserSecretNames(),
    args.loadUserVarNames(),
    args.loadConnectorBindings(),
  ]);
  const existingSecretNames = new Set([
    ...userSecretNames,
    ...guaranteedConnectorProvidedBindingNames({
      bindings: connectorBindings,
      namespace: "secrets",
    }),
  ]);
  const existingVarNames = new Set([
    ...userVarNames,
    ...guaranteedConnectorProvidedBindingNames({
      bindings: connectorBindings,
      namespace: "vars",
    }),
  ]);

  return {
    requiredSecrets,
    requiredVars,
    missingSecrets: requiredSecrets.filter((name) => {
      return !existingSecretNames.has(name);
    }),
    missingVars: requiredVars.filter((name) => {
      return !existingVarNames.has(name);
    }),
  };
}

async function resolveConnectedStatusFields(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly loadUserSecretNames: () => Promise<readonly string[]>;
  readonly loadUserVarNames: () => Promise<readonly string[]>;
  readonly loadConnectorBindings: () => Promise<ConnectorProvidedBindings>;
}): Promise<ConnectedTeamsStatusFields> {
  const composeId = await resolveEffectiveComposeId(
    args.db,
    args.userId,
    args.orgId,
  );
  const environment = await resolveTeamsEnvironment(args);
  return {
    defaultAgentName: composeId
      ? ((await getTeamsAgentName(args.db, composeId)) ?? null)
      : null,
    environment,
  };
}

async function teamsConnectionForStatus(args: {
  readonly db: ReadonlyDb;
  readonly userId: string;
  readonly tenantId: string;
}): Promise<typeof teamsOrgConnections.$inferSelect | undefined> {
  const [connection] = await args.db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.userId, args.userId),
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
      ),
    )
    .limit(1);
  return connection;
}

function inactiveTeamsStatus(args: {
  readonly installation: TeamsInstallation | undefined;
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}): TeamsConnectStatus {
  return {
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
  readonly permissionMismatch?: boolean | null;
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
}): TeamsConnectStatus {
  const status: TeamsConnectStatus = {
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

export function teamsConnectStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly isAdmin: boolean;
}): Computed<Promise<TeamsConnectStatus>> {
  return computed(async (get) => {
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (!installation || !isTeamsInstallationActive(installation)) {
      return inactiveTeamsStatus({ ...args, installation });
    }

    const connection = await teamsConnectionForStatus({
      db,
      userId: args.userId,
      tenantId: installation.teamsTenantId,
    });
    const connectedFields = connection
      ? await resolveConnectedStatusFields({
          db,
          orgId: args.orgId,
          userId: args.userId,
          loadUserSecretNames: async () => {
            const list = await get(
              userSecrets({ orgId: args.orgId, userId: args.userId }),
            );
            return list.secrets.map((secret) => {
              return secret.name;
            });
          },
          loadUserVarNames: async () => {
            const list = await get(
              userVariables({ orgId: args.orgId, userId: args.userId }),
            );
            return list.variables.map((variable) => {
              return variable.name;
            });
          },
          loadConnectorBindings: async () => {
            const connectors = await get(
              builtinConnectorList({ orgId: args.orgId, userId: args.userId }),
            );
            return connectors.connectorProvidedBindings;
          },
        })
      : null;

    return activeTeamsStatus({
      ...args,
      installation,
      connection,
      connectedFields,
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
    publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
    updatedAt: nowDate(),
  };
}

async function updateTeamsInstallationMetadata(
  writeDb: Db,
  tenantId: string,
  args: Parameters<typeof installationMetadataPatch>[0],
): Promise<void> {
  const patch = installationMetadataPatch(args);
  await writeDb
    .update(teamsOrgInstallations)
    .set(patch)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId));
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

type BindTeamsInstallationResult =
  | { readonly kind: "bound"; readonly installation: TeamsInstallation }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string };

function buildTeamsWelcomeCard(
  installation: TeamsInstallation,
): TeamsAdaptiveCard {
  const { assistantName } = PUBLIC_BRAND_PRESENTATION;
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

async function notifyTeamsConnect(
  args: {
    readonly db: Db;
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
): Promise<void> {
  const [connection] = await args.db
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
      text: `You're connected to ${PUBLIC_BRAND_PRESENTATION.assistantName}!`,
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

  await args.db
    .update(teamsOrgConnections)
    .set({ dmWelcomeSent: true, updatedAt: nowDate() })
    .where(eq(teamsOrgConnections.id, args.connectionId));
  signal.throwIfAborted();
}

async function bindUnclaimedTeamsInstallation(
  args: {
    readonly db: Db;
    readonly connectArgs: ConnectTeamsInstallationArgs;
  },
  signal: AbortSignal,
): Promise<BindTeamsInstallationResult> {
  const [updated] = await args.db
    .update(teamsOrgInstallations)
    .set({
      orgId: args.connectArgs.orgId,
      installedByUserId: args.connectArgs.userId,
      publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(teamsOrgInstallations.teamsTenantId, args.connectArgs.tenantId),
        isNull(teamsOrgInstallations.orgId),
      ),
    )
    .returning();
  signal.throwIfAborted();

  if (updated) {
    return { kind: "bound", installation: updated };
  }

  const [existing] = await args.db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, args.connectArgs.tenantId))
    .limit(1);
  signal.throwIfAborted();
  if (!existing) {
    return { kind: "not_found", message: installationNotFoundMessage };
  }
  if (existing.orgId !== args.connectArgs.orgId) {
    return { kind: "forbidden", message: orgMismatchMessage };
  }
  return { kind: "bound", installation: existing };
}

async function finalizeTeamsConnection(
  args: {
    readonly db: Db;
    readonly connectArgs: ConnectTeamsInstallationArgs;
    readonly installation: TeamsInstallation;
    readonly role: "admin" | "member";
  },
  signal: AbortSignal,
): Promise<Extract<TeamsConnectResult, { readonly kind: "ok" }>> {
  const { connectArgs } = args;
  const connectionId = await upsertTeamsConnection(args.db, {
    teamsUserId: connectArgs.teamsUserId,
    teamsAadObjectId: connectArgs.teamsAadObjectId,
    teamsTenantId: connectArgs.tenantId,
    userId: connectArgs.userId,
    teamsUserDisplayName: connectArgs.teamsUserDisplayName,
    teamsUserPrincipalName: connectArgs.teamsUserPrincipalName,
  });
  signal.throwIfAborted();

  await notifyTeamsConnect(
    {
      db: args.db,
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
}

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

    const [installation] = await writeDb
      .insert(teamsOrgInstallations)
      .values({
        teamsTenantId: args.tenantId,
        teamsTenantName: args.tenantName,
        orgId: args.orgId,
        installedByUserId: args.userId,
        publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
      })
      .onConflictDoUpdate({
        target: teamsOrgInstallations.teamsTenantId,
        set: {
          orgId: args.orgId,
          teamsTenantName: sql`coalesce(excluded.teams_tenant_name, ${teamsOrgInstallations.teamsTenantName})`,
          installedByUserId: args.userId,
          publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
          updatedAt: nowDate(),
        },
      })
      .returning();
    signal.throwIfAborted();

    if (!installation) {
      throw new Error("Failed to prepare Teams installation");
    }

    const connectionId = await upsertTeamsConnection(writeDb, {
      teamsUserId: args.teamsUserId,
      teamsAadObjectId: args.teamsAadObjectId,
      teamsTenantId: args.tenantId,
      userId: args.userId,
      teamsUserDisplayName: args.teamsUserDisplayName,
      teamsUserPrincipalName: args.teamsUserPrincipalName,
    });
    signal.throwIfAborted();

    return { kind: "ok", connectionId, installation };
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

    if (installation.orgId === null) {
      if (args.orgRole !== "admin") {
        return { kind: "forbidden", message: adminRequiredMessage };
      }

      await updateTeamsInstallationMetadata(writeDb, args.tenantId, {
        tenantName: args.tenantName,
        teamId: args.teamId,
        teamName: args.teamName,
        serviceUrl: args.serviceUrl,
      });
      signal.throwIfAborted();

      const bindResult = await bindUnclaimedTeamsInstallation(
        {
          db: writeDb,
          connectArgs: args,
        },
        signal,
      );
      if (bindResult.kind !== "bound") {
        return bindResult;
      }

      return finalizeTeamsConnection(
        {
          db: writeDb,
          connectArgs: args,
          installation: bindResult.installation,
          role: "admin",
        },
        signal,
      );
    }

    if (installation.orgId !== args.orgId) {
      return { kind: "forbidden", message: orgMismatchMessage };
    }

    await updateTeamsInstallationMetadata(writeDb, args.tenantId, {
      tenantName: args.tenantName,
      teamId: args.teamId,
      teamName: args.teamName,
      serviceUrl: args.serviceUrl,
    });
    signal.throwIfAborted();

    return finalizeTeamsConnection(
      {
        db: writeDb,
        connectArgs: args,
        installation: {
          ...installation,
          publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
        },
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
    const [installation] = await writeDb
      .select()
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      return { kind: "not_found", message: connectionNotFoundMessage };
    }

    const [connection] = await writeDb
      .select({ id: teamsOrgConnections.id })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.userId, args.userId),
          eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connection) {
      return { kind: "not_found", message: connectionNotFoundMessage };
    }

    await writeDb
      .delete(teamsOrgConnections)
      .where(eq(teamsOrgConnections.id, connection.id));
    signal.throwIfAborted();

    return { kind: "ok", orgId: args.orgId, userId: args.userId };
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

    await writeDb
      .delete(teamsOrgConnections)
      .where(eq(teamsOrgConnections.teamsTenantId, installation.teamsTenantId));
    signal.throwIfAborted();

    await writeDb
      .delete(teamsUserAgentPreferences)
      .where(eq(teamsUserAgentPreferences.orgId, args.orgId));
    signal.throwIfAborted();

    await writeDb
      .delete(teamsOrgInstallations)
      .where(
        eq(teamsOrgInstallations.teamsTenantId, installation.teamsTenantId),
      );
    signal.throwIfAborted();

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

      await writeDb
        .delete(teamsOrgConnections)
        .where(eq(teamsOrgConnections.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

      if (installation.orgId) {
        await writeDb
          .delete(teamsUserAgentPreferences)
          .where(eq(teamsUserAgentPreferences.orgId, installation.orgId));
        signal.throwIfAborted();
      }

      await writeDb
        .delete(teamsOrgInstallations)
        .where(eq(teamsOrgInstallations.teamsTenantId, activity.tenantId));
      signal.throwIfAborted();

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
        publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
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
          publicBrand: OFFICIAL_TEAMS_PUBLIC_BRAND,
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
