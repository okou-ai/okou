import { installSharedThreadStorage } from "./helpers/shared-thread-storage";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { chatShareSelectionContract } from "@okouai/api-contracts/contracts/chat-share-selection";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { sharedThreadRoutes } from "../shared-threads";
import {
  createChatEventsFixture,
  assistantEvent,
} from "./helpers/chat-events-fixture";

const context = testContext();
const fixture = createChatEventsFixture(context);
const app = () => {
  return setupApp({ context, routes: sharedThreadRoutes });
};

test("resolves the final answer with its prompt and shares exactly the selected records", async () => {
  const { actor, agentId, runnerGroup } =
    await fixture.entitledNativeChatActor();
  const run = await fixture.sendChatRun(actor, {
    agentId,
    prompt: "Plan a quiet trip",
  });
  const claim = await fixture.claimChatRun(runnerGroup, run.runId);
  fixture.chatCallbacks.mockChatOutputEvents([
    assistantEvent(0, "Working on the itinerary"),
    assistantEvent(1, "The final itinerary"),
  ]);
  await fixture.completeChatRunOk(run.runId, claim.sandboxHeaders);
  await fixture.waitForRunStatus(actor, run.runId, "completed");
  installSharedThreadStorage(context);
  const headers = fixture.sessionHeaders(actor);
  const selected = await accept(
    app()(chatShareSelectionContract).get({
      params: { threadId: run.threadId },
      headers,
    }),
    [200],
  );
  expect(
    selected.body.messages.map((message) => {
      return message.role;
    }),
  ).toStrictEqual(["user", "assistant"]);
  const answer = selected.body.messages[1]!;
  expect(answer.turnEventIds).toStrictEqual(
    selected.body.messages.map((message) => {
      return message.eventId;
    }),
  );
  const created = await accept(
    app()(chatShareSelectionContract).create({
      params: { threadId: run.threadId },
      headers,
      body: {
        id: randomUUID(),
        audience: "public",
        eventIds: [answer.eventId],
      },
    }),
    [201],
  );
  const shared = await accept(
    app()(sharedThreadsContract).get({ params: { id: created.body.id } }),
    [200],
  );
  expect(
    shared.body.messages.map((message) => {
      return {
        role: message.role,
        content: message.content,
      };
    }),
  ).toStrictEqual([{ role: "assistant", content: "The final itinerary" }]);
  await accept(
    app()(chatShareSelectionContract).create({
      params: { threadId: run.threadId },
      headers,
      body: {
        id: randomUUID(),
        audience: "public",
        eventIds: [answer.eventId, randomUUID()],
      },
    }),
    [409],
  );
});

test("keeps the published selection contract private to the owner without a rollout switch", async () => {
  const { actor, agentId } = await fixture.entitledNativeChatActor();
  const run = await fixture.sendChatRun(actor, {
    agentId,
    prompt: "Private travel plans",
  });
  await accept(
    app()(chatShareSelectionContract).get({
      params: { threadId: run.threadId },
      headers: fixture.sessionHeaders(actor),
    }),
    [200],
  );
  const other = fixture.bdd.user();
  const denied = await accept(
    app()(chatShareSelectionContract).get({
      params: { threadId: run.threadId },
      headers: fixture.sessionHeaders(other),
    }),
    [404],
  );
  expect(denied.body.error.code).toBe("NOT_FOUND");
});
