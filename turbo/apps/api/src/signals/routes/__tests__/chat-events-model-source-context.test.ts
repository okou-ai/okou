import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { withAgentBootstrapFailureFixture } from "../../../test-fixtures/agent-bootstrap-failure";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";

const context = testContext();
const {
  bdd,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  requestSendEventRaw,
} = createChatEventsFixture(context);

describe("identity model source context through real sends", () => {
  it.each(["keys", "pricing"] as const)(
    "fails before enqueue when the global %s read fails and accepts a later retry",
    async (read) => {
      const { actor, agentId, runnerGroup } = await entitledNativeChatActor();
      const thread = await chat.createThread(actor, { agentId });
      if (!actor.orgId) {
        throw new Error("Expected an organization");
      }
      const before = await chat.listThreadEvents(actor, thread.id);
      const clientEventId = randomUUID();
      const prompt = "global model read must succeed before enqueue";
      await withAgentBootstrapFailureFixture(
        { userId: actor.userId, orgId: actor.orgId, agentId, read },
        async () => {
          const rejected = await requestSendEventRaw(actor, {
            agentId,
            threadId: thread.id,
            clientEventId,
            prompt,
            hasTextContent: true,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: prompt }],
            },
          });
          expect(rejected).toStrictEqual({
            status: 500,
            body: { error: "Internal server error" },
          });
          await expect(flushWaitUntilForTest()).resolves.toBeUndefined();
          const after = await chat.listThreadEvents(actor, thread.id);
          expect(after.events).toStrictEqual(before.events);
        },
      );
      const retried = await sendChatRun(actor, {
        agentId,
        threadId: thread.id,
        clientEventId,
        prompt,
      });
      const claimed = await claimChatRun(runnerGroup, retried.runId);
      await cancelChatRun(actor, retried.runId, claimed.sandboxHeaders);
    },
  );

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
});
