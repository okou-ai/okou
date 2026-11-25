import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { completedMarkdownReply } from "./markdown-page-test-helpers.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
const context = testContext();
test("sidebar-mac-shortcut-001 Command-B collapses the open chat list from the focused composer", async () => {
  context.mocks.browser.platform("MacIntel");
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  );
  await setupPage({
    context,
    path: completedMarkdownReply(context, "Compare the two estimates."),
  });
  await screen.findByText("Compare the two estimates.");
  await expect(screen.findByLabelText("Chat threads")).resolves.toBeVisible();
  const hide = await findAction("button", "Hide chat list");
  expect(hide).toBeVisible();
  const user = userEvent.setup({ delay: null });
  const editor = await screen.findByLabelText("Message");
  await user.click(editor);
  expect(editor).toHaveFocus();
  await user.keyboard("{Meta>}b{/Meta}");
  await expect(findAction("button", "Show chat list")).resolves.toBeVisible();
  expect(hide).not.toBeInTheDocument();
  const visibleLists = screen
    .queryAllByLabelText("Chat threads")
    .filter((list) => {
      return !list.closest("[inert],[hidden]");
    });
  expect(visibleLists).toHaveLength(0);
});
