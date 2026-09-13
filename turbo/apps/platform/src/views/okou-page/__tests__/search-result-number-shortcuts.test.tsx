import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatSearchContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  agentsByIdContract,
  agentsMainContract,
} from "@okouai/api-contracts/contracts/agents";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowSummary,
} from "@okouai/api-contracts/contracts/workflows";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  artifactSummary,
  fileArtifactDetail,
} from "./chat-navigation-artifact-test-helpers.ts";
import {
  CHAT_LIST_AGENT_ID,
  chatListThread,
  fastButton,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";

async function openSearch(modifiers = { ctrlKey: true, metaKey: false }) {
  fireEvent.keyDown(document.body, {
    key: modifiers.metaKey ? "Meta" : "Control",
    ...modifiers,
  });
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    shiftKey: true,
    ...modifiers,
  });
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  const search = within(dialog).getByPlaceholderText(SEARCH_LABEL);
  fireEvent.keyUp(search, { key: "Shift", ...modifiers, shiftKey: false });
  return { dialog, search };
}

function numberedHints(dialog: HTMLElement): string[] {
  return [...dialog.querySelectorAll("kbd")]
    .map((keycap) => {
      return keycap.textContent?.match(/[1-9]$/)?.[0];
    })
    .filter((text): text is string => {
      return text !== undefined;
    });
}

function searchResultTitles(dialog: HTMLElement): string[] {
  return queryAllByRoleFast("option", dialog).map((option) => {
    return option.querySelector(".truncate")?.textContent ?? "";
  });
}

function installSearchResources() {
  const agent = {
    isDefaultAgent: false,
    agentId: "c7000000-0000-4000-a000-000000000002",
    displayName: "Budget agent",
    ownerId: "test-user",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private" as const,
  };
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, [
      { ...agent, agentId: CHAT_LIST_AGENT_ID, displayName: "List agent" },
      agent,
    ]);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      ...agent,
      agentId: params.id,
      displayName:
        params.id === agent.agentId ? agent.displayName : "List agent",
    });
  });
  const workflow: WorkflowSummary = {
    id: "f7000000-0000-4000-a000-000000000001",
    agentId: CHAT_LIST_AGENT_ID,
    agentName: "Support Agent",
    agentDisplayName: "Support Agent",
    name: "budget-review",
    displayName: "Budget review",
    description: null,
    visibility: "private",
    ownerUserId: "test-user",
    createdAt: "2026-08-01T01:00:00.000Z",
    canManage: true,
    canPublish: true,
    official: null,
  };
  context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [workflow]);
  });
  context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
    return respond(200, {
      ...workflow,
      createdByUserId: workflow.ownerUserId,
      updatedByUserId: workflow.ownerUserId,
      updatedAt: workflow.createdAt,
      instruction: "Review the budget.",
      files: [],
      fileContents: [],
      automations: [],
    });
  });
  const artifact = artifactSummary(
    "f7000000-0000-4000-a000-000000000002",
    "file",
    "Budget report",
  );
  context.mocks.http.get(
    "https://cdn.vm7.io/search-shortcuts/budget.txt",
    () => {
      return new Response("Budget report contents", {
        headers: { "Content-Type": "text/plain" },
      });
    },
  );
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [artifact], nextCursor: null });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(
      200,
      fileArtifactDetail(artifact, {
        contentType: "text/plain",
        fileId: "f7000000-0000-4000-a000-000000000002",
        filename: "budget.txt",
        url: "https://cdn.vm7.io/search-shortcuts/budget.txt",
      }),
    );
  });
  return { agent, workflow, artifact };
}

test("Limit empty search to 25 cached chats in sidebar order", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const threads = Array.from({ length: 26 }, (_, index) => {
    return chatListThread(index + 1, `Chat ${index + 1}`, {
      pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
    });
  });
  const remoteChatList = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 77,
    threads,
    chatListRemoteGate: remoteChatList.promise,
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  const expectedTitles = [
    "Chat 1",
    "Chat 2",
    ...Array.from({ length: 23 }, (_, index) => {
      return `Chat ${26 - index}`;
    }),
  ];
  const chatThreads = await screen.findByLabelText("Chat threads");
  await within(chatThreads).findByText(expectedTitles[0]!);
  expect(sidebarThreadTitles().slice(0, 3)).toStrictEqual(
    expectedTitles.slice(0, 3),
  );
  click(fastButton("Hide chat list"));
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  const { dialog } = await openSearch();
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual(expectedTitles);
  });
  expect(remoteChatList.settled()).toBeFalsy();
});

