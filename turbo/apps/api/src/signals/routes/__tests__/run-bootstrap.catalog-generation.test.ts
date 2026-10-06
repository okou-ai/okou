import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { API_TEST_CONNECTOR_CATALOG_ARTIFACT } from "../../../test-fixtures/connector-catalog-artifact";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";
import { createPublicConnectorCatalog } from "./helpers/public-connector-catalog";

const context = testContext();
const {
  chat,
  connectors,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
} = createChatEventsFixture(context);

describe("Run connector catalog selection", () => {
  it("keeps captured connector entries across catalog rotation without loading the full payload", async () => {
    const publisher = createPublicConnectorCatalog(context);
    const first = {
      ...API_TEST_CONNECTOR_CATALOG_ARTIFACT,
      catalogVersion: `bootstrap-old-${randomUUID()}`,
    };
    await publisher.publish(first);
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const connection = await connectors.connectManualGrant(
      actor,
      "openai",
      "api-token",
      {
        apiKey: `bootstrap-owned-${randomUUID()}`,
      },
      agentId,
    );
    const clientEventId = randomUUID();
    const sent = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          const text = barrierQueryText(queryArgs);
          return (
            text.includes('from "connector_catalog"') &&
            text.includes('"connector_catalog_entries"') &&
            !text.includes('"catalog_gzip"')
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        pauseAfter: true,
        work: async (barrier) => {
          const sending = chat.requestSendEvent(
            actor,
            {
              agentId,
              prompt: "use the captured connector catalog",
              clientEventId,
            },
            [201],
          );
          await barrier.entered;
          const response = await sending;
          if (response.status !== 201) {
            throw new Error("Expected the direct send to be accepted");
          }
          const catalogVersion = `bootstrap-new-${randomUUID()}`;
          await publisher.publish({
            ...first,
            catalogVersion,
            connectors: first.connectors.filter((connector) => {
              return connector.slug !== "openai";
            }),
          });
          barrier.release();
          await flushWaitUntilForTest();
          return response;
        },
      },
      context.signal,
    );
    const runId = userMessages(
      (await chat.listThreadEvents(actor, sent.body.threadId)).events,
    ).find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (!runId) {
      throw new Error("Expected a run prepared from the captured catalog");
    }
    const claimed = await claimChatRun(runnerGroup, runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toMatchObject({ sourceId: connection.id });
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
    const next = await sendChatRun(actor, {
      agentId,
      prompt: "use the replacement catalog",
      threadId: sent.body.threadId,
    });
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(
      nextClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  });
});
