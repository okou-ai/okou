import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadMarkAgentReadContract } from "@okouai/api-contracts/contracts/chat-threads";

import { click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import {
  AGENT_ID,
  RESEARCH_AGENT_ID,
  context,
  menuItemByText,
  mobileSidebar,
  mockMobileLayout,
  mockUnreadAgents,
  pinnedAgentLink,
  prepareAgents,
  setupSidebarPage,
} from "./sidebar-test-helpers.tsx";

async function openSidebar() {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  click(screen.getByLabelText("Open menu"));
  await waitFor(() => {
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
    expect(
      pinnedAgentLink(mobileSidebar(), "Research Agent"),
    ).toBeInTheDocument();
  });
}

function agentMenu(name: string) {
  const row = within(mobileSidebar())
    .getAllByTestId("pinned-agent-card")
    .find((card) => {
      return card.textContent?.trim() === name;
    });
  if (!row) {
    throw new Error(`Missing agent row: ${name}`);
  }
  return within(row).getByLabelText("Open agent menu");
}

test.each(["pointer", "Enter", "Space"])(
  "Open an agent menu with %s without selecting its row and restore focus on Escape",
  async (activation) => {
    const user = userEvent.setup();
    await openSidebar();
    const trigger = agentMenu("Research Agent");
    if (activation === "pointer") {
      await user.click(trigger);
    } else {
      act(() => {
        trigger.focus();
      });
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }

    await screen.findByRole("menu");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
    expect(
      pinnedAgentLink(mobileSidebar(), "Research Agent"),
    ).not.toHaveAttribute("aria-current");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    await user.click(pinnedAgentLink(mobileSidebar(), "Research Agent"));
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
      expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
    });
  },
);

test("Unpin from the agent menu without navigating or closing the sidebar", async () => {
  const user = userEvent.setup();
  await openSidebar();
  await user.click(agentMenu("Research Agent"));
  await screen.findByRole("menu");
  await user.click(menuItemByText("Unpin"));

  await waitFor(() => {
    expect(
      within(mobileSidebar()).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
  });
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
  expect(pinnedAgentLink(mobileSidebar(), "Nova")).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("Keep unread state and disable the menu while its only action is pending", async () => {
  const pending = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadMarkAgentReadContract.markAgentRead,
    async ({ respond }) => {
      await pending.promise;
      return respond(204);
    },
  );
  mockUnreadAgents(() => {
    return [AGENT_ID];
  });
  const user = userEvent.setup();
  await openSidebar();
  const trigger = agentMenu("Nova");
  const unread = within(mobileSidebar()).getByLabelText("Unread");
  await user.click(trigger);
  await screen.findByRole("menu");
  await user.click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  await user.click(trigger);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(unread).toBeInTheDocument();
  expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
  expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");

  pending.resolve();
  await waitFor(() => {
    expect(trigger).toBeEnabled();
  });
});