test.each([
  {
    caseId: 74,
    platform: "Mac Chrome",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    modifiers: { metaKey: true, ctrlKey: false },
    numberModifiers: { metaKey: true, ctrlKey: false },
    firstHint: ["⌘1"],
  },
  {
    caseId: 75,
    platform: "Mac Safari",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
    modifiers: { metaKey: true, ctrlKey: false },
    numberModifiers: { metaKey: true, ctrlKey: true },
    firstHint: ["⌘⌃1"],
  },
  {
    caseId: 76,
    platform: "Windows",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    modifiers: { metaKey: false, ctrlKey: true },
    numberModifiers: { metaKey: false, ctrlKey: true },
    firstHint: ["Ctrl+1"],
  },
])(
  "Number only the first nine search results and open the ninth on $platform",
  async ({ caseId, userAgent, modifiers, numberModifiers, firstHint }) => {
    context.mocks.browser.userAgent(userAgent);
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
      );
    });
    // Keep one result beyond the nine shortcuts; the 25-result cap is separate.
    const threads = Array.from({ length: 10 }, (_, index) => {
      return chatListThread(index + 1, `Chat ${index + 1}`, {
        pinnedAt: index < 2 ? `2026-08-01T00:5${2 - index}:00.000Z` : null,
      });
    });
    const remoteChatList = context.mocks.deferred<void>();
    const workspace = installContinuityWorkspace(context, {
      caseId,
      threads,
      chatListRemoteGate: remoteChatList.promise,
    });
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      ...workspace.pageOptions,
    });
    const expectedTitles = [
      "Chat 1",
      "Chat 2",
      ...Array.from({ length: 8 }, (_, index) => {
        return `Chat ${10 - index}`;
      }),
    ];
    const chatThreads = await screen.findByLabelText("Chat threads");
    await within(chatThreads).findByText(expectedTitles[0]!);
    expect(sidebarThreadTitles().slice(0, 3)).toStrictEqual(
      expectedTitles.slice(0, 3),
    );
    expect(remoteChatList.settled()).toBeFalsy();
    click(fastButton("Hide chat list"));
    const { dialog, search } = await openSearch(modifiers);
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual(expectedTitles);
      expect(numberedHints(dialog)).toStrictEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
      ]);
    });
    expect(
      [...queryAllByRoleFast("option", dialog)[0]!.querySelectorAll("kbd")].map(
        (keycap) => {
          return keycap.textContent;
        },
      ),
    ).toStrictEqual(firstHint);
    expect(
      queryAllByRoleFast("option", dialog)[9]!.querySelector("kbd"),
    ).toBeNull();
    fireEvent.keyUp(search, { key: modifiers.metaKey ? "Meta" : "Control" });
    await waitFor(() => {
      expect(numberedHints(dialog)).toStrictEqual([]);
    });
    fireEvent.keyDown(search, {
      key: modifiers.metaKey ? "Meta" : "Control",
      ...modifiers,
    });
    await waitFor(() => {
      expect(numberedHints(dialog)).toHaveLength(9);
    });
    fireEvent.keyDown(search, {
      key: "9",
      code: "Digit9",
      ...numberModifiers,
      shiftKey: false,
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(pathname()).toBe(`/chats/${threads[3]!.id}`);
    });
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  },
);

test("Empty search follows the current agent and unread filter", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const first = chatListThread(1, "First pin", {
    pinnedAt: "2026-08-01T00:51:00.000Z",
  });
  const second = chatListThread(2, "Unread pin", {
    pinnedAt: "2026-08-01T00:50:00.000Z",
  });
  const third = chatListThread(3, "Unread regular chat");
  const foreign = chatListThread(4, "Other agent's pin", {
    agentId: "c7000000-0000-4000-a000-000000000002",
    pinnedAt: "2026-08-01T00:59:00.000Z",
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 25,
    threads: [first, second, third, foreign],
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: [second, third].map((thread) => {
        return { threadId: thread.id, unreadAt: "2026-08-01T01:00:00.000Z" };
      }),
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(sidebarThreadTitles()).toHaveLength(3);
  });
  click(fastButton("Open chat list menu"));
  const unreadOnly = queryAllByRoleFast("menuitem").find((item) => {
    return item.textContent?.trim() === "Unread only";
  });
  if (!unreadOnly) {
    throw new Error("Expected unread filter");
  }
  click(unreadOnly);
  await waitFor(() => {
    expect(sidebarThreadTitles()).toStrictEqual([
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  const { dialog, search } = await openSearch();
  await fill(search, "   ");
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual([
      "Unread pin",
      "Unread regular chat",
    ]);
  });
  fireEvent.keyDown(search, {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: false,
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${second.id}`);
  });
});

test("Search numbers follow fresh matches and restart after filtering", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const titleMatch = chatListThread(1, "Budget planning");
  const messageMatch = chatListThread(2, "Project notes");
  const workspace = installContinuityWorkspace(context, {
    caseId: 26,
    threads: [titleMatch, messageMatch],
  });
  context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
    return respond(200, {
      results:
        query.keyword === "budget"
          ? [
              {
                chatThreadId: messageMatch.id,
                agentName: "Support Agent",
                matchedMessage: {
                  chatThreadId: messageMatch.id,
                  role: "user",
                  content: "Review the budget",
                  createdAt: "2026-08-01T01:00:00.000Z",
                  seqId: 1,
                  runId: null,
                },
                matchedRanges: [{ start: 11, end: 17 }],
              },
            ]
          : [],
    });
  });
  await setupPage({
    context,
    path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
    ...workspace.pageOptions,
  });
  const { dialog, search } = await openSearch();
  await fill(search, "budget");
  fireEvent.keyDown(search, { key: "Control", ctrlKey: true });
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual([
      "Budget planning",
      "Project notes",
    ]);
    expect(numberedHints(dialog)).toStrictEqual(["1", "2"]);
  });
  const messagesTab = queryAllByRoleFast("tab", dialog).find((tab) => {
    return tab.textContent === "Messages";
  });
  if (!messagesTab) {
    throw new Error("Expected Messages filter");
  }
  click(messagesTab);
  await waitFor(() => {
    expect(searchResultTitles(dialog)).toStrictEqual(["Project notes"]);
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  fireEvent.keyDown(search, {
    key: "1",
    code: "Digit1",
    ctrlKey: true,
    shiftKey: false,
  });
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${messageMatch.id}`);
  });
});

