import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
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
  it("keeps absent and deleted account bindings unavailable without choosing a default", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId, runnerGroup } = owned;
      const absentRun = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Discover without a binding",
      });
      const absentClaim = await owned.claimChatRun(
        runnerGroup,
        absentRun.runId,
      );
      const absentToken = okouTokenFromClaim(absentClaim.claim);
      expect((await discovery(absentToken)).body.connectors).toStrictEqual([]);
      const account = await connectors.connectManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        { apiKey: "owned-default" },
      );
      expect((await discovery(absentToken)).body.connectors).toStrictEqual([]);
      await chat.cancelChatRun(
        actor,
        absentRun.runId,
        absentClaim.sandboxHeaders,
      );
      await runs.enableAgentConnectors(actor, agentId, ["manual-mcp"]);
      const admitted = await owned.sendChatRun(actor, {
        agentId,
        prompt: "Discover admitted accounts",
      });
      const claimed = await owned.claimChatRun(runnerGroup, admitted.runId);
      const token = okouTokenFromClaim(claimed.claim);
      expect((await discovery(token)).body.connectors).toMatchObject([
        {
          target: { kind: "builtin", connectorSlug: "manual-mcp" },
          connectionId: account.id,
          runtimeAvailable: true,
        },
      ]);
      await connectors.connectManualGrant(actor, "manual-mcp", "api-token", {
        apiKey: "healthy-sibling",
      });
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "manual-mcp",
        account.id,
      );
      expect((await discovery(token)).body.connectors).toStrictEqual([]);
    });
  });

  it("returns reconnect guidance for the exact non-default account", async () => {
    const owned = await publicChatActor(context);
    await owned.run(async () => {
      const { actor, agentId, runnerGroup } = owned;
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
      await runs.enableAgentConnectors(actor, agentId, ["manual-mcp"]);
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
          body: {
            agentId,
            connectorSelections: [
              {
                connectionId: selected.id,
                target: { kind: "builtin", connectorSlug: "manual-mcp" },
              },
            ],
          },
        }),
        [201],
      );
      const run = await owned.sendChatRun(actor, {
        agentId,
        threadId: thread.body.id,
        prompt: "Reconnect the selected account",
      });
      const claimed = await owned.claimChatRun(runnerGroup, run.runId);
      const headers = {
        authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
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
      await accept(client().reauthorizeOAuth({ headers, body }), [409]);
    });
  });
});
