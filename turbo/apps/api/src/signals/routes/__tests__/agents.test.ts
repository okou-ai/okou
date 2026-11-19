import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const mocks = createRouteMocks(context);

describe("PUT /api/agents/:id/user-connectors", () => {
  it("updates canonical connector slugs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});
    const headers = { authorization: "Bearer clerk-session" };

    const created = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers,
        body: {},
      }),
      [201],
    );
    const client = setupApp({ context, routes: agentsRoutes })(
      userBuiltinConnectorsContract,
    );
    const params = { id: created.body.agentId };

    const canonical = await accept(
      client.update({
        params,
        body: { enabledConnectorSlugs: ["slack"] },
        headers,
      }),
      [200],
    );
    expect(canonical.body).toStrictEqual({
      enabledConnectorSlugs: ["slack"],
    });

    const added = await accept(
      client.update({
        params,
        body: {
          enabledConnectorSlugs: ["github"],
          operation: "add",
        },
        headers,
      }),
      [200],
    );
    expect(new Set(added.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "slack"]),
    );
  });
});
