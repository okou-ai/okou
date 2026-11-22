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

test("Selecting the newly arrived conversation from member Home restores its model, fast tier and computer", async () => {
  const record = chatListThread(8, "Prepared workspace", {
    selectedModel: "deepseek-v4-flash",
  });
  installChatListRunModels(context);
  installActiveChatBoundaries(context, {
    metadata: record,
    hosts: [workstation],
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
        computerUseHostId: workstation.id,
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
    path: "/",
  });
  const sidebar = within(await screen.findByTestId("chat-list-column"));
  click(await sidebar.findByText("Prepared workspace"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${record.id}`);
    expect(
      queryComposerModelTrigger("GPT 5.6 Sol, Max, Fast"),
    ).toBeInTheDocument();
  });
  await expect(openHostSettings()).resolves.toBeChecked();
});

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
