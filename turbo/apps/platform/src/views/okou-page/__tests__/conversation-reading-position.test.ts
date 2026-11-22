import userEvent from "@testing-library/user-event";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { sendComposerMessage } from "./chat-composer-template-gallery-test-helpers.ts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  mockChatEventRows,
  normalizeMockChatEvents,
} from "./chat-event-test-helpers.ts";
import {
  mockChatGeometry,
  messageOffset,
  requiredElement,
} from "./chat-conversation-locator-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
function eventId(group: number, index: number) {
  return (
    "8a790000-0000-4000-a000-" + String(group * 100 + index).padStart(12, "0")
  );
}
async function library(
  first: "Research" | "Current",
  entry: "home" | "conversation",
) {
  mockChatGeometry();
  const current = continuityThread(179, 1, first + " notes");
  const peer = continuityThread(179, 2, "Planning notes");
  const messages = [current, peer].flatMap((thread) => {
    const label = thread.id === current.id ? first : "Planning";
    const inputs = Array.from({ length: 9 }, (_, i) => {
      return {
        id: eventId(thread.id === current.id ? 1 : 2, i + 1),
        role: "user" as const,
        content: label + " message " + (i + 1),
        runId: eventId(thread.id === current.id ? 1 : 2, i + 1),
        createdAt: new Date(Date.UTC(2026, 6, 1, 9, i)).toISOString(),
      };
    });
    return mockChatEventRows(normalizeMockChatEvents(inputs, thread.id));
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 179,
    threads: [current, peer],
    chatEventRows: messages,
  });
  await setupPage({
    context,
    ...pageOptions,
    path: entry === "home" ? "/?compose=1" : "/chats/" + current.id,
  });
  return { current, peer };
}
async function surface(text: string) {
  await screen.findByText(text, { exact: true });
  const viewport = requiredElement("[data-scroll-container]");
  expect(within(viewport).getByText(text, { exact: true })).toBeVisible();
  return viewport;
}
async function read(text: string, offset: number) {
  const viewport = await surface(text);
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
  });
  fireEvent.scroll(viewport);
  fireEvent.wheel(viewport, { deltaY: -400 });
  viewport.scrollTop += messageOffset(text, viewport) - offset;
  fireEvent.scroll(viewport);
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
  expect(messageOffset(text, viewport)).toBe(offset);
  return viewport;
}
async function sidebar(title: string) {
  click(await findFastControl("link", title));
}
async function shortcut(key: "ArrowUp" | "ArrowDown") {
  const editor = await findComposerEditor();
  editor.focus();
  fireEvent.keyDown(editor, { key, ctrlKey: true, shiftKey: true });
}
test("chat-navigation-position-restoration-001 The chat shortcuts restore the current message 64 pixels below the viewport", async () => {
  const { current, peer } = await library("Current", "conversation");
  await read("Current message 2", 64);
  await shortcut("ArrowUp");
  const next = await surface("Planning message 2");
  expect(location.pathname).toBe("/chats/" + peer.id);
  expect(within(next).queryByText("Current message 2")).toBeNull();
  await shortcut("ArrowDown");
  const restored = await surface("Current message 2");
  await waitFor(() => {
    expect(messageOffset("Current message 2", restored)).toBe(64);
  });
  expect(location.pathname).toBe("/chats/" + current.id);
  expect(within(restored).queryByText("Planning message 2")).toBeNull();
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
});
test("chat-navigation-position-restoration-002 Returning from Planning in the sidebar preserves the Research reading offset", async () => {
  await library("Research", "conversation");
  await read("Research message 2", 96);
  await sidebar("Planning notes");
  await surface("Planning message 1");
  await sidebar("Research notes");
  const restored = await surface("Research message 2");
  await waitFor(() => {
    expect(messageOffset("Research message 2", restored)).toBe(96);
  });
  await expect(
    findFastControl("button", "Scroll to bottom"),
  ).resolves.toBeVisible();
});
test("chat-navigation-position-restoration-003 Scroll to bottom returns from Research history to the latest activity", async () => {
  await library("Research", "home");
  await sidebar("Planning notes");
  await surface("Planning message 1");
  await sidebar("Research notes");
  const viewport = await read("Research message 2", 48);
  click(await findFastControl("button", "Scroll to bottom"));
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
  });
});
test("chat-navigation-position-restoration-010 Sending while reading history clears the editor and returns to the newest activity", async () => {
  mockChatGeometry();
  const thread = "3a790000-0000-4000-a000-000000000011";
  const run = eventId(4, 8);
  const messages = Array.from({ length: 8 }, (_, i) => {
    return {
      id: eventId(4, i + 1),
      runId: eventId(4, i + 1),
      role: "user" as const,
      content: "History message " + (i + 1),
      createdAt: new Date(Date.UTC(2026, 6, 1, 10, i)).toISOString(),
    };
  });
  mockChatLifecycle(context, {
    threadId: thread,
    chatEvents: messages,
    activeRunIds: [run],
  });
  await setupPage({ context, path: "/chats/" + thread });
  const viewport = await read("History message 2", 48);
  const editor = await findComposerEditor();
  const text = "Add the latest deployment result.";
  await sendComposerMessage(userEvent.setup({ delay: null }), text);
  await within(viewport).findByText(text, { exact: true });
  await waitFor(() => {
    expect(viewport.scrollTop + viewport.clientHeight).toBe(
      viewport.scrollHeight,
    );
    expect(editor.textContent).toBe("");
    expect(queryFastControl("button", "Scroll to bottom")).toBeNull();
  });
});
