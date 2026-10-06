import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { chatThreadRoutes } from "../chat-threads";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";

const context = testContext();
const {
  chat,
  connectors,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  chatThreadsClient,
  sessionHeaders,
} = createChatEventsFixture(context);

function selectionsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadConnectorSelectionContract,
  );
}

describe("thread connector selection across catalog generations", () => {
  it("starts the run when the runtime catalog no longer contains the selected built-in", async () => {
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "retired-thread-openai-key" },
      agentId,
    );
    const runtimeConnection = await connectors.connectManualGrant(
      actor,
      "runtime",
      "api-token",
      { apiKey: "retired-thread-runtime-key" },
      agentId,
    );
    const thread = await chat.createThread(actor, {
      agentId,
      title: "Retired catalog connector thread",
    });
    await accept(
      selectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [200],
    );
    await accept(
      selectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: runtimeConnection.id,
          target: { kind: "builtin", connectorSlug: "runtime" },
        },
      }),
      [200],
    );
    await publisher.publish({
      ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
      connectors: API_TEST_CONNECTOR_CATALOG_ARTIFACT.connectors.filter(
        (connector) => {
          return connector.slug !== "openai";
        },
      ),
    });
    const run = await sendChatRun(actor, {
      agentId,
      threadId: thread.id,
      prompt: "Continue after the selected connector leaves the catalog",
    });
    const claimed = await claimChatRun(runnerGroup, run.runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    const selections = await accept(
      selectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(selections.body.selections).toStrictEqual([
      {
        connectionId: runtimeConnection.id,
        target: { kind: "builtin", connectorSlug: "runtime" },
      },
    ]);
    await accept(
      selectionsClient().update({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: {
          connectionId: connection.id,
          target: { kind: "builtin", connectorSlug: "openai" },
        },
      }),
      [400],
    );
    await accept(
      chatThreadsClient().create({
        headers: sessionHeaders(actor),
        body: {
          agentId,
          model: "claude-fable-5-1",
          connectorSelections: [
            {
              connectionId: connection.id,
              target: { kind: "builtin", connectorSlug: "openai" },
            },
          ],
        },
      }),
      [400],
    );
    await accept(
      selectionsClient().clear({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
        body: { kind: "builtin", connectorSlug: "openai" },
      }),
      [204],
    );
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const restoredSelections = await accept(
      selectionsClient().get({
        headers: sessionHeaders(actor),
        params: { id: thread.id },
      }),
      [200],
    );
    expect(restoredSelections.body.selections).toStrictEqual(
      selections.body.selections,
    );
    await cancelChatRun(actor, run.runId, claimed.sandboxHeaders);
  });
});
