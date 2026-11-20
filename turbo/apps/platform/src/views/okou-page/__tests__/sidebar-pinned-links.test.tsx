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
  pinnedAgentLink,
  RESEARCH_AGENT_ID,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const { mockSidebarThreadStory, prepareAgents } = createSidebarHelpers(context);

async function preparePinnedNavigation() {
  const user = userEvent.setup({ delay: null });
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
  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  const pinned = () => {
    return screen.getByTestId("pinned-agents-grid");
  };
  const current = () => {
    return pinnedAgentLink(pinned(), "Nova");
  };
  const other = () => {
    return pinnedAgentLink(pinned(), "Research Agent");
  };
  const list = () => {
    return sidebar();
  };
  await waitFor(() => {
    expect(within(pinned()).getByLabelText("Unread")).toBeInTheDocument();
  });
  await within(list()).findByText("Read conversation");
  click(current());
  await waitFor(() => {
    expect(
      within(list()).queryByText("Read conversation"),
    ).not.toBeInTheDocument();
    expect(within(list()).getByText("Unread conversation")).toBeInTheDocument();
  });
  return { user, current, other, list };
}

test.each(["Alt"])(
  "Pinned links preserve the current agent and unread filter for %s activation",
  async (modifier) => {
    const { user, current, other, list } = await preparePinnedNavigation();
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
  },
);

test.each(["[MouseMiddle]", "[MouseRight]"])(
  "Pinned links preserve the current agent and unread filter for %s activation",
  async (keys) => {
    const { user, other, list } = await preparePinnedNavigation();
    await user.pointer({ target: other(), keys });
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(
      within(list()).queryByText("Read conversation"),
    ).not.toBeInTheDocument();
    if (screen.queryByRole("menu")) {
      await user.keyboard("{Escape}");
    }
  },
);

test("Pinned links preserve the current agent and unread filter for keyboard activation", async () => {
  const { user, current, other, list } = await preparePinnedNavigation();
  current().focus();
  await user.keyboard("{Enter}");
  await within(list()).findByText("Read conversation");
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  other().focus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });
});

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
