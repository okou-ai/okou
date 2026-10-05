import { act, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { CHAT_LIST_AGENT_ID, fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();
const CHAT_LIST_PATH = `/agents/${CHAT_LIST_AGENT_ID}/chat`;

const legacyEnvironments = [
  {
    name: "the default switch setting in a mobile PWA",
    caseId: 71,
    standalone: true,
    desktop: false,
    featureSwitches: {},
  },
  {
    name: "the default switch setting in a regular mobile browser",
    caseId: 72,
    standalone: false,
    desktop: false,
    featureSwitches: {},
  },
  {
    name: "an enabled switch in a desktop PWA",
    caseId: 73,
    standalone: true,
    desktop: true,
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
  },
] as const;

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

test.each(
  legacyEnvironments.filter((environment) => {
    return !environment.desktop;
  }),
)("Keep the existing chat page for $name", async (environment) => {
  mockDisplayMode(environment);
  const thread = continuityThread(environment.caseId, 1, "Existing work");
  const workspace = installContinuityWorkspace(context, {
    caseId: environment.caseId,
    threads: [thread],
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    featureSwitches: environment.featureSwitches,
    ...workspace.pageOptions,
  });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Main navigation" }),
  ).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);

  click(screen.getByLabelText("Open menu"));
  const sidebar = await screen.findByRole("complementary", {
    name: "Sidebar",
  });
  await waitFor(() => {
    expect(sidebar).toHaveAttribute("data-sidebar-expanded", "true");
  });
  expect(within(sidebar).getByText("Existing work")).toBeInTheDocument();
});

test("Keep the existing desktop PWA navigation when the switch is enabled", async () => {
  const environment = legacyEnvironments[2];
  mockDisplayMode(environment);
  const workspace = installContinuityWorkspace(context, {
    caseId: environment.caseId,
    threads: [continuityThread(environment.caseId, 1, "Existing work")],
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    featureSwitches: environment.featureSwitches,
    ...workspace.pageOptions,
  });

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Main navigation" }),
  ).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
});

test("Switch between the desktop composer and mobile chat list as the browser resizes", async () => {
  const viewport = context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const workspace = installContinuityWorkspace(context, {
    caseId: 79,
    threads: [continuityThread(79, 1, "Responsive planning")],
  });

  await setupPage({
    context,
    path: CHAT_LIST_PATH,
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
    ...workspace.pageOptions,
  });

  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();

  act(() => {
    viewport.setMatches(false);
  });

  await screen.findByRole("heading", { name: "Chats" });
  expect(screen.getByText("Responsive planning")).toBeInTheDocument();
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();

  act(() => {
    viewport.setMatches((query) => {
      return query === "(min-width: 48rem)";
    });
  });

  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Main navigation" }),
  ).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
});

test("Keep Me within mobile widths while the browser resizes", async () => {
  const viewport = context.mocks.browser.matchMedia(false);
  const workspace = installContinuityWorkspace(context, {
    caseId: 80,
    threads: [],
  });

  await setupPage({
    context,
    path: "/me",
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
    ...workspace.pageOptions,
  });

  await screen.findByRole("heading", { name: "Me" });

  act(() => {
    viewport.setMatches((query) => {
      return query === "(min-width: 48rem)";
    });
  });

  await screen.findByRole("heading", { name: "That page isn't here." });
  expect(
    screen.queryByRole("navigation", { name: "Main navigation" }),
  ).not.toBeInTheDocument();

  act(() => {
    viewport.setMatches(false);
  });

  await screen.findByRole("heading", { name: "Me" });
  expect(
    screen.getByRole("navigation", { name: "Main navigation" }),
  ).toBeInTheDocument();
  expect(window.location.pathname).toBe("/me");
});

