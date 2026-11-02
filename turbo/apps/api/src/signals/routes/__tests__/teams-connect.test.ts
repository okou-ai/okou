import { describe, expect, it, beforeEach } from "vitest";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";

import { mockEnv } from "../../../lib/env";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";
import { teamsConnectRoutes } from "../teams-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function client() {
  return setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
}
const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
  return removeTeamsForTest(context.signal, fixture);
});
async function connectedFixture() {
  const fixture = await track(Promise.resolve(teamsConnectFixture()));
  await installTeamsForTest(context.signal, fixture);
  await connectTeamsAccountForTest(context, fixture);
  return fixture;
}
beforeEach(() => {
  setupTeamsConnectTestEnv();
});

describe("GET /api/integrations/teams/connect", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(client().getStatus({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns independent account and installation actions without a Teams installation", async () => {
    const fixture = teamsConnectFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      workspaceIdentity: true,
      isInstalled: false,
      isConnected: false,
      linkedAccounts: [],
      pendingInstallation: false,
      isAdmin: true,
      installUrl: expect.stringContaining(
        "https://api.okou.test/api/teams/oauth/connect?connectState=teams-start.",
      ),
      connectUrl: expect.stringContaining(
        "https://api.okou.test/api/teams/oauth/connect?connectState=teams-start.",
      ),
    });
  });

  it("uses the web origin when the API backend URL is unset", async () => {
    mockEnv("OKOU_API_BACKEND_URL", undefined);
    const fixture = teamsConnectFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body.connectUrl).toStrictEqual(
      expect.stringContaining(
        "https://app.okou.test/api/teams/oauth/connect?connectState=teams-start.",
      ),
    );
  });

  it("returns installed but disconnected status for an unlinked user", async () => {
    const fixture = await connectedFixture();
    mocks.clerk.session(`other-${fixture.userId}`, fixture.orgId, "org:member");
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      isAdmin: false,
      linkedAccounts: [],
      installUrl: null,
      connectUrl: expect.any(String),
    });
  });

  it("returns a Teams reinstall URL to admins when the installed app id is stale", async () => {
    await connectedFixture();
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      isConnected: true,
      permissionMismatch: true,
      reinstallUrl: expect.stringContaining(
        "https://teams.microsoft.com/l/app/",
      ),
    });
  });

  it("keeps status identity isolated across users and organizations", async () => {
    const fixture = await connectedFixture();
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      isConnected: true,
      tenantId: fixture.teamsTenantId,
      linkedAccounts: [{ teamsAadObjectId: fixture.teamsAadObjectId }],
    });
    mocks.clerk.session(fixture.userId, `other-${fixture.orgId}`, "org:admin");
    const other = await accept(client().getStatus({ headers }), [200]);
    expect(other.body).toMatchObject({
      isConnected: false,
      isInstalled: false,
      linkedAccounts: [],
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const original = await accept(client().getStatus({ headers }), [200]);
    expect(original.body).toMatchObject({
      isConnected: true,
      tenantId: fixture.teamsTenantId,
    });
  });
});

describe("DELETE /api/integrations/teams/connect", () => {
  it("disconnects the current user without uninstalling Teams", async () => {
    const fixture = await connectedFixture();
    await accept(client().disconnect({ headers }), [200]);
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("lets admins uninstall Teams while keeping their account connected", async () => {
    const fixture = await connectedFixture();
    await accept(
      client().disconnect({ headers, query: { action: "uninstall" } }),
      [200],
    );
    const response = await accept(client().getStatus({ headers }), [200]);
    expect(response.body).toMatchObject({
      isInstalled: false,
      isConnected: true,
      linkedAccounts: [{ teamsAadObjectId: fixture.teamsAadObjectId }],
      pendingInstallation: false,
      connectUrl: null,
      installUrl: expect.any(String),
    });
  });
});
