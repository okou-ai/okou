import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadEventsContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { runsRoutes } from "../runs";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

const app = setupApp({
  context,
  routes: [...chatThreadRoutes, ...chatEventsRoutes, ...runsRoutes],
});
const threadsApi = app(chatThreadsContract);
const threadEventsApi = app(chatThreadEventsContract);
const chatEventsApi = app(chatEventsContract);

function signIn(user: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? "org:admin",
  );
  return headers;
}

describe("CHAT-02: web chat send and client ids", () => {
  it("chat-events-admission-006 authorizes existing-thread sends by owner", async () => {
    const owner = bdd.user();
    if (!owner.orgId) {
      throw new Error("Expected owner orgId");
    }
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });

    const created = await accept(
      threadsApi.create({
        headers: signIn(owner),
        body: { title: "Owner thread" },
      }),
      [201],
    );
    const threadId = created.body.id;

    const peerSend = await accept(
      chatEventsApi.send({
        headers: signIn(peer),
        body: {
          threadId,
          prompt: "Unauthorized prompt",
          hasTextContent: true,
          clientEventId: randomUUID(),
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Unauthorized prompt" }],
          },
        },
      }),
      [404],
    );
    expect(peerSend.body.error.message).toBe("Chat thread not found");

    const beforeOwnerSend = await accept(
      threadEventsApi.rows({
        headers: signIn(owner),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    expect(beforeOwnerSend.body.rows).toStrictEqual([]);

    const ownerEventId = randomUUID();
    await accept(
      chatEventsApi.send({
        headers: signIn(owner),
        body: {
          threadId,
          prompt: "Owner prompt",
          hasTextContent: true,
          clientEventId: ownerEventId,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Owner prompt" }],
          },
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();

    const afterOwnerSend = await accept(
      threadEventsApi.rows({
        headers: signIn(owner),
        params: { threadId },
        query: { sinceSeqId: 0, limit: 50 },
      }),
      [200],
    );
    const events = projectChatEventRows(afterOwnerSend.body.rows);
    expect(events).toContainEqual(
      expect.objectContaining({
        id: ownerEventId,
        eventType: "input.prompt",
      }),
    );
  });
});
