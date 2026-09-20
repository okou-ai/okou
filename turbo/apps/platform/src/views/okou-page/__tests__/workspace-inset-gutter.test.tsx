import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";

const context = testContext();

/**
 * The workspace sheet drops its left margin only because the chat list column
 * already holds that edge open. Hiding the column leaves the bare navigation
 * rail there, which does not, so the sheet has to frame itself again.
 */
test("the workspace sheet keeps its left inset once the chat list is hidden", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
  const thread = chatListThread(1, "Workspace inset");
  const workspace = installContinuityWorkspace(context, {
    caseId: 64,
    threads: [thread],
  });
  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    ...workspace.pageOptions,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  click(composer);
  await screen.findByTestId("chat-list-column");

  const inset = screen.getByTestId("workspace-inset");
  expect(inset.className).toContain("md:ml-0");

  const user = userEvent.setup();
  await user.keyboard("{Control>}b{/Control}");
  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  });
  expect(screen.getByTestId("workspace-inset").className).not.toContain(
    "md:ml-0",
  );

  await user.keyboard("{Control>}b{/Control}");
  await screen.findByTestId("chat-list-column");
  expect(screen.getByTestId("workspace-inset").className).toContain("md:ml-0");
});
