import { randomUUID } from "node:crypto";

import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import {
  deleteSlackConnectOrg$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/slack-connect";
import { slackConnectRoutes } from "../slack-connect";

const TEST_APP_ROUTES = Object.freeze([...slackConnectRoutes]);

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
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
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context, routes: slackConnectRoutes })(
      slackConnectContract,
    );

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
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
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
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
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { withConnection: true, slackWorkspaceName: "Test Workspace" },
        context.signal,
      ),
    );
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
      workspaceName: "Test Workspace",
      defaultAgentName: null,
    });
  });

  it("returns isAdmin: true for admin users", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
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
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
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
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

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
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await postRawSlackConnect("{}");

    expect(response.status).toBe(400);
    expectErrorCode(response.body, "BAD_REQUEST");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
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
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
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
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
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
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: null },
        context.signal,
      ),
    );
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
    const targetOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { installationOrgId: targetOrgId },
        context.signal,
      ),
    );
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
