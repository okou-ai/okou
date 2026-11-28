import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";
import { createStore } from "ccstate";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { teamsConnectRoutes } from "../teams-connect";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { connectTeamsAccountForTest } from "./helpers/teams-account";
import {
  installTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/teams-connect";

const context = testContext();
const memberships = createStore();

const SESSION = Object.freeze({ authorization: "Bearer clerk-session" });

function client() {
  return setupApp({ context, routes: teamsConnectRoutes })(
    teamsConnectContract,
  );
}

async function seedMembers(
  members: readonly {
    readonly orgId: string;
    readonly userId: string;
    readonly role: "admin" | "member";
  }[],
): Promise<void> {
  for (const member of members) {
    await memberships.set(seedOrgMembership$, member, context.signal);
  }
}

/** The bot is installed through Teams and the admin links through OAuth. */
async function linkedAdmin(): Promise<TeamsConnectFixture> {
  const fixture = teamsConnectFixture();
  setupTeamsConnectTestEnv();
  await installTeamsForTest(context.signal, fixture);
  await connectTeamsAccountForTest(context, fixture, { learnSender: false });
  return fixture;
}

async function readStatus(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member" = "org:admin",
) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
  const response = await accept(
    client().getStatus({ headers: SESSION }),
    [200],
  );
  return response.body;
}

function linkedAccountOf(fixture: TeamsConnectFixture) {
  return {
    tenantId: fixture.teamsTenantId,
    teamsAadObjectId: fixture.teamsAadObjectId,
    userPrincipalName: fixture.teamsUserPrincipalName,
  };
}

describe("GET /api/integrations/teams/connect", () => {
  it("teams-connect-004 shows an unlinked member that Teams is installed but not connected", async () => {
    const fixture = await linkedAdmin();
    const memberId = `user_member_${fixture.fixtureId}`;
    await seedMembers([
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      { orgId: fixture.orgId, userId: memberId, role: "member" },
    ]);

    const status = await readStatus(memberId, fixture.orgId, "org:member");

    expect(status).toMatchObject({
      isInstalled: true,
      isConnected: false,
      isAdmin: false,
      linkedAccounts: [],
    });
    expect(status.connectUrl).toStrictEqual(expect.any(String));
    expect(status.installUrl ?? null).toBeNull();
  });

  it("teams-connect-006 keeps a linked identity in its own organization across switches", async () => {
    const fixture = await linkedAdmin();
    const otherOrgId = `org_other_${fixture.fixtureId}`;
    await seedMembers([
      { orgId: fixture.orgId, userId: fixture.userId, role: "admin" },
      { orgId: otherOrgId, userId: fixture.userId, role: "admin" },
    ]);
    const connected = {
      isInstalled: true,
      isConnected: true,
      tenantId: fixture.teamsTenantId,
      linkedAccounts: [linkedAccountOf(fixture)],
    };

    const original = await readStatus(fixture.userId, fixture.orgId);
    const other = await readStatus(fixture.userId, otherOrgId);
    const returned = await readStatus(fixture.userId, fixture.orgId);

    expect(original).toMatchObject(connected);
    expect(other).toMatchObject({
      isInstalled: false,
      isConnected: false,
      pendingInstallation: false,
      linkedAccounts: [],
    });
    expect(returned).toMatchObject(connected);
  });
});

describe("DELETE /api/integrations/teams/connect", () => {
  it("teams-connect-007 disconnects the user while Teams stays installed", async () => {
    const fixture = await linkedAdmin();
    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);

    await accept(client().disconnect({ headers: SESSION, query: {} }), [200]);
    const status = await readStatus(fixture.userId, fixture.orgId);

    expect(status).toMatchObject({
      isInstalled: true,
      isConnected: false,
      tenantId: fixture.teamsTenantId,
      linkedAccounts: [],
    });
  });

  it("teams-connect-008 lets an admin uninstall Teams and keep their account linked", async () => {
    const fixture = await linkedAdmin();
    createRouteMocks(context).clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().disconnect({
        headers: SESSION,
        query: { action: "uninstall" },
      }),
      [200],
    );
    const status = await readStatus(fixture.userId, fixture.orgId);

    expect(status).toMatchObject({
      isInstalled: false,
      pendingInstallation: false,
      isConnected: true,
      linkedAccounts: [linkedAccountOf(fixture)],
      connectUrl: null,
    });
    expect(status.installUrl).toStrictEqual(expect.any(String));
  });
});
