import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { modelProviderConnectionsByIdContract } from "@okouai/api-contracts/contracts/model-provider-gateways";
import { setupApp } from "../../../__tests__/test-helpers";
import { modelProviderGatewayRoutes } from "../model-provider-gateways";
import { accept, testContext } from "../../../__tests__/test-context";
import { withAgentBootstrapFailureFixture } from "../../../test-fixtures/agent-bootstrap-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import {
  createChatEventsFixture,
  userMessages,
  claimEnvironment,
} from "./helpers/chat-events-fixture";
import type { ApiTestUser } from "./helpers/api-bdd";

const context = testContext({ connectorCatalog: true });
const {
  api,
  bdd,
  chat,
  misc,
  entitledNativeChatActor,
  seedBuiltInModelKey,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  waitForThreadMessages,
  modelProviderConnectionsClient,
  sessionHeaders,
  requestSendEventRaw,
} = createChatEventsFixture(context);
const MODEL = "claude-fable-5-1";
const PATHS = ["built-in", "org-provider", "gateway"] as const;
type ModelPath = (typeof PATHS)[number];

async function configureSource(actor: ApiTestUser, path: ModelPath) {
  if (path === "built-in") {
    await seedBuiltInModelKey(MODEL);
    await api.updateOrgModelPolicies(actor, [
      {
        model: MODEL,
        preferred: true,
        defaultProviderType: "built-in",
        credentialScope: "org",
        modelProviderId: null,
      },
    ]);
    return { providerType: "built-in" };
  }
  if (path === "org-provider") {
    return { providerType: "anthropic-api-key" };
  }
  const created = await accept(
    modelProviderConnectionsClient().create({
      headers: sessionHeaders(actor),
      body: {
        displayName: "Context messages gateway",
        secret: `context-gateway-${randomUUID()}`,
        surfaces: [
          {
            protocol: "anthropic-messages",
            apiBaseUrl: "https://context-gateway.example.com/v1",
            authHeaderName: "x-api-key",
            authHeaderTemplate: "{{secret}}",
            modelMappings: { [MODEL]: "company-fable" },
          },
        ],
      },
    }),
    [201],
  );
  const surfaceId = created.body.surfaces[0]?.id;
  if (!surfaceId) {
    throw new Error("Expected a gateway surface");
  }
  await api.updateOrgModelPolicies(actor, [
    {
      model: MODEL,
      preferred: true,
      defaultProviderType: "custom-anthropic-messages",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: surfaceId,
    },
  ]);
  return {
    providerType: "custom-anthropic-messages",
    connectionId: created.body.id,
  };
}

async function launchedQueuedInput(
  actor: ApiTestUser,
  threadId: string,
  clientEventId: string,
) {
  const events = await waitForThreadMessages(actor, threadId, (items) => {
    return userMessages(items).some((message) => {
      return (
        message.revokesEventId === clientEventId &&
        typeof message.runId === "string"
      );
    });
  });
  const runId = userMessages(events.events).find((message) => {
    return message.revokesEventId === clientEventId;
  })?.runId;
  if (!runId) {
    throw new Error("Expected an independently drained run");
  }
  return runId;
}

