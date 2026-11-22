import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
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
    sharedWorkerTestTransport: "message-port",
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
    sharedWorkerTestTransport: "message-port",
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
