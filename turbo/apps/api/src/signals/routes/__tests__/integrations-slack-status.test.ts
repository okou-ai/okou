import { randomUUID } from "node:crypto";

import { integrationsSlackContract } from "@okouai/api-contracts/contracts/integrations-slack";
import { slackOauthContract } from "@okouai/api-contracts/contracts/slack-oauth";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { integrationsSlackRoutes } from "../integrations-slack";
import { slackOauthRoutes } from "../slack-oauth";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRouteMocks } from "./helpers/route-test";
import { createPublicSlackOrgApi } from "./helpers/slack-public-install";

const context = testContext();

const API_ORIGIN = "https://api.okou.ai";

interface StatusActor {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole?: "org:admin" | "org:member";
}

function useApiOrigin(): void {
  mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
}

async function readStatus(actor: StatusActor, baseUrl?: string) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  // Clerk's directory answers the OAuth start's membership check for the caller.
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: actor.orgId
      ? [
          {
            organization: { id: actor.orgId },
            role: actor.orgRole ?? "org:admin",
            createdAt: 1,
          },
        ]
      : [],
  });
  const client = setupApp({
    context,
    routes: integrationsSlackRoutes,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  })(integrationsSlackContract);
  return await accept(
    client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
}

function slackOauth() {
  return setupApp({ context, routes: slackOauthRoutes })(slackOauthContract);
}

function entryQuery(entry: string | null | undefined, path: string) {
  if (!entry) {
    throw new Error(`Expected a Slack entry URL for ${path}`);
  }
  const url = new URL(entry);
  expect(`${url.origin}${url.pathname}`).toBe(`${API_ORIGIN}${path}`);
  return Object.fromEntries(url.searchParams);
}

function slackAuthorization(location: string | null): URL {
  if (!location) {
    throw new Error("Expected a Slack authorization redirect");
  }
  const url = new URL(location);
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://slack.com/oauth/v2/authorize",
  );
  return url;
}

async function followConnect(connectUrl: string | null | undefined) {
  const query = entryQuery(connectUrl, "/api/slack/oauth/connect");
  const response = await accept(slackOauth().connect({ query }), [307]);
  return slackAuthorization(response.headers.get("location"));
}

async function followInstall(installUrl: string | null | undefined) {
  const query = entryQuery(installUrl, "/api/slack/oauth/install");
  const response = await accept(slackOauth().install({ query }), [307]);
  return slackAuthorization(response.headers.get("location"));
}

function userScopes(authorization: URL): string[] {
  return (authorization.searchParams.get("user_scope") ?? "").split(",");
}

