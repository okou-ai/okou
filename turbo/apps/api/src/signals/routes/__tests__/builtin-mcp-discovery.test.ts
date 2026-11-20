import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import {
  createChatEventsFixture,
  okouTokenFromExecution,
} from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const chat = createChatEventsFixture(context);

function client() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}
async function discovery(token: string) {
  return await accept(
    client().list({ headers: { authorization: `Bearer ${token}` } }),
    [200],
  );
}

describe("builtin MCP discovery authority", () => {
  it("refreshes discovery as Chat accounts become available and are deleted", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const { actor, agentId } = owned;

      const absentRun = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Discover without a binding",
      });
      const absentExecution = await owned.runExecution(absentRun.runId);
      const absentToken = okouTokenFromExecution(absentExecution.execution);
      expect((await discovery(absentToken)).body.connectors).toStrictEqual([]);
      const account = await connectors.connectManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        { apiKey: "owned-default" },
      );
      expect((await discovery(absentToken)).body.connectors).toMatchObject([
        { connectionId: account.id, runtimeAvailable: true },
      ]);
      await chat.cancelChatRun(
        actor,
        absentRun.runId,
        absentExecution.sandboxHeaders,
      );
      const admitted = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Discover admitted accounts",
      });
      const execution = await owned.runExecution(admitted.runId);
      const token = okouTokenFromExecution(execution.execution);
      expect((await discovery(token)).body.connectors).toMatchObject([
        {
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: account.id,
          runtimeAvailable: true,
        },
      ]);
      const sibling = await connectors.connectManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        {
          apiKey: "healthy-sibling",
        },
      );
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "manual-mcp",
        account.id,
      );
      expect((await discovery(token)).body.connectors).toMatchObject([
        { connectionId: sibling.id, runtimeAvailable: true },
      ]);
    });
  });

  it("returns reconnect guidance for the exact non-default account", async () => {
    const owned = await publicChatActor(context);
    owned.ownsFeatureSwitches();
    await owned.run(async () => {
      const { actor, agentId } = owned;

      mockEnv("APP_URL", "https://app.okou.ai");
      await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
        apiKey: "default-secret",
      });
      await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
        apiKey: "selected-secret",
      });
      const accounts = await connectors.listBuiltinConnectorAccounts(
        actor,
        "manual-mcp",
      );
      const selected = accounts.find((account) => {
        return !account.isDefault;
      });
      if (!selected) {
        throw new Error("Expected non-default account");
      }
      createRouteMocks(context).clerk.session(
        actor.userId,
        actor.orgId,
        actor.orgRole,
      );
      const thread = await accept(
        setupApp({ context, routes: chatThreadCreateRoutes })(
          chatThreadsContract,
        ).create({
          headers: { authorization: "Bearer clerk-session" },
          body: { agentId },
        }),
        [201],
      );
      await accept(
        setupApp({ context, routes: chatConnectorAccessRoutes })(
          chatConnectorAccessContract,
        ).setThreadCurrent({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: thread.body.id },
          body: {
            connectionId: selected.id,
            target: { kind: "builtin", connectorSlug: "manual-mcp" },
          },
        }),
        [200],
      );
      const run = await owned.sendChatRun(actor, {
        agentId,
        threadId: thread.body.id,
        prompt: "Reconnect the selected account",
      });
      const execution = await owned.runExecution(run.runId);
      const headers = {
        authorization: `Bearer ${okouTokenFromExecution(execution.execution)}`,
      };
      const body = {
        target: { kind: "builtin" as const, connectorSlug: "manual-mcp" },
        scopes: ["read"],
      };
      const result = await accept(
        client().reauthorizeOAuth({ headers, body }),
        [200],
      );
      expect(result.body).toStrictEqual({
        kind: "reconnect",
        connectionId: selected.id,
        authorizationUrl: `https://app.okou.ai/connectors/manual-mcp/reconnect/${selected.id}`,
      });
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "manual-mcp",
        selected.id,
      );
      const remaining = await connectors.readDefaultBuiltinAccount(
        actor,
        "manual-mcp",
      );
      const reconnected = await accept(
        client().reauthorizeOAuth({ headers, body }),
        [200],
      );
      expect(reconnected.body).toMatchObject({
        kind: "reconnect",
        connectionId: remaining.id,
      });
    });
  });
});
