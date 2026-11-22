import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "vitest";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  builtinConnectorNoAuthGrantContract,
  builtinConnectorsMainContract,
  builtinConnectorsSearchContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatConnectorAccessApi } from "./helpers/chat-connector-access";
import { createRouteMocks } from "./helpers/route-test";

describe("builtin MCP account surfaces", () => {
  const context = testContext();
  const mocks = createRouteMocks(context);
  const headers = { authorization: "Bearer clerk-session" };
  const target = { kind: "builtin", connectorSlug: "public-mcp" } as const;
  const routes = [
    ...connectorCatalogRoutes,
    ...connectorAccountRoutes,
    ...builtinConnectorsRoutes,
  ];
  function accounts() {
    return setupApp({ context, routes })(connectorAccountsContract);
  }
  function catalog() {
    return setupApp({ context, routes })(connectorCatalogContract);
  }
  const createdAccounts: string[] = [];

  function authenticate() {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  }

  afterEach(async () => {
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
      setupApp({ context, routes })(builtinConnectorsSearchContract).search({
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
      setupApp({ context, routes })(
        builtinConnectorNoAuthGrantContract,
      ).connect({
        headers,
        params: { connectorSlug: target.connectorSlug },
        body: {
          authMethod: "none",
          account: { intent: "add", displayName: "Research" },
        },
      }),
      [200],
    );
    const connectionId = connected.body.connectionId;
    createdAccounts.push(connectionId);
    const list = await accept(
      setupApp({ context, routes })(builtinConnectorsMainContract).list({
        headers,
      }),
      [200],
    );
    expect(list.body.connectors).toMatchObject([
      { slug: target.connectorSlug, connectionStatus: "connected" },
    ]);
    const [connections, account, scopeDiff, impact, inspection] =
      await Promise.all([
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
      ]);
    expect(connections.body.connections).toMatchObject([
      { id: connectionId, target },
    ]);
    expect(connections.body.defaultConnection).toMatchObject({
      id: connectionId,
      target,
    });
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

  it("manages selected MCP accounts and keeps reads available during catalog outages", async () => {
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `test-mcp-selection-${randomUUID()}`,
    );

    const bdd = createBddApi(context);
    const runs = createRunsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    await runs.grantProEntitlement(actor);
    await runs.ensurePersonalSubscriptionModel(actor);
    const connected = await accept(
      setupApp({ context, routes })(
        builtinConnectorNoAuthGrantContract,
      ).connect({
        headers,
        params: { connectorSlug: target.connectorSlug },
        body: { authMethod: "none", account: { intent: "add" } },
      }),
      [200],
    );
    const connectionId = connected.body.connectionId;
    createdAccounts.push(connectionId);
    const selection = { target, connectionId };
    const threads = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadsContract,
    );
    const selections = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadConnectorSelectionContract,
    );
    const createdThread = await accept(
      threads.create({
        headers,
        body: { model: "claude-sonnet-5-5" },
      }),
      [201],
    );
    const params = { id: createdThread.body.id };
    await accept(
      selections.update({ headers, params, body: selection }),
      [200],
    );
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
    const access = createChatConnectorAccessApi(context);
    await access.setThreadOverride(actor, params.id, selection, false);
    const cleared = await accept(selections.get({ headers, params }), [200]);
    expect(cleared.body).toStrictEqual({
      selections: [],
      selectedConnections: [],
    });
    await access.setThreadOverride(actor, params.id, selection, true);
    await accept(
      selections.update({ headers, params, body: selection }),
      [200],
    );
    const restored = await accept(selections.get({ headers, params }), [200]);
    expect(restored.body.selections).toStrictEqual([selection]);
  });
});
