import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  buttonByText,
  context,
  mobileSidebar,
  mockMobileLayout,
  prepareDefaultAgent,
  setupSidebarPage,
} from "./sidebar-test-helpers.tsx";

test.each([
  { title: "Manage", link: "Agents" },
  { title: "Pinned", link: "Nova" },
])(
  "Toggle the mobile $title section with keyboard and pointer",
  async ({ title, link }) => {
    const user = userEvent.setup({ delay: null });
    mockMobileLayout();
    prepareDefaultAgent();
    await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    click(screen.getByLabelText("Open menu"));
    const drawer = mobileSidebar();
    await waitFor(() => {
      expect(drawer).toHaveAttribute("data-sidebar-expanded", "true");
    });
    const titleButton = buttonByText(title, drawer);
    const contentId = titleButton.getAttribute("aria-controls");
    if (!contentId) {
      throw new Error(`${title} does not identify its controlled content`);
    }
    const content = document.getElementById(contentId);
    if (!content) {
      throw new Error(`${title} controlled content is missing`);
    }
    await within(content).findByText(link);
    expect(titleButton).toHaveAttribute("aria-expanded", "true");
    expect(content).toBeVisible();

    titleButton.focus();
    expect(titleButton).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(titleButton).toHaveFocus();
    expect(titleButton).toHaveAttribute("aria-expanded", "false");
    expect(titleButton).toHaveAttribute("aria-controls", contentId);
    expect(content).not.toBeVisible();
    expect(within(content).queryByText(link)).not.toBeInTheDocument();
    expect(queryAllByRoleFast("link", content)).toHaveLength(0);

    await user.keyboard(" ");

    expect(titleButton).toHaveFocus();
    expect(titleButton).toHaveAttribute("aria-expanded", "true");
    expect(content).toBeVisible();
    expect(within(content).getByText(link)).toBeInTheDocument();

    click(titleButton);

    expect(titleButton).toHaveAttribute("aria-expanded", "false");
    expect(content).not.toBeVisible();
    expect(within(content).queryByText(link)).not.toBeInTheDocument();
    expect(drawer).toHaveAttribute("data-sidebar-expanded", "true");
  },
);

test("Keep the desktop pinned heading separate from mobile disclosures", async () => {
  prepareDefaultAgent();
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const section = await screen.findByTestId("pinned-agents-horizontal");
  await within(section).findByText("Nova");
  expect(within(section).getByText("Pinned agents")).toBeInTheDocument();
  expect(
    queryAllByRoleFast("button", section).filter((button) => {
      return button.hasAttribute("aria-expanded");
    }),
  ).toHaveLength(0);
  expect(screen.queryByTestId("pinned-section-header")).not.toBeInTheDocument();
});
