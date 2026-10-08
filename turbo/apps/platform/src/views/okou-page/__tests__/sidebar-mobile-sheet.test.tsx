import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { fillComposer } from "./chat-test-helpers.ts";
import {
  AGENT_ID,
  buttonByText,
  context,
  mockMobileLayout,
  prepareDefaultAgent,
  setupSidebarPage,
} from "./sidebar-test-helpers.tsx";

async function setupMobileSidebar() {
  mockMobileLayout();
  prepareDefaultAgent();
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  return screen.getByLabelText("Open menu");
}

test("Keyboard opening contains focus and Escape returns it to the mobile menu trigger", async () => {
  const user = userEvent.setup();
  const trigger = await setupMobileSidebar();
  const composer = screen.getByRole("textbox", { name: "Message" });
  await fillComposer(composer, "Keep this unsent draft");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();

  trigger.focus();
  await user.keyboard("{Enter}");
  const drawer = screen.getByRole("dialog", { name: "Sidebar" });
  await waitFor(() => {
    expect(drawer.contains(document.activeElement)).toBeTruthy();
  });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(trigger).toHaveAttribute("aria-controls", drawer.id);
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();

  const firstFocused = document.activeElement;
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  expect(drawer.contains(document.activeElement)).toBeTruthy();
  expect(document.activeElement).not.toBe(firstFocused);
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(firstFocused);
  expect(composer).not.toHaveFocus();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Keep this unsent draft",
  );
});

test("The existing collapse control and backdrop close the drawer without losing section state", async () => {
  const user = userEvent.setup();
  const trigger = await setupMobileSidebar();
  await user.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Sidebar" });
  const manage = buttonByText("Manage", drawer);
  click(manage);
  expect(manage).toHaveAttribute("aria-expanded", "false");

  const close = within(drawer).getByLabelText("Collapse sidebar");
  close.focus();
  await user.keyboard(" ");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  await user.keyboard(" ");
  const reopened = screen.getByRole("dialog", { name: "Sidebar" });
  expect(buttonByText("Manage", reopened)).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  const backdrop = document.querySelector<HTMLElement>(
    '[data-slot="sheet-overlay"]',
  );
  if (!backdrop) {
    throw new Error("Expected the mobile sidebar backdrop");
  }
  await user.click(backdrop);
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
  });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("Primary sidebar navigation closes the sheet and restores its trigger", async () => {
  const user = userEvent.setup();
  const trigger = await setupMobileSidebar();
  await user.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Sidebar" });
  const agents = queryAllByRoleFast("link", drawer).find((link) => {
    return link.getAttribute("href") === "/agents";
  });
  if (!agents) {
    throw new Error("Expected the Agents navigation link");
  }
  agents.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByRole("dialog", { name: "Sidebar" })).toBeNull();
    expect(screen.getByLabelText("Open menu")).toHaveFocus();
  });
});
