import { randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { runnersBuiltinFirewallsResolveContract } from "@okouai/api-contracts/contracts/runners";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { runnersRoutes } from "../runners";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

test("preview-connector-catalog.catalog-generation-001 serves the active catalog through discovery, detail and Runner firewall lookup", async () => {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
    connectorCatalogContract,
  );
  const firewalls = setupApp({ context, routes: runnersRoutes })(
    runnersBuiltinFirewallsResolveContract,
  );

  const list = await accept(catalog.list({ headers }), [200]);
  const detail = await accept(
    catalog.get({ headers, params: { connectorSlug: "gitlab" } }),
    [200],
  );
  const discovery = await accept(
    catalog.discovery({ headers, query: { keyword: "gitlab" } }),
    [200],
  );
  const resolved = await accept(
    firewalls.resolve({
      headers: {
        authorization: `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`,
      },
      body: { names: ["github", "gitlab"] },
    }),
    [200],
  );

  const listedSlugs = list.body.connectors.map((connector) => {
    return connector.slug;
  });
  expect(listedSlugs).toStrictEqual(
    expect.arrayContaining(["github", "gitlab"]),
  );
  expect(detail.body.connector).toMatchObject({
    slug: "gitlab",
    label: "GitLab",
  });
  expect(
    discovery.body.connectors.map((connector) => {
      return connector.slug;
    }),
  ).toContain("gitlab");
  expect(Object.keys(resolved.body.firewalls).sort()).toStrictEqual([
    "github",
    "gitlab",
  ]);
});
