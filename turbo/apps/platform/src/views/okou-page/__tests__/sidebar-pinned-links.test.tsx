import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  AGENT_ID,
  context,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  mobileSidebar,
  mockMobileLayout,
  mockSidebarThreadStory,
  pinnedAgentLink,
  prepareAgents,
  RESEARCH_AGENT_ID,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

test.each(["horizontal", "vertical"] as const)(
  "%s pinned links preserve the current agent and unread filter for browser activations",
  async (layout) => {
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
    const pinned =
      layout === "horizontal"
        ? await screen.findByTestId("pinned-agents-grid")
        : mobileSidebar();
    const current = await waitFor(() => {
      const link = pinnedAgentLink(pinned, "Nova");
      expect(within(pinned).getByLabelText("Unread")).toBeInTheDocument();
      return link;
    });
    const other = pinnedAgentLink(pinned, "Research Agent");
    const list = layout === "horizontal" ? sidebar() : mobileSidebar();
    await within(list).findByText("Read conversation");

    if (layout === "vertical") {
      click(screen.getByLabelText("Open menu"));
    }
    click(current);
    await waitFor(() => {
      expect(
        within(list).queryByText("Read conversation"),
      ).not.toBeInTheDocument();
      expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
    });
    if (layout === "vertical") {
      click(screen.getByLabelText("Open menu"));
    }
    await waitFor(() => {
      expect(pinned.dataset.sidebarExpanded).toBe(
        layout === "vertical" ? "true" : undefined,
      );
    });

    for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
      await user.keyboard(`{${modifier}>}`);
      await user.click(current);
      await user.click(other);
      await user.keyboard(`{/${modifier}}`);
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
      expect(current).toHaveAttribute("aria-current", "page");
      expect(
        within(list).queryByText("Read conversation"),
      ).not.toBeInTheDocument();
      expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
      expect(pinned.dataset.sidebarExpanded).toBe(
        layout === "vertical" ? "true" : undefined,
      );
    }
    for (const keys of ["[MouseMiddle]", "[MouseRight]"]) {
      await user.pointer({ target: other, keys });
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
      expect(
        within(list).queryByText("Read conversation"),
      ).not.toBeInTheDocument();
      expect(pinned.dataset.sidebarExpanded).toBe(
        layout === "vertical" ? "true" : undefined,
      );
      await user.keyboard("{Escape}");
    }

    current.focus();
    await user.keyboard("{Enter}");
    await within(list).findByText("Read conversation");
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(pinned).not.toHaveAttribute("data-sidebar-expanded");
    if (layout === "vertical") {
      click(screen.getByLabelText("Open menu"));
    }
    other.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    });
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
