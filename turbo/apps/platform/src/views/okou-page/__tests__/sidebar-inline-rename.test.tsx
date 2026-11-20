import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const { mockSidebarThreadStory, prepareDefaultAgent } =
  createSidebarHelpers(context);

async function setupConversations({
  mockBeforePage,
}: {
  mockBeforePage?: () => void;
} = {}): Promise<void> {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  mockBeforePage?.();
  await setupSidebarPage({
    context,
    path: `/chats/${INCIDENT_THREAD_ID}`,
  });
  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
  });
}

function findRenameField(): Promise<HTMLElement> {
  return within(sidebar()).findByRole("textbox", { name: "Rename chat" });
}

function queryRenameField(): HTMLElement | null {
  return within(sidebar()).queryByRole("textbox", { name: "Rename chat" });
}

test("Opening another chat from the field still sends its title", async () => {
  const user = userEvent.setup();
  const renames: { threadId: string; title: string }[] = [];
  await setupConversations({
    mockBeforePage: () => {
      context.mocks.api(
        chatThreadRenameContract.rename,
        ({ params, body, respond }) => {
          renames.push({ threadId: params.id, title: body.title });
          return respond(204);
        },
      );
    },
  });

  await user.dblClick(threadLinkByTitle("Incident notes"));
  await findRenameField();
  await user.keyboard("Postmortem");

  // The press that leaves the field also opens the other chat. Holding the
  // rename before it is sent proves that navigation does not cancel it.
  const tokenRequested = context.mocks.deferred<void>();
  const releaseToken = context.mocks.deferred<void>();
  mockedClerk.sessionGetToken.mockImplementationOnce(async () => {
    tokenRequested.resolve();
    await releaseToken.promise;
    return "inline-rename-token";
  });
  await user.click(threadLinkByTitle("Release plan"));
  await tokenRequested.promise;
  await waitFor(() => {
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  });
  releaseToken.resolve();

  await waitFor(() => {
    expect(renames).toContainEqual({
      threadId: INCIDENT_THREAD_ID,
      title: "Postmortem",
    });
  });
  expect(within(sidebar()).getByText("Postmortem")).toBeInTheDocument();
  expect(queryRenameField()).not.toBeInTheDocument();
});

test("Escape or an emptied field keeps the title", async () => {
  const user = userEvent.setup();
  await setupConversations();

  await user.dblClick(threadLinkByTitle("Incident notes"));
  await findRenameField();
  await user.keyboard("Discarded{Escape}");

  await waitFor(() => {
    expect(threadLinkByTitle("Incident notes")).toHaveFocus();
  });
  expect(queryRenameField()).not.toBeInTheDocument();

  await user.dblClick(threadLinkByTitle("Incident notes"));
  await findRenameField();
  await user.keyboard("{Backspace}{Enter}");

  await waitFor(() => {
    expect(threadLinkByTitle("Incident notes")).toHaveFocus();
  });
  expect(queryRenameField()).not.toBeInTheDocument();
});

test("A modified double-click keeps its browser behavior instead of renaming", async () => {
  const user = userEvent.setup();
  // Happy DOM hands modified anchor activations to window.open.
  context.mocks.browser.open();
  await setupConversations();

  for (const modifier of ["Alt", "Control", "Meta", "Shift"]) {
    await user.keyboard(`{${modifier}>}`);
    await user.dblClick(threadLinkByTitle("Incident notes"));
    await user.keyboard(`{/${modifier}}`);
    expect(queryRenameField()).not.toBeInTheDocument();
  }

  await user.dblClick(threadLinkByTitle("Incident notes"));
  await expect(findRenameField()).resolves.toHaveValue("Incident notes");
});
