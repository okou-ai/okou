import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import {
  AGENT_ID,
  context,
  pinnedAgentNames,
  prepareAgents,
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

test.each(["pointer", "Enter"])(
  "Pin one highlighted search result with %s and preserve the query",
  async (activation) => {
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
    await user.keyboard("{ArrowUp}");
    expect(search).toHaveAttribute("aria-activedescendant", support.id);
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", research.id);
    await user.keyboard("{ArrowDown}");
    expect(search).toHaveAttribute("aria-activedescendant", support.id);

    if (activation === "pointer") {
      await user.click(support);
    } else {
      await user.keyboard("{Enter}");
    }

    await expect(
      screen.findByText("Support Agent pinned"),
    ).resolves.toBeInTheDocument();
    expect(screen.getAllByText("Support Agent pinned")).toHaveLength(1);
    expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Support Agent"]);
    expect(dialog).toBeInTheDocument();
    expect(search).toHaveValue("Agent");
    expect(search).toHaveFocus();
    expect(
      within(dialog).getByRole("option", { name: "Support Agent Unpin" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  },
);

test("Finish composing a search before Enter activates a command", async () => {
  const user = userEvent.setup({ delay: null });
  const { dialog, grid, search } = await openPinManager();
  await user.click(search);
  await user.keyboard("{ArrowDown}");

  fireEvent.compositionStart(search);
  fireEvent.change(search, { target: { value: "support" } });
  fireEvent.keyDown(search, {
    key: "Enter",
    code: "Enter",
    keyCode: 229,
    which: 229,
    isComposing: true,
  });

  expect(search).toHaveValue("support");
  expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  expect(pinnedAgentNames(grid)).toStrictEqual(["Nova"]);

  fireEvent.compositionEnd(search, { data: "support" });
  await waitFor(() => {
    const support = within(dialog).getByRole("option", {
      name: "Support Agent Pin",
    });
    expect(search).toHaveAttribute("aria-activedescendant", support.id);
    expect(
      within(dialog).queryByText("Research Agent"),
    ).not.toBeInTheDocument();
  });
  await user.keyboard("{Enter}");

  await expect(
    screen.findByText("Support Agent pinned"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByText("Support Agent pinned")).toHaveLength(1);
  expect(pinnedAgentNames(grid)).toStrictEqual(["Nova", "Support Agent"]);
  expect(search).toHaveValue("support");
});
