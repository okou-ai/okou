import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const SEARCH_LABEL = "Search workspace...";

test("Navigate workspace search filters without changing the query or clearing selection", async () => {
  const user = userEvent.setup({ delay: null });
  const workspace = installContinuityWorkspace(context, {
    caseId: 94,
    threads: [continuityThread(94, 1, "Research notes")],
  });
  await setupPage({ context, path: "/", ...workspace.pageOptions });
  const trigger = screen.getByLabelText("Search workspace", {
    selector: "button",
  });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: SEARCH_LABEL });
  const search = within(dialog).getByRole("combobox");
  await user.click(search);
  await user.type(search, "Research");
  await within(dialog).findByRole("option", { name: /Research notes/ });

  const group = within(dialog).getByRole("group", { name: SEARCH_LABEL });
  const filters = queryAllByRoleFast("button", group);
  expect(
    filters.map((button) => {
      return button.textContent;
    }),
  ).toStrictEqual(["All", "Chats", "Messages", "Workflows", "Artifacts"]);
  await user.click(filters[0]!);
  expect(filters[0]).toHaveFocus();
  expect(filters[0]).toHaveAttribute("aria-pressed", "true");
  await user.keyboard(" ");
  expect(filters[0]).toHaveAttribute("aria-pressed", "true");
  expect(within(dialog).getByText("1 result")).toBeInTheDocument();

  for (const [offset, filter] of filters.slice(1).entries()) {
    const index = offset + 1;
    await user.keyboard("{ArrowRight}");
    expect(filter).toHaveFocus();
    expect(filter).toHaveAttribute("aria-pressed", "false");
    expect(filters[offset]).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(index % 2 === 0 ? " " : "{Enter}");
    expect(filter).toHaveAttribute("aria-pressed", "true");
    expect(search).toHaveValue("Research");
    const hasResult = index === 1;
    await waitFor(() => {
      expect(
        within(dialog).getByText(hasResult ? "1 result" : "0 results"),
      ).toBeInTheDocument();
      expect(queryAllByRoleFast("option", dialog)).toHaveLength(
        hasResult ? 1 : 0,
      );
    });
  }

  await user.keyboard(" ");
  expect(filters[4]).toHaveAttribute("aria-pressed", "true");
  await user.click(search);
  expect(search).toHaveFocus();
  expect(search).toHaveValue("Research");
  await user.click(filters[4]!);
  expect(filters[4]).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: SEARCH_LABEL })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
