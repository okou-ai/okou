import { builtinConnectorsBySlugContract } from "@okouai/api-contracts/contracts/connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { breakCurrentConnectorCatalogEntriesExcept } from "../../../test-fixtures/connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { userPermissionGrantsRoutes } from "../user-permission-grants";
import { createBddApi } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const AUTH_HEADERS = { authorization: "Bearer clerk-session" } as const;

// Every other current entry has an icon key that fails whole-catalog runtime
// materialization, so these requests succeed only when they read the slugs
// they name.
describe("slug-targeted connector catalog readers", () => {
  it("applies and lists permission grants from the named connector only", async () => {
    await setupApp({ context, routes: [], isolatePg: true });
    const bdd = createBddApi(context);
    const actor = bdd.user({ orgRole: "org:member" });
    bdd.acceptAgentStorageWrites();
    const agent = await bdd.createAgent(actor, {});
    await breakCurrentConnectorCatalogEntriesExcept(["slack"]);
    mocks.clerk.session(actor.userId, actor.orgId, "org:member");

    const grants = setupApp({ context, routes: userPermissionGrantsRoutes })(
      userPermissionGrantsContract,
    );
    await accept(
      grants.apply({
        body: {
          agentId: agent.agentId,
          connectorSlug: "slack",
          mode: "patch",
          grants: [{ permission: "chat:write", action: "deny" }],
        },
        headers: AUTH_HEADERS,
      }),
      [200],
    );
    const listed = await accept(
      grants.list({ query: { agentId: agent.agentId }, headers: AUTH_HEADERS }),
      [200],
    );
    expect(
      listed.body.map((grant) => {
        return [grant.connectorSlug, grant.permission, grant.action];
      }),
    ).toStrictEqual([["slack", "chat:write", "deny"]]);
  });

  it("connects and reads a builtin account from its own entry", async () => {
    await setupApp({ context, routes: [], isolatePg: true });
    const actor = createBddApi(context).user();
    await breakCurrentConnectorCatalogEntriesExcept(["openai"]);

    const connected = await createConnectorBddApi(context).connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "targeted-catalog-secret" },
    );
    mocks.clerk.session(actor.userId, actor.orgId);
    const read = await accept(
      setupApp({ context, routes: builtinConnectorsRoutes })(
        builtinConnectorsBySlugContract,
      ).get({ params: { connectorSlug: "openai" }, headers: AUTH_HEADERS }),
      [200],
    );
    expect(read.body).toMatchObject({
      id: connected.id,
      slug: "openai",
      authMethod: "api-token",
    });
  });
});
