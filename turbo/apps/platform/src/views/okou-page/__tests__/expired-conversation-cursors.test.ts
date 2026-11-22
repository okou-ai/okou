import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import {
  chatThreadsContract,
  chatThreadEventsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, cleanup } from "@testing-library/react";
import { test, expect } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
  createTestRuntime,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import { chatListEvent } from "./chat-list-test-helpers.ts";
import { promptEvent } from "./chat-run-test-fixtures.ts";
const context = testContext();
test("worker-runtime-007 An expired transcript and thread list recover their fresh snapshots and both tails", async () => {
  const thread = continuityThread(819, 1, "Preliminary plan"),
    stamp = crypto.randomUUID(),
    run = crypto.randomUUID();
  const renewed = { ...thread, title: "Updated plan" },
    latest = chatListEvent(819, 11, "renamed", thread.id, {
      title: "Reviewed plan",
    });
  const rows = mockChatEventRows(
    normalizeMockChatEvents(
      ["Initial version", "Revised schedule", "Minutes approved"].map(
        (text, i) => {
          return promptEvent({
            id: crypto.randomUUID(),
            runId: run,
            seqId: [1, 10, 11][i]!,
            text,
          });
        },
      ),
      thread.id,
    ),
  );
  const ws = installContinuityWorkspace(context, {
    caseId: 819,
    threads: [thread],
    chatEventRows: [],
  });
  let expired = false;
  const url = "https://local-archive.example/meeting-rows";
  const rowExpired = context.mocks.deferred<void>(),
    metaExpired = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [expired ? renewed : thread],
        latestSeqId: expired ? 10 : 1,
        latestEventId: expired ? rows[1]!.id : stamp,
      }),
    );
  });
  context.mocks.api(chatThreadsContract.events, ({ query, respond }) => {
    if (expired && query.sinceSeqId === 1) {
      if (!metaExpired.settled()) {
        metaExpired.resolve();
      }
      return respond(410, {
        error: { code: "CURSOR_EXPIRED", message: "Refresh meeting list" },
      });
    }
    return respond(200, {
      events: expired && query.sinceSeqId === 10 ? [latest] : [],
      hasMore: false,
    });
  });
  context.mocks.http.get(url, () => {
    return new Response(JSON.stringify(rows[1]) + "\n");
  });
  context.mocks.api(chatThreadEventsContract.snapshot, ({ respond }) => {
    return expired
      ? respond(200, {
          url,
          expiresInSeconds: 90,
          lastEventId: rows[1]!.id,
          lastSeqId: 10,
        })
      : respond(404, {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
            message: "No archive",
          },
        });
  });
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    if (expired && query.sinceSeqId === 1) {
      if (!rowExpired.settled()) {
        rowExpired.resolve();
      }
      return respond(410, {
        error: { code: "CHAT_EVENTS_EXPIRED", message: "Refresh transcript" },
      });
    }
    const result = rows.filter((row) => {
        return (
          (expired ? row.seqId === 11 : row.seqId === 1) &&
          row.seqId > (query.sinceSeqId ?? 0)
        );
      }),
      last = result.at(-1);
    return respond(200, {
      rows: result,
      cursor: last
        ? { lastEventId: last.id, lastSeqId: last.seqId }
        : query.sinceEventId
          ? { lastEventId: query.sinceEventId, lastSeqId: query.sinceSeqId }
          : { lastEventId: null, lastSeqId: 0 },
      hasMore: false,
    });
  });
  await setupPage({
    context: createTestRuntime(context),
    auth: ws.pageOptions.auth,
    path: "/chats/" + thread.id,
    sharedWorkerTestTransport: "message-port",
  });
  await expect(screen.findByText("Initial version")).resolves.toBeVisible();
  const channel =
    "user-org:" +
    ws.pageOptions.auth.user.id +
    ":" +
    ws.pageOptions.auth.organization!.activeOrg!.id;
  expired = true;
  context.mocks.ably.triggerOnChannel(channel, "threadListChanged");
  context.mocks.ably.triggerOnChannel(
    channel,
    "chatThreadMessageCreated:" + thread.id,
  );
  await Promise.all([rowExpired.promise, metaExpired.promise]);
  await expect(screen.findByText("Minutes approved")).resolves.toBeVisible();
  await expect(screen.findByText("Revised schedule")).resolves.toBeVisible();
  await expect(
    findFastControl("link", /Reviewed plan/u),
  ).resolves.toBeVisible();
  cleanup();
  const held = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ query, respond }) => {
      await held.promise;
      return respond(200, {
        rows: [],
        hasMore: false,
        cursor: query.sinceEventId
          ? { lastEventId: query.sinceEventId, lastSeqId: query.sinceSeqId }
          : { lastEventId: null, lastSeqId: 0 },
      });
    },
  );
  const reopened = await startPage({
    context: createTestRuntime(context),
    auth: ws.pageOptions.auth,
    path: "/chats/" + thread.id,
    sharedWorkerTestTransport: "message-port",
  });
  await reopened.content;
  await expect(screen.findByText("Minutes approved")).resolves.toBeVisible();
  await expect(screen.findByText("Revised schedule")).resolves.toBeVisible();
  expect(screen.queryByText("Initial version")).toBeNull();
  held.resolve();
  await reopened.ready;
});
