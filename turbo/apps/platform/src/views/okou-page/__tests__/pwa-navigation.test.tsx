import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  queryAllByRoleFast,
  setupPage,
  swipeBack,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { CHAT_LIST_AGENT_ID, fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();
const CHAT_LIST_PATH = `/agents/${CHAT_LIST_AGENT_ID}/chat`;

function mockDisplayMode({
  standalone,
  desktop,
}: {
  readonly standalone: boolean;
  readonly desktop: boolean;
}): void {
  context.mocks.browser.matchMedia((query) => {
    if (query === "(display-mode: standalone)") {
      return standalone;
    }
    return query === "(min-width: 48rem)" && desktop;
  });
}

function linkTo(href: string, container: ParentNode = document): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.getAttribute("href") === href;
  });
  if (!link) {
    throw new Error(`Expected link to ${href}`);
  }
  return link;
}

function menuItem(name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected menu item ${name}`);
  }
  return item;
}

test("Keep the desktop navigation in a desktop PWA", async () => {
  mockDisplayMode({ standalone: true, desktop: true });
  const workspace = installContinuityWorkspace(context, {
    caseId: 73,
    threads: [continuityThread(73, 1, "Existing work")],
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
});

test.each([false])(
  "Open workspace search from the compact mobile chat header (standalone: %s)",
  async (standalone) => {
    mockDisplayMode({ standalone, desktop: false });
    const caseId = standalone ? 82 : 81;
    const workspace = installContinuityWorkspace(context, {
      caseId,
      threads: [continuityThread(caseId, 1, "Search planning")],
    });

    await setupPage({
      context,
      path: CHAT_LIST_PATH,
      ...workspace.pageOptions,
    });

    await screen.findByText("Search planning");
    const search = screen.getByLabelText("Search workspace");
    const header = search.closest("header");
    if (!header) {
      throw new Error("Expected workspace search in the chat list header");
    }
    expect(
      queryAllByRoleFast("button", header).map((button) => {
        return button.getAttribute("aria-label");
      }),
    ).toStrictEqual([
      "Switch agent",
      "Search workspace",
      "New chat",
      "Open chat list menu",
    ]);

    click(search);
    const dialog = await screen.findByRole("dialog", {
      name: "Search workspace...",
    });
    expect(
      within(dialog).getByPlaceholderText("Search workspace..."),
    ).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Search workspace..." }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Search planning")).toBeInTheDocument();
    expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  },
);

test("Browse and filter mobile browser chats before opening a conversation and returning", async () => {
  mockDisplayMode({ standalone: false, desktop: false });
  const inbox = continuityThread(74, 1, "Plan the launch");
  const archived = {
    ...continuityThread(74, 2, "Previous launch"),
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 74,
    threads: [inbox, archived],
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      agentId: params.id,
      isDefaultAgent: false,
      ownerId: "chat-list-owner",
      displayName: "List agent",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "private",
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  const navigation = await screen.findByRole("navigation", {
    name: "Main navigation",
  });
  await screen.findByText("Plan the launch");
  expect(linkTo(CHAT_LIST_PATH, navigation)).toHaveTextContent("Chats");
  expect(linkTo(CHAT_LIST_PATH, navigation)).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(linkTo("/connectors", navigation)).toHaveTextContent("Connectors");
  expect(linkTo("/artifacts", navigation)).toHaveTextContent("Artifacts");
  expect(linkTo("/me", navigation)).toHaveTextContent("Me");
  expect(screen.queryByText("Previous launch")).not.toBeInTheDocument();

  click(fastButton("Open chat list menu"));
  await waitFor(() => {
    expect(menuItem("Archived")).toBeInTheDocument();
  });
  click(menuItem("Archived"));

  await screen.findByText("Previous launch");
  expect(screen.queryByText("Plan the launch")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);

  click(linkTo(`/chats/${archived.id}`));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(`/chats/${archived.id}`);
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeInTheDocument();

  click(screen.getByLabelText("Back to chats"));

  await waitFor(() => {
    expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  });
  expect(screen.getByLabelText("Switch agent")).toHaveTextContent("List agent");

  click(screen.getByLabelText("New chat"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  expect(new URLSearchParams(window.location.search).get("compose")).toBe("1");
  expect(screen.getByLabelText("Back to chats")).toBeInTheDocument();

  click(
    linkTo("/me", screen.getByRole("navigation", { name: "Main navigation" })),
  );

  await expect(
    screen.findByRole("heading", { name: "Me" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/me");
});

test("Slide conversations in from the mobile chat list and out back to the tabs", async () => {
  mockDisplayMode({ standalone: true, desktop: false });
  const viewTransition = context.mocks.browser.viewTransition();
  const thread = continuityThread(83, 1, "Draft the brief");
  const workspace = installContinuityWorkspace(context, {
    caseId: 83,
    threads: [thread],
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  await screen.findByText("Draft the brief");

  click(linkTo(`/chats/${thread.id}`));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(viewTransition.startedTypes).toStrictEqual([["push"]]);

  click(screen.getByLabelText("Back to chats"));

  await screen.findByText("Draft the brief");
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  expect(viewTransition.startedTypes).toStrictEqual([["push"], ["pop"]]);

  click(linkTo(`/chats/${thread.id}`));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(viewTransition.startedTypes).toStrictEqual([
    ["push"],
    ["pop"],
    ["push"],
  ]);

  act(() => {
    window.history.back();
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  });
  await screen.findByText("Draft the brief");
  expect(viewTransition.startedTypes).toStrictEqual([
    ["push"],
    ["pop"],
    ["push"],
    ["pop"],
  ]);

  click(
    linkTo("/me", screen.getByRole("navigation", { name: "Main navigation" })),
  );

  await expect(
    screen.findByRole("heading", { name: "Me" }),
  ).resolves.toBeInTheDocument();
  expect(viewTransition.startedTypes).toStrictEqual([
    ["push"],
    ["pop"],
    ["push"],
    ["pop"],
  ]);
});

test("My Okou's chats tab is its chat list at / and composes a new chat there", async () => {
  mockDisplayMode({ standalone: true, desktop: false });
  const viewTransition = context.mocks.browser.viewTransition();
  const thread = continuityThread(84, 1, "Draft the brief");
  const workspace = installContinuityWorkspace(context, {
    caseId: 84,
    threads: [thread],
  });
  context.mocks.data.onboardingStatus({ defaultAgentId: CHAT_LIST_AGENT_ID });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });

  await setupPage({
    context,
    path: "/",
    featureSwitches: {
      [FeatureSwitchKey.SingleAgent]: true,
    },
    ...workspace.pageOptions,
  });

  const navigation = await screen.findByRole("navigation", {
    name: "Main navigation",
  });
  await screen.findByText("Draft the brief");
  expect(linkTo("/", navigation)).toHaveAttribute("aria-current", "page");

  click(linkTo(`/chats/${thread.id}`));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(viewTransition.startedTypes).toStrictEqual([["push"]]);

  click(screen.getByLabelText("Back to chats"));

  await screen.findByText("Draft the brief");
  expect(window.location.pathname).toBe("/");
  expect(viewTransition.startedTypes).toStrictEqual([["push"], ["pop"]]);

  click(screen.getByLabelText("New chat"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/");
  expect(new URLSearchParams(window.location.search).get("compose")).toBe("1");
  expect(screen.getByLabelText("Back to chats")).toHaveAttribute("href", "/");
  expect(viewTransition.startedTypes).toStrictEqual([
    ["push"],
    ["pop"],
    ["push"],
  ]);
});

test("Leave the slide to the browser after an edge swipe back", async () => {
  mockDisplayMode({ standalone: false, desktop: false });
  const viewTransition = context.mocks.browser.viewTransition();
  const thread = continuityThread(85, 1, "Plan the offsite");
  const workspace = installContinuityWorkspace(context, {
    caseId: 85,
    threads: [thread],
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  await screen.findByText("Plan the offsite");

  click(linkTo(`/chats/${thread.id}`));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(viewTransition.startedTypes).toStrictEqual([["push"]]);

  act(() => {
    swipeBack();
  });

  await waitFor(() => {
    expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  });
  await screen.findByText("Plan the offsite");
  expect(viewTransition.startedTypes).toStrictEqual([["push"]]);
});

test("Point to unread chats in other agents from the tabs and the agent switcher", async () => {
  mockDisplayMode({ standalone: false, desktop: false });
  const researchAgentId = "c7000000-0000-4000-a000-000000000003";
  const workspace = installContinuityWorkspace(context, {
    caseId: 80,
    threads: [continuityThread(80, 1, "Launch planning")],
  });
  const listAgent: AgentResponse = {
    agentId: CHAT_LIST_AGENT_ID,
    isDefaultAgent: false,
    ownerId: "chat-list-owner",
    displayName: "List agent",
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "private",
  };
  const agents = [
    listAgent,
    { ...listAgent, agentId: researchAgentId, displayName: "Research agent" },
  ];
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const agent = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    return agent
      ? respond(200, agent)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Agent not found" },
        });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [researchAgentId]: "unread" },
      threads: {},
      unreadAt: {},
    });
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  await screen.findByText("Launch planning");
  const navigation = screen.getByRole("navigation", {
    name: "Main navigation",
  });
  await waitFor(() => {
    expect(
      within(linkTo(CHAT_LIST_PATH, navigation)).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(fastButton("Switch agent")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
  expect(
    within(linkTo("/me", navigation)).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();

  click(fastButton("Switch agent"));

  const researchOption = await screen.findByRole("option", {
    name: "Research agent",
  });
  expect(within(researchOption).getByLabelText("Unread")).toBeInTheDocument();
  expect(
    within(screen.getByRole("option", { name: "List agent" })).queryByLabelText(
      "Unread",
    ),
  ).not.toBeInTheDocument();
});

test("Keep a PWA home prompt handoff in the prepared chat composer", async () => {
  mockDisplayMode({ standalone: true, desktop: false });
  const workspace = installContinuityWorkspace(context, {
    caseId: 76,
    threads: [],
  });
  context.mocks.data.onboardingStatus({
    defaultAgentId: CHAT_LIST_AGENT_ID,
  });

  await setupPage({
    context,
    path: "/?prompt=Draft%20a%20launch%20plan",
    ...workspace.pageOptions,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(composer).toHaveTextContent("Draft a launch plan");
  });
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeInTheDocument();
});

test("Switch the mobile browser chat list to another agent", async () => {
  mockDisplayMode({ standalone: false, desktop: false });
  const researchAgentId = "c7000000-0000-4000-a000-000000000002";
  const workspace = installContinuityWorkspace(context, {
    caseId: 78,
    threads: [
      continuityThread(78, 1, "Launch planning"),
      {
        ...continuityThread(78, 2, "Research brief"),
        agentId: researchAgentId,
      },
    ],
  });
  const listAgent: AgentResponse = {
    agentId: CHAT_LIST_AGENT_ID,
    isDefaultAgent: false,
    ownerId: "chat-list-owner",
    displayName: "List agent",
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "private",
  };
  const agents = [
    listAgent,
    {
      ...listAgent,
      agentId: researchAgentId,
      displayName: "Research agent",
    },
  ];
  context.mocks.api(agentsMainContract.list, ({ respond }) => {
    return respond(200, agents);
  });
  context.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
    const agent = agents.find((candidate) => {
      return candidate.agentId === params.id;
    });
    return agent
      ? respond(200, agent)
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Agent not found" },
        });
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    ...workspace.pageOptions,
  });

  await screen.findByText("Launch planning");
  expect(screen.queryByText("Research brief")).not.toBeInTheDocument();

  click(fastButton("Switch agent"));
  const researchOption = await screen.findByRole("option", {
    name: "Research agent",
  });
  click(researchOption);

  await screen.findByText("Research brief");
  await waitFor(() => {
    expect(fastButton("Switch agent")).toHaveTextContent("Research agent");
  });
  expect(window.location.pathname).toBe(`/agents/${researchAgentId}/chat`);
  expect(screen.queryByText("Launch planning")).not.toBeInTheDocument();
  const navigation = screen.getByRole("navigation", {
    name: "Main navigation",
  });
  expect(linkTo(`/agents/${researchAgentId}/chat`, navigation)).toHaveAttribute(
    "aria-current",
    "page",
  );
});
