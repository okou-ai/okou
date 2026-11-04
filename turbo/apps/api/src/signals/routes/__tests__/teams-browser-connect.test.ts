import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { teamsBrowserConnectRoutes } from "../teams-browser-connect";
import { createRouteMocks } from "./helpers/route-test";
import {
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const CONNECT_PATH = "http://api.test/api/teams/connect";
const APP_ORIGIN = "https://app.okou.test";

async function requestConnect(
  url: string,
  headers: RequestInit["headers"] = {},
) {
  return await createAppWithRoutes({
    signal: context.signal,
    routes: teamsBrowserConnectRoutes,
  }).request(url, { headers });
}

describe("GET /api/teams/connect", () => {
  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
  });

  it("redirects unauthenticated users to app sign-in with redirect_url", async () => {
    const response = await requestConnect(CONNECT_PATH);
    expect(response.status).toBe(307);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin).toBe(APP_ORIGIN);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(CONNECT_PATH);
  });

  it("verifies a provider link through Microsoft OAuth for the active account", async () => {
    const fixture = teamsConnectFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    const response = await requestConnect(
      `${CONNECT_PATH}?${new URLSearchParams({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        orgId: "receiving-installation-org",
      })}`,
      { authorization: "Bearer clerk-session" },
    );
    expect(response.status).toBe(307);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin + url.pathname).toBe(
      "https://api.okou.test/api/teams/oauth/connect",
    );
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      orgId: fixture.orgId,
      userId: fixture.userId,
    });
  });
});
