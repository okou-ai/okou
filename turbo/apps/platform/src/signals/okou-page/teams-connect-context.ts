import type {
  TeamsConnectBody,
  TeamsConnectStatus,
} from "@okouai/api-contracts/contracts/teams-connect";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";

/** Only new App actions opt in; old API starts safely ignore this field. */
export function teamsCompletionUrl(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const url = new URL(value, window.location.origin);
  if (url.pathname === "/api/teams/oauth/connect") {
    url.searchParams.set("completion", "settings");
  }
  return url.toString();
}

export function teamsEntryUrl(status: TeamsConnectStatus): string | null {
  if (status.pendingInstallation === true) {
    return INTEGRATION_SETTINGS_PATHS.teams;
  }
  return (
    teamsCompletionUrl(status.connectUrl) ??
    (status.installUrl ? INTEGRATION_SETTINGS_PATHS.teams : null)
  );
}

export function teamsConnectBody(
  params: URLSearchParams,
): TeamsConnectBody | null {
  const tenantId = params.get("tenantId");
  const teamsUserId = params.get("teamsUserId");
  const teamsAadObjectId = params.get("teamsAadObjectId");
  if (!tenantId || (!teamsUserId && !teamsAadObjectId)) {
    return null;
  }
  const body: TeamsConnectBody = { tenantId };
  const fields = [
    "tenantName",
    "teamsUserId",
    "teamsAadObjectId",
    "teamId",
    "teamName",
    "serviceUrl",
    "conversationId",
    "conversationType",
    "activityId",
    "channelId",
    "threadId",
  ] as const;
  for (const field of fields) {
    const value = params.get(field);
    if (value) {
      body[field] = value;
    }
  }
  const displayName =
    params.get("teamsUserDisplayName") ?? params.get("displayName");
  const upn = params.get("teamsUserPrincipalName") ?? params.get("upn");
  if (displayName) {
    body.teamsUserDisplayName = displayName;
  }
  if (upn) {
    body.teamsUserPrincipalName = upn;
  }
  return body;
}

type TeamsTargetState =
  "invalid" | "orgMismatch" | "none" | "different" | "unknown" | "match";

export function teamsTargetState(
  params: URLSearchParams,
  status: TeamsConnectStatus,
  orgId: string,
): TeamsTargetState {
  for (const key of [
    "orgId",
    "tenantId",
    "teamsUserId",
    "teamsAadObjectId",
    "teamId",
  ]) {
    const values = params.getAll(key);
    if (
      values.some((value) => {
        return !value || value !== values[0];
      })
    ) {
      return "invalid";
    }
  }
  const org = params.get("orgId");
  if (org && org !== orgId) {
    return "orgMismatch";
  }
  const tenant = params.get("tenantId");
  const user = params.get("teamsUserId");
  const aad = params.get("teamsAadObjectId");
  const team = params.get("teamId");
  if ((user || aad || team) && !tenant) {
    return "invalid";
  }
  if (!tenant) {
    return "none";
  }
  if (
    (status.tenantId && status.tenantId !== tenant) ||
    (team && status.teamId !== team)
  ) {
    return "different";
  }
  // New App -> old API: its broad boolean cannot identify the requested
  // account. Remove this unknown branch only when pre-D01 APIs are neither
  // serving nor supported rollback targets (tracked by #40196).
  if (!status.linkedAccounts) {
    return "unknown";
  }
  return status.linkedAccounts.some((account) => {
    return (
      account.tenantId === tenant &&
      (!user || account.teamsUserId === user) &&
      (!aad || account.teamsAadObjectId === aad)
    );
  })
    ? "match"
    : "different";
}

/** Browser context never supplies an origin, a service URL, or a Graph chat ID. */
export function teamsReturnUrl(
  params: URLSearchParams,
  status: TeamsConnectStatus,
  matched: boolean,
): string {
  const channelId = params.get("channelId");
  if (
    !matched ||
    !status.tenantId ||
    !status.teamId ||
    !channelId ||
    !/^19:[^/?#]+@thread\.(?:tacv2|skype)$/u.test(channelId)
  ) {
    return "https://teams.microsoft.com/";
  }
  const activity = params.get("activityId");
  const path =
    activity && /^\d+$/u.test(activity)
      ? `/l/message/${encodeURIComponent(channelId)}/${encodeURIComponent(activity)}`
      : `/l/channel/${encodeURIComponent(channelId)}/channel`;
  const url = new URL(path, "https://teams.microsoft.com");
  url.searchParams.set("tenantId", status.tenantId);
  url.searchParams.set("groupId", status.teamId);
  const thread = params.get("threadId");
  if (activity && thread && /^\d+$/u.test(thread)) {
    url.searchParams.set("parentMessageId", thread);
  }
  return url.toString();
}
