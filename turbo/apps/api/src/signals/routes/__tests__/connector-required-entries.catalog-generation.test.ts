import { randomUUID } from "node:crypto";

import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
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
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
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

describe("connector catalog entries missing for authorized connectors", () => {
  it("launches without an enabled connector that has no entry at the captured hash", async () => {
    const publisher = createPublicConnectorCatalog(context, {
      isolatePg: true,
    });
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

    const run = await sendChatRun(actor, {
      agentId,
      prompt: "run without the missing enabled connector",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);

    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const restored = await sendChatRun(actor, {
      agentId,
      threadId: run.threadId,
      prompt: "run after the entry is published again",
    });
    const restoredClaim = await claimChatRun(runnerGroup, restored.runId);
    expect(
      restoredClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    await cancelChatRun(actor, restored.runId, restoredClaim.sandboxHeaders);
  });

  it("omits an admitted account from the Run MCP list like every other read", async () => {
    const publisher = createPublicConnectorCatalog(context, {
      isolatePg: true,
    });
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

    // A delisted connector cannot be disconnected; treat it as unauthorized.
    const omitted = await accept(mcp.list({ headers: runHeaders }), [200]);
    expect(omitted.body.connectors).not.toContainEqual(
      expect.objectContaining({ connectionId: connection.id }),
    );

    // Single-item reads are not found and lists omit the slug.
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
