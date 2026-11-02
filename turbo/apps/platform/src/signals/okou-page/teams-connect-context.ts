import type { TeamsConnectStatus } from "@okouai/api-contracts/contracts/teams-connect";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";

/** Resolve the API-provided connect URL against the current page origin. */
export function teamsConnectUrl(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  return new URL(value, window.location.origin).toString();
}

export function teamsEntryUrl(status: TeamsConnectStatus): string | null {
  if (status.pendingInstallation) {
    return INTEGRATION_SETTINGS_PATHS.teams;
  }
  return (
    teamsConnectUrl(status.connectUrl) ??
    (status.installUrl ? INTEGRATION_SETTINGS_PATHS.teams : null)
  );
}

type TeamsTargetState = "invalid" | "none" | "different" | "match";

export function teamsTargetState(
  params: URLSearchParams,
  status: TeamsConnectStatus,
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
  if (status.tenantId && status.tenantId !== tenant) {
    return "different";
  }
  return status.linkedAccounts.some((account) => {
    return (
      account.tenantId === tenant &&
      (!user ||
        account.teamsUserId === user ||
        (account.teamsUserId === null && aad === account.teamsAadObjectId)) &&
      (!aad || account.teamsAadObjectId === aad)
    );
  })
    ? "match"
    : "different";
}
