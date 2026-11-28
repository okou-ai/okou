import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { expect, test } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { customConnectorsGetRoutes } from "../custom-connectors-get";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
} from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);

test("agent-custom-connectors-001 returns the permission bundle of a custom connector", async () => {
  const member = bdd.user();
  const connector = await connectors.createCustomConnector(
    member,
    manualHttpCustomConnectorCreateBody({
      displayName: "Slack relay",
      prefixTemplates: ["https://slack-relay.example.test/"],
      permissionBundleRef: "builtin:slack@1",
    }),
  );

  createRouteMocks(context).clerk.session(
    member.userId,
    member.orgId,
    member.orgRole,
  );
  const response = await accept(
    setupApp({ context, routes: customConnectorsGetRoutes })(
      customConnectorByIdContract,
    ).permissions({
      params: { id: connector.id },
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );

  expect(response.body.ref).toBe("builtin:slack@1");
  expect(
    response.body.permissions.map((p) => {
      return p.name;
    }),
  ).toContain("chat:write");
  expect(response.body.defaultPolicies["chat:write"]).toBe("deny");
});
