import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  mobileSidebar,
  pinnedAgentLink,
  RESEARCH_AGENT_ID,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const { mockMobileLayout, mockSidebarThreadStory, prepareAgents } =
  createSidebarHelpers(context);

async function preparePinnedNavigation(layout: "horizontal" | "vertical") {
  const user = userEvent.setup({ delay: null });
  if (layout === "vertical") {
    mockMobileLayout();
  }
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });
  // Happy DOM delegates anchor defaults to window.open. Native tab/window
  // selection is a browser check; this test observes the app's own state.
  context.mocks.browser.open();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Read conversation"),
    createThread(INCIDENT_THREAD_ID, "Unread conversation"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: { [AGENT_ID]: "unread" },
      threads: { [INCIDENT_THREAD_ID]: "unread" },
      unreadAt: { [INCIDENT_THREAD_ID]: "2026-03-10T00:05:00Z" },
    });
  });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  if (layout === "vertical") {
    click(screen.getByLabelText("Open menu"));
  }
  const pinned = () => {
    return layout === "horizontal"
      ? screen.getByTestId("pinned-agents-grid")
      : mobileSidebar();
  };
  const current = () => {
    return pinnedAgentLink(pinned(), "Nova");
  };
  const other = () => {
    return pinnedAgentLink(pinned(), "Research Agent");
  };
  const list = () => {
    return layout === "horizontal" ? sidebar() : mobileSidebar();
  };
  await waitFor(() => {
    expect(within(pinned()).getByLabelText("Unread")).toBeInTheDocument();
  });
  await within(list()).findByText("Read conversation");
  click(current());
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
  });
  if (layout === "vertical") {
    click(screen.getByLabelText("Open menu"));
  }
  await waitFor(() => {
    expect(
      within(list()).queryByText("Read conversation"),
    ).not.toBeInTheDocument();
    expect(within(list()).getByText("Unread conversation")).toBeInTheDocument();
    expect(pinned().dataset.sidebarExpanded).toBe(
      layout === "vertical" ? "true" : undefined,
    );
  });
  return { user, pinned, current, other, list };
}

test.each(
  (["horizontal", "vertical"] as const).flatMap((layout) => {
    return ["Alt", "Control", "Meta", "Shift"].map((modifier) => {
      return { layout, modifier };
    });
  }),
)(
  "$layout pinned links preserve the current agent and unread filter for $modifier activation",
  async ({ layout, modifier }) => {
    const { user, pinned, current, other, list } =
      await preparePinnedNavigation(layout);
    await user.keyboard(`{${modifier}>}`);
    await user.click(current());
    await user.click(other());
    await user.keyboard(`{/${modifier}}`);
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(current()).toHaveAttribute("aria-current", "page");
    expect(
      within(list()).queryByText("Read conversation"),
    ).not.toBeInTheDocument();
    expect(within(list()).getByText("Unread conversation")).toBeInTheDocument();
    expect(pinned().dataset.sidebarExpanded).toBe(
      layout === "vertical" ? "true" : undefined,
    );
  },
);

test.each(
  (["horizontal", "vertical"] as const).flatMap((layout) => {
    return ["[MouseMiddle]", "[MouseRight]"].map((keys) => {
      return { layout, keys };
    });
  }),
)(
  "$layout pinned links preserve the current agent and unread filter for $keys activation",
  async ({ layout, keys }) => {
    const { user, pinned, other, list } = await preparePinnedNavigation(layout);
    await user.pointer({ target: other(), keys });
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(
      within(list()).queryByText("Read conversation"),
    ).not.toBeInTheDocument();
    expect(pinned().dataset.sidebarExpanded).toBe(
      layout === "vertical" ? "true" : undefined,
    );
    if (screen.queryByRole("menu")) {
      await user.keyboard("{Escape}");
    }
  },
);

test.each(["horizontal", "vertical"] as const)(
  "%s pinned links preserve the current agent and unread filter for keyboard activation",
  async (layout) => {
    const { user, current, other, list } =
      await preparePinnedNavigation(layout);
    current().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
    });
    if (layout === "vertical") {
      click(screen.getByLabelText("Open menu"));
    }
    await within(list()).findByText("Read conversation");
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    other().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    });
  },
);

test.each(["horizontal", "vertical"] as const)(
  "%s pinned links label an available unnamed agent with its ID",
  async (layout) => {
    if (layout === "vertical") {
      mockMobileLayout();
    }
    const agents = prepareAgents().map((agent) => {
      return agent.agentId === RESEARCH_AGENT_ID
        ? { ...agent, displayName: null }
        : agent;
    });
    context.mocks.data.agents(agents);
    context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });
    await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
    if (layout === "vertical") {
      click(screen.getByLabelText("Open menu"));
    }
    const pinned =
      layout === "horizontal"
        ? screen.getByTestId("pinned-agents-grid")
        : mobileSidebar();
    const link = await waitFor(() => {
      return pinnedAgentLink(pinned, RESEARCH_AGENT_ID);
    });
    expect(link).toHaveAttribute("href", `/agents/${RESEARCH_AGENT_ID}/chat`);
  },
);

test("Alt-click still opens a thread in the sidebar pane", async () => {
  const user = userEvent.setup({ delay: null });
  prepareAgents();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Main conversation"),
    createThread(INCIDENT_THREAD_ID, "Side conversation"),
  ]);
  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });
  const sideLink = await waitFor(() => {
    return threadLinkByTitle("Side conversation");
  });

  await user.keyboard("{Alt>}");
  await user.click(sideLink);
  await user.keyboard("{/Alt}");

  await waitFor(() => {
    expect(new URLSearchParams(location.search).get("sidebar")).toBe(
      INCIDENT_THREAD_ID,
    );
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${INCIDENT_THREAD_ID}"]`,
      ),
    ).toBeInTheDocument();
  });
});