describe("GET /api/integrations/slack", () => {
  it("integrations-slack-status-001 rejects a signed-in session without an organization", async () => {
    createRouteMocks(context).clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context, routes: integrationsSlackRoutes })(
      integrationsSlackContract,
    );

    const status = await accept(
      client.getStatus({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(status.body.error.code).toBe("UNAUTHORIZED");
  });

  it("integrations-slack-status-002 keeps each status read scoped to its user and organization", async () => {
    const integrations = createBddIntegrationApi(context);
    const admin = integrations.user({ orgRole: "org:admin" });
    if (!admin.orgId) {
      throw new Error("Expected the admin to belong to an organization");
    }
    const teamId = `T_${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    integrations.configureSlackAppMocks();
    await integrations.installSlackWorkspace(admin, {
      teamId,
      teamName: `Workspace ${teamId}`,
    });
    useApiOrigin();
    const member = { userId: `user_${randomUUID()}`, orgId: admin.orgId };
    const otherOrgId = `org_${randomUUID()}`;

    const first = await readStatus(admin);
    const memberStatus = await readStatus(
      { ...member, orgRole: "org:member" },
      "https://api-preview.vm7.ai",
    );
    const otherOrg = await readStatus({
      userId: admin.userId,
      orgId: otherOrgId,
      orgRole: "org:admin",
    });
    const again = await readStatus(admin, "https://api-preview.vm7.ai");

    expect(first.body).toStrictEqual({
      isConnected: true,
      isInstalled: true,
      isAdmin: true,
      workspaceName: `Workspace ${teamId}`,
      scopeMismatch: false,
      reinstallUrl: null,
    });
    expect(memberStatus.body).toStrictEqual({
      isConnected: false,
      isInstalled: true,
      isAdmin: false,
      installUrl: null,
      connectUrl: expect.stringMatching(
        /^https:\/\/api\.okou\.ai\/api\/slack\/oauth\/connect\?/,
      ),
    });
    const memberAuthorization = await followConnect(
      memberStatus.body.connectUrl,
    );
    expect(userScopes(memberAuthorization)).toContain("users:read");
    expect(otherOrg.body).toStrictEqual({
      isConnected: false,
      isInstalled: false,
      isAdmin: true,
      installUrl: expect.stringMatching(
        /^https:\/\/api\.okou\.ai\/api\/slack\/oauth\/install\?/,
      ),
      connectUrl: expect.stringMatching(
        /^https:\/\/api\.okou\.ai\/api\/slack\/oauth\/connect\?/,
      ),
    });
    expect(again.body).toStrictEqual(first.body);
  });

  it("integrations-slack-status-004 offers an unconnected member a Slack connect link", async () => {
    // Slack answers the installation notices like the real Web API.
    createBddIntegrationApi(context).configureSlackAppMocks();
    const slack = createPublicSlackOrgApi(context);
    const orgId = `org_${randomUUID()}`;
    await slack.installForOrg({ orgId });
    useApiOrigin();

    const status = await readStatus({
      userId: `user_${randomUUID()}`,
      orgId,
      orgRole: "org:admin",
    });

    expect(status.body.isConnected).toBeFalsy();
    const authorization = await followConnect(status.body.connectUrl);
    expect(userScopes(authorization)).toContain("users:read");
  });

  it("integrations-slack-status-005 sends an admin without Slack to the API-origin install flow", async () => {
    createBddIntegrationApi(context).configureSlackOauthProvider();
    useApiOrigin();

    const status = await readStatus({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      orgRole: "org:admin",
    });

    const authorization = await followInstall(status.body.installUrl);
    expect(authorization.searchParams.get("scope")).toBeTruthy();
    expect(authorization.searchParams.get("user_scope")).toBeTruthy();
  });

  it("integrations-slack-status-008 asks an admin to reinstall a workspace missing bot scopes", async () => {
    const integrations = createBddIntegrationApi(context);
    // Slack answers the installation notices like the real Web API.
    integrations.configureSlackAppMocks();
    const slack = createPublicSlackOrgApi(context);
    const admin = integrations.user({ orgRole: "org:admin" });
    if (!admin.orgId) {
      throw new Error("Expected the admin to belong to an organization");
    }
    const { slackWorkspaceId } = await slack.installForOrg({
      orgId: admin.orgId,
      installer: admin,
      botScopes: "chat:write,channels:read",
    });
    useApiOrigin();

    const status = await readStatus(admin);

    expect(status.body.isConnected).toBeTruthy();
    expect(status.body.scopeMismatch).toBeTruthy();
    const authorization = await followInstall(status.body.reinstallUrl);
    expect(authorization.searchParams.get("team")).toBe(slackWorkspaceId);
    expect(authorization.searchParams.get("scope")).toBeTruthy();
    expect(authorization.searchParams.get("user_scope")).toBeTruthy();
  });

  it("integrations-slack-status-011 hides scope mismatch details from a regular member", async () => {
    // Slack answers the installation and connect notices like the real Web API.
    createBddIntegrationApi(context).configureSlackAppMocks();
    const slack = createPublicSlackOrgApi(context);
    const orgId = `org_${randomUUID()}`;
    const memberId = `user_${randomUUID()}`;
    const { slackWorkspaceId } = await slack.installForOrg({
      orgId,
      botScopes: "chat:write",
    });
    await slack.connectMember({
      orgId,
      userId: memberId,
      slackWorkspaceId,
    });

    const status = await readStatus({
      userId: memberId,
      orgId,
      orgRole: "org:member",
    });

    expect(status.body.isConnected).toBeTruthy();
    expect(status.body).not.toHaveProperty("scopeMismatch");
    expect(status.body).not.toHaveProperty("reinstallUrl");
  });
});
