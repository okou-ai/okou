import { randomUUID } from "node:crypto";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { builtinConnectorsSearchContract } from "@okouai/api-contracts/contracts/connectors";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { builtinConnectorsRoutes } from "../connectors";
import { cronConnectorCatalogRoutes } from "../cron-connector-catalog";
import { customConnectorsRoutes } from "../custom-connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signInAdmin() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

describe("connector catalog v4 preparation", () => {
  it("cron-connector-catalog-v4-009 finds the current Monday MCP connector by name and slug", async () => {
    signInAdmin();
    const search = setupApp({ context, routes: builtinConnectorsRoutes })(
      builtinConnectorsSearchContract,
    );
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );

    for (const keyword of ["Monday.com", "monday-mcp"]) {
      const searched = await accept(
        search.search({ headers, query: { keyword } }),
        [200],
      );
      const discovered = await accept(
        catalog.discovery({ headers, query: { keyword } }),
        [200],
      );

      expect(searched.body.connectors[0]?.slug).toBe("monday-mcp");
      expect(discovered.body.connectors[0]?.slug).toBe("monday-mcp");
    }
  });

  it("cron-connector-catalog-v4-006 keeps serving the catalog when its source is unavailable", async () => {
    signInAdmin();
    context.mocks.s3.send.mockRejectedValue(
      Object.assign(new Error("The specified key does not exist."), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const cron = setupApp({ context, routes: cronConnectorCatalogRoutes })(
      cronConnectorCatalogContract,
    );

    const before = await accept(catalog.list({ headers }), [200]);
    const synced = await accept(
      cron.sync({
        headers: { authorization: `Bearer ${env("CRON_SECRET")}` },
      }),
      [200],
    );
    const after = await accept(catalog.list({ headers }), [200]);

    expect(synced.body).toStrictEqual({
      outcome: "rejected",
      failureCode: "source-unavailable",
    });
    expect(after.body).toStrictEqual(before.body);
  });

  it("cron-connector-catalog-v4-010 does not expose an MCP transport as an executable HTTP permission bundle", async () => {
    signInAdmin();
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const customConnectors = setupApp({
      context,
      routes: customConnectorsRoutes,
    })(customConnectorsContract);

    const detail = await accept(
      catalog.get({ headers, params: { connectorSlug: "plaud-mcp" } }),
      [200],
    );
    const created = await accept(
      customConnectors.create({
        headers,
        body: {
          displayName: "Plaud over HTTP",
          prefixTemplates: [`https://api-${randomUUID()}.example.test/v1/`],
          fields: [],
          headerInjections: [],
          queryInjections: [],
          authMode: "none",
          permissionBundleRef: "builtin:plaud-mcp@1",
        },
      }),
      [400],
    );

    expect(
      detail.body.connector.authMethods.map((method) => {
        return method.grantKind;
      }),
    ).toContain("automatic");
    expect(created.body.error.message).toBe(
      "Unknown custom connector permission bundle: builtin:plaud-mcp@1",
    );
  });
});
