import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
  installActiveChatBoundaries,
  installChatListRunModels,
  onlineComputerUseHost,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import { findNamedButton } from "./chat-attachment-test-helpers.ts";
import { queryComposerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();
const workstation = onlineComputerUseHost(
  "58000000-0000-4000-8000-000000000028",
);
async function openHostSettings() {
  click(await findNamedButton("Connectors"));
  const menu = await screen.findByRole("dialog", { name: "Connectors" });
  return await within(menu).findByRole("switch", { name: "Studio Mac" });
}

test.each(["Studio Mac", "Workshop Mac"] as const)(
  "A member can replay early configuration selecting %s after leaving the retired agent URL",
  async (selected) => {
    const alternate = onlineComputerUseHost(
      "a421cc28-3b86-499a-8797-ad379bc497e3",
      "Workshop Mac",
    );
    const record = chatListThread(8, "Prepared workspace", {
      selectedModel: "deepseek-v4-flash",
    });
    installChatListRunModels(context);
    installActiveChatBoundaries(context, {
      metadata: record,
      hosts: [alternate, workstation],
    });
    installChatListStream(context, {
      caseId: 286,
      snapshot: [],
      events: [
        chatListEvent(286, 2, "model_selection_updated", record.id, {
          selectedModel: "gpt-5.6-sol",
        }),
        chatListEvent(286, 3, "service_tier_updated", record.id, {
          serviceTier: "priority",
        }),
        chatListEvent(286, 4, "computer_use_host_updated", record.id, {
          computerUseHostId:
            selected === "Studio Mac" ? workstation.id : alternate.id,
        }),
        chatListEvent(286, 5, "created", record.id, {
          title: record.title,
          selectedModel: record.selectedModel,
          createdAt: record.createdAt,
        }),
      ],
    });
    await setupPage({
      context,
      path: "/agents/c7000000-0000-4000-a000-000000000001/chat",
    });
    const browse = await findFastControl("link", "Browse workflows");
    expect(browse).toHaveAttribute("href", "/workflows");
    expect(screen.queryByText(record.title!)).toBeNull();
    click(
      await findFastControl("link", "Back to home", screen.getByRole("main")),
    );
    const sidebar = within(await screen.findByTestId("chat-list-column"));
    click(await sidebar.findByText("Prepared workspace"));
    await waitFor(() => {
      expect(location.pathname).toBe(`/chats/${record.id}`);
      expect(
        queryComposerModelTrigger("GPT 5.6 Sol, Max, Fast"),
      ).toBeInTheDocument();
    });
    await openHostSettings();
    const hosts = within(screen.getByRole("dialog", { name: "Connectors" }));
    expect(hosts.getByRole("switch", { name: selected })).toBeChecked();
    expect(
      hosts.getByRole("switch", {
        name: selected === "Studio Mac" ? "Workshop Mac" : "Studio Mac",
      }),
    ).not.toBeChecked();
  },
);

test("chat-list-configuration-003 applies tier and host changes without moving the configured chat", async () => {
  const configured = chatListThread(5, "Configured conversation", {
    selectedModel: "gpt-5.6-sol",
  });
  const recent = chatListThread(22, "Newer conversation");
  const remote = context.mocks.deferred<void>();
  const records = [configured, recent];
  installChatListRunModels(context);
  installActiveChatBoundaries(context, {
    metadata: configured,
    hosts: [workstation],
  });
  const priority = chatListEvent(
    287,
    2,
    "service_tier_updated",
    configured.id,
    { serviceTier: "priority" },
  );
  const connect = chatListEvent(
    287,
    3,
    "computer_use_host_updated",
    configured.id,
    { computerUseHostId: workstation.id },
  );
  const stream = installChatListStream(context, {
    caseId: 287,
    snapshot: records,
    remoteGate: remote.promise,
    events: [priority],
  });
  const page = await startPage({
    context,
    path: `/chats/${configured.id}`,
    cachedChatThreadEvents: cachedChatListEvents(287, records),
  });
  await page.content;
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      recent.title,
      configured.title,
    ]);
    expect(queryComposerModelTrigger("GPT 5.6 Sol")).toBeInTheDocument();
  });
  expect(
    queryComposerModelTrigger("GPT 5.6 Sol, Max, Fast"),
  ).not.toBeInTheDocument();
  const host = await openHostSettings();
  expect(host).not.toBeChecked();
  remote.resolve();
  await waitFor(() => {
    expect(
      queryComposerModelTrigger("GPT 5.6 Sol, Max, Fast"),
    ).toBeInTheDocument();
  });
  expect(host).not.toBeChecked();
  stream.setEvents([priority, connect]);
  context.mocks.ably.trigger("threadListChanged");
  await waitFor(() => {
    expect(host).toBeChecked();
  });
  expect(
    queryComposerModelTrigger("GPT 5.6 Sol, Max, Fast"),
  ).toBeInTheDocument();
  expect(sidebarThreadTitles()).toStrictEqual([recent.title, configured.title]);
});
