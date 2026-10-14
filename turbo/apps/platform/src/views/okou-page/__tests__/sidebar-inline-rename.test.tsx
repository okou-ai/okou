import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { pathname } from "../../../signals/location.ts";
import {
  context,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  mockSidebarThreadStory,
  prepareDefaultAgent,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

async function setupConversations(inlineRename = true): Promise<void> {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  await setupSidebarPage({
    context,
    path: `/chats/${INCIDENT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ChatThreadInlineRename]: inlineRename,
    },
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

test("Double-click a conversation to open it and rename it in place", async () => {
  const user = userEvent.setup();
  await setupConversations();

  await user.dblClick(threadLinkByTitle("Release plan"));

  const field = await findRenameField();
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
  expect(field).toHaveValue("Release plan");
  expect(field).toHaveFocus();

  // The title arrives selected, so typing replaces it.
  await user.keyboard("Launch plan{Enter}");

  await waitFor(() => {
    expect(threadLinkByTitle("Launch plan")).toHaveFocus();
  });
  expect(queryRenameField()).not.toBeInTheDocument();
});

test("Leaving the field saves the title it holds", async () => {
  const user = userEvent.setup();
  await setupConversations();

  await user.dblClick(threadLinkByTitle("Incident notes"));
  await findRenameField();
  await user.keyboard("Postmortem");
  await user.click(threadLinkByTitle("Release plan"));

  await waitFor(() => {
    expect(within(sidebar()).getByText("Postmortem")).toBeInTheDocument();
  });
  expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
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

test("Enter and Escape stay with an input method while it composes", async () => {
  const user = userEvent.setup();
  await setupConversations();

  await user.dblClick(threadLinkByTitle("Incident notes"));
  const field = await findRenameField();

  // A cancelled keydown is what keeps Safari's composition-ending Enter from
  // submitting the form.
  expect(fireEvent.keyDown(field, { key: "Enter", keyCode: 229 })).toBeFalsy();
  fireEvent.keyDown(field, { key: "Escape", isComposing: true });

  expect(field).toBeInTheDocument();
  expect(field).toHaveFocus();
});

test("Double-click only opens the conversation while inline rename is off", async () => {
  const user = userEvent.setup();
  await setupConversations(false);

  await user.dblClick(threadLinkByTitle("Release plan"));

  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(queryRenameField()).not.toBeInTheDocument();
});
