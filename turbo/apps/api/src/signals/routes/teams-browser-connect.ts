import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { command } from "ccstate";
import { teamsBrowserConnectContract } from "@okouai/api-contracts/contracts/teams-browser-connect";

import { env } from "../../lib/env";
import { requiredAuthContext$ } from "../auth/auth-context";
import { request$ } from "../context/hono";
import { buildTeamsOauthConnectUrl } from "../services/teams-connect.service";
import type { RouteEntry } from "../route-entry";

function redirectResponse(url: string): Response {
  return new Response(null, {
    status: 307,
    headers: { location: url },
  });
}

function signInRedirect(requestUrl: string): Response {
  const signInUrl = new URL("/sign-in", env("APP_URL"));
  signInUrl.searchParams.set("redirect_url", requestUrl);
  return redirectResponse(signInUrl.toString());
}

const browserConnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  const auth = await set(requiredAuthContext$, {}, signal);
  signal.throwIfAborted();

  if ("status" in auth) {
    return signInRedirect(request.url);
  }
  if (!auth.orgId) {
    const params = new URLSearchParams({
      error:
        "Choose an organization before connecting your Microsoft Teams account.",
    });
    return redirectResponse(
      `${env("APP_URL")}${INTEGRATION_SETTINGS_PATHS.teams}?${params.toString()}`,
    );
  }
  return redirectResponse(
    buildTeamsOauthConnectUrl({ orgId: auth.orgId, userId: auth.userId }),
  );
});

export const teamsBrowserConnectRoutes: readonly RouteEntry[] = [
  {
    route: teamsBrowserConnectContract.connect,
    handler: browserConnect$,
  },
];
