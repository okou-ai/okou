import { randomUUID } from "node:crypto";

import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { slackConnectRoutes } from "../slack-connect";

const context = testContext();
const mocks = createRouteMocks(context);
const slackOrgs = createPublicSlackOrgApi(context);
describe("GET /api/integrations/slack/connect", () => {
  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns isConnected: false when the user has no slack connection", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });
  });

  it("returns isConnected: true with workspace info when the user is connected", async () => {
    const fixture = await slackOrgs.installOrg({ withConnection: true });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: fixture.slackWorkspaceName,
      defaultAgentName: null,
    });
  });

  it("offers OAuth before resolving another user's Slack account ownership", async () => {
    const fixture = await slackOrgs.installOrg({ withConnection: true });
    const currentUserId = `user_${randomUUID()}`;
    mocks.clerk.session(currentUserId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
      linkStatus: { kind: "connect" },
    });
  });

  it("reports the identity switch when another workspace belongs to another organization", async () => {
    const current = await slackOrgs.installOrg({ withConnection: true });
    const requested = await slackOrgs.installOrg({ withConnection: true });
    mocks.clerk.session(current.userId, current.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: requested.slackWorkspaceId,
          slackUserId: requested.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: current.slackWorkspaceName,
      defaultAgentName: null,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: current.slackUserId,
        requestedSlackUserId: requested.slackUserId,
      },
    });
  });

  it("reports when the current user is linked to a different Slack account", async () => {
    const fixture = await slackOrgs.installOrg({ withConnection: true });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const requestedSlackUserId = `U_${randomUUID()}`;

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: requestedSlackUserId,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: fixture.slackWorkspaceName,
      defaultAgentName: null,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: fixture.slackUserId,
        requestedSlackUserId,
      },
    });
  });

  it("offers connect when the requested account is not linked", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
      linkStatus: { kind: "connect" },
    });
  });

  it.each(["org:admin", "org:member"] as const)(
    "keeps unbound workspace link eligibility for %s",
    async (role) => {
      const fixture = await slackOrgs.installOrg({ installation: "unbound" });
      mocks.clerk.session(fixture.userId, fixture.orgId, role);
      const client = setupApp({ context, routes: slackConnectRoutes })(
        slackConnectContract,
      );

      const response = await accept(
        client.getLinkStatus({
          headers: { authorization: "Bearer clerk-session" },
          query: {
            workspaceId: fixture.slackWorkspaceId,
            slackUserId: fixture.slackUserId,
          },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({
        isConnected: false,
        isAdmin: role === "org:admin",
        linkStatus: {
          kind: "connect",
        },
      });
    },
  );

  it("keeps the current connection when an admin requests another unbound workspace", async () => {
    const current = await slackOrgs.installOrg({ withConnection: true });
    const requested = await slackOrgs.installOrg({ installation: "unbound" });
    mocks.clerk.session(current.userId, current.orgId, "org:admin");
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: requested.slackWorkspaceId,
          slackUserId: requested.slackUserId,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: current.slackWorkspaceName,
      defaultAgentName: null,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: current.slackUserId,
        requestedSlackUserId: requested.slackUserId,
      },
    });
  });

  it("offers identity OAuth without requiring an installed workspace", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getLinkStatus({
        headers: { authorization: "Bearer clerk-session" },
        query: {
          workspaceId: `T_${randomUUID()}`,
          slackUserId: `U_${randomUUID()}`,
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
      linkStatus: { kind: "connect" },
    });
  });

  it("returns isAdmin: true for admin users", async () => {
    const fixture = await slackOrgs.installOrg({ withConnection: true });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
  });

  it("returns isAdmin: false for member users", async () => {
    const fixture = await slackOrgs.installOrg({ withConnection: true });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
  });
});

describe("POST /api/integrations/slack/connect", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.connect({
        headers: {},
        body: {
          requestUserScopes: true,
          workspaceId: "T-test",
          slackUserId: "U-test",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("starts identity OAuth when the workspace has no installation", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          requestUserScopes: true,
          workspaceId: "T-nonexistent",
          slackUserId: fixture.slackUserId,
        },
      }),
      [202],
    );

    expect(new URL(response.body.authorizationUrl).pathname).toBe(
      "/api/slack/oauth/connect",
    );
  });

  it("member starts user OAuth before connecting to a bound workspace", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          requestUserScopes: true,
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [202],
    );

    expect(response.body.authorizationUrl).toContain(
      "/api/slack/oauth/connect?connectorState=",
    );
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.isConnected).toBeFalsy();
  });

  it("starts identity OAuth for a member of an unbound workspace", async () => {
    const fixture = await slackOrgs.installOrg({ installation: "unbound" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          requestUserScopes: true,
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [202],
    );

    expect(new URL(response.body.authorizationUrl).pathname).toBe(
      "/api/slack/oauth/connect",
    );
  });

  it("starts identity OAuth through another organization's installation", async () => {
    const fixture = await slackOrgs.installOrg({ installation: "other-org" });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          requestUserScopes: true,
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [202],
    );

    expect(new URL(response.body.authorizationUrl).pathname).toBe(
      "/api/slack/oauth/connect",
    );
  });
});

describe("POST /api/integrations/slack/connect/switch", () => {
  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(
      client.switchAccount({
        headers: {},
        body: {
          requestUserScopes: true,
          workspaceId: "T-test",
          slackUserId: "U-test",
        },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("uses a distinct route for switch intent", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );
    const response = await accept(
      client.switchAccount({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          requestUserScopes: true,
          workspaceId: fixture.slackWorkspaceId,
          slackUserId: fixture.slackUserId,
        },
      }),
      [202],
    );
    const authorizationUrl = new URL(response.body.authorizationUrl);
    const connectorState = authorizationUrl.searchParams.get("connectorState");

    expect(slackConnectContract.switchAccount.path).toBe(
      "/api/integrations/slack/connect/switch",
    );
    expect(authorizationUrl.pathname).toBe("/api/slack/oauth/connect");
    expect(connectorState).not.toBeNull();
  });
});
