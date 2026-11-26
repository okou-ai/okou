import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);

function api() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}

describe("GET /api/mcp-connectors", () => {
  it("mcp-connectors-004 requires an agent token to read connectors", async () => {
    const admin = bdd.user();

    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    const anonymous = await accept(api().list({ headers: {} }), [401]);
    createRouteMocks(context).clerk.session(
      admin.userId,
      admin.orgId,
      admin.orgRole,
    );
    const session = await accept(
      api().list({ headers: { authorization: "Bearer clerk-session" } }),
      [403],
    );

    expect(anonymous.status).toBe(401);
    expect(session.status).toBe(403);
  });
});
