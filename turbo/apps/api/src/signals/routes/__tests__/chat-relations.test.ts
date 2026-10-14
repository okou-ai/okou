import { randomUUID } from "node:crypto";
import { chatRelationsContract } from "@okouai/api-contracts/contracts/chat-relations";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatRelationsRoutes } from "../chat-relations";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createChatEventsFixture,
  okouTokenFromClaim,
  userMessages,
} from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const {
  bdd,
  api,
  chat,
  entitledNativeChatActor,
  sendChatRun,
  claimChatRun,
  cancelChatRun,
  requestSendEventWithBearer,
} = createChatEventsFixture(context);
const relations = setupApp({ context, routes: chatRelationsRoutes })(
  chatRelationsContract,
);
const threads = setupApp({ context, routes: chatThreadCreateRoutes })(
  chatThreadsContract,
);
function headers(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" };
}
async function enable(actor: ApiTestUser, enabled = true) {
  if (!actor.orgId) {
    throw new Error("Expected an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    { [FeatureSwitchKey.ChatRelations]: enabled },
  );
}
async function sourceFixture() {
  const fixture = await entitledNativeChatActor();
  await enable(fixture.actor);
  const source = await sendChatRun(fixture.actor, {
    agentId: fixture.agentId,
    model: "claude-fable-5-1",
    prompt: "Coordinate related chats",
  });
  const claimed = await claimChatRun(fixture.runnerGroup, source.runId);
  return {
    ...fixture,
    source,
    claimed,
    token: okouTokenFromClaim(claimed.claim),
  };
}

describe("chat relationships", () => {
  it("records empty chat creation once and paginates without inferring human-created children", async () => {
    const { actor, agentId, source, claimed, token } = await sourceFixture();
    const createdIds: string[] = [];
    for (let index = 0; index < 3; index++) {
      const clientThreadId = randomUUID();
      const request = {
        headers: { authorization: `Bearer ${token}` },
        body: { agentId, clientThreadId, title: `Child ${index}` },
      };
      const created = await accept(threads.create(request), [201]);
      await accept(threads.create(request), [201]);
      createdIds.push(created.body.id);
    }
    await chat.createThread(actor, { agentId });
    const first = await accept(
      relations.children({
        headers: headers(actor),
        params: { id: source.threadId },
        query: { limit: 1 },
      }),
      [200],
    );
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      sourceRunId: source.runId,
      status: "idle",
    });
    const cursor = first.body.nextCursor;
    if (!cursor) {
      throw new Error("Expected another page");
    }
    const rest = await accept(
      relations.children({
        headers: headers(actor),
        params: { id: source.threadId },
        query: { limit: 5, before: cursor.createdAt, beforeId: cursor.id },
      }),
      [200],
    );
    expect(rest.body.nextCursor).toBeNull();
    expect(
      [...first.body.items, ...rest.body.items]
        .map((item) => {
          return item.threadId;
        })
        .sort(),
    ).toStrictEqual(createdIds.sort());
    const messages = await accept(
      relations.communications({
        headers: headers(actor),
        params: { id: source.threadId },
        query: {},
      }),
      [200],
    );
    expect(messages.body.items).toStrictEqual([]);
    await cancelChatRun(actor, source.runId, claimed.sandboxHeaders);
  });

  it("records both directions between existing chats and attributes only consumed messages", async () => {
    const { actor, agentId, source, claimed, token, runnerGroup } =
      await sourceFixture();
    const peer = await chat.createThread(actor, { agentId });
    const eventId = randomUUID();
    const send = {
      agentId,
      threadId: peer.id,
      clientEventId: eventId,
      model: "claude-fable-5-1",
      prompt: "Investigate the customer request",
    };
    await requestSendEventWithBearer(token, send, [201]);
    await requestSendEventWithBearer(token, send, [201]);
    await flushWaitUntilForTest();
    const events = await chat.listThreadEvents(actor, peer.id);
    const peerRunId = userMessages(events.events).find((event) => {
      return event.revokesEventId === eventId;
    })?.runId;
    if (!peerRunId) {
      throw new Error("Expected the accepted message to launch a run");
    }
    const peerClaim = await claimChatRun(runnerGroup, peerRunId);
    const replyId = randomUUID();
    await requestSendEventWithBearer(
      okouTokenFromClaim(peerClaim.claim),
      {
        agentId,
        threadId: source.threadId,
        clientEventId: replyId,
        prompt: "Here is the investigation",
      },
      [201],
    );
    await flushWaitUntilForTest();
    const timeline = await accept(
      relations.messages({
        headers: headers(actor),
        params: { id: source.threadId, peerId: peer.id },
        query: {},
      }),
      [200],
    );
    expect(timeline.body.items).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "sent",
          messageEventId: eventId,
          sourceRunId: source.runId,
          targetRunId: peerRunId,
        }),
        expect.objectContaining({
          direction: "received",
          messageEventId: replyId,
          sourceRunId: peerRunId,
          targetRunId: null,
        }),
      ]),
    );
    expect(timeline.body.items).toHaveLength(2);
    expect(
      timeline.body.items.find((item) => {
        return item.messageEventId === eventId;
      })?.userMessage?.parts,
    ).toContainEqual({ type: "text", text: send.prompt });
    await api.declareSteeredInput(
      claimed.claim.sandboxToken,
      source.runId,
      replyId,
    );
    await api.declareSteeredInput(
      claimed.claim.sandboxToken,
      source.runId,
      replyId,
    );
    const consumed = await accept(
      relations.messages({
        headers: headers(actor),
        params: { id: source.threadId, peerId: peer.id },
        query: { limit: 1 },
      }),
      [200],
    );
    expect(consumed.body.items[0]).toMatchObject({
      messageEventId: replyId,
      targetRunId: source.runId,
    });
    expect(consumed.body.nextCursor).not.toBeNull();
    const recalledId = randomUUID();
    await requestSendEventWithBearer(
      token,
      {
        agentId,
        threadId: peer.id,
        clientEventId: recalledId,
        prompt: "Withdraw this request",
      },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: peer.id,
        revokesEventId: recalledId,
        clientEventId: randomUUID(),
      },
      [201],
    );
    const recalled = await accept(
      relations.messages({
        headers: headers(actor),
        params: { id: source.threadId, peerId: peer.id },
        query: {},
      }),
      [200],
    );
    expect(
      recalled.body.items.find((item) => {
        return item.messageEventId === recalledId;
      }),
    ).toMatchObject({ targetRunId: null });
    await requestSendEventWithBearer(
      token,
      { agentId, threadId: source.threadId, prompt: "Self follow-up" },
      [201],
    );
    await chat.requestSendEvent(
      actor,
      {
        agentId,
        threadId: peer.id,
        sourceRunId: source.runId,
        prompt: "Human forwarding",
      },
      [201],
    );
    const outbound = await accept(
      relations.communications({
        headers: headers(actor),
        params: { id: source.threadId },
        query: {},
      }),
      [200],
    );
    const inbound = await accept(
      relations.communications({
        headers: headers(actor),
        params: { id: peer.id },
        query: {},
      }),
      [200],
    );
    expect(outbound.body.items).toMatchObject([
      { threadId: peer.id, sentCount: 2, receivedCount: 1 },
    ]);
    expect(inbound.body.items).toMatchObject([
      { threadId: source.threadId, sentCount: 1, receivedCount: 2 },
    ]);
    const children = await accept(
      relations.children({
        headers: headers(actor),
        params: { id: source.threadId },
        query: {},
      }),
      [200],
    );
    expect(children.body.items).toStrictEqual([]);
    await cancelChatRun(actor, peerRunId, peerClaim.sandboxHeaders);
    await cancelChatRun(actor, source.runId, claimed.sandboxHeaders);
  });

  it("records implicit creation and enforces the feature, user and organization boundaries", async () => {
    const { actor, agentId, source, claimed, token } = await sourceFixture();
    const sent = await requestSendEventWithBearer(
      token,
      { agentId, prompt: "Start a delegated chat", model: "claude-fable-5-1" },
      [201],
    );
    if (sent.status !== 201) {
      throw new Error("Expected an accepted message");
    }
    const children = await accept(
      relations.children({
        headers: headers(actor),
        params: { id: source.threadId },
        query: {},
      }),
      [200],
    );
    expect(children.body.items).toMatchObject([
      { threadId: sent.body.threadId, sourceRunId: source.runId },
    ]);
    const other = bdd.user({ orgId: actor.orgId });
    await enable(other);
    for (const id of [source.threadId, randomUUID()]) {
      const denied = await accept(
        relations.children({
          headers: headers(other),
          params: { id },
          query: {},
        }),
        [404],
      );
      expect(denied.body).toStrictEqual({
        error: { code: "NOT_FOUND", message: "Chat thread not found" },
      });
    }
    const otherOrg = bdd.user({ userId: actor.userId });
    await enable(otherOrg);
    await accept(
      relations.communications({
        headers: headers(otherOrg),
        params: { id: source.threadId },
        query: {},
      }),
      [404],
    );
    await enable(actor, false);
    await accept(
      relations.children({
        headers: headers(actor),
        params: { id: source.threadId },
        query: {},
      }),
      [403],
    );
    await cancelChatRun(actor, source.runId, claimed.sandboxHeaders);
  });
});
