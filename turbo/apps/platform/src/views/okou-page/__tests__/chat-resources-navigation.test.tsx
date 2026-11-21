import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { artifactSummary } from "./chat-navigation-artifact-test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
  continuitySidebarLink,
} from "./chat-continuity-test-helpers.ts";
import {
  openResources,
  resourceButton,
} from "./chat-resources-test-helpers.ts";

const context = testContext();
const first = continuityThread(340, 1, "September review");
const second = continuityThread(340, 2, "October review");
function workspace() {
  return installContinuityWorkspace(context, {
    caseId: 340,
    threads: [second, first],
  }).pageOptions;
}

test("chat-resources-navigation-001 replaces the previous report only when the new chat's messages finish loading", async () => {
  const options = workspace();
  const inbox = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadEventsContract.rows,
    async ({ params, query, respond }) => {
      if (params.threadId === second.id) {
        await inbox.promise;
      }
      return respond(200, chatEventRowsResponse([], query));
    },
  );
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    const row =
      query.chatThreadId === first.id
        ? artifactSummary(
            "a8898cb5-b1c9-47eb-aa43-d0583bdc9050",
            "file",
            "first.pdf",
          )
        : artifactSummary(
            "411cc207-b1b2-4346-b0a4-3c9895b941a2",
            "file",
            "second.pdf",
          );
    return respond(200, { artifacts: [row], nextCursor: null });
  });
  await setupPage({ context, ...options, path: "/chats/" + first.id });
  const original = await openResources();
  await within(original).findByText("first.pdf");
  click(continuitySidebarLink(second.id));
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      second.title!,
    );
  });
  expect(resourceButton()).toHaveAttribute("aria-expanded", "false");
  const next = await openResources();
  await within(next).findByRole("status", { name: "Loading artifacts" });
  expect(within(next).queryByText("first.pdf")).toBeNull();
  inbox.resolve();
  await within(next).findByText("second.pdf");
  expect(within(next).queryByText("first.pdf")).toBeNull();
});

test("chat-resources-navigation-003 keeps the edited title focused when the adjacent-chat shortcut is pressed", async () => {
  const options = workspace();
  await setupPage({ context, ...options, path: "/chats/" + first.id });
  const user = userEvent.setup({ delay: null });
  const header = await screen.findByTestId("chat-thread-header-title");
  await waitFor(() => {
    expect(header).toHaveTextContent(first.title!);
  });
  await user.dblClick(header);
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  const title = within(dialog).getByRole("textbox");
  await user.click(title);
  await user.keyboard("{End} notes");
  expect(title).toHaveValue(first.title + " notes");
  expect(title).toHaveFocus();
  await user.keyboard("{Control>}{Shift>}{ArrowUp}{/Shift}{/Control}");
  expect(location.pathname).toBe("/chats/" + first.id);
  expect(title).toHaveFocus();
});
