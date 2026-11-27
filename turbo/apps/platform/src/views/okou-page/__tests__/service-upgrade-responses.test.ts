import { screen } from "@testing-library/react";
import { ChatDatabaseHttpError } from "../../../signals/chat-database/http-error.ts";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  fill,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findButton,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const context = testContext();
function upgrade() {
  return HttpResponse.json(
    {
      error: {
        code: "CLIENT_UPGRADE_REQUIRED",
        message: "Upgrade this client",
      },
    },
    { status: 426 },
  );
}
const updateDialog = { name: "Update required" } as const;
test("fetch-003 Searching the connector catalog reveals a required client refresh after delivery", async () => {
  await setupPage({ context, path: "/connectors" });
  const search = await screen.findByPlaceholderText("Find connectors");
  await findButton("Connect GitHub");
  expect(screen.queryByRole("dialog", updateDialog)).toBeNull();
  const request = context.mocks.deferred<void>();
  const reply = context.mocks.deferred<void>();
  context.mocks.http.get(
    "*" + connectorCatalogContract.discovery.path,
    async () => {
      request.resolve();
      await reply.promise;
      return upgrade();
    },
  );
  await fill(search, "quarterly ledger");
  await request.promise;
  expect(screen.queryByRole("dialog", updateDialog)).toBeNull();
  reply.resolve();
  await expect(
    screen.findByRole("dialog", updateDialog),
  ).resolves.toHaveTextContent("Refresh to get the latest version.");
});
test("shared-database-browser-005 The indicator service requires the member to update", async () => {
  const received = context.mocks.deferred<void>();
  const reply = context.mocks.deferred<void>();
  context.mocks.http.get(
    "*" + chatThreadsContract.indicators.path,
    async () => {
      received.resolve();
      await reply.promise;
      return upgrade();
    },
  );
  const opening = await startPage({
    context,
    path: "/workflows",
  });
  await opening.content;
  click(await findButton("Open chat list menu"));
  await received.promise;
  expect(screen.queryByRole("dialog", updateDialog)).toBeNull();
  reply.resolve();
  await expect(
    screen.findByRole("dialog", updateDialog),
  ).resolves.toHaveTextContent("Refresh to get the latest version.");
});
test("worker-runtime-001 A chat database catch-up failure propagates its HTTP status and offers an update", async () => {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  const body = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  context.mocks.http.get(
    "*/api/chat-threads/:threadId/event-rows",
    async () => {
      received.resolve();
      await body.promise;
      return upgrade();
    },
  );
  const page = await startPage({
    context,
    path: RUN_PATH,
  });
  await received.promise;
  body.resolve();
  await expect(page.ready).rejects.toMatchObject({ status: 426 });
  await expect(
    screen.findByRole("dialog", updateDialog),
  ).resolves.toBeVisible();
});

test("message-port-017 the workspace snapshot rejects startup with its chat database HTTP status", async () => {
  const arrived = context.mocks.deferred<void>();
  const deliver = context.mocks.deferred<void>();
  context.mocks.http.get("*" + chatThreadsContract.snapshot.path, async () => {
    if (!arrived.settled()) {
      arrived.resolve();
    }
    await deliver.promise;
    return upgrade();
  });
  const page = await startPage({
    context,
    path: "/workflows",
  });
  await arrived.promise;
  deliver.resolve();
  await expect(page.ready).rejects.toBeInstanceOf(ChatDatabaseHttpError);
  await expect(page.ready).rejects.toMatchObject({ status: 426 });
  await expect(
    screen.findByRole("dialog", updateDialog),
  ).resolves.toBeVisible();
});
