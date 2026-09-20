import { randomUUID } from "node:crypto";

import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import { agentsRoutes } from "../agents";

const context = testContext();
const mocks = createRouteMocks(context);

describe("GET /api/agents/:id/user-connectors", () => {
  it("keeps connector grants when their discovery feature switch is disabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const actor = { userId, orgId };
    mocks.clerk.session(userId, orgId);
    context.mocks.s3.send.mockResolvedValue({});

    const created = await accept(
      setupApp({ context, routes: agentsRoutes })(agentsMainContract).create({
        headers: { authorization: "Bearer clerk-session" },
        body: {},
      }),
      [201],
    );
    const agentId = created.body.agentId;

    const client = setupApp({ context, routes: agentsRoutes })(
      userBuiltinConnectorsContract,
    );

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    await accept(
      client.update({
        params: { id: agentId },
        body: { enabledConnectorSlugs: ["test-oauth", "github"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    // Connector feature switches only govern discovery. A connector already
    // granted to an agent remains usable when its discovery switch is disabled.
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(new Set(response.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["github", "test-oauth"]),
    );
    await deleteFeatureSwitchesForUser(context, actor);
  });

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
