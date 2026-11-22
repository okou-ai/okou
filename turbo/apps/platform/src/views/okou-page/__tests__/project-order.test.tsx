import {
  projectsContract,
  type Project,
} from "@okouai/api-contracts/contracts/projects";
import {
  chatThreadsContract,
  chatThreadPinOrderContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListAuth,
  chatListThread,
  cachedChatListEvents,
  installActiveChatBoundaries,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext(),
  canon = Object.freeze(["Launch", "Research", "Campaign"]),
  reordered = Object.freeze(["Research", "Launch", "Campaign"]),
  now = "2026-08-01T09:00:00Z";
async function start(at: "pin" | "project" | "home") {
  const projects: Project[] = canon.map((name, index) => {
    return {
      id: crypto.randomUUID(),
      name,
      sortOrder: "a" + index,
      createdAt: now,
      updatedAt: now,
    };
  });
  const research = projects[1]!;
  const first = chatListThread(31, "First pin", {
      pinnedAt: now,
      pinOrder: "a0",
    }),
    second = chatListThread(32, "Current pin", {
      pinnedAt: now,
      pinOrder: "a1",
    }),
    inside = chatListThread(33, "Unread Research", { projectId: research.id });
  const threads = [first, second, inside];
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects,
      latestSeqId: 1,
      latestEventId: crypto.randomUUID(),
    });
  });
  context.mocks.api(projectsContract.reorder, ({ respond }) => {
    return respond(204);
  });
  context.mocks.api(
    chatThreadPinOrderContract.reorder,
    ({ body, params, respond }) => {
      const pin = threads.find((item) => {
        return item.id === params.id;
      });
      if (!pin) {
        throw new Error("Unknown pin");
      }
      pin.pinOrder = body.pinOrder;
      return respond(204);
    },
  );
  context.mocks.api(projectsContract.threads, ({ params, respond }) => {
    return respond(200, {
      threads: threads.filter((chat) => {
        return chat.projectId === params.id;
      }),
      nextAfter: null,
    });
  });
  installChatListStream(context, { caseId: 859, snapshot: threads });
  installActiveChatBoundaries(context, { metadata: second });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: { [inside.id]: "unread" },
      unreadAt: { [inside.id]: now },
    });
  });
  const path =
    at === "pin"
      ? "/chats/" + second.id
      : at === "project"
        ? "/projects/" + research.id
        : "/";
  await setupPage({
    context,
    path,
    auth: chatListAuth(859),
    sharedWorkerTestTransport: "message-port",
    cachedChatThreadEvents: cachedChatListEvents(859, threads),
  });
  await check(canon);
  return path;
}
function check(names: readonly string[]) {
  return waitFor(() => {
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-project-trigger]"),
      ).map((row) => {
        return row
          .getAttribute("aria-label")
          ?.replace("Show or hide chats in ", "");
      }),
    ).toStrictEqual(names);
  });
}
function project() {
  return findFastControl("button", "Show or hide chats in Research");
}
function menu() {
  return findFastControl("button", "Options for Research");
}
async function filter(text: string) {
  click(await findFastControl("button", "Open chat list menu"));
  const panel = await screen.findByRole("menu");
  click(await within(panel).findByText(text));
}
function shortcut(
  target: HTMLElement,
  key: string,
  extra: KeyboardEventInit = {},
) {
  return fireEvent.keyDown(target, {
    key,
    altKey: true,
    shiftKey: true,
    ...extra,
  });
}
test("project-order-003 the project shortcut ignores composition, repeat and Meta, keeping the edited draft focused", async () => {
  const path = await start("project"),
    editor = await findComposerEditor();
  await fill(editor, "Unsent project request");
  editor.focus();
  for (const modifiers of [
    { isComposing: true },
    { repeat: true },
    { metaKey: true },
  ]) {
    expect(shortcut(editor, "ArrowUp", modifiers)).toBeTruthy();
    await check(canon);
  }
  shortcut(editor, "ArrowUp");
  await check(reordered);
  expect(editor).toHaveFocus();
  expect(editor.textContent).toBe("Unsent project request");
  expect(location.pathname).toBe(path);
  click(await findFastControl("button", "Open chat list menu"));
  const panel = await screen.findByRole("menu");
  fireEvent.keyDown(panel, { key: "ArrowUp" });
  fireEvent.keyDown(panel, { key: "ArrowDown" });
  await check(reordered);
});
test("project-order-006 filtering to Unread prevents Research from moving out of its canonical Inbox position", async () => {
  await start("home");
  await filter("Unread");
  await check(["Research"]);
  click(await menu());
  const panel = await screen.findByRole("menu");
  expect(within(panel).getByText("Rename")).toBeInTheDocument();
  expect(within(panel).queryByText("Move up")).toBeNull();
  fireEvent.keyDown(panel, { key: "Escape" });
  const trigger = await project();
  trigger.focus();
  shortcut(trigger, "ArrowUp");
  await filter("Inbox");
  await check(canon);
  click(await menu());
  const item = await within(await screen.findByRole("menu")).findByText(
    "Move up",
  );
  expect(item.closest('[role="menuitem"]')).toHaveAttribute(
    "aria-keyshortcuts",
    "Alt+Shift+ArrowUp",
  );
});
