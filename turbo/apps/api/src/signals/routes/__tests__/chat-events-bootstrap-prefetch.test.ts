import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import { withAgentBootstrapFailureFixture } from "../../../test-fixtures/agent-bootstrap-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/database-transaction-barrier";
import {
  createChatEventsFixture,
  userMessages,
} from "./helpers/chat-events-fixture";

const context = testContext({ connectorCatalog: true });
const {
  api,
  chat,
  connectors,
  chatCallbacks,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);

describe("chat agent bootstrap prefetch", () => {
  it("returns the accepted input while bootstrap is still reading", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const clientEventId = randomUUID();
    const sent = await withDatabaseTransactionBarrierFixture(
      {
        select: (queryArgs) => {
          const text = barrierQueryText(queryArgs);
          return (
            text.includes('from "user_cache"') &&
            text.includes("union all") &&
            barrierQueryBinds(queryArgs, agentId)
          );
        },
        stopAt: (_queryArgs, selecting) => {
          return selecting;
        },
        work: async (barrier) => {
          const sending = chat.requestSendEvent(
            actor,
            {
              agentId,
              prompt: "overlap bootstrap with enqueue",
              clientEventId,
            },
            [201],
          );
          await barrier.entered;
          const response = await sending;
          if (response.status !== 201) {
            throw new Error("Expected the direct send to be accepted");
          }
          expect(response.body.runId).toBeNull();
          const queued = await chat.listThreadEvents(
            actor,
            response.body.threadId,
          );
          expect(userMessages(queued.events)).toContainEqual(
            expect.objectContaining({
              id: clientEventId,
              eventType: "input.prompt",
            }),
          );
          expect(
            userMessages(queued.events).every((message) => {
              return message.runId === undefined;
            }),
          ).toBeTruthy();
          barrier.release();
          await flushWaitUntilForTest();
          return response;
        },
      },
      context.signal,
    );
    const messages = userMessages(
      (await chat.listThreadEvents(actor, sent.body.threadId)).events,
    );
    const runId = messages.find((message) => {
      return message.revokesEventId === clientEventId;
    })?.runId;
    if (!runId) {
      throw new Error(
        "Expected preparation to finish after releasing bootstrap",
      );
    }
    const claimed = await claimChatRun(runnerGroup, runId);
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
  });
  it.each(["web", "cli"] as const)(
    "preserves the queued input and claimable run through %s",
    async (entry) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      chatCallbacks.failIfChatCallbackRouteIsFetched();
      const clientEventId = randomUUID();
      const body = { agentId, prompt: "prepare my agent", clientEventId };
      const sent =
        entry === "web"
          ? await chat.requestSendEvent(actor, body, [201])
          : await requestSendEventWithBearer(
              (await api.createCliToken(actor)).token,
              body,
              [201],
            );
      if (sent.status !== 201) {
        throw new Error("Expected the direct send to be accepted");
      }
      expect(sent.body.runId).toBeNull();
      await flushWaitUntilForTest();
      const messages = userMessages(
        (await chat.listThreadEvents(actor, sent.body.threadId)).events,
      );
      const associated = messages.find((message) => {
        return message.revokesEventId === clientEventId;
      });
      expect(associated).toMatchObject({ eventType: "input.prompt" });
      if (!associated?.runId) {
        throw new Error("Expected a run-associated replacement");
      }
      const run = await api.readRun(actor, associated.runId);
      expect(run).toMatchObject({ prompt: "prepare my agent" });
      const metadata = await chat.readThreadMetadata(actor, sent.body.threadId);
      expect(metadata.agentId).toBe(agentId);
      const claimed = await claimChatRun(runnerGroup, associated.runId);
      expect(claimed.claim.platformEnvironment).toHaveProperty("OKOU_TOKEN");
      await cancelChatRun(actor, associated.runId, claimed.sandboxHeaders);
    },
  );

  it("uses the current catalog when its projection set changes during prefetch", async () => {
    mockEnv(
      "R2_USER_STORAGES_BUCKET_NAME",
      `bootstrap-catalog-${randomUUID()}`,
    );
    await installApiTestConnectorCatalog({
      catalogVersion: `bootstrap-old-${randomUUID()}`,
      runtimeProjection: true,
    });
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    await connectors.connectManualGrant(
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
          return (
            barrierQueryText(queryArgs).includes(
              'from "connector_catalog_runtime_projections"',
            ) && barrierQueryBinds(queryArgs, "openai")
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
              prompt: "use the current connector catalog",
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
          await installApiTestConnectorCatalog({
            runtimeProjection: true,
            catalog: {
              ...API_TEST_CONNECTOR_CATALOG,
              catalogVersion,
              connectors: API_TEST_CONNECTOR_CATALOG.connectors.filter(
                (connector) => {
                  return connector.slug !== "openai";
                },
              ),
            },
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
      throw new Error("Expected a run prepared from the current catalog");
    }
    const claimed = await claimChatRun(runnerGroup, runId);
    expect(
      claimed.claim.secretConnectorMetadataMap?.OPENAI_TOKEN,
    ).toBeUndefined();
    await cancelChatRun(actor, runId, claimed.sandboxHeaders);
  });

  it("rejects the input when a matching prefetch fails instead of rereading", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const clientEventId = randomUUID();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    const sent = await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const response = await chat.requestSendEvent(
          actor,
          { agentId, prompt: "fail fast during preparation", clientEventId },
          [201],
        );
        if (response.status !== 201) {
          throw new Error("Expected enqueue to accept the input");
        }
        expect(response.body.runId).toBeNull();
        await expect(flushWaitUntilForTest()).rejects.toThrow("Failed query");
        return response;
      },
    );
    const events = (await chat.listThreadEvents(actor, sent.body.threadId))
      .events;
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "input.rejected",
        revokesEventId: clientEventId,
        error: "internal_error",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: "output.error",
        error: "internal_error",
      }),
    );
    expect(
      userMessages(events).some((message) => {
        return (
          message.revokesEventId === clientEventId &&
          message.runId !== undefined
        );
      }),
    ).toBeFalsy();
  });

  it("keeps an active run steerable when its unused speculative read fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    chatCallbacks.failIfChatCallbackRouteIsFetched();
    const active = await sendChatRun(actor, {
      agentId,
      prompt: "keep working",
    });
    const claimed = await claimChatRun(runnerGroup, active.runId);
    const clientEventId = randomUUID();
    if (!actor.orgId) {
      throw new Error("Expected an organization-scoped actor");
    }
    await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const sent = await chat.requestSendEvent(
          actor,
          {
            agentId,
            threadId: active.threadId,
            prompt: "steer the existing run",
            clientEventId,
          },
          [201],
        );
        if (sent.status !== 201) {
          throw new Error("Expected the steer input to be accepted");
        }
        expect(sent.body.runId).toBeNull();
        await flushWaitUntilForTest();
      },
    );
    await expect(
      api.nextSteerableInput(claimed.claim.sandboxToken, active.runId),
    ).resolves.toStrictEqual({
      input: { eventId: clientEventId, prompt: "steer the existing run" },
    });
    await cancelChatRun(actor, active.runId, claimed.sandboxHeaders);
  });
});
