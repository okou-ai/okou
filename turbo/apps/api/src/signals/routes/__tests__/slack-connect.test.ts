import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { slackConnectRoutes } from "../slack-connect";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createBddIntegrationApi,
  mockSlackIdentityLookup,
} from "./helpers/api-bdd-integrations";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import {
  createPublicSlackOrgApi,
  uniqueSlackUserId,
} from "./helpers/slack-public-install";

const context = testContext();

/** Browser sessions of real organization members within one case. */
function sessions() {
  const directory = createStore();
  return async function signIn(actor: ApiTestUser) {
    const orgId = actor.orgId;
    if (!orgId) {
      throw new Error("Expected the Slack actor to belong to an organization");
    }
    await directory.set(
      seedOrgMembership$,
      {
        orgId,
        userId: actor.userId,
        role: actor.orgRole === "org:member" ? "member" : "admin",
      },
      context.signal,
    );
    createRouteMocks(context).clerk.session(actor.userId, orgId, actor.orgRole);
    return { authorization: "Bearer clerk-session" };
  };
}

function connectApi() {
  return setupApp({ context, routes: slackConnectRoutes })(
    slackConnectContract,
  );
}

async function readStatus(headers: { authorization: string }) {
  const response = await accept(connectApi().getStatus({ headers }), [200]);
  return response.body;
}

async function readLinkStatus(
  headers: { authorization: string },
  query: { readonly workspaceId: string; readonly slackUserId: string },
) {
  const response = await accept(
    connectApi().getLinkStatus({ headers, query }),
    [200],
  );
  return response.body;
}

describe("GET /api/integrations/slack/connect", () => {
  it("slack-connect-002 reports an unlinked admin as not connected", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg();

    const status = await readStatus(await signIn(org.actor));

    expect(status).toStrictEqual({ isConnected: false, isAdmin: true });
  });

  it("slack-connect-003 reports a connected admin with the Slack workspace name", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });

    const status = await readStatus(await signIn(org.actor));

    expect(status).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: org.slackWorkspaceName,
    });
  });

  it("slack-connect-004 offers OAuth to an unlinked admin for another member's Slack user", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    const admin = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:admin",
    });

    const status = await readLinkStatus(await signIn(admin), {
      workspaceId: org.slackWorkspaceId,
      slackUserId: org.slackUserId,
    });

    expect(status).toStrictEqual({
      isConnected: false,
      isAdmin: true,
      linkStatus: { kind: "connect" },
    });
  });

  it("slack-connect-005 reports a Slack account switch for another organization's workspace", async () => {
    const signIn = sessions();
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const other = await slack.installOrg({ withConnection: true });

    const status = await readLinkStatus(await signIn(org.actor), {
      workspaceId: other.slackWorkspaceId,
      slackUserId: other.slackUserId,
    });

    expect(status).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: org.slackWorkspaceName,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: org.slackUserId,
        requestedSlackUserId: other.slackUserId,
      },
    });
  });

  it("slack-connect-006 reports a different Slack user in the admin's own workspace", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg({
      withConnection: true,
    });
    const requestedSlackUserId = uniqueSlackUserId();

    const status = await readLinkStatus(await signIn(org.actor), {
      workspaceId: org.slackWorkspaceId,
      slackUserId: requestedSlackUserId,
    });

    expect(status).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: org.slackWorkspaceName,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: org.slackUserId,
        requestedSlackUserId,
      },
    });
  });

  it("slack-connect-010 keeps the current connection when another unbound workspace is requested", async () => {
    const signIn = sessions();
    const slack = createPublicSlackOrgApi(context);
    const org = await slack.installOrg({ withConnection: true });
    const unbound = await slack.installOrg({ installation: "unbound" });

    const status = await readLinkStatus(await signIn(org.actor), {
      workspaceId: unbound.slackWorkspaceId,
      slackUserId: unbound.slackUserId,
    });

    expect(status).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: org.slackWorkspaceName,
      linkStatus: {
        kind: "slack_account_mismatch",
        currentSlackUserId: org.slackUserId,
        requestedSlackUserId: unbound.slackUserId,
      },
    });
  });

  it("slack-connect-013 reports isAdmin false for a connected member", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg();
    const teamId = org.slackWorkspaceId;
    const member = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:member",
    });
    await signIn(member);
    await createBddIntegrationApi(context).connectSlackUser(member, {
      workspaceId: teamId,
      slackUserId: uniqueSlackUserId(),
    });

    const status = await readStatus(await signIn(member));

    expect(status).toMatchObject({ isConnected: true, isAdmin: false });
  });
});

describe("POST /api/integrations/slack/connect", () => {
  it("slack-connect-015 starts identity OAuth for a workspace without an installation", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg();

    const started = await accept(
      connectApi().connect({
        headers: await signIn(org.actor),
        body: {
          workspaceId: "T-nonexistent",
          slackUserId: org.slackUserId,
          requestUserScopes: true,
        },
      }),
      [202],
    );

    expect(new URL(started.body.authorizationUrl).pathname).toBe(
      "/api/slack/oauth/connect",
    );
  });

  it("slack-connect-016 starts user OAuth for a member of a bound workspace without connecting", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg();
    const teamId = org.slackWorkspaceId;
    const member = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:member",
    });
    const slackUserId = uniqueSlackUserId();
    mockSlackIdentityLookup(context, {
      id: slackUserId,
      team_id: teamId,
      real_name: "Slack Member",
      profile: { email: member.email, display_name: "Slack Member" },
    });
    const headers = await signIn(member);

    const started = await accept(
      connectApi().connect({
        headers,
        body: { workspaceId: teamId, slackUserId, requestUserScopes: true },
      }),
      [202],
    );

    expect(started.body.authorizationUrl).toContain(
      "/api/slack/oauth/connect?connectorState=",
    );
    await expect(readStatus(headers)).resolves.toMatchObject({
      isConnected: false,
    });
  });
});

describe("POST /api/integrations/slack/connect/switch", () => {
  it("slack-connect-020 starts the switch OAuth on its own route", async () => {
    const signIn = sessions();
    const org = await createPublicSlackOrgApi(context).installOrg();
    const teamId = org.slackWorkspaceId;
    const member = createBddApi(context).user({
      orgId: org.orgId,
      orgRole: "org:member",
    });
    const slackUserId = uniqueSlackUserId();
    mockSlackIdentityLookup(context, {
      id: slackUserId,
      team_id: teamId,
      real_name: "Slack Member",
      profile: { email: member.email, display_name: "Slack Member" },
    });

    const switched = await accept(
      connectApi().switchAccount({
        headers: await signIn(member),
        body: { workspaceId: teamId, slackUserId, requestUserScopes: true },
      }),
      [202],
    );

    expect(slackConnectContract.switchAccount.path).toBe(
      "/api/integrations/slack/connect/switch",
    );
    const authorization = new URL(switched.body.authorizationUrl);
    expect(authorization.pathname).toBe("/api/slack/oauth/connect");
    expect(authorization.searchParams.get("connectorState")).toBeTruthy();
  });
});
