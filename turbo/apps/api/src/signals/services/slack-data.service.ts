import { computed, type Computed } from "ccstate";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import type { ApiOrgRole } from "../../types/auth";
import { createUserFeatureSwitchContext } from "./feature-switches.service";
import {
  userFeatureSwitchOverridesFromRows,
  userFeatureSwitchRowCondition,
} from "./feature-switch-scope";
import { buildSlackConnectorOAuthStartUrl } from "./slack-connector-oauth-state";
import { createSlackClient } from "../external/slack-message-client";
import {
  slackAccountConnection,
  slackWorkspaceIdentityEnabled,
} from "./slack-workspace-identity.service";

export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:read",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
  "links:read",
  "links:write",
];

function hasAllBotScopes(storedScopes: string | null): boolean {
  if (storedScopes === null) {
    return false;
  }
  const parsed: unknown = JSON.parse(storedScopes);
  const scopes: string[] = Array.isArray(parsed) ? parsed : [];
  const stored = new Set(scopes);
  return SLACK_BOT_SCOPES.every((s) => {
    return stored.has(s);
  });
}

function buildSlackInstallUrl(args: {
  readonly apiOrigin: string;
  readonly orgId: string;
  readonly userId: string;
  readonly reinstall: boolean;
  readonly workspaceId?: string;
}): string | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  return buildSlackConnectorOAuthStartUrl(args.apiOrigin, {
    flow: "install",
    orgId: args.orgId,
    userId: args.userId,
    reinstall: args.reinstall,
    workspaceId: args.workspaceId,
  });
}

function buildSlackConnectUrl(args: {
  readonly apiOrigin: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId?: string;
}): string | null {
  const clientId = env("SLACK_OAUTH_CLIENT_ID");
  if (!clientId) {
    return null;
  }
  return buildSlackConnectorOAuthStartUrl(args.apiOrigin, {
    flow: "connect",
    orgId: args.orgId,
    userId: args.userId,
    workspaceId: args.workspaceId,
  });
}

interface SlackOrgStatusResult {
  readonly isConnected: boolean;
  readonly isInstalled: boolean;
  readonly isAdmin: boolean;
  readonly workspaceName: string | null;
  readonly installUrl: string | null;
  readonly connectUrl: string | null;
  readonly defaultAgentName: string | null;
  readonly scopeMismatch: boolean | null;
  readonly reinstallUrl: string | null;
}

interface SlackStatusArgs {
  readonly apiOrigin: string;
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
}

function slackScopeStatus(
  args: SlackStatusArgs,
  installationRow: typeof slackOrgInstallations.$inferSelect,
): { scopeMismatch: boolean | null; reinstallUrl: string | null } {
  if (args.orgRole !== "admin") {
    return { scopeMismatch: null, reinstallUrl: null };
  }
  const scopeMismatch = !hasAllBotScopes(installationRow.botScopes);
  const reinstallUrl = scopeMismatch
    ? buildSlackInstallUrl({
        apiOrigin: args.apiOrigin,
        orgId: args.orgId,
        userId: args.userId,
        reinstall: true,
        workspaceId: installationRow.slackWorkspaceId,
      })
    : null;
  return { scopeMismatch, reinstallUrl };
}

function slackDefaultAgentName(args$: Computed<SlackStatusArgs>) {
  return computed(async (get) => {
    const args = get(args$);
    const db = get(db$);
    let defaultAgentName: string | null = null;

    const [orgMeta] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);

    if (orgMeta?.defaultAgentId) {
      const [agent] = await db
        .select({
          displayName: agents.displayName,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.id, orgMeta.defaultAgentId))
        .limit(1);
      defaultAgentName = agent?.displayName ?? agent?.name ?? null;
    }
    return defaultAgentName;
  });
}

