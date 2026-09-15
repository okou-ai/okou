import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly id: string; readonly avatarUrl: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly renamedAt?: string | null;
}

beforeEach(() => {
  context.mocks.browser.userAgent(MAC_USER_AGENT);
});

function prepareDefaultAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

function createThread(id: string, title: string): SidebarThread {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    pinnedAt: null,
  };
}

function mockSidebarThreadStory(threads: readonly SidebarThread[]): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threads.map((thread, index) => {
        return {
          id: thread.id,
          agentId: thread.agent.id,
          title: thread.title,
          sortAt: new Date(
            Date.parse("2026-03-10T00:00:00Z") +
              (threads.length - index) * 1000,
          ).toISOString(),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? null,
          renamedAt: thread.renamedAt ?? null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
          selectedVideoModel: null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
}

test("The Mac shortcut toggles the chat list while composing", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  const list = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(list).getByLabelText("Hide chat list")).toBeInTheDocument();
  });

  composer.focus();
  expect(composer).toHaveFocus();
  fireEvent.keyDown(composer, {
    key: "b",
    code: "KeyB",
    keyCode: 66,
    metaKey: true,
  });

  await waitFor(() => {
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
        "Show chat list",
      ),
    ).toBeInTheDocument();
  });
});

test("The standalone Mac app copies the current URL with Command-L", async () => {
  context.mocks.browser.standaloneDisplayMode(true);
  const clipboard = context.mocks.browser.clipboardWriteText();
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  const event = new KeyboardEvent("keydown", {
    key: "l",
    code: "KeyL",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(event);
  expect(event.defaultPrevented).toBeTruthy();

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([window.location.href]);
  });
});

test("The browser keeps Command-L outside standalone mode", async () => {
  context.mocks.browser.standaloneDisplayMode(false);
  const clipboard = context.mocks.browser.clipboardWriteText();
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(THREAD_ID, "Release plan")]);

  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
  });

  const composer = await screen.findByRole("textbox", { name: "Message" });
  composer.focus();
  const event = new KeyboardEvent("keydown", {
    key: "l",
    code: "KeyL",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(event);
  expect(event.defaultPrevented).toBeFalsy();

  expect(clipboard.writes).toStrictEqual([]);
});
