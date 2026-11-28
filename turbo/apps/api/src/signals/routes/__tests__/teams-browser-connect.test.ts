import { randomUUID } from "node:crypto";
import { teamsBrowserConnectContract } from "@okouai/api-contracts/contracts/teams-browser-connect";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { teamsBrowserConnectRoutes } from "../teams-browser-connect";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const memberships = createStore();

describe("GET /api/teams/connect", () => {
  it("teams-browser-connect-001 sends a signed-out browser to app sign-in and back to the connect URL", async () => {
    const appOrigin = "https://app-teams-connect.okou.test";
    const apiOrigin = "https://api-teams-connect.okou.test";
    mockEnv("APP_URL", appOrigin);
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const query = {
      tenantId: `tenant-${randomUUID()}`,
      teamsUserId: `29:user-${randomUUID()}`,
    };

    const response = await accept(
      setupApp({
        context,
        routes: teamsBrowserConnectRoutes,
        baseUrl: apiOrigin,
      })(teamsBrowserConnectContract).connect({ query }),
      [307],
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(appOrigin);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("redirect_url")).toBe(
      `${apiOrigin}/api/teams/connect?${new URLSearchParams(query).toString()}`,
    );
  });

  it("teams-browser-connect-002 sends the signed-in member to Microsoft OAuth for their active account", async () => {
    const apiOrigin = "https://api-teams-connect.okou.test";
    mockEnv("OKOU_API_BACKEND_URL", apiOrigin);
    const member = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    await memberships.set(seedOrgMembership$, member, context.signal);
    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      "org:member",
    );

    const response = await accept(
      setupApp({ context, routes: teamsBrowserConnectRoutes })(
        teamsBrowserConnectContract,
      ).connect({
        query: {
          tenantId: `tenant-${randomUUID()}`,
          teamsUserId: `29:user-${randomUUID()}`,
          orgId: `org_${randomUUID()}`,
        },
        extraHeaders: { authorization: "Bearer clerk-session" },
      }),
      [307],
    );

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(apiOrigin);
    expect(location.pathname).toBe("/api/teams/oauth/connect");
    expect(Object.fromEntries(location.searchParams)).toStrictEqual({
      orgId: member.orgId,
      userId: member.userId,
    });
  });
});
