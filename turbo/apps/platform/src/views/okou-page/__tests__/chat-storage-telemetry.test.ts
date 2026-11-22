// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { HttpResponse } from "msw";
import { screen } from "@testing-library/react";

import { expect, test, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
  sharedWorkerTestTransport: "message-port",
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