function slackAccountStatus(
  args: SlackStatusArgs,
  account:
    | {
        readonly connection: typeof slackOrgConnections.$inferSelect;
        readonly installation: typeof slackOrgInstallations.$inferSelect | null;
      }
    | undefined,
  installation: typeof slackOrgInstallations.$inferSelect | undefined,
  defaultAgentName: string | null,
): SlackOrgStatusResult {
  const isAdmin = args.orgRole === "admin";
  const ownInstallation = account?.installation;
  return {
    isConnected: Boolean(account),
    isInstalled: Boolean(account ? ownInstallation : installation),
    isAdmin,
    workspaceName:
      account?.connection.slackWorkspaceName ??
      ownInstallation?.slackWorkspaceName ??
      null,
    defaultAgentName,
    installUrl:
      isAdmin && !ownInstallation
        ? buildSlackInstallUrl({
            apiOrigin: args.apiOrigin,
            orgId: args.orgId,
            userId: args.userId,
            reinstall: false,
            workspaceId: account?.connection.slackWorkspaceId,
          })
        : null,
    connectUrl: account
      ? null
      : buildSlackConnectUrl({
          apiOrigin: args.apiOrigin,
          orgId: args.orgId,
          userId: args.userId,
        }),
    ...(ownInstallation?.orgId === args.orgId
      ? slackScopeStatus(args, ownInstallation)
      : { scopeMismatch: null, reinstallUrl: null }),
  };
}

export function slackOrgStatus(
  args$: Computed<{
    readonly apiOrigin: string;
    readonly orgId: string;
    readonly userId: string;
    readonly orgRole?: ApiOrgRole;
  }>,
): Computed<Promise<SlackOrgStatusResult>> {
  const identity$ = computed((get) => {
    const args = get(args$);
    return { orgId: args.orgId, userId: args.userId };
  });
  const accountEnabled$ = slackWorkspaceIdentityEnabled(identity$);
  const account$ = slackAccountConnection(identity$);
  const defaultAgentName$ = slackDefaultAgentName(args$);
  return computed(async (get) => {
    const args = get(args$);
    const db = get(db$);

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    const isAdmin = args.orgRole === "admin";
    const defaultAgentName =
      installation || (await get(accountEnabled$))
        ? await get(defaultAgentName$)
        : null;

    if (await get(accountEnabled$)) {
      return slackAccountStatus(
        args,
        await get(account$),
        installation,
        defaultAgentName,
      );
    }

    if (!installation) {
      const installUrl = isAdmin
        ? buildSlackInstallUrl({
            apiOrigin: args.apiOrigin,
            orgId: args.orgId,
            userId: args.userId,
            reinstall: false,
          })
        : null;
      return {
        isConnected: false,
        isInstalled: false,
        isAdmin,
        workspaceName: null,
        installUrl,
        connectUrl: null,
        defaultAgentName,
        scopeMismatch: null,
        reinstallUrl: null,
      };
    }

    const [connection] = await db
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      )
      .limit(1);

    if (!connection) {
      const scopeFields = slackScopeStatus(args, installation);
      const connectUrl = buildSlackConnectUrl({
        apiOrigin: args.apiOrigin,
        orgId: args.orgId,
        userId: args.userId,
        workspaceId: installation.slackWorkspaceId,
      });

      return {
        isConnected: false,
        isInstalled: true,
        isAdmin,
        workspaceName: installation.slackWorkspaceName ?? null,
        installUrl: null,
        connectUrl,
        defaultAgentName,
        ...scopeFields,
      };
    }

    const scopeFields = slackScopeStatus(args, installation);

    return {
      isConnected: true,
      isInstalled: true,
      isAdmin,
      workspaceName: installation.slackWorkspaceName ?? null,
      installUrl: null,
      connectUrl: null,
      defaultAgentName,
      ...scopeFields,
    };
  });
}

export function slackOrgInstallation(
  input$: Computed<{
    readonly orgId: string;
    readonly userId?: string;
  }>,
): Computed<
  Promise<{
    readonly workspaceId: string;
    readonly botToken: string;
    readonly workspaceName: string | null;
  } | null>
