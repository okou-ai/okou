import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  setupPage,
  startPage,
  fill,
} from "../../../__tests__/page-helper.ts";
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
  sidebarThreadLinks,
} from "./chat-list-test-helpers.ts";
import { findNamedButton } from "./chat-attachment-test-helpers.ts";
import {
  queryComposerModelTrigger,
  composerModelTrigger,
} from "./chat-composer-test-helpers.ts";
import {
  type ChatThreadEvent,
  type ChatThreadSnapshotProjection,
  chatThreadsContract,
  chatThreadDraftContract,
  chatThreadArtifactsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { accountModels } from "./chat-account-model-fixture.ts";
import {
  openModelPanel,
  findModelOption,
  closeModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import userEvent from "@testing-library/user-event";
import {
  createChatRunFixtures,
  findEnabledButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

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

async function openCachedList(
  caseId: number,
  threads: ChatThreadSnapshotProjection[],
) {
  const remote = context.mocks.deferred<void>();
  const stream = installChatListStream(context, {
    caseId,
    snapshot: threads,
    remoteGate: remote.promise,
  });
  const page = await startPage({
    context,
    path: "/",
    cachedChatThreadEvents: cachedChatListEvents(caseId, threads),
  });
  await page.content;
  const list = within(await screen.findByTestId("chat-list-column"));
  return {
    list,
    deliver(events: ChatThreadEvent[]) {
      stream.setEvents(events);
      remote.resolve();
    },
  };
}

test("chat-list-event-order-001 replaces the removed conversation with the newly created chat destination", async () => {
  const old = chatListThread(9, "Old conversation");
  const current = chatListThread(12, "Current conversation");
  const { list, deliver } = await openCachedList(283, [old]);
  await list.findByText("Old conversation");
  deliver([
    chatListEvent(283, 2, "renamed", old.id, { title: "Closing" }),
    chatListEvent(283, 3, "sort_touched", old.id),
    chatListEvent(283, 4, "created", current.id, { title: current.title }),
    chatListEvent(283, 5, "deleted", old.id),
  ]);
  await list.findByText("Current conversation");
  expect(sidebarThreadTitles()).toStrictEqual(["Current conversation"]);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${current.id}`,
  );
});

test("chat-list-event-order-002 promotes the oldest chat ahead of the two newer regular chats", async () => {
  const old = chatListThread(1, "Oldest conversation");
  const middle = chatListThread(4, "Middle conversation");
  const recent = chatListThread(7, "Newest conversation");
  const { list, deliver } = await openCachedList(284, [middle, old, recent]);
  await list.findByText("Newest conversation");
  expect(sidebarThreadTitles()).toStrictEqual([
    recent.title,
    middle.title,
    old.title,
  ]);
  deliver([chatListEvent(284, 2, "pinned", old.id)]);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      old.title,
      recent.title,
      middle.title,
    ]);
  });
});

test("chat-list-event-order-003 retains pin-time ordering when activity reorders regular chats", async () => {
  const first = chatListThread(1, "First pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const second = chatListThread(2, "Second pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const tied = chatListThread(3, "Tied pin", { pinnedAt: second.pinnedAt });
  const older = chatListThread(4, "Older regular chat");
  const newer = chatListThread(5, "Newer regular chat");
  const { list, deliver } = await openCachedList(285, [
    older,
    second,
    newer,
    tied,
    first,
  ]);
  const pinned = [tied.title, second.title, first.title];
  await list.findByText("Tied pin");
  expect(sidebarThreadTitles()).toStrictEqual([
    ...pinned,
    newer.title,
    older.title,
  ]);
  deliver([
    chatListEvent(285, 2, "sort_touched", second.id),
    chatListEvent(285, 3, "sort_touched", first.id),
    chatListEvent(285, 4, "sort_touched", older.id),
    chatListEvent(285, 5, "renamed", newer.id, {
      title: "Updated regular chat",
    }),
  ]);
  await list.findByText("Updated regular chat");
  expect(sidebarThreadTitles()).toStrictEqual([
    ...pinned,
    older.title,
    "Updated regular chat",
  ]);
});

const savedDraft = "Continue the saved shipment review";
function offerServerDraft() {
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftAttachments: null,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: savedDraft }],
      },
    });
  });
}

test("chat-list-optimistic-007 reconciles the temporary sidebar destination with the confirmed title", async () => {
  const submitted = context.mocks.deferred<{ id: string; event: string }>();
  const confirm = context.mocks.deferred<void>();
  const createAccepted = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
    onSendRequest: () => {
      return createAccepted.resolve();
    },
  });
  installChatListRunModels(context);
  const stream = installChatListStream(context, { caseId: 292, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    if (!body.clientThreadId || !body.eventId) {
      throw new Error("Missing client identity on create");
    }
    submitted.resolve({ id: body.clientThreadId, event: body.eventId });
    await confirm.promise;
    return respond(201, {
      id: body.clientThreadId,
      title: null,
      createdAt: "2026-09-19T10:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });

  offerServerDraft();
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Start the local conversation.",
  );
  click(await findEnabledButton("Send"));
  const identity = await submitted.promise;
  const list = within(await screen.findByTestId("chat-list-column"));
  try {
    await waitFor(() => {
      return expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    });
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(composer).not.toHaveTextContent(savedDraft);
    expect(sidebarThreadLinks()[0]).toHaveAttribute(
      "href",
      `/chats/${identity.id}`,
    );
  } finally {
    confirm.resolve();
  }
  await createAccepted.promise;
  stream.setEvents([
    chatListEvent(292, 2, "created", identity.id, {
      id: identity.event,
      title: "Confirmed conversation",
    }),
  ]);
  context.mocks.ably.trigger("threadListChanged");
  await list.findByText("Confirmed conversation");
  expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${identity.id}`,
  );
});

test("The pending conversation plays its inline QuickTime recording before its artifact catalog exists", async () => {
  const movie = {
    id: crypto.randomUUID(),
    filename: "recording.mov",
    contentType: "video/quicktime",
    size: 5,
    url: "https://files.example.org/review/recording.mov",
  };
  context.mocks.upload.success(movie);
  const receipt = context.mocks.deferred<string>(),
    release = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    return query.file_id === movie.id
      ? respond(200, {
          url: movie.url,
          downloadUrl: movie.url,
          expiresAt: "2099-01-01T00:00:00Z",
          publicUrl: movie.url,
        })
      : respond(404, {
          error: { code: "FILE_NOT_FOUND", message: "Missing file" },
        });
  });
  installChatListRunModels(context);
  installChatListStream(context, { caseId: 901, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    const id = body.clientThreadId!;
    receipt.resolve(id);
    await release.promise;
    return respond(201, {
      id,
      title: null,
      createdAt: "2026-11-23T00:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(404, {
      error: { code: "THREAD_NOT_FOUND", message: "Chat thread not found" },
    });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Review the recorded clip.",
  );
  await userEvent
    .setup({ delay: null })
    .upload(
      await screen.findByLabelText("Attach", { selector: "input" }),
      new File(["movie"], movie.filename, { type: movie.contentType }),
    );
  await findEnabledButton("Remove recording.mov");
  click(await findEnabledButton("Send"));
  const id = await receipt.promise;
  try {
    await waitFor(() => {
      return expect(sidebarThreadLinks()[0]).toHaveAttribute(
        "href",
        "/chats/" + id,
      );
    });
    await screen.findByText("Review the recorded clip.");
    await waitFor(() => {
      return expect(document.querySelector("video")?.getAttribute("src")).toBe(
        movie.url + "#t=0.001",
      );
    });
    expect(screen.queryByText("Chat thread not found")).toBeNull();
  } finally {
    release.resolve();
  }
});

test("The confirmed conversation restores the shipment draft supplied by the same draft endpoint", async () => {
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
  });
  offerServerDraft();
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    return expect(editor).toHaveTextContent(savedDraft);
  });
});

