import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  pinnedAgentNames,
  prepareAgents,
  prepareDefaultAgent,
  setupSidebarPage,
} from "./sidebar-test-helpers.tsx";

async function openPinManager() {
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [] });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova"]);
  });

  click(screen.getByLabelText("Pin an agent"));
  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
  const search = within(dialog).getByRole("combobox");
  return { dialog, grid, search };
}

test("Pin one highlighted search result with Enter and preserve the query", async () => {
  const user = userEvent.setup({ delay: null });
  const { dialog, grid, search } = await openPinManager();
  await user.click(search);
  await user.type(search, "Agent");

  const research = within(dialog).getByRole("option", {
    name: "Research Agent Pin",
  });
  const support = within(dialog).getByRole("option", {
    name: "Support Agent Pin",
  });
  await waitFor(() => {
    expect(search).toHaveAttribute("aria-activedescendant", research.id);
  });
  await user.keyboard("{ArrowDown}");
  expect(search).toHaveAttribute("aria-activedescendant", support.id);
  expect(search).toHaveFocus();

  await user.keyboard("{Enter}");

  await expect(
    screen.findByText("Support Agent pinned"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Support Agent pinned")).toHaveLength(1);
  expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Support Agent"]);
  expect(dialog).toBeInTheDocument();
  expect(search).toHaveValue("Agent");
  expect(
    within(dialog).getByRole("option", { name: "Support Agent Unpin" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

test("Hand off from the pin manager to the create-agent dialog and back", async () => {
  const user = userEvent.setup({ delay: null });
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [] });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  const grid = await screen.findByTestId("pinned-agents-grid");
  const pinTile = within(grid).getByLabelText("Pin an agent");

  await user.click(pinTile);
  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
  await user.click(within(dialog).getByRole("option", { name: "New agent" }));

  const createDialog = await screen.findByRole("dialog", {
    name: "Create a new agent",
  });
  await waitFor(() => {
    expect(within(createDialog).getByLabelText("Name")).toHaveFocus();
  });
  expect(
    screen.queryByRole("dialog", { name: "Pin an agent" }),
  ).not.toBeInTheDocument();

  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(pinTile).toHaveFocus();
  });
  expect(createDialog).not.toBeInTheDocument();
});

test("Create the first agent from an empty pin manager with Enter", async () => {
  const user = userEvent.setup({ delay: null });
  prepareDefaultAgent();
  context.mocks.data.userPreferences({ pinnedAgentIds: [] });
  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await screen.findByTestId("pinned-agents-grid");

  click(screen.getByLabelText("Pin an agent"));
  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
  expect(
    within(dialog).getByText("You do not have any other agents yet."),
  ).toBeInTheDocument();
  const search = within(dialog).getByRole("combobox");
  await user.click(search);
  await user.keyboard("{ArrowDown}{Enter}");

  await expect(
    screen.findByRole("dialog", { name: "Create a new agent" }),
  ).resolves.toBeInTheDocument();
});
