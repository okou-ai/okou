import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "vitest";
import {
  CONNECTOR_CONTRACT_HEADER,
  CONNECTOR_CONTRACT_BUILTIN_MCP_V1,
} from "@okouai/api-contracts/contracts/client-headers";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorNoAuthGrantContract,
  connectorScopeDiffContract,
  connectorsBySlugContract,
  connectorsMainContract,
  connectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  agentsMainContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsRoutes } from "../connectors";
import { agentsRoutes } from "../agents";
import { createRouteMocks } from "./helpers/route-test";

describe("builtin MCP client compatibility", () => {
  const context = testContext();
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
  const capableHeaders = {
    ...headers,
    [CONNECTOR_CONTRACT_HEADER]: CONNECTOR_CONTRACT_BUILTIN_MCP_V1,
  };
  const target = { kind: "builtin", connectorSlug: "public-mcp" } as const;
  const routes = [
    ...connectorCatalogRoutes,
    ...connectorAccountRoutes,
    ...connectorsRoutes,
    ...agentsRoutes,
  ];
  function accounts() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }
  function catalog() {
    return setupApp({ context, routes })(connectorCatalogContract);
  }
  const createdAccounts: string[] = [];
  const createdAgents: string[] = [];

  function authenticate() {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  }

  afterEach(async () => {
    for (const id of createdAgents.splice(0)) {
      await accept(
        setupApp({ context, routes })(agentsByIdContract).delete({
          headers,
          params: { id },
        }),
        [204],
      );
    }
    for (const connectionId of createdAccounts.splice(0)) {
      await accept(
        accounts().delete({
          headers: capableHeaders,
          params: { connectionId },
          body: { target },
        }),
        [200],
      );
    }
  });

  it("projects one compatible inventory through catalog, search and category totals", async () => {
    authenticate();
    const legacy = await accept(
      catalog().discovery({ headers, query: {} }),
      [200],
    );
    const capable = await accept(
      catalog().discovery({ headers: capableHeaders, query: {} }),
      [200],
    );
    expect(capable.body.totalConnectorCount).toBe(
      legacy.body.totalConnectorCount + 2,
    );
    expect(capable.body.categoryConnectorCounts?.["test-connectors"]).toBe(
      (legacy.body.categoryConnectorCounts?.["test-connectors"] ?? 0) + 2,
    );
    const search = setupApp({ context, routes })(connectorsSearchContract);
    const oldSearch = await accept(
      search.search({ headers, query: { keyword: "public-mcp" } }),
      [200],
    );
    const newSearch = await accept(
      search.search({
        headers: capableHeaders,
        query: { keyword: "public-mcp" },
      }),
      [200],
    );
    expect(oldSearch.body.connectors).toStrictEqual([]);
    expect(newSearch.body.connectors).toMatchObject([
      { slug: "public-mcp", label: "Public Tools" },
    ]);
    const detail = await accept(
      catalog().get({
        headers: capableHeaders,
        params: { connectorSlug: target.connectorSlug },
      }),
      [200],
    );
    expect(detail.body.connector.mcp).toMatchObject({
      transport: "streamable-http",
    });
    expect(detail.body.connector.permissionSummary.hasPermissions).toBeFalsy();
    await accept(
      catalog().permissions({
        headers: capableHeaders,
        params: { connectorSlug: target.connectorSlug },
      }),
      [404],
    );
  });

  it.each([undefined, "unknown-contract"])(
    "rejects an incompatible direct connection before persistence (%s)",
    async (contract) => {
      authenticate();
      const result = await accept(
        setupApp({ context, routes })(connectorNoAuthGrantContract).connect({
          headers,
          extraHeaders:
            contract === undefined
              ? undefined
              : { [CONNECTOR_CONTRACT_HEADER]: contract },
          params: { connectorSlug: target.connectorSlug },
          body: { authMethod: "none", account: { intent: "add" } },
        }),
        [426],
      );
      expect(result.body.error.code).toBe("CONNECTOR_CLIENT_UPGRADE_REQUIRED");
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      const remaining = await accept(
        accounts().connections({
          headers: capableHeaders,
          query: { ...target, limit: 50 },
        }),
        [200],
      );
      expect(remaining.body.connections).toStrictEqual([]);
    },
  );

  it("keeps builtin accounts usable for capable clients while older account collections remain HTTP-compatible", async () => {
    authenticate();
    const connected = await accept(
      setupApp({ context, routes })(connectorNoAuthGrantContract).connect({
        headers: capableHeaders,
        params: { connectorSlug: target.connectorSlug },
        body: {
          authMethod: "none",
          account: { intent: "add", displayName: "Research" },
        },
      }),
      [200],
    );
    const connectionId = connected.body.id;
    createdAccounts.push(connectionId);
    const summaries = await accept(accounts().summaries({ headers }), [200]);
    expect(summaries.body.summaries).toStrictEqual([]);
    const list = await accept(
      setupApp({ context, routes })(connectorsMainContract).list({ headers }),
      [200],
    );
    expect(list.body.connectors).toStrictEqual([]);
    const incompatibleReads = await Promise.all([
      accept(accounts().connections({ headers, query: target }), [426]),
      accept(
        accounts().connection({
          headers,
          params: { connectionId },
          query: target,
        }),
        [426],
      ),
      accept(
        accounts().scopeDiff({
          headers,
          params: { connectionId },
          query: { connectorSlug: target.connectorSlug },
        }),
        [426],
      ),
      accept(
        accounts().inspect({
          headers,
          body: { selections: [{ target, connectionId }] },
        }),
        [426],
      ),
      accept(
        setupApp({ context, routes })(connectorsBySlugContract).get({
          headers,
          params: { connectorSlug: target.connectorSlug },
        }),
        [426],
      ),
      accept(
        setupApp({ context, routes })(connectorScopeDiffContract).getScopeDiff({
          headers,
          params: { connectorSlug: target.connectorSlug },
        }),
        [426],
      ),
    ]);
    for (const result of incompatibleReads) {
      expect(result.body.error.code).toBe("CONNECTOR_CLIENT_UPGRADE_REQUIRED");
      expect(result.headers.get("Cache-Control")).toBe("no-store");
    }
    await accept(
      accounts().setDefault({
        headers,
        params: { connectionId },
        body: { target },
      }),
      [426],
    );
    const current = await accept(
      accounts().connection({
        headers: capableHeaders,
        params: { connectionId },
        query: target,
      }),
      [200],
    );
    expect(current.body).toMatchObject({
      id: connectionId,
      displayName: "Research",
      target,
    });
  });

  it("preserves hidden MCP grants when an older client replaces its visible Agent connector list", async () => {
    authenticate();
    context.mocks.s3.send.mockResolvedValue({});
    const created = await accept(
      setupApp({ context, routes })(agentsMainContract).create({
        headers,
        body: {},
      }),
      [201],
    );
    const params = { id: created.body.agentId };
    createdAgents.push(params.id);
    const client = setupApp({ context, routes })(userConnectorsContract);
    await accept(
      client.update({
        headers: capableHeaders,
        params,
        body: { enabledConnectorSlugs: ["public-mcp", "github"] },
      }),
      [200],
    );
    const visible = await accept(client.get({ headers, params }), [200]);
    expect(visible.body.enabledConnectorSlugs).toStrictEqual(["github"]);
    const replaced = await accept(
      client.update({
        headers,
        params,
        body: { enabledConnectorSlugs: ["slack"] },
      }),
      [200],
    );
    expect(replaced.body.enabledConnectorSlugs).toStrictEqual(["slack"]);
    await accept(
      client.update({
        headers,
        params,
        body: { enabledConnectorSlugs: ["public-mcp"], operation: "remove" },
      }),
      [426],
    );
    const actual = await accept(
      client.get({ headers: capableHeaders, params }),
      [200],
    );
    expect(new Set(actual.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["public-mcp", "slack"]),
    );
  });
});