test.each([
  ["chat-list-optimistic-001", false, "Start the local conversation."],
  ["chat-list-optimistic-005", true, "Review the winter shipment"],
] as const)(
  "%s the pending conversation keeps the requested destination and model",
  async (_case, changeModel, prompt) => {
    const creation = context.mocks.deferred<{
      id: string;
      model: string | null | undefined;
    }>();
    const acknowledge = context.mocks.deferred<void>();
    const initialModel = changeModel ? "gpt-5.6-luna" : "claude-sonnet-5";
    createChatRunFixtures(context).installRunChat({
      selectedModel: initialModel,
    });
    accountModels(context, ["gpt-5.6-luna", "claude-sonnet-5"], initialModel);
    installChatListStream(context, { caseId: 475, snapshot: [] });
    offerServerDraft();
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      const id = body.clientThreadId;
      if (!id) {
        throw new Error("Expected the new conversation's ID");
      }
      creation.resolve({ id, model: body.model });
      await acknowledge.promise;
      return respond(201, {
        id,
        selectedModel: body.model ?? null,
        serviceTier: null,
        createdAt: "2026-11-24T00:00:00Z",
        title: null,
      });
    });
    await setupPage({ context, path: "/" });
    if (changeModel) {
      const models = await openModelPanel("GPT 5.6 Luna");
      click(await findModelOption("Claude Sonnet 5", models));
      await composerModelTrigger("Claude Sonnet 5");
      await closeModelPanel();
    }
    const editor = await screen.findByRole("textbox", { name: "Message" });
    await fill(editor, prompt);
    expect(editor).toHaveTextContent(prompt);
    click(await findEnabledButton("Send"));
    try {
      const { id, model } = await creation.promise;
      expect(model).toBe("claude-sonnet-5");
      await expect(
        composerModelTrigger("Claude Sonnet 5"),
      ).resolves.toBeVisible();
      await waitFor(() => {
        expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
        expect(sidebarThreadLinks()[0]).toHaveAttribute("href", "/chats/" + id);
      });
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).not.toHaveTextContent(savedDraft);
    } finally {
      acknowledge.resolve();
    }
  },
);
