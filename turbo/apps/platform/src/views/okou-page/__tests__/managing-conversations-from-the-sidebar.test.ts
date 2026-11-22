import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";

import {
  mockSidebarThreadStory,
  openThreadMenu,
} from "./sidebar-test-helpers.tsx";
const context = testContext(),
  release = chatListThread(11, "Release plan"),
  incident = chatListThread(10, "Incident notes"),
  quiet = chatListThread(9, "Quiet task"),
  archived = chatListThread(8, "Archived context", { archived: true });
const route = (id: string) => {
  return "/chats/" + id;
};
async function workspace(
  threads: ReturnType<typeof chatListThread>[],
  path: string,
  unread?: string,
) {
  context.mocks.browser.matchMedia((q) => {
    return q.includes("min-width");
  });
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 864,
    threads,
  });
  mockSidebarThreadStory(context, threads);
  if (unread) {
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        threads: { [unread]: "unread" },
        unreadAt: { [unread]: "2026-10-01T12:00:00Z" },
      });
    });
  }
  await setupPage({ context, ...pageOptions, path });
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toContain(threads[0]!.title);
  });
}
function menuChoice(label: string) {
  return waitFor(() => {
    const opt = queryAllByRoleFast("menuitem").find((e) => {
      return e.textContent?.trim().startsWith(label);
    });
    expect(opt).toBeDefined();
    return opt!;
  });
}
async function action(title: string, label: string) {
  openThreadMenu(title);
  click(await menuChoice(label));
}
async function deletion(title: string) {
  await action(title, "Delete chat");
  return screen.findByRole("dialog", { name: "Delete chat?" });
}
async function confirm(box: HTMLElement) {
  click(await findFastControl("button", "Delete", box));
  await screen.findByText("Chat deleted");
}
async function filter(name: string) {
  click(await findFastControl("button", "Open chat list menu"));
  click(await menuChoice(name));
}
async function titles(...names: string[]) {
  await waitFor(() => {
    return expect(sidebarThreadTitles()).toStrictEqual(names);
  });
}
test("sidebar-chat-history-002 Cancelling deletion preserves Release plan and confirming removes only that chat", async () => {
  await workspace([release, incident], route(release.id));
  const first = await deletion("Release plan");
  for (const clause of [
    "permanently delete",
    "stopped immediately",
    "linked automations will be paused",
    "cannot be undone",
  ]) {
    expect(first).toHaveTextContent(clause);
  }
  click(await findFastControl("button", "Cancel", first));
  await titles("Release plan", "Incident notes");
  expect(location.pathname).toBe(route(release.id));
  await confirm(await deletion("Release plan"));
  await titles("Incident notes");
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(findComposer()).resolves.toBeVisible();
});
test.each([
  ["sidebar-chat-history-003", "Release plan"],
  ["sidebar-chat-history-005", "Incident notes"],
] as const)(
  "%s Deleting %s leaves the correct composer and conversation open",
  async (id, title) => {
    const last = id.endsWith("003");
    await workspace(last ? [release] : [release, incident], route(release.id));
    await confirm(await deletion(title));
    await titles(...(last ? [] : ["Release plan"]));
    await waitFor(() => {
      return expect(location.pathname).toBe(last ? "/" : route(release.id));
    });
    await expect(findComposer()).resolves.toBeVisible();
    expect(
      screen.queryByText(/chat not found|chat could not be found/i),
    ).toBeNull();
  },
);
test("sidebar-chat-history-012 Undoing a mute restores the unread marker after explaining notification behavior", async () => {
  await workspace([release, quiet], route(release.id), quiet.id);
  await findFastControl("link", /Quiet task Unread/);
  await action("Quiet task", "Mute chat");
  await screen.findByText(
    /new replies won't show as unread or send push notifications/i,
  );
  await findFastControl("link", /Quiet task Muted/);
  click(await findFastControl("button", "Undo"));
  await expect(
    findFastControl("link", /Quiet task Unread/),
  ).resolves.toBeVisible();
});
test("sidebar-chat-history-018 Unmuting the only filtered chat empties Muted and Show all chats restores the inbox", async () => {
  await workspace([release, { ...quiet, muted: true }], route(release.id));
  await filter("Muted");
  await titles("Quiet task");
  await action("Quiet task", "Unmute chat");
  await expect(screen.findByText("No muted chats")).resolves.toBeVisible();
  await titles();
  click(await findFastControl("button", "Show all chats"));
  await titles("Release plan", "Quiet task");
});
test("sidebar-chat-history-022 Undo restores an archived muted chat after its distinct toast explains that new replies will not return it", async () => {
  await workspace([release, { ...quiet, muted: true }], route(release.id));
  await action("Quiet task", "Archive chat");
  await expect(
    screen.findByText(/muted, so new replies won't bring it back/i),
  ).resolves.toBeVisible();
  await titles("Release plan");
  click(await findFastControl("button", "Undo"));
  await titles("Release plan", "Quiet task");
});
test("sidebar-chat-history-021 The advertised archive shortcut toggles the current conversation out of and back into Inbox", async () => {
  await workspace([release], route(release.id));
  openThreadMenu("Release plan");
  const archive = await menuChoice("Archive chat");
  expect(archive).toHaveTextContent(/Ctrl.*Shift.*X/i);
  expect(
    archive.getAttribute("aria-keyshortcuts")?.toLowerCase().split(" "),
  ).toStrictEqual(expect.arrayContaining(["control+shift+x", "meta+shift+x"]));
  await userEvent.setup({ delay: null }).keyboard("{Escape}");
  const archiveKey = () => {
    return fireEvent.keyDown(document, {
      key: "X",
      code: "KeyX",
      ctrlKey: true,
      shiftKey: true,
    });
  };
  archiveKey();
  await screen.findByText("Your inbox is empty");
  await screen.findByText("Chat archived.");
  await titles();
  archiveKey();
  await screen.findByText("Chat moved to Inbox");
  await titles("Release plan");
  expect(screen.queryByText("Your inbox is empty")).toBeNull();
});
test("sidebar-chat-history-008 Unread and Archived filters navigate among genuinely archived and unread conversations", async () => {
  const shipped = chatListThread(6, "✅ Shipped notes"),
    review = chatListThread(7, "Waiting for review", { archived: true });
  await workspace(
    [release, shipped, archived, review],
    route(release.id),
    review.id,
  );
  await filter("Unread");
  await titles("Waiting for review");
  await waitFor(() => {
    return expect(location.pathname).toBe(route(review.id));
  });
  await filter("Archived");
  await titles("Archived context", "Waiting for review");
  expect(location.pathname).toBe(route(review.id));
  await filter("Inbox");
  await titles("Release plan", "✅ Shipped notes");
  await waitFor(() => {
    return expect(location.pathname).toBe(route(release.id));
  });
});
test("sidebar-chat-history-027 The new-chat shortcut and Chat navigation both return to the root composer", async () => {
  await workspace([release], route(release.id));
  const nav = await findFastControl("link", "Chat");
  expect(nav).toHaveAttribute("href", "/");
  fireEvent.keyDown(document, {
    key: "O",
    code: "KeyO",
    ctrlKey: true,
    shiftKey: true,
  });
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(findComposer()).resolves.toBeVisible();
  click(await findFastControl("link", "Release plan"));
  await waitFor(() => {
    return expect(location.pathname).toBe(route(release.id));
  });
  click(nav);
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await expect(findComposer()).resolves.toBeVisible();
});
test("sidebar-chat-history-025 Starting a new My Okou chat from a retained research conversation uses the root chat destination", async () => {
  const research = chatListThread(21, "Research conversation");
  await workspace([research], route(research.id));
  click(await screen.findByText("New chat", { exact: true }));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  const nav = await findFastControl("link", "Chat");
  expect(nav).toHaveAttribute("href", "/");
  click(nav);
  await waitFor(async () => {
    return await expect(findComposer()).resolves.toBeVisible();
  });
  expect(location.pathname).toBe("/");
});
test("sidebar-chat-history-028 The Chat rail action leaves the archived list and restores Release plan at the root", async () => {
  await workspace([release, archived], route(release.id));
  await filter("Archived");
  await titles("Archived context");
  await screen.findByText("Archived", { exact: true });
  click(await findFastControl("link", "Chat"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  await titles("Release plan");
  expect(screen.queryByText("Archived", { exact: true })).toBeNull();
});
