import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, cleanup, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import {
  createTestRuntime,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListEvent,
  cachedChatListEvents,
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();

test("platform-direct-bridge-001 The Debug panel measures the UTF-8 bytes of the thread shown in the workspace", async () => {
  const title = "预算草案 🌾";
  const records = [chatListThread(17, title)];
  installChatListStream(context, { caseId: 781, snapshot: records });
  await setupPage({
    context,
    path: "/?settings=debug",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await expect(screen.findByText(title)).resolves.toBeInTheDocument();
  const settings = within(await screen.findByRole("dialog"));
  click(
    await settings.findByText("IndexedDB storage", {
      selector: "summary span",
    }),
  );
  const view = within(
    await settings.findByRole("region", { name: "Thread snapshot" }),
  );
  click(await findFastControl("button", "Measure snapshot"));
  const serialized = JSON.stringify({
    ...cachedChatListEvents(781, records).snapshot,
    id: "current",
  });
  const bytes = new TextEncoder().encode(serialized).byteLength;
  expect(bytes).toBeGreaterThan(serialized.length);
  await expect(view.findByText(String(bytes) + "B")).resolves.toBeVisible();
});

test("platform-direct-bridge-006 A second rename arrives on the live workspace list", async () => {
  const item = chatListThread(21, "Initial map");
  const first = chatListEvent(782, 2, "renamed", item.id, {
    title: "Team field notes",
  });
  const second = chatListEvent(782, 3, "renamed", item.id, {
    title: "Reviewed field notes",
  });
  const remote = installChatListStream(context, {
    caseId: 782,
    snapshot: [item],
    events: [first],
  });
  await setupPage({
    context,
    path: "/",
  });
  const initial = await findFastControl("link", /Team field notes/u);
  expect(initial.getAttribute("href")).toContain(item.id);
  remote.setEvents([first, second]);
  expect(queryFastControl("link", /Reviewed field notes/u)).toBeNull();
  context.mocks.ably.trigger("threadListChanged");
  await expect(
    findFastControl("link", /Reviewed field notes/u),
  ).resolves.toHaveAttribute("href", initial.getAttribute("href"));
  expect(queryFastControl("link", /Team field notes/u)).toBeNull();
});

test("A reopened workspace shows its downloaded conversation before a later rename is delivered", async () => {
  const thread = chatListThread(51, "Southern coast notes");
  const auth = { user: { id: "field-reader", fullName: "Field reader" } };
  const archive =
    "https://r2.example.com/snapshot/coastal-archive.json?signature=fixture";
  const started = context.mocks.deferred<void>();
  const allowObject = context.mocks.deferred<void>();
  const tailRead = context.mocks.deferred<void>();
  const allowRename = context.mocks.deferred<void>();
  let reopening = false;
  installChatListStream(context, { caseId: 851, snapshot: [] });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      url: archive,
      expiresInSeconds: 300,
      latestSeqId: 1,
      latestEventId: crypto.randomUUID(),
    });
  });
  context.mocks.http.get(archive.split("?")[0]!, async ({ request }) => {
    if (new URL(request.url).searchParams.get("signature") !== "fixture") {
      return new Response("Invalid signature", { status: 403 });
    }
    if (!started.settled()) {
      started.resolve();
    }
    await allowObject.promise;
    return Response.json({ chatThreads: [thread] });
  });
  context.mocks.api(chatThreadsContract.events, async ({ query, respond }) => {
    if (reopening) {
      if (!tailRead.settled()) {
        tailRead.resolve();
      }
      await allowRename.promise;
    }
    const events =
      reopening && (query.sinceSeqId ?? 0) < 2
        ? [
            chatListEvent(851, 2, "renamed", thread.id, {
              title: "Approved coast notes",
            }),
          ]
        : [];
    return respond(200, { events, hasMore: false });
  });
  const options = {
    path: "/",
    auth,
  };
  const first = createTestRuntime(context);
  const session = await startPage({ ...options, context: first });
  await started.promise;
  expect(queryFastControl("link", thread.title!)).toBeNull();
  allowObject.resolve();
  await session.ready;
  await expect(findFastControl("link", thread.title!)).resolves.toBeVisible();
  cleanup();
  first.dispose();
  reopening = true;
  const second = await startPage({
    ...options,
    context: createTestRuntime(context),
  });
  await tailRead.promise;
  await expect(findFastControl("link", thread.title!)).resolves.toBeVisible();
  expect(queryFastControl("link", "Approved coast notes")).toBeNull();
  allowRename.resolve();
  await second.ready;
  const renamed = await findFastControl("link", "Approved coast notes");
  expect(renamed.getAttribute("href")).toContain(thread.id);
  expect(queryFastControl("link", thread.title!)).toBeNull();
});
