import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { apiTestConnectorCatalogWithUnavailableAuthMethods } from "../../../test-fixtures/connector-catalog";
import { createFirewallApi } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
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
  it("omits filtered auth from scoped runtime claims after identity rotation", async () => {
    mockOptionalEnv("CAL_COM_OAUTH_CLIENT_ID", undefined);
    const publisher = createPublicConnectorCatalog(context);
    await publisher.publish(API_TEST_CONNECTOR_CATALOG_ARTIFACT);
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const api = createRunsApi(context);
    await api.enableAgentConnectors(actor, agentId, ["x"]);
    const warm = await sendChatRun(actor, {
      agentId,
      prompt: "warm scoped connector runtime",
    });
    await api.requestCancelRun(actor, warm.runId, [200]);
    await createFirewallApi(context).seedTestConnector(actor, {
      connectorSlug: "x",
      authMethod: "oauth",
      accessToken: "x-filtered-access",
      refreshToken: "x-filtered-refresh",
    });
    mockOptionalEnv(
      "CAL_COM_OAUTH_CLIENT_ID",
      "api-test-calcom-oauth-client-id",
    );
    await publisher.publish(
      apiTestConnectorCatalogWithUnavailableAuthMethods(
        API_TEST_CONNECTOR_CATALOG_ARTIFACT,
        [{ connectorSlug: "x", authMethodId: "oauth" }],
      ),
    );
    const filtered = await sendChatRun(actor, {
      agentId,
      prompt: "omit a compatibility-filtered connector method",
    });
    const { claim, sandboxHeaders } = await claimChatRun(
      runnerGroup,
      filtered.runId,
    );
    expect(claim.environment ?? {}).not.toHaveProperty("X_TOKEN");
    expect(claim.secretConnectorMap ?? {}).not.toHaveProperty("X_TOKEN");
    expect(
      claim.firewalls?.some((entry) => {
        return entry.kind === "builtin" && entry.name === "x";
      }),
    ).toBeFalsy();
    expect(claim.billableFirewalls).not.toContain("x");
    expect(claim.networkPolicies ?? {}).not.toHaveProperty("x");
    expect(claim).not.toHaveProperty("connectorPermissionBaseline");
    await cancelChatRun(actor, filtered.runId, sandboxHeaders);
  });

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
    await createFirewallApi(context).seedTestConnector(actor, {
      connectorSlug: "x",
      authMethod: "oauth",
      accessToken: "x-captured-filter-access",
      refreshToken: "x-captured-filter-refresh",
    });
    await createRunsApi(context).enableAgentConnectors(actor, agentId, [
      "openai",
      "x",
    ]);
    await publisher.publish(
      apiTestConnectorCatalogWithUnavailableAuthMethods(first, [
        { connectorSlug: "x", authMethodId: "oauth" },
      ]),
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
    expect(claimed.claim.environment ?? {}).not.toHaveProperty("X_TOKEN");
    expect(claimed.claim.secretConnectorMap ?? {}).not.toHaveProperty(
      "X_TOKEN",
    );
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
    // openai is still enabled but has no entry in the replacement generation;
    // that required connector would reject the next input, so drop it first.
    await createRunsApi(context).enableAgentConnectors(actor, agentId, ["x"]);
    const next = await sendChatRun(actor, {
      agentId,
      prompt: "use the replacement catalog",
      threadId: sent.body.threadId,
    });
    const nextClaim = await claimChatRun(runnerGroup, next.runId);
    expect(
      nextClaim.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    expect(nextClaim.claim.environment).toHaveProperty("X_TOKEN");
    expect(nextClaim.claim.secretConnectorMap).toHaveProperty("X_TOKEN");
    await cancelChatRun(actor, next.runId, nextClaim.sandboxHeaders);
  });
});
