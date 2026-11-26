import { randomUUID } from "node:crypto";
import {
  connectorAccountsContract,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  chatThreadConnectorSelectionContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  builtinConnectorNoAuthGrantContract,
  builtinConnectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { describe, expect, it } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadConnectorSelectionRoutes } from "../chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { connectorAccountRoutes } from "../connector-accounts";
import { builtinConnectorsRoutes } from "../connectors";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [
    ...builtinConnectorsRoutes,
    ...connectorAccountRoutes,
    ...chatThreadCreateRoutes,
    ...chatThreadConnectorSelectionRoutes,
    ...chatConnectorAccessRoutes,
  ],
});
const target: ConnectorAccountTarget = Object.freeze({
  kind: "builtin",
  connectorSlug: "public-mcp",
});

function signIn() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );
}

async function connectResearch() {
  const connected = await accept(
    app(builtinConnectorNoAuthGrantContract).connect({
      headers,
      params: { connectorSlug: "public-mcp" },
      body: {
        authMethod: "none",
        account: { intent: "add", displayName: "Research" },
      },
    }),
    [200],
  );
  return connected.body.connectionId;
}

describe("builtin MCP account surfaces", () => {
  it("builtin-mcp-account-surfaces-003 manages a Chat's MCP account selection through disable and re-enable", async () => {
    signIn();
    const [connectionId, thread] = await Promise.all([
      connectResearch(),
      accept(
        app(chatThreadsContract).create({ headers, body: { model: null } }),
        [201],
      ),
    ]);
    const threadId = thread.body.id;
    const selection = { connectionId, target };
    const selections = app(chatThreadConnectorSelectionContract);
    const readSelections = async () => {
      return (
        await accept(
          selections.get({ headers, params: { id: threadId } }),
          [200],
        )
      ).body;
    };
    const setOverride = (enabled: boolean) => {
      return accept(
        app(chatConnectorAccessContract).setThreadOverride({
          headers,
          params: { threadId, connectionId },
          body: { target, enabled },
        }),
        [200],
      );
    };
    const select = async () => {
      const updated = await accept(
        selections.update({
          headers,
          params: { id: threadId },
          body: selection,
        }),
        [200],
      );
      expect(updated.body).toStrictEqual(selection);
    };

    await select();
    const selected = await readSelections();
    expect(selected.selections).toStrictEqual([selection]);
    expect(
      selected.selectedConnections.map((account) => {
        return [account.id, account.connectionStatus];
      }),
    ).toStrictEqual([[connectionId, "connected"]]);
    const inspection = await accept(
      app(connectorAccountsContract).inspect({
        headers,
        body: { selections: [selection] },
      }),
      [200],
    );
    expect(inspection.body.results[0]?.kind).toBe("available");

    await setOverride(false);
    await expect(readSelections()).resolves.toStrictEqual({
      selections: [],
      selectedConnections: [],
    });

    await setOverride(true);
    await select();
    const restored = await readSelections();
    expect(restored.selections).toStrictEqual([selection]);
  });

  it("builtin-mcp-account-surfaces-002 manages a public MCP account through ordinary connector endpoints", async () => {
    signIn();
    const connectionId = await connectResearch();
    const accounts = app(connectorAccountsContract);

    const [list, connections, detail, scopeDiff, impact, inspection] =
      await Promise.all([
        accept(app(builtinConnectorsMainContract).list({ headers }), [200]),
        accept(
          accounts.connections({
            headers,
            query: { kind: "builtin", connectorSlug: "public-mcp", limit: 50 },
          }),
          [200],
        ),
        accept(
          accounts.connection({
            headers,
            params: { connectionId },
            query: target,
          }),
          [200],
        ),
        accept(
          accounts.scopeDiff({
            headers,
            params: { connectionId },
            query: { connectorSlug: "public-mcp" },
          }),
          [200],
        ),
        accept(
          accounts.deletionImpact({
            headers,
            params: { connectionId },
            query: target,
          }),
          [200],
        ),
        accept(
          accounts.inspect({
            headers,
            body: { selections: [{ connectionId, target }] },
          }),
          [200],
        ),
      ]);

    expect(
      list.body.connectors.find((connector) => {
        return connector.slug === "public-mcp";
      }),
    ).toMatchObject({ id: connectionId, connectionStatus: "connected" });
    expect(
      connections.body.connections.map((account) => {
        return account.id;
      }),
    ).toStrictEqual([connectionId]);
    expect(connections.body.defaultConnection?.id).toBe(connectionId);
    expect(detail.body).toMatchObject({
      id: connectionId,
      target,
      displayName: "Research",
    });
    expect(scopeDiff.body.addedScopes).toStrictEqual([]);
    expect(scopeDiff.body.removedScopes).toStrictEqual([]);
    expect(impact.body).toMatchObject({
      connectionId,
      explicitSelectionCount: 0,
    });
    expect(inspection.body.results).toHaveLength(1);
    expect(inspection.body.results[0]).toMatchObject({
      kind: "available",
      connectionId,
      target,
    });

    const defaulted = await accept(
      accounts.setDefault({
        headers,
        params: { connectionId },
        body: { target },
      }),
      [200],
    );
    expect(defaulted.body).toMatchObject({ id: connectionId, isDefault: true });
    const reread = await accept(
      accounts.connection({ headers, params: { connectionId }, query: target }),
      [200],
    );
    expect(reread.body).toMatchObject({
      id: connectionId,
      target,
      displayName: "Research",
    });
  });
});