test("Search shortcuts preserve typing and reset hints when the modifier is released or the dialog closes", async () => {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  const first = chatListThread(1, "First chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 27,
    threads: [first],
  });
  await setupPage({
    context,
    path: `/chats/${first.id}`,
    ...workspace.pageOptions,
  });
  const { dialog, search } = await openSearch();
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  for (const ignored of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { altKey: true },
    { shiftKey: true },
    { metaKey: true },
  ]) {
    const event = new KeyboardEvent("keydown", {
      key: "1",
      code: "Digit1",
      ctrlKey: true,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
      ...ignored,
    });
    search.dispatchEvent(event);
    expect(event.defaultPrevented).toBeFalsy();
    expect(dialog).toBeInTheDocument();
  }
  fireEvent.keyDown(search, {
    key: "9",
    code: "Digit9",
    ctrlKey: true,
    shiftKey: false,
  });
  expect(dialog).toBeInTheDocument();
  expect(search).toHaveValue("");
  fireEvent.keyUp(search, { key: "Control", ctrlKey: false });
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual([]);
  });
  search.focus();
  await userEvent.keyboard("19");
  expect(search).toHaveValue("19");
  await fill(search, "");
  fireEvent.keyDown(search, { key: "Control", ctrlKey: true });
  await waitFor(() => {
    expect(numberedHints(dialog)).toStrictEqual(["1"]);
  });
  fireEvent.keyDown(search, { key: "Escape", code: "Escape" });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(fastButton("Search workspace"));
  const reopened = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  await waitFor(() => {
    expect(searchResultTitles(reopened)).toStrictEqual(["First chat"]);
  });
  expect(numberedHints(reopened)).toStrictEqual([]);
});

test.each([
  {
    filter: "All",
    titles: [
      "Budget planning",
      "Budget agent",
      "Budget review",
      "Budget report",
    ],
    hints: ["1", "2", "3", "4"],
    digit: "4",
  },
  { filter: "Agents", titles: ["Budget agent"], hints: ["1"], digit: "1" },
  { filter: "Workflows", titles: ["Budget review"], hints: ["1"], digit: "1" },
])(
  "Open a resource from numbered search results in $filter",
  async ({ filter, titles, hints, digit }) => {
    context.mocks.browser.matchMedia((query) => {
      return (
        query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
      );
    });
    const titleMatch = chatListThread(1, "Budget planning");
    const workspace = installContinuityWorkspace(context, {
      caseId: 29,
      threads: [titleMatch],
    });
    const { agent, workflow, artifact } = installSearchResources();
    await setupPage({
      context,
      path: `/agents/${CHAT_LIST_AGENT_ID}/chat`,
      ...workspace.pageOptions,
    });
    const { dialog, search } = await openSearch();
    await fill(search, "budget");
    fireEvent.keyDown(search, { key: "Control", ctrlKey: true });
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual([
        "Budget planning",
        "Budget agent",
        "Budget review",
        "Budget report",
      ]);
      expect(numberedHints(dialog)).toStrictEqual(["1", "2", "3", "4"]);
    });
    const tab = queryAllByRoleFast("tab", dialog).find((item) => {
      return item.textContent === filter;
    });
    if (!tab) {
      throw new Error(`Expected ${filter} filter`);
    }
    click(tab);
    await waitFor(() => {
      expect(searchResultTitles(dialog)).toStrictEqual(titles);
      expect(numberedHints(dialog)).toStrictEqual(hints);
    });
    fireEvent.keyDown(search, {
      key: digit,
      code: `Digit${digit}`,
      ctrlKey: true,
      shiftKey: false,
    });
    const expectedPath =
      filter === "Agents"
        ? `/agents/${agent.agentId}/chat`
        : filter === "Workflows"
          ? `/workflows/${workflow.id}`
          : "/artifacts";
    const expectedArtifact = filter === "All" ? artifact.id : null;
    const expectedTab = filter === "All" ? "file" : null;
    await waitFor(() => {
      expect(pathname()).toBe(expectedPath);
      const searchParams = new URL(window.location.href).searchParams;
      expect(searchParams.get("artifact")).toBe(expectedArtifact);
      expect(searchParams.get("tab")).toBe(expectedTab);
    });
  },
);
