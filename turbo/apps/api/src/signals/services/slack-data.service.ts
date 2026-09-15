import { computed, type Computed } from "ccstate";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { decryptPersistentSecretValue } from "./crypto.utils";
import type { ApiOrgRole } from "../../types/auth";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { buildSlackConnectorOAuthStartUrl } from "./slack-connector-oauth-state";

export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read",
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
  readonly workspaceId: string;
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

export function slackOrgStatus(args: {
  readonly apiOrigin: string;
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: ApiOrgRole;
}): Computed<Promise<SlackOrgStatusResult>> {
  return computed(async (get) => {
    const db = get(db$);

    const [installation] = await db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, args.orgId))
      .limit(1);

    const isAdmin = args.orgRole === "admin";
    let defaultAgentName: string | null = null;

    if (installation) {
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
    }

    function computeScopeFields(
      installationRow: typeof slackOrgInstallations.$inferSelect,
    ): { scopeMismatch: boolean | null; reinstallUrl: string | null } {
      if (!isAdmin) {
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
      const scopeFields = computeScopeFields(installation);
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

    const scopeFields = computeScopeFields(installation);

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

export function slackOrgInstallation(args: {
  readonly orgId: string;
  readonly userId?: string;
}): Computed<
  Promise<{
    readonly workspaceId: string;
    readonly botToken: string;
    readonly workspaceName: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);

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
      args.userId
        ? await get(userFeatureSwitchContext(args.orgId, args.userId))
        : { orgId: args.orgId },
    );

    return {
      workspaceId: installation.slackWorkspaceId,
      botToken,
      workspaceName: installation.slackWorkspaceName ?? null,
    };
  });
}

export function slackUserInstallation(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
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
  return computed(async (get) => {
    const db = get(db$);
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
      await get(userFeatureSwitchContext(args.orgId, args.userId)),
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
