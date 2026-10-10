import { randomUUID } from "node:crypto";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const { api, connectors, cancelChatRun } = createChatEventsFixture(context);

describe("authorized connector admission", () => {
  it("claims the exact normally connected account for an enabled connector", async () => {
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context);
    await own(() => {
      return api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const connection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "openai",
        "api-token",
        { apiKey: `required-entry-${randomUUID()}` },
        agentId,
      );
    });
    await own(() => {
      return api.enableAgentConnectors(actor, agentId, ["openai"]);
    });
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "use the enabled OpenAI connection",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    await own(() => {
      return cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
    });
  });

  it("lists the exact admitted manual MCP account for a claimed Run", async () => {
    const {
      actor,
      agentId,
      runnerGroup,
      run: own,
      sendChatRun,
      claimChatRun,
    } = await publicChatActor(context);
    await own(() => {
      return api.updateUserModelPreference(actor, "claude-fable-5-1");
    });
    const connection = await own(() => {
      return connectors.connectManualGrant(
        actor,
        "manual-mcp",
        "api-token",
        { apiKey: `required-mcp-${randomUUID()}` },
        agentId,
      );
    });
    await own(() => {
      return api.enableAgentConnectors(actor, agentId, ["manual-mcp"]);
    });
    const run = await sendChatRun(actor, {
      agentId,
      prompt: "admit the builtin MCP account",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      run.runId,
    );
    const mcp = setupApp({ context, routes: mcpConnectorsRoutes })(
      mcpConnectorsContract,
    );
    const admitted = await own(() => {
      return accept(
        mcp.list({
          headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
        }),
        [200],
      );
    });
    expect(admitted.body.connectors).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "manual-mcp" },
        connectionId: connection.id,
      }),
    );
    await own(() => {
      return cancelChatRun(actor, run.runId, sandboxHeaders);
    });
  });
});
