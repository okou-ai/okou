import { randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorOverviewRoutes } from "../connector-overview";
import { mcpConnectorsRoutes } from "../mcp-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
} from "./helpers/chat-events-fixture";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";

const context = testContext();
const {
  chat,
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  waitForThreadMessages,
  sessionHeaders,
} = createChatEventsFixture(context);

// Each case publishes the generation whose missing entry it reads.
function withoutConnector(connectorSlug: string): ConnectorCatalogArtifact {
  return {
    ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
    catalogVersion: `required-entries-${randomUUID()}`,
    connectors: API_TEST_CONNECTOR_CATALOG_ARTIFACT.connectors.filter(
      (connector) => {
        return connector.slug !== connectorSlug;
      },
    ),
  };
}

describe("required connector catalog entries", () => {
  it("rejects a run whose enabled connector has no entry at the captured hash", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: `required-entry-${randomUUID()}` },
      agentId,
    );
    await createRunsApi(context).enableAgentConnectors(actor, agentId, [
      "openai",
    ]);
    await publisher.publish(withoutConnector("openai"));

    const clientEventId = randomUUID();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId,
        prompt: "run without the missing enabled connector",
        clientEventId,
      },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected the send to be accepted for preparation");
    }
    await flushWaitUntilForTest();
    const page = await waitForThreadMessages(
      actor,
      sent.body.threadId,
      (items) => {
        return items.some((event) => {
          return event.eventType === "input.rejected";
        });
      },
    );
    expect(page.events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "conflict",
      }),
    );
    expect(page.events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "conflict",
        content:
          "Connectors enabled for this agent are unavailable: openai. Remove them from the agent or try again later.",
      }),
    );
    expect(
      page.events.filter((event) => {
        return event.runId !== undefined;
      }),
    ).toStrictEqual([]);

    // The failure belongs to the missing entry, not the catalog as a whole.
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const restored = await sendChatRun(actor, {
      agentId,
      threadId: sent.body.threadId,
      prompt: "run after the entry is published again",
    });
    const claimed = await claimChatRun(runnerGroup, restored.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    await cancelChatRun(actor, restored.runId, claimed.sandboxHeaders);
  });

  it("fails the Run MCP list for an admitted account while optional reads omit the slug", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const connection = await connectors.connectManualGrant(
      actor,
      "manual-mcp",
      "api-token",
      { apiKey: `required-mcp-${randomUUID()}` },
      agentId,
    );
    await createRunsApi(context).enableAgentConnectors(actor, agentId, [
      "manual-mcp",
    ]);
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
    const runHeaders = { authorization: `Bearer ${okouTokenFromClaim(claim)}` };
    const admitted = await accept(mcp.list({ headers: runHeaders }), [200]);
    expect(admitted.body.connectors).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "manual-mcp" },
        connectionId: connection.id,
      }),
    );

    await publisher.publish(withoutConnector("manual-mcp"));

    // Required: the admitted MCP scope fails instead of shrinking to empty.
    await accept(mcp.list({ headers: runHeaders }), [500]);

    // Optional: single-item reads are not found and lists omit the slug.
    const headers = sessionHeaders(actor);
    const catalog = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    await accept(
      catalog.get({ headers, params: { connectorSlug: "manual-mcp" } }),
      [404],
    );
    await accept(
      catalog.permissions({ headers, params: { connectorSlug: "manual-mcp" } }),
      [404],
    );
    const overview = setupApp({ context, routes: connectorOverviewRoutes })(
      connectorOverviewContract,
    );
    const agentOverview = await accept(
      overview.agent({ headers, params: { id: agentId } }),
      [200],
    );
    expect(agentOverview.body.enabledConnectorSlugs).not.toContain(
      "manual-mcp",
    );
    const connected = await accept(overview.overview({ headers }), [200]);
    expect(connected.body.builtinConnectors).not.toContainEqual(
      expect.objectContaining({ slug: "manual-mcp" }),
    );
    const stored = await connectors.listBuiltinConnectors(actor);
    expect(stored.connectors).not.toContainEqual(
      expect.objectContaining({ slug: "manual-mcp" }),
    );

    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const restored = await accept(mcp.list({ headers: runHeaders }), [200]);
    expect(restored.body.connectors).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "manual-mcp" },
        connectionId: connection.id,
      }),
    );
    await cancelChatRun(actor, run.runId, sandboxHeaders);
  });
});
