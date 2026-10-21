import { fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { chatThreadRenameContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  mockSidebarViewport,
  setupSidebarPage,
  sidebar,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const { mockSidebarThreadStory, prepareDefaultAgent } =
  createSidebarHelpers(context);

const ROW_HEIGHT = 36;

function inlineRenameSwitch(enabled: boolean) {
  return { [FeatureSwitchKey.ChatThreadInlineRename]: enabled };
}

async function setupConversations({
  inlineRename = true,
  mockBeforePage,
}: {
  inlineRename?: boolean;
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
    featureSwitches: inlineRenameSwitch(inlineRename),
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

test("Scrolling the field's row away saves it instead of reopening it", async () => {
  const user = userEvent.setup();
  const threadIdAt = (index: number) => {
    return `b3300000-0000-4000-a000-${String(index).padStart(12, "0")}`;
  };
  prepareDefaultAgent();
  mockSidebarThreadStory(
    Array.from({ length: 40 }, (_, index) => {
      return createThread(threadIdAt(index), `Chat ${index + 1}`);
    }),
  );
  mockSidebarViewport(5 * ROW_HEIGHT, 40 * ROW_HEIGHT);
  await setupSidebarPage({
    context,
    path: `/chats/${threadIdAt(0)}`,
    featureSwitches: inlineRenameSwitch(true),
  });
  await within(sidebar()).findByText("Chat 1");

  await user.dblClick(threadLinkByTitle("Chat 1"));
  await findRenameField();
  await user.keyboard("Scrolled away");

  const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
  scrollArea.scrollTop = 30 * ROW_HEIGHT;
  fireEvent.scroll(scrollArea);
  await within(sidebar()).findByText("Chat 31");
  expect(queryRenameField()).not.toBeInTheDocument();

  scrollArea.scrollTop = 0;
  fireEvent.scroll(scrollArea);
  await within(sidebar()).findByText("Scrolled away");
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

test("Double-click only opens the conversation while inline rename is off", async () => {
  const user = userEvent.setup();
  await setupConversations({ inlineRename: false });

  await user.dblClick(threadLinkByTitle("Release plan"));

  await waitFor(() => {
    expect(threadLinkByTitle("Release plan")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(queryRenameField()).not.toBeInTheDocument();
});
