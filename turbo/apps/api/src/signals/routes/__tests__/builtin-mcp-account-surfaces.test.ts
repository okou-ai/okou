import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "vitest";
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
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  clearApiTestConnectorCatalogExternalReaderIdentityReplacements,
  installApiTestConnectorCatalog,
  setApiTestConnectorCatalogExternalReaderIdentityReadHook,
} from "../../../test-fixtures/connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsRoutes } from "../connectors";
import { agentsRoutes } from "../agents";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

describe("builtin MCP account surfaces", () => {
  const context = testContext();
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
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
    clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
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
          headers,
          params: { connectionId },
          body: { target },
        }),
        [200],
      );
    }
  });

  it("includes MCP in catalog discovery, search and category totals", async () => {
    authenticate();
    const listed = await accept(catalog().list({ headers }), [200]);
    const discovery = await accept(
      catalog().discovery({ headers, query: { category: "test-connectors" } }),
      [200],
    );
    expect(discovery.body.totalConnectorCount).toBe(
      listed.body.connectors.length,
    );
    expect(discovery.body.categoryConnectorCounts?.["test-connectors"]).toBe(
      discovery.body.connectors.length,
    );
    expect(discovery.body.connectors).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "public-mcp" }),
        expect.objectContaining({ slug: "manual-mcp" }),
      ]),
    );
    const search = await accept(
      setupApp({ context, routes })(connectorsSearchContract).search({
        headers,
        query: { keyword: "public-mcp" },
      }),
      [200],
    );
    expect(search.body.connectors).toMatchObject([
      { slug: "public-mcp", label: "Public Tools" },
    ]);
    const detail = await accept(
      catalog().get({
        headers,
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
        headers,
        params: { connectorSlug: target.connectorSlug },
      }),
      [404],
    );
  });

  it("connects and manages MCP accounts through ordinary connector endpoints", async () => {
    authenticate();
    const connected = await accept(
      setupApp({ context, routes })(connectorNoAuthGrantContract).connect({
        headers,
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
    expect(summaries.body.summaries).toMatchObject([
      { target, accountCount: 1, defaultConnection: { id: connectionId } },
    ]);
    const list = await accept(
      setupApp({ context, routes })(connectorsMainContract).list({ headers }),
      [200],
    );
    expect(list.body.connectors).toMatchObject([
      { slug: target.connectorSlug, connectionStatus: "connected" },
    ]);
    const [
      connections,
      account,
      scopeDiff,
      impact,
      inspection,
      detail,
      defaultScopeDiff,
    ] = await Promise.all([
      accept(accounts().connections({ headers, query: target }), [200]),
      accept(
        accounts().connection({
          headers,
          params: { connectionId },
          query: target,
        }),
        [200],
      ),
      accept(
        accounts().scopeDiff({
          headers,
          params: { connectionId },
          query: { connectorSlug: target.connectorSlug },
        }),
        [200],
      ),
      accept(
        accounts().deletionImpact({
          headers,
          params: { connectionId },
          query: target,
        }),
        [200],
      ),
      accept(
        accounts().inspect({
          headers,
          body: { selections: [{ target, connectionId }] },
        }),
        [200],
      ),
      accept(
        setupApp({ context, routes })(connectorsBySlugContract).get({
          headers,
          params: { connectorSlug: target.connectorSlug },
        }),
        [200],
      ),
      accept(
        setupApp({ context, routes })(connectorScopeDiffContract).getScopeDiff({
          headers,
          params: { connectorSlug: target.connectorSlug },
        }),
        [200],
      ),
    ]);
    expect(connections.body.connections).toMatchObject([
      { id: connectionId, target },
    ]);
    expect(account.body).toMatchObject({ id: connectionId, target });
    expect(scopeDiff.body).toMatchObject({
      addedScopes: [],
      removedScopes: [],
    });
    expect(impact.body).toMatchObject({
      connectionId,
      explicitSelectionCount: 0,
    });
    expect(inspection.body.results).toMatchObject([
      { kind: "available", connectionId, target },
    ]);
    expect(detail.body).toMatchObject({ slug: target.connectorSlug });
    expect(defaultScopeDiff.body).toMatchObject({
      addedScopes: [],
      removedScopes: [],
    });
    await accept(
      accounts().setDefault({
        headers,
        params: { connectionId },
        body: { target },
      }),
      [200],
    );
    const current = await accept(
      accounts().connection({
        headers,
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

  it("replaces and removes MCP Agent grants through the ordinary connector list", async () => {
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
        headers,
        params,
        body: { enabledConnectorSlugs: ["public-mcp", "github"] },
      }),
      [200],
    );
    const visible = await accept(client.get({ headers, params }), [200]);
    expect(new Set(visible.body.enabledConnectorSlugs)).toStrictEqual(
      new Set(["public-mcp", "github"]),
    );
    const replaced = await accept(
      client.update({
        headers,
        params,
        body: { enabledConnectorSlugs: ["slack"] },
      }),
      [200],
    );
    expect(replaced.body.enabledConnectorSlugs).toStrictEqual(["slack"]);
    const actual = await accept(client.get({ headers, params }), [200]);
    expect(actual.body.enabledConnectorSlugs).toStrictEqual(["slack"]);
    await accept(
      client.update({
        headers,
        params,
        body: { enabledConnectorSlugs: ["public-mcp"], operation: "add" },
      }),
      [200],
    );
    const removed = await accept(
      client.update({
        headers,
        params,
        body: { enabledConnectorSlugs: ["public-mcp"], operation: "remove" },
      }),
      [200],
    );
    expect(removed.body.enabledConnectorSlugs).toStrictEqual(["slack"]);
  });

  it("manages selected MCP accounts and keeps reads available during catalog outages", async () => {
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `test-mcp-selection-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog({ runtimeProjection: true });
    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "Scoped MCP selections",
    });
    createdAgents.push(agent.agentId);
    await accept(
      setupApp({ context, routes })(userConnectorsContract).update({
        headers,
        params: { id: agent.agentId },
        body: { enabledConnectorSlugs: [target.connectorSlug] },
      }),
      [200],
    );
    const connected = await accept(
      setupApp({ context, routes })(connectorNoAuthGrantContract).connect({
        headers,
        params: { connectorSlug: target.connectorSlug },
        body: { authMethod: "none", account: { intent: "add" } },
      }),
      [200],
    );
    const connectionId = connected.body.id;
    createdAccounts.push(connectionId);
    const selection = { target, connectionId };
    const threads = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadsContract,
    );
    const selections = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadConnectorSelectionContract,
    );
    const threadBody = {
      agentId: agent.agentId,
      model: "claude-sonnet-5" as const,
      connectorSelections: [selection],
    };
    const createdThread = await accept(
      threads.create({ headers, body: threadBody }),
      [201],
    );
    const params = { id: createdThread.body.id };

    // The accepted PostgreSQL projection remains readable while the complete
    // catalog snapshot is unavailable at its external-reader boundary.
    setApiTestConnectorCatalogExternalReaderIdentityReadHook(() => {
      return Promise.reject(new Error("Full catalog read is unavailable"));
    });
    const selected = await accept(selections.get({ headers, params }), [200]);
    expect(selected.body.selections).toStrictEqual([selection]);
    expect(selected.body.selectedConnections).toMatchObject([
      { id: connectionId, target, connectionStatus: "connected" },
    ]);
    const inspected = await accept(
      accounts().inspect({ headers, body: { selections: [selection] } }),
      [200],
    );
    expect(inspected.body.results).toMatchObject([
      { kind: "available", connectionId, target },
    ]);
    await accept(selections.clear({ headers, params, body: target }), [204]);
    const cleared = await accept(selections.get({ headers, params }), [200]);
    expect(cleared.body).toStrictEqual({
      selections: [],
      selectedConnections: [],
    });
    clearApiTestConnectorCatalogExternalReaderIdentityReplacements();
    await accept(
      selections.update({ headers, params, body: selection }),
      [200],
    );
    const restored = await accept(selections.get({ headers, params }), [200]);
    expect(restored.body.selections).toStrictEqual([selection]);
  });
});