> {
  const identity$ = computed((get) => {
    const args = get(input$);
    return { orgId: args.orgId, userId: args.userId ?? "" };
  });
  const account$ = slackAccountConnection(identity$);
  const accountEnabled$ = slackWorkspaceIdentityEnabled(identity$);
  const overrides$ = computed(async (get) => {
    const { orgId, userId } = get(input$);
    if (!userId) {
      return undefined;
    }
    const db = get(db$);
    const rows = await db
      .select({
        userId: userFeatureSwitches.userId,
        switches: userFeatureSwitches.switches,
      })
      .from(userFeatureSwitches)
      .where(userFeatureSwitchRowCondition(orgId, userId));
    return userFeatureSwitchOverridesFromRows(rows, userId);
  });
  const featureContext$ = computed(
    async (get): Promise<FeatureSwitchContext> => {
      const { orgId, userId } = get(input$);
      if (!userId) {
        return { orgId };
      }
      return { orgId, userId, overrides: await get(overrides$) };
    },
  );

  return computed(async (get) => {
    const args = get(input$);
    const db = get(db$);

    if (args.userId && (await get(accountEnabled$))) {
      const account = await get(account$);
      const installation = account?.installation;
      if (!account || !installation) {
        return null;
      }
      const botToken = await decryptPersistentSecretValue(
        installation.encryptedBotToken,
        installation.orgId ? { orgId: installation.orgId } : {},
      );
      const member = await createSlackClient(botToken).fetchUserIdentity(
        account.connection.slackUserId,
      );
      if (
        !member ||
        member.deleted ||
        member.isBot ||
        member.teamId !== account.connection.slackWorkspaceId
      ) {
        return null;
      }
      return {
        workspaceId: installation.slackWorkspaceId,
        botToken,
        workspaceName: installation.slackWorkspaceName,
      };
    }

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    if (!installation) {
      return null;
    }

    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      args.userId ? await get(featureContext$) : { orgId: args.orgId },
    );

    return {
      workspaceId: installation.slackWorkspaceId,
      botToken,
      workspaceName: installation.slackWorkspaceName ?? null,
    };
  });
}

export function slackUserInstallation(
  input$: Computed<{
    readonly orgId: string;
    readonly userId: string;
  }>,
): Computed<
  Promise<
    | {
        readonly kind: "connected";
        readonly workspaceId: string;
        readonly botToken: string;
        readonly workspaceName: string | null;
        readonly slackUserId: string;
      }
    | { readonly kind: "not-installed" }
    | { readonly kind: "not-connected" }
  >
> {
  const identity$ = computed((get) => {
    return Promise.resolve(get(input$));
  });
  const featureContext$ = createUserFeatureSwitchContext(identity$);
  const account$ = slackAccountConnection(identity$);
  const accountEnabled$ = slackWorkspaceIdentityEnabled(identity$);
  const accountInstallation$ = slackOrgInstallation(input$);

  return computed(async (get) => {
    const args = get(input$);
    const db = get(db$);

    if (await get(accountEnabled$)) {
      const account = await get(account$);
      if (!account) {
        return { kind: "not-connected" } as const;
      }
      if (!account.installation) {
        return { kind: "not-installed" } as const;
      }
      const installation = await get(accountInstallation$);
      if (!installation) {
        return { kind: "not-connected" } as const;
      }
      return {
        kind: "connected",
        ...installation,
        slackUserId: account.connection.slackUserId,
      } as const;
    }

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);
    if (!installation) {
      return { kind: "not-installed" } as const;
    }

    const [connection] = await db
      .select({ slackUserId: slackOrgConnections.slackUserId })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.userId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      )
      .limit(1);
    if (!connection) {
      return { kind: "not-connected" } as const;
    }

    const botToken = await decryptPersistentSecretValue(
      installation.encryptedBotToken,
      await get(featureContext$),
    );
    return {
      kind: "connected",
      workspaceId: installation.slackWorkspaceId,
      botToken,
      workspaceName: installation.slackWorkspaceName ?? null,
      slackUserId: connection.slackUserId,
    } as const;
  });
}
