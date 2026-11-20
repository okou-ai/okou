import { command, computed } from "ccstate";
import type {
  GithubConnectUserBody,
  GithubInstallationResponse,
} from "@okouai/api-contracts/contracts/integrations-github";
import { connectors } from "@okouai/db/schema/connector";
import { githubInstallations } from "@okouai/db/schema/github-installation";
import { githubUserLinks } from "@okouai/db/schema/github-user-link";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { env, optionalEnv } from "../../lib/env";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import {
  buildGithubAppInstallUrl$,
  startGithubUserOAuth$,
  findGithubInstallationByInstallationId$,
  getGithubOAuthAuthMethod,
  linkGithubUser$,
  verifyGithubConnectSignature,
} from "./github-oauth.service";
import { readConnectorResolver$ } from "./connector-action-resolver.service";

function errorResponse(status: 400 | 404 | 409, message: string, code: string) {
  return { status, body: { error: { message, code } } };
}

function githubConnectStartUrl(origin: string): string {
  return new URL("/api/github/oauth/connect", origin).toString();
}

const githubInstallUrl$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly callbackOrigin: string;
      readonly providerCallbackOrigin: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const appSlug = optionalEnv("GITHUB_APP_SLUG");
    if (!appSlug) {
      return null;
    }

    const db = get(db$);
    const [orgRow] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();
    const composeId = orgRow?.defaultAgentId ?? null;

    return await set(
      buildGithubAppInstallUrl$,
      {
        appSlug,
        userId: args.userId,
        orgId: args.orgId,
        composeId: composeId ?? undefined,
        callbackOrigin: args.callbackOrigin,
        providerCallbackOrigin: args.providerCallbackOrigin,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      },
      signal,
    );
  },
);

async function publishGithubChanged(userIds: readonly string[]): Promise<void> {
  const uniqueUserIds = Array.from(new Set(userIds));
  if (uniqueUserIds.length === 0) {
    return;
  }

  await publishUserSignal(uniqueUserIds, "github:changed");
}

type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;

interface GitHubUserLinkRecord {
  readonly githubUserId: string;
}

function canManageInstallation(args: {
  readonly orgRole: string | undefined;
}): boolean {
  return args.orgRole === "admin";
}

const orgGithubInstallation$ = computed(
  async (get): Promise<GitHubInstallationRecord | null> => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.orgId, auth.orgId),
          eq(githubInstallations.status, "active"),
        ),
      )
      .limit(1);

    return installation ?? null;
  },
);

const userGithubLink$ = computed(
  async (get): Promise<GitHubUserLinkRecord | null> => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const installation = await get(orgGithubInstallation$);
    if (!installation) {
      return null;
    }
    const [link] = await db
      .select({ githubUserId: githubUserLinks.githubUserId })
      .from(githubUserLinks)
      .where(
        and(
          eq(githubUserLinks.installationId, installation.id),
          eq(githubUserLinks.userId, auth.userId),
        ),
      )
      .limit(1);

    return link ?? null;
  },
);

const userGithubConnectorUsername$ = computed(
  async (get): Promise<string | null> => {
    const auth = get(organizationAuthContext$);
    const db = get(db$);
    const link = await get(userGithubLink$);
    if (!link) {
      return null;
    }
    const [connector] = await db
      .select({ externalUsername: connectors.externalUsername })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, auth.orgId),
          eq(connectors.userId, auth.userId),
          eq(connectors.connectorSlug, "github"),
          eq(connectors.isDefault, true),
          eq(connectors.externalId, link.githubUserId),
        ),
      )
      .limit(1);

    return connector?.externalUsername ?? null;
  },
);

export const connectGithubUser$ = command(
  async ({ get, set }, body: GithubConnectUserBody, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    set(writeDb$);
    const connectSignature = body?.connectSignature;
    if (
      connectSignature &&
      !verifyGithubConnectSignature({
        installationId: connectSignature.installationId,
        githubUserId: connectSignature.githubUserId,
        githubUsername: connectSignature.githubUsername,
        timestamp: connectSignature.timestamp,
        signature: connectSignature.signature,
        secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
      })
    ) {
      return errorResponse(
        400,
        "Invalid or expired GitHub connect link",
        "INVALID_CONNECT_LINK",
      );
    }

    const installation = connectSignature
      ? await set(
          findGithubInstallationByInstallationId$,
          {
            installationId: connectSignature.installationId,
            orgId: auth.orgId,
          },
          signal,
        )
      : await get(orgGithubInstallation$);
    signal.throwIfAborted();

    if (!installation) {
      return errorResponse(404, "No GitHub installation found", "NOT_FOUND");
    }

    const githubUserId = await set(
      linkGithubUser$,
      {
        installRecordId: installation.id,
        userId: auth.userId,
        knownGithubUserId: connectSignature?.githubUserId,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!githubUserId) {
      return connectSignature
        ? errorResponse(
            409,
            "This GitHub account is already linked to the installation",
            "GITHUB_ACCOUNT_ALREADY_LINKED",
          )
        : errorResponse(
            409,
            "Connect your GitHub account before linking this installation",
            "GITHUB_ACCOUNT_REQUIRED",
          );
    }

    await publishGithubChanged([auth.userId]);
    signal.throwIfAborted();

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const getGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const apiOrigin = getOAuthApiOrigin(get(request$).raw);
    const callbackOrigin = apiOrigin;
    const providerCallbackOrigin = apiOrigin;
    set(writeDb$);
    const installation = await get(orgGithubInstallation$);
    signal.throwIfAborted();

    if (!installation) {
      const installUrl = canManageInstallation({ orgRole: auth.orgRole })
        ? await set(
            githubInstallUrl$,
            {
              userId: auth.userId,
              orgId: auth.orgId,
              callbackOrigin,
              providerCallbackOrigin,
            },
            signal,
          )
        : null;
      signal.throwIfAborted();

      return {
        status: 404 as const,
        body: {
          error: {
            message: "No GitHub installation found",
            code: "NOT_FOUND",
          },
          installUrl,
        },
      };
    }

    const link = await get(userGithubLink$);
    signal.throwIfAborted();

    const connectedGithubUsername =
      link === null ? null : await get(userGithubConnectorUsername$);
    signal.throwIfAborted();

    const resolver = await set(readConnectorResolver$, ["github"]);
    signal.throwIfAborted();
    const resolvedMethod = await resolver.resolveNewActionMethod({
      connectorSlug: "github",
      authMethodId: getGithubOAuthAuthMethod(),
      expectedGrantKind: "auth-code",
    });
    signal.throwIfAborted();
    const connectUrl =
      link === null && resolvedMethod.ok
        ? ((await set(
            startGithubUserOAuth$,
            {
              userId: auth.userId,
              orgId: auth.orgId,
              origin: callbackOrigin,
              authMethodId: resolvedMethod.authMethodId,
              method: resolvedMethod.method,
              readEnv: optionalEnv,
            },
            signal,
          )) ?? githubConnectStartUrl(callbackOrigin))
        : githubConnectStartUrl(callbackOrigin);
    signal.throwIfAborted();

    const body: GithubInstallationResponse = {
      installation: {
        id: installation.id,
        installationId: installation.installationId,
        status: installation.status,
        targetName: installation.targetName,
        targetType: installation.targetType,
        isAdmin: canManageInstallation({ orgRole: auth.orgRole }),
      },
      isConnected: link !== null,
      connectedGithubUserId: link?.githubUserId ?? null,
      connectedGithubUsername,
      connectUrl,
    };

    return { status: 200 as const, body };
  },
);
