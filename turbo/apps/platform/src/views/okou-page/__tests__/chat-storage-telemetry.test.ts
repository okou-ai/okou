// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { openDB } from "idb";
import { HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";

import { expect, test, vi } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListAuth } from "./chat-list-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const sink = vi.hoisted(() => {
  return vi.fn<(_dataset: string, events: Record<string, unknown>[]) => void>();
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest = sink;
      async flush() {}
    },
  };
});
const context = testContext();
const settings = {
  context,
  auth: chatListAuth(789),
  host: "app.okou.ai",
  env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "local-observability" },
} as const;
function reports(name: string) {
  return sink.mock.calls
    .flatMap(([, events]) => {
      return events;
    })
    .filter((event) => {
      return event.name === name;
    });
}
test("indexeddb-client-001 Opening a workspace emits a successful duration without disclosing the member or organization", async () => {
  sink.mockClear();
  await setupPage({ ...settings, path: "/workflows" });
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
  const events = reports("chat.open");
  expect(events).toContainEqual(
    expect.objectContaining({
      duration: expect.any(Number),
      "attributes.custom": expect.objectContaining({
        "okou.client.outcome": "success",
        "okou.client.runtime": "window",
      }),
    }),
  );
  expect(JSON.stringify(events)).not.toMatch(/chat-list-(?:user|org)-789/u);
});

test("indexeddb-client-006 Opening a private chat reports its event-rows route without the token, cursor or thread identity", async () => {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  sink.mockClear();
  const received = context.mocks.deferred<{
    limit?: number;
    sinceSeqId?: number;
    authorization: string | null;
  }>();
  context.mocks.http.get(
    "*/api/chat-threads/:threadId/event-rows",
    ({ request }) => {
      const params = new URL(request.url).searchParams;
      if (!received.settled()) {
        received.resolve({
          limit: Number(params.get("limit")),
          sinceSeqId: params.has("sinceSeqId")
            ? Number(params.get("sinceSeqId"))
            : undefined,
          authorization: request.headers.get("authorization"),
        });
      }
      return HttpResponse.json({
        rows: [],
        cursor: { lastSeqId: 0, lastEventId: null },
        hasMore: false,
      });
    },
  );
  await setupPage({ ...settings, path: RUN_PATH });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  await expect(received.promise).resolves.toMatchObject({
    limit: 50,
    sinceSeqId: 0,
    authorization: "Bearer test-token",
  });
  const events = reports("GET /api/chat-threads/:threadId/event-rows");
  expect(events).toContainEqual(
    expect.objectContaining({
      "attributes.http.response.status_code": 200,
      "attributes.custom": expect.objectContaining({
        "okou.client.runtime": "window",
        "okou.client.outcome": "success",
      }),
    }),
  );
  for (const value of [RUN_THREAD_ID, "test-token", "sinceSeqId"]) {
    expect(JSON.stringify(events)).not.toContain(value);
  }
});

test("chat-idb-002 A returning workspace keeps the previous generation's records and receives its later upgrade notification", async () => {
  const name = "vm0-chat-chat-list-user-789-chat-list-org-789";
  const previous = await openDB(name, 32_008, {
    upgrade(db) {
      const events = db.createObjectStore("chat_events", { keyPath: "id" });
      events.createIndex("byThreadAndSeq", ["chatThreadId", "seqId"], {
        unique: true,
      });
      db.createObjectStore("chat_thread_snapshot", { keyPath: "id" });
      db.createObjectStore("chat_event_cursors", { keyPath: "threadId" });
      db.createObjectStore("chat_thread_event_sync", { keyPath: "id" });
      db.createObjectStore("chat_thread_events", { keyPath: "id" }).createIndex(
        "bySeqId",
        "seqId",
        { unique: true },
      );
    },
  });
  const record = { id: "earlier-snapshot", title: "Ferry timetable" };
  const seed = previous.transaction(
    ["chat_thread_snapshot", "chat_events"],
    "readwrite",
  );
  await seed.objectStore("chat_thread_snapshot").put(record);
  for (const seqId of [2, 3, 1]) {
    await seed.objectStore("chat_events").add({
      id: "ferry-" + (4 - seqId),
      chatThreadId: "ferry",
      seqId,
    });
  }
  await seed.done;
  previous.close();
  sink.mockClear();
  await setupPage({ ...settings, path: "/workflows" });
  await screen.findByRole("heading", { name: "Workflows" });
  const upgraded = await openDB(name);
  const version = upgraded.version;
  try {
    expect(version).toBeGreaterThan(32_008);
    expect(Array.from(upgraded.objectStoreNames)).toStrictEqual([
      "chat_event_cursors",
      "chat_events",
      "chat_thread_event_sync",
      "chat_thread_events",
      "chat_thread_snapshot",
      "project_events",
      "project_snapshot",
    ]);
    await expect(
      upgraded.get("chat_thread_snapshot", record.id),
    ).resolves.toStrictEqual(record);
    const sequence = await upgraded.getAllKeysFromIndex(
      "chat_events",
      "byThreadAndSeq",
      IDBKeyRange.bound(["ferry", 1], ["ferry", 3]),
    );
    expect(sequence).toStrictEqual(["ferry-3", "ferry-2", "ferry-1"]);
  } finally {
    upgraded.close();
  }
  const successor = await openDB(name, version + 1);
  successor.close();
  await waitFor(() => {
    expect(reports("chat.version_changed")).toStrictEqual([
      expect.objectContaining({
        "scope.name": "okou-app/indexeddb",
        "attributes.custom": expect.objectContaining({
          "db.namespace": "chat",
          "db.system": "indexeddb",
          "okou.client.outcome": "error",
        }),
      }),
    ]);
  });
});

test("Opening a conversation with a failing local archive reports only the database operation", async () => {
  const original = new DOMException(
    "private cove diagnostic",
    "InvalidStateError",
  );
  const open = indexedDB.open.bind(indexedDB);
  const entered = context.mocks.deferred<void>();
  vi.spyOn(indexedDB, "open").mockImplementation((name, version) => {
    if (name.endsWith("chat-list-user-789-chat-list-org-789")) {
      if (!entered.settled()) {
        entered.resolve();
      }
      throw original;
    }
    return open(name, version);
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  sink.mockClear();
  const route = await startPage({ ...settings, path: RUN_PATH });
  await entered.promise;
  await route.ready;
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  const records = reports("chat.open");
  expect(records).toContainEqual(
    expect.objectContaining({
      duration: expect.any(Number),
      "attributes.custom": expect.objectContaining({
        "okou.client.outcome": "error",
      }),
    }),
  );
  expect(JSON.stringify(records)).not.toMatch(
    /private cove diagnostic|chat-list-(?:user|org)-789/u,
  );
});