describe("identity model source context through real sends", () => {
  it.each(["missing-agent", "thread-agent-mismatch"] as const)(
    "preserves %s authorization rejection while early preload fails",
    async (path) => {
      const { actor, agentId } = await entitledNativeChatActor();
      const other = await bdd.createAgent(actor);
      const thread = await chat.createThread(actor, { agentId });
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      const before = await chat.listThreadEvents(actor, thread.id);
      const requestedAgentId =
        path === "missing-agent" ? randomUUID() : other.agentId;
      await withAgentBootstrapFailureFixture(
        {
          userId: actor.userId,
          orgId: actor.orgId,
          agentId: requestedAgentId,
          read: "pricing",
        },
        async () => {
          const rejected = await chat.requestSendEvent(
            actor,
            {
              agentId: requestedAgentId,
              ...(path === "thread-agent-mismatch"
                ? { threadId: thread.id }
                : {}),
              prompt: "unauthorized input must not enqueue",
            },
            [404],
          );
          expect(rejected.status).toBe(404);
          expect(rejected.body).toMatchObject({
            error: {
              code: "NOT_FOUND",
              message:
                path === "missing-agent"
                  ? "Agent not found"
                  : "Chat thread not found",
            },
          });
          await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
          const after = await chat.listThreadEvents(actor, thread.id);
          expect(after.events).toStrictEqual(before.events);
        },
      );
    },
  );

  it("settles early preload when attachment resolution aborts before enqueue", async () => {
    const { actor, agentId } = await entitledNativeChatActor();
    const thread = await chat.createThread(actor, { agentId });
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    const before = await chat.listThreadEvents(actor, thread.id);
    const controller = new AbortController();
    const error = new Error("client disconnected during attachment lookup");
    error.name = "AbortError";
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        controller.abort(error);
      }
      return Promise.resolve({ Contents: [] });
    });
    await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const rejected = await requestSendEventRaw(
          actor,
          {
            agentId,
            threadId: thread.id,
            prompt: "abort before enqueue",
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [
                {
                  type: "file",
                  fileId: randomUUID(),
                  filenameSnapshot: "aborted.txt",
                  contentType: "text/plain",
                },
                { type: "text", text: "abort before enqueue" },
              ],
            },
          },
          controller.signal,
        );
        expect(controller.signal.aborted).toBeTruthy();
        expect(rejected).toStrictEqual({
          status: 500,
          body: { error: "Internal server error" },
        });
        await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
        const after = await chat.listThreadEvents(actor, thread.id);
        expect(after.events).toStrictEqual(before.events);
      },
    );
  });

  it("preserves validation rejection when an authorized send's early preload fails", async () => {
    const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
    const first = await sendChatRun(actor, {
      agentId,
      prompt: "early preload rejection anchor",
    });
    const claimed = await claimChatRun(runnerGroup, first.runId);
    await cancelChatRun(actor, first.runId, claimed.sandboxHeaders);
    await flushWaitUntilForTest();
    const before = await chat.listThreadEvents(actor, first.threadId);
    if (!actor.orgId) {
      throw new Error("Expected an organization");
    }
    await withAgentBootstrapFailureFixture(
      { userId: actor.userId, orgId: actor.orgId, agentId },
      async () => {
        const rejected = await chat.requestSendEvent(
          actor,
          {
            agentId,
            threadId: first.threadId,
            clientEventId: randomUUID(),
            model: "missing-preload-rejection-model",
            prompt: "must not enqueue",
          },
          [400],
        );
        expect(rejected.status).toBe(400);
        expect(rejected.body).toMatchObject({
          error: {
            code: "BAD_REQUEST",
            message: 'Unknown model "missing-preload-rejection-model"',
          },
        });
        // The infrastructure fixture requires an actual cancelled read. All
        // speculative promises must settle even though no pick will consume them.
        await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
        const after = await chat.listThreadEvents(actor, first.threadId);
        expect(after.events).toStrictEqual(before.events);
      },
    );
  });
  it.each(PATHS)(
    "uses %s with a matching context and a later request without context",
    async (path) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      const source = await configureSource(actor, path);
      const first = await sendChatRun(actor, {
        agentId,
        model: MODEL,
        prompt: `captured ${path}`,
      });
      expect((await api.readRun(actor, first.runId)).source).toMatchObject({
        model: MODEL,
        providerType: source.providerType,
        credentialScope: "org",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      expect(firstClaim.claim.cliAgentType).toBe("claude-code");
      expect(claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL).toBe(
        path === "gateway" ? "company-fable" : MODEL,
      );
      const clientEventId = randomUUID();
      const queued = await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: first.threadId,
          model: MODEL,
          prompt: `independent ${path}`,
          clientEventId,
        },
        [201],
      );
      if (queued.status !== 201) {
        throw new Error("Expected the queued send to be accepted");
      }
      expect(queued.body.runId).toBeNull();
      await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
      const nextRunId = await launchedQueuedInput(
        actor,
        first.threadId,
        clientEventId,
      );
      expect((await api.readRun(actor, nextRunId)).source).toMatchObject({
        model: MODEL,
        providerType: source.providerType,
        credentialScope: "org",
      });
      const nextClaim = await claimChatRun(runnerGroup, nextRunId);
      expect(nextClaim.claim.cliAgentType).toBe("claude-code");
      expect(claimEnvironment(nextClaim.claim).ANTHROPIC_MODEL).toBe(
        claimEnvironment(firstClaim.claim).ANTHROPIC_MODEL,
      );
      await cancelChatRun(actor, nextRunId, nextClaim.sandboxHeaders);
    },
  );

  it.each(["org-provider", "gateway"] as const)(
    "does not reuse an absent %s after a later-request drain",
    async (path) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      const source = await configureSource(actor, path);
      const first = await sendChatRun(actor, {
        agentId,
        model: MODEL,
        prompt: "hold the thread",
      });
      const firstClaim = await claimChatRun(runnerGroup, first.runId);
      const clientEventId = randomUUID();
      await chat.requestSendEvent(
        actor,
        {
          agentId,
          threadId: first.threadId,
          model: MODEL,
          prompt: "the removed source must not launch",
          clientEventId,
        },
        [201],
      );
      if (source.connectionId) {
        await accept(
          setupApp({ context, routes: modelProviderGatewayRoutes })(
            modelProviderConnectionsByIdContract,
          ).delete({
            headers: sessionHeaders(actor),
            params: { id: source.connectionId },
          }),
          [204],
        );
      } else {
        await misc.deleteOrgModelProvider(actor, "anthropic-api-key", [204]);
      }
      await cancelChatRun(actor, first.runId, firstClaim.sandboxHeaders);
      const events = await waitForThreadMessages(
        actor,
        first.threadId,
        (items) => {
          return items.some((event) => {
            return (
              event.eventType === "input.rejected" &&
              event.revokesEventId === clientEventId
            );
          });
        },
      );
      expect(events.events).toContainEqual(
        expect.objectContaining({
          eventType: "input.rejected",
          revokesEventId: clientEventId,
        }),
      );
      expect(
        userMessages(events.events).some((event) => {
          return (
            event.revokesEventId === clientEventId && event.runId !== undefined
          );
        }),
      ).toBeFalsy();
    },
  );

  it.each([
    { path: "built-in", read: "managed-keys" },
    { path: "built-in", read: "pricing" },
    { path: "org-provider", read: "org-providers" },
    { path: "gateway", read: "gateways" },
  ] as const)(
    "fails $path when the captured $read read fails, without another loader",
    async ({ path, read }) => {
      const { actor, agentId } = await entitledNativeChatActor();
      await configureSource(actor, path);
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      const clientEventId = randomUUID();
      await withAgentBootstrapFailureFixture(
        { userId: actor.userId, orgId: actor.orgId, agentId, read },
        async () => {
          if (read === "org-providers" || read === "gateways") {
            // These groups are required in S1. Their captured rejection prevents enqueue.
            const failed = await requestSendEventRaw(actor, {
              agentId,
              model: MODEL,
              prompt: "fail captured source",
              clientEventId,
              hasTextContent: true,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "fail captured source" }],
              },
            });
            expect(failed.status).toBe(500);
            return;
          }
          const sent = await chat.requestSendEvent(
            actor,
            {
              agentId,
              model: MODEL,
              prompt: "fail captured source",
              clientEventId,
            },
            [201],
          );
          expect(sent.status).toBe(201);
          if (sent.status !== 201) {
            throw new Error(
              "Expected the input to enqueue before global preload",
            );
          }
          await expect(flushWaitUntilForTest()).rejects.toThrow("Failed query");
          const events = (
            await chat.listThreadEvents(actor, sent.body.threadId)
          ).events;
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
            userMessages(events).some((event) => {
              return (
                event.revokesEventId === clientEventId &&
                event.runId !== undefined
              );
            }),
          ).toBeFalsy();
        },
      );
    },
  );
});
