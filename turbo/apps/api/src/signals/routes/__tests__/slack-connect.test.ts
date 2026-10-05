import { randomUUID } from "node:crypto";

import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";
import { slackConnectRoutes } from "../slack-connect";

const TEST_APP_ROUTES = Object.freeze([...slackConnectRoutes]);

const context = testContext();
const mocks = createRouteMocks(context);
const slackOrgs = createPublicSlackOrgApi(context);
const SLACK_CONNECT_PATH = "/api/integrations/slack/connect";

async function postRawSlackConnect(body: string): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const app = createApp({ signal: context.signal, routes: TEST_APP_ROUTES });
  const response = await app.request(SLACK_CONNECT_PATH, {
    method: "POST",
    headers: {
      authorization: "Bearer clerk-session",
      "content-type": "application/json",
    },
    body,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function expectErrorCode(
  body: unknown,
  code: string,
): asserts body is { readonly error: { readonly message: string } } {
  expect(body).toMatchObject({ error: { code } });
}

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

  it("reports when the requested Slack account belongs to another Okou user", async () => {
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
      linkStatus: { kind: "slack_account_in_use" },
    });
  });

  it("reports when the requested Slack workspace belongs to another organization", async () => {
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
        kind: "workspace_mismatch",
        currentWorkspaceName: current.slackWorkspaceName,
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

  it("returns 400 when body is missing required fields", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await postRawSlackConnect("{}");

    expect(response.status).toBe(400);
    expectErrorCode(response.body, "BAD_REQUEST");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const fixture = await slackOrgs.installOrg();
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await postRawSlackConnect("not-json");

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid JSON in request body",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 404 when workspace does not exist", async () => {
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
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Slack workspace not found",
        code: "NOT_FOUND",
      },
    });
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

  it("returns 403 when non-admin tries to connect unbound workspace", async () => {
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
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("Only admins");
  });

  it("returns 404 when workspace is bound to a different org", async () => {
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
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Slack workspace not found", code: "NOT_FOUND" },
    });
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
