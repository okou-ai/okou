import { vi, expect, test } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  RUN_PATH,
  RUN_THREAD_ID,
  assistantEvent,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
test("worker-runtime-002 Reopening a conversation reads only rows belonging to the member's selected workspace", async () => {
  const user = { id: "local-archive-owner", fullName: "Archive reader" };
  const member = (id: string) => {
    return {
      user,
      organization: { activeOrg: { id, name: id }, memberships: [{ id }] },
    };
  };
  const sources = [
    {
      org: "archive-east",
      id: "0ef0613e-49f0-4532-8e75-7b0e585b5391",
      text: "East accounting report",
    },
    {
      org: "archive-west",
      id: "d26ef4c4-65ca-4d63-8e52-7b4734ab55ec",
      text: "West planning report",
    },
  ];

  for (const entry of sources) {
    const open = createTestRuntime(context);
    mockChatLifecycle(context, {
      threadId: RUN_THREAD_ID,
      chatEvents: [
        assistantEvent({
          id: entry.id,
          runId: "fa01e1ce-4214-4ffe-9b79-409b7d220215",
          seqId: 1,
          text: entry.text,
        }),
      ],
    });
    await setupPage({
      context: open,
      path: RUN_PATH,
      auth: member(entry.org),
      sharedWorkerTestTransport: "message-port",
    });
    await expect(screen.findByText(entry.text)).resolves.toBeVisible();
    cleanup();
    if (vi.isMockFunction(history.replaceState)) {
      vi.mocked(history.replaceState).mockRestore();
    }
  }
  for (const entry of sources) {
    const online = context.mocks.deferred<void>();
    context.mocks.http.get("*/api/chat-threads/:id/event-rows", async () => {
      await online.promise;
      return Response.json({
        rows: [],
        cursor: { lastEventId: null, lastSeqId: 0 },
        hasMore: false,
      });
    });
    const open = createTestRuntime(context);
    const page = await startPage({
      context: open,
      path: RUN_PATH,
      auth: member(entry.org),
      sharedWorkerTestTransport: "message-port",
    });
    await page.content;
    await expect(screen.findByText(entry.text)).resolves.toBeVisible();
    for (const other of sources.filter((source) => {
      return source !== entry;
    })) {
      expect(screen.queryByText(other.text)).toBeNull();
    }
    online.resolve();
    await page.ready;
    cleanup();
    if (vi.isMockFunction(history.replaceState)) {
      vi.mocked(history.replaceState).mockRestore();
    }
  }
});
