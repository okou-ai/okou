import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command } from "ccstate";
import { teamsBrowserConnectContract } from "@okouai/api-contracts/contracts/teams-browser-connect";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { teamsBotDisplayName } from "../../lib/teams-official-app";
import { requiredAuthContext$ } from "../auth/auth-context";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import {
  connectTeamsInstallation$,
  buildTeamsOauthConnectUrl,
  publishTeamsChanged$,
} from "../services/teams-connect.service";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const L = logger("TeamsBrowserConnect");
const REDIRECT_STATUS = 307;

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: REDIRECT_STATUS,
    headers: { location: url },
  });
}

function appRedirect(path: string): Response {
  return redirectResponse(`${env("APP_URL")}${path}`);
}

function teamsSettingsParams(
  query: {
    readonly tenantId?: string;
    readonly tenantName?: string;
    readonly teamsUserId?: string;
    readonly teamsAadObjectId?: string;
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
    readonly displayName?: string;
    readonly upn?: string;
    readonly teamId?: string;
    readonly teamName?: string;
    readonly botName?: string;
    readonly serviceUrl?: string;
    readonly conversationId?: string;
    readonly conversationType?: string;
    readonly activityId?: string;
    readonly channelId?: string;
    readonly threadId?: string;
    readonly orgId?: string;
  },
  extras: Readonly<Record<string, string | null | undefined>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extras)) {
    if (value) {
      params.set(key, value);
    }
  }
  if (query.tenantId) {
    params.set("tenantId", query.tenantId);
  }
  if (query.tenantName) {
    params.set("tenantName", query.tenantName);
  }
  if (query.teamsUserId) {
    params.set("teamsUserId", query.teamsUserId);
  }
  if (query.teamsAadObjectId) {
    params.set("teamsAadObjectId", query.teamsAadObjectId);
  }
  if (query.displayName) {
    params.set("displayName", query.displayName);
  }
  if (query.teamsUserDisplayName) {
    params.set("teamsUserDisplayName", query.teamsUserDisplayName);
  }
  if (query.upn) {
    params.set("upn", query.upn);
  }
  if (query.teamsUserPrincipalName) {
    params.set("teamsUserPrincipalName", query.teamsUserPrincipalName);
  }
  if (query.teamId) {
    params.set("teamId", query.teamId);
  }
  if (query.teamName) {
    params.set("teamName", query.teamName);
  }
  if (query.serviceUrl) {
    params.set("serviceUrl", query.serviceUrl);
  }
  if (query.conversationId) {
    params.set("conversationId", query.conversationId);
  }
  if (query.conversationType) {
    params.set("conversationType", query.conversationType);
  }
  if (query.activityId) {
    params.set("activityId", query.activityId);
  }
  if (query.channelId) {
    params.set("channelId", query.channelId);
  }
  if (query.threadId) {
    params.set("threadId", query.threadId);
  }
  if (query.orgId) {
    params.set("orgId", query.orgId);
  }
  return params;
}

function connectError(
  message: string,
  query: Parameters<typeof teamsSettingsParams>[0] = {},
): Response {
  const params = teamsSettingsParams(query, { error: message });
  return appRedirect(
    `${INTEGRATION_SETTINGS_PATHS.teams}?${params.toString()}`,
  );
}