test.each(legacyEnvironments)(
  "Keep /me unavailable for $name",
  async (environment) => {
    mockDisplayMode(environment);
    const workspace = installContinuityWorkspace(context, {
      caseId: environment.caseId + 10,
      threads: [],
    });

    await setupPage({
      context,
      path: "/me",
      featureSwitches: environment.featureSwitches,
      ...workspace.pageOptions,
    });

    await expect(
      screen.findByRole("heading", { name: "That page isn't here." }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Me" }),
    ).not.toBeInTheDocument();
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
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
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
    featureSwitches: {
      [FeatureSwitchKey.PwaNavigation]: true,
      [FeatureSwitchKey.ChatThreadArchiving]: true,
    },
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
  expect(
    screen.queryByRole("complementary", { name: "Sidebar" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Previous launch")).not.toBeInTheDocument();

  click(fastButton("Open chat list menu"));
  await waitFor(() => {
    expect(menuItem("Archived")).toBeInTheDocument();
  });
  click(menuItem("Archived"));

  await screen.findByText("Previous launch");
  expect(screen.queryByText("Plan the launch")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(CHAT_LIST_PATH);
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();

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
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByLabelText("Switch agent")).toHaveTextContent("List agent");

  click(screen.getByLabelText("New chat"));

  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toMatch(/^\/chats\/[^/]+$/u);
  expect(window.location.pathname).not.toBe(`/chats/${archived.id}`);
  await expect(
    screen.findByText("Send a message to start the conversation"),
  ).resolves.toBeInTheDocument();

  click(
    linkTo("/me", screen.getByRole("navigation", { name: "Main navigation" })),
  );

  await expect(
    screen.findByRole("heading", { name: "Me" }),
  ).resolves.toBeInTheDocument();
  expect(window.location.pathname).toBe("/me");
});

test("Open profile settings from Me in a regular mobile browser", async () => {
  mockDisplayMode({ standalone: false, desktop: false });
  const workspace = installContinuityWorkspace(context, {
    caseId: 75,
    threads: [],
  });

  await setupPage({
    context,
    path: "/me",
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
    ...workspace.pageOptions,
  });

  await screen.findByRole("heading", { name: "Me" });
  expect(screen.getByText("Chat list user")).toBeInTheDocument();
  const navigation = screen.getByRole("navigation", {
    name: "Main navigation",
  });
  expect(linkTo("/me", navigation)).toHaveAttribute("aria-current", "page");

  click(fastButton("Settings"));

  const settings = await screen.findByRole("dialog", { name: "Settings" });
  expect(within(settings).getByText("Account & security")).toBeInTheDocument();
  expect(within(settings).getByText("Chat list user")).toBeInTheDocument();
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
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
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

test("Remove a disconnected subscription from Me without reopening the page", async () => {
  mockDisplayMode({ standalone: true, desktop: false });
  const workspace = installContinuityWorkspace(context, {
    caseId: 77,
    threads: [],
  });
  context.mocks.data.org({ role: "member" });
  context.mocks.data.personalModelProviders([
    {
      id: "00000000-0000-4000-a000-000000000377",
      modelProviderId: "00000000-0000-4000-a000-000000000300",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
      isDefault: false,
      isActive: true,
      selectedModel: null,
      accountEmail: "pwa-subscription@example.test",
      workspaceName: "Personal ChatGPT",
      planType: "pro",
      needsReconnect: false,
      lastRefreshErrorCode: null,
      subscriptionResetCredits: 2,
      subscriptionUsage: {
        fiveHour: {
          usedPercent: 18,
          remainingPercent: 82,
          resetAt: "2030-01-01T05:00:00.000Z",
          windowSeconds: 18_000,
        },
        weekly: null,
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
    },
  ]);

  await setupPage({
    context,
    path: "/me",
    featureSwitches: {
      [FeatureSwitchKey.PwaNavigation]: true,
      [FeatureSwitchKey.SidebarSubscriptionUsage]: true,
      [FeatureSwitchKey.PersonalModelProviderAccounts]: true,
    },
    ...workspace.pageOptions,
  });

  await screen.findByRole("heading", { name: "Codex" });
  expect(screen.getByLabelText("2 resets left")).toBeInTheDocument();

  click(fastButton("Settings"));
  const settings = await screen.findByRole("dialog", { name: "Settings" });
  click(fastButton("Models", settings));
  const accountIdentity = await within(settings).findByText(
    "pwa-subscription@example.test",
  );
  const row = accountIdentity.closest('[role="row"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected the connected subscription account row");
  }

  click(within(row).getByLabelText("More options"));
  await waitFor(() => {
    expect(menuItem("Disconnect account")).toBeInTheDocument();
  });
  click(menuItem("Disconnect account"));
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect pwa-subscription@example.test?",
  });
  click(fastButton("Disconnect account", confirmation));

  await screen.findByText("Account disconnected");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Disconnect pwa-subscription@example.test?",
      }),
    ).not.toBeInTheDocument();
  });
  click(within(settings).getByLabelText("Close"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByRole("heading", { name: "Me" })).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Codex" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("2 resets left")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe("/me");
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
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
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
    featureSwitches: { [FeatureSwitchKey.PwaNavigation]: true },
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
    expect(
      screen.queryByRole("option", { name: "Research agent" }),
    ).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe(`/agents/${researchAgentId}/chat`);
  expect(screen.queryByText("Launch planning")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
  const navigation = screen.getByRole("navigation", {
    name: "Main navigation",
  });
  expect(linkTo(`/agents/${researchAgentId}/chat`, navigation)).toHaveAttribute(
    "aria-current",
    "page",
  );
});
