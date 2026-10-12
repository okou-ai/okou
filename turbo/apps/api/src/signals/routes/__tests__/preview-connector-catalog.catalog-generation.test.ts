import { randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { runnersBuiltinFirewallsResolveContract } from "@okouai/api-contracts/contracts/runners";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { createRouteMocks } from "./helpers/route-test";
import { connectorCatalogRoutes } from "../connector-catalog";
import { runnersRoutes } from "../runners";

const context = testContext();

test("serves the existing catalog through discovery, detail and authenticated Runner firewall lookup", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const client = setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
  const listed = await accept(client.list({ headers }), [200]);
  expect(
    listed.body.connectors.map((entry) => {
      return entry.slug;
    }),
  ).toStrictEqual(expect.arrayContaining(["github", "gitlab"]));
  const detail = await accept(
    client.get({ headers, params: { connectorSlug: "gitlab" } }),
    [200],
  );
  expect(detail.body.connector.slug).toBe("gitlab");
  expect(detail.body.connector.label).toBe("GitLab");
  const discovery = await accept(
    client.discovery({ headers, query: { keyword: "gitlab" } }),
    [200],
  );
  expect(
    discovery.body.connectors.map((entry) => {
      return entry.slug;
    }),
  ).toContain("gitlab");
  const firewalls = await accept(
    setupApp({ context, routes: runnersRoutes })(
      runnersBuiltinFirewallsResolveContract,
    ).resolve({
      headers: {
        authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
      },
      body: { names: ["github", "gitlab"] },
    }),
    [200],
  );
  expect(Object.keys(firewalls.body.firewalls).sort()).toStrictEqual([
    "github",
    "gitlab",
  ]);
});
