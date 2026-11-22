import { screen, cleanup } from "@testing-library/react";
import { expect, test } from "vitest";
import { startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatListAuth, chatListThread } from "./chat-list-test-helpers.ts";
import { observeWorkerTraffic } from "./worker-traffic-fixture.ts";

const context = testContext();
function threadLists(
  wire: ReturnType<typeof observeWorkerTraffic>,
  consistency: "catch-up" | "cache-only",
) {
  const ids = new Set(
    wire.requests().flatMap((msg) => {
      return msg.type === "query" &&
        msg.query.consistency === consistency &&
        msg.query.dataKey.kind === "chat-thread-event"
        ? [msg.requestId]
        : [];
    }),
  );
  return wire.received().flatMap((reply) => {
    return reply.type === "result" && ids.has(reply.requestId)
      ? [reply.value]
      : [];
  });
}

test("worker-runtime-005 A signed object supplies the workspace list and a reopened app reads the same snapshot from cache", async () => {
  const wire = observeWorkerTraffic(context.signal);
  const owner = chatListAuth(791);
  const open = createTestRuntime(context);
  const item = chatListThread(22, "Dispatch ledger");
  const latestEventId = "fdda7791-55bb-4706-b521-48237dfe38cb";
  const snapshot = { chatThreads: [item], latestEventId, latestSeqId: 11 };
  const archive =
    "https://fixture.example.org/objects/dispatch-list.json?fixture=read";
  const pending = context.mocks.deferred<void>();
  const delivered = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      url: archive,
      expiresInSeconds: 60,
      latestEventId,
      latestSeqId: 11,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.http.get(archive.split("?")[0]!, async () => {
    if (!delivered.settled()) {
      delivered.resolve();
    }
    await pending.promise;
    return Response.json({ chatThreads: [item] });
  });
  const options = {
    path: "/",
    auth: owner,
    sharedWorkerTestTransport: "message-port",
  } as const;
  const first = await startPage({ ...options, context: open });
  await delivered.promise;
  await first.content;
  expect(screen.queryByText("Dispatch ledger")).toBeNull();
  pending.resolve();
  await first.ready;
  await expect(screen.findByText("Dispatch ledger")).resolves.toBeVisible();
  const result = { snapshot, events: [] };
  expect(threadLists(wire, "catch-up")).toContainEqual(result);
  cleanup();
  const offline = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.events, async ({ respond }) => {
    await offline.promise;
    return respond(200, { events: [], hasMore: false });
  });
  const reopened = await startPage({
    ...options,
    context: createTestRuntime(context),
  });
  await reopened.content;
  await expect(screen.findByText("Dispatch ledger")).resolves.toBeVisible();
  expect(threadLists(wire, "cache-only")).toContainEqual(result);
  offline.resolve();
  await reopened.ready;
});
