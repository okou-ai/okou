import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { projectChatContract } from "@okouai/api-contracts/contracts/project-chat";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  installContinuityWorkspace,
  continuityThread,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const id = "30000000-0000-4000-8000-000000000071";
const at = "2026-11-02T00:00:00.000Z";
function metadata() {
  const p = { id, name: "Launch", createdAt: at, updatedAt: at };
  context.mocks.api(projectsContract.snapshot, ({ respond }) =>
    {return respond(200, { projects: [p], latestEventId: null, latestSeqId: 1 })},
  );
  context.mocks.api(projectsContract.events, ({ respond }) =>
    {return respond(200, { events: [], hasMore: false })},
  );
  context.mocks.api(projectChatContract.agentDraft, ({ respond }) =>
    {return respond(200, { draftUserMessage: null, draftAttachments: null })},
  );
  context.mocks.api(projectChatContract.draft, ({ respond }) =>
    {return respond(200, { draftUserMessage: null, draftAttachments: null })},
  );
  context.mocks.api(projectChatContract.saveAgentDraft, ({ respond }) =>
    {return respond(204)},
  );
  context.mocks.api(projectChatContract.saveDraft, ({ respond }) =>
    {return respond(204)},
  );
}
test("Project view shows conversations across Agents, filters archives and preserves original chat links", async () => {
  const ordinary = continuityThread(90, 1, "Ordinary chat");
  const member = {
    ...continuityThread(90, 2, "Launch planning"),
    projectId: id,
  };
  const other = {
    ...continuityThread(90, 3, "Other Agent research"),
    projectId: id,
    agentId: "c7000000-0000-4000-a000-000000000009",
  };
  const archived = {
    ...continuityThread(90, 4, "Archived research"),
    projectId: id,
    archived: true,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 90,
    threads: [ordinary, member, other, archived],
  });
  metadata();
  await setupPage({
    context,
    path: `/projects/${id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  const main = await screen.findByRole("main");
  await waitFor(() =>
    {return expect(
      within(main).getByRole("link", { name: "Launch planning" }),
    ).toBeVisible()},
  );
  expect(
    within(main).getByRole("link", { name: "Other Agent research" }),
  ).toHaveAttribute("href", expect.stringContaining("/chats/" + other.id));
  expect(
    within(main).queryByRole("link", { name: "Ordinary chat" }),
  ).toBeNull();
  expect(
    within(main).queryByRole("link", { name: "Archived research" }),
  ).toBeNull();
  click(within(main).getByRole("checkbox", { name: "Archived conversations" }));
  expect(
    await within(main).findByRole("link", { name: "Archived research" }),
  ).toBeVisible();
});
test("ordinary lists hide assigned chats and @Project inserts captured identity without navigating", async () => {
  const ordinary = continuityThread(91, 1, "Ordinary chat");
  const member = {
    ...continuityThread(91, 2, "Launch planning"),
    projectId: id,
  };
  const workspace = installContinuityWorkspace(context, {
    caseId: 91,
    threads: [ordinary, member],
  });
  metadata();
  await setupPage({
    context,
    path: `/chats/${ordinary.id}`,
    ...workspace.pageOptions,
    featureSwitches: { [FeatureSwitchKey.Projects]: true },
  });
  await waitFor(() =>
    {return expect(
      document.querySelector(`[data-sidebar-chat-thread-id="${ordinary.id}"]`),
    ).toBeVisible()},
  );
  expect(
    document.querySelector(`[data-sidebar-chat-thread-id="${member.id}"]`),
  ).toBeNull();
  const input = await screen.findByRole("textbox", { name: "Message" });
  const user = userEvent.setup({ delay: null });
  await user.click(input);
  await user.type(input, "@Launch");
  const menu = await screen.findByTestId("chat-thread-suggestion-menu");
  await user.click(within(menu).getByRole("button", { name: "Launch" }));
  expect(
    input.querySelector(`[data-project-mention="${id}"]`),
  ).toHaveTextContent("Launch");
  expect(location.pathname).toContain(ordinary.id);
});
