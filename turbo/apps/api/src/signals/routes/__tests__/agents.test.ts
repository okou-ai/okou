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

  it("applies independent Drive grants when another agent is missing", async () => {
    const headers = { authorization: "Bearer clerk-session" };
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    context.mocks.s3.send.mockResolvedValue({});
    const app = setupApp({ context, routes: agentsRoutes });
    const agents = await Promise.all(
      ["First agent", "Second agent"].map((displayName) => {
        return accept(
          app(agentsMainContract).create({
            headers,
            body: { displayName, visibility: "private" },
          }),
          [201],
        );
      }),
    );
    const agentIds = agents.map(({ body }) => {
      return body.agentId;
    });
    const updates = await Promise.all(
      [randomUUID(), ...agentIds].map((id) => {
        return app(userBuiltinConnectorsContract).update({
          headers,
          params: { id },
          body: { enabledConnectorSlugs: ["google-drive"], operation: "add" },
        });
      }),
    );
    expect(
      updates.map(({ status }) => {
        return status;
      }),
    ).toStrictEqual([404, 200, 200]);
    expect(
      updates.slice(1).map(({ body }) => {
        return body;
      }),
    ).toStrictEqual([
      { enabledConnectorSlugs: ["google-drive"] },
      { enabledConnectorSlugs: ["google-drive"] },
    ]);
  });
});