function connectSuccess(
  query: Parameters<typeof teamsSettingsParams>[0],
  installation: {
    readonly teamsTenantName?: string | null;
    readonly teamsTeamName?: string | null;
    readonly botName?: string | null;
  },
): Response {
  const params = teamsSettingsParams(query, {
    status: "connected",
    tenantName: installation.teamsTenantName,
    teamName: installation.teamsTeamName,
    botName: teamsBotDisplayName(installation.botName),
  });
  return appRedirect(
    `${INTEGRATION_SETTINGS_PATHS.teams}?${params.toString()}`,
  );
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", env("APP_URL"));
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const invalidConnectLinkMessage = "Invalid connect link.";
const installationNotFoundMessage =
  "Teams installation not found. Please install the Teams app first.";
const adminRequiredMessage = "Ask your org admin to connect first.";
const orgMismatchMessage =
  "Your active organization doesn't match this Teams installation. Please switch to the correct organization in the platform sidebar before connecting.";

type TeamsBrowserConnectQuery = Parameters<typeof teamsSettingsParams>[0];
type TeamsOrgInstallation = typeof teamsOrgInstallations.$inferSelect;

function resolveBrowserConnectOrgId(args: {
  readonly query: TeamsBrowserConnectQuery;
  readonly activeOrgId?: string | null;
  readonly orgRole?: string | null;
  readonly userId: string;
  readonly installation: TeamsOrgInstallation;
}):
  | { readonly kind: "ok"; readonly orgId: string }
  | {
      readonly kind: "error";
      readonly message: string;
    } {
  if (args.query.orgId && args.query.orgId !== args.activeOrgId) {
    return { kind: "error", message: orgMismatchMessage };
  }
  const effectiveOrgId = args.activeOrgId;
  if (!args.installation.orgId) {
    if (!effectiveOrgId || args.orgRole !== "admin") {
      return { kind: "error", message: adminRequiredMessage };
    }
    return { kind: "ok", orgId: effectiveOrgId };
  }

  if (!effectiveOrgId || effectiveOrgId !== args.installation.orgId) {
    L.debug("Org check failed", {
      activeOrgId: args.activeOrgId,
      explicitOrgId: args.query.orgId,
      installationOrgId: args.installation.orgId,
      userId: args.userId,
    });
    return { kind: "error", message: orgMismatchMessage };
  }

  return { kind: "ok", orgId: args.installation.orgId };
}

const independentTeamsBrowserUrl$ = command(
  async (
    { set },
    auth: { readonly orgId?: string | null; readonly userId: string },
    signal: AbortSignal,
  ) => {
    if (!auth.orgId) {
      return undefined;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.TeamsWorkspaceIdentity, features)
      ? buildTeamsOauthConnectUrl({ orgId: auth.orgId, userId: auth.userId })
      : undefined;
  },
);

function teamsBrowserIdentity(query: TeamsBrowserConnectQuery) {
  const { tenantId, teamsUserId, teamsAadObjectId } = query;
  if (!tenantId || (!teamsUserId && !teamsAadObjectId)) {
    return null;
  }
  return { tenantId, teamsUserId, teamsAadObjectId };
}

const browserConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();

  if ("status" in auth) {
    return signInRedirect(request.url);
  }

  const independentUrl = await set(independentTeamsBrowserUrl$, auth, signal);
  if (independentUrl) {
    return redirectResponse(independentUrl);
  }
  const query = get(queryOf(teamsBrowserConnectContract.connect));
  const identity = teamsBrowserIdentity(query);
  if (!identity) {
    return connectError(invalidConnectLinkMessage, query);
  }
  const { tenantId, teamsUserId, teamsAadObjectId } = identity;

  const db = get(db$);
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  signal.throwIfAborted();

  if (!installation) {
    return connectError(installationNotFoundMessage, query);
  }

  const orgResolution = resolveBrowserConnectOrgId({
    query,
    activeOrgId: auth.orgId,
    orgRole: auth.orgRole,
    userId: auth.userId,
    installation,
  });
  if (orgResolution.kind === "error") {
    return connectError(orgResolution.message, query);
  }
  const orgId = orgResolution.orgId;

  const membership = await set(
    getMemberRoleAndUpdateCache$,
    orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  if (membership.kind !== "member") {
    return connectError(orgMismatchMessage, query);
  }

  const result = await set(
    connectTeamsInstallation$,
    {
      userId: auth.userId,
      orgId,
      orgRole: membership.role,
      tenantId,
      tenantName: query.tenantName ?? installation.teamsTenantName ?? undefined,
      teamsUserId,
      teamsAadObjectId,
      teamsUserDisplayName: query.teamsUserDisplayName ?? query.displayName,
      teamsUserPrincipalName: query.teamsUserPrincipalName ?? query.upn,
      teamId: query.teamId ?? installation.teamsTeamId ?? undefined,
      teamName: query.teamName ?? installation.teamsTeamName ?? undefined,
      serviceUrl: query.serviceUrl ?? installation.serviceUrl ?? undefined,
      conversationId: query.conversationId,
      conversationType: query.conversationType,
      activityId: query.activityId,
      channelId: query.channelId,
      threadId: query.threadId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return connectError(result.message, query);
  }

  if (result.kind === "forbidden") {
    return connectError(result.message, query);
  }

  await set(publishTeamsChanged$, { orgId, userIds: [auth.userId] }, signal);
  signal.throwIfAborted();

  return connectSuccess(query, result.installation);
});

export const teamsBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: teamsBrowserConnectContract.connect,
    handler: browserConnect$,
  },
];
