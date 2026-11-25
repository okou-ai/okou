import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatThreadsContract,
  chatThreadRenameContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import {
  findComposer,
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
const release = chatListThread(1, "Release plan"),
  incident = chatListThread(2, "Incident notes");
const route = (id: string) => {
  return "/chats/" + id;
};
async function openDesk(
  options: { active?: string; unread?: boolean; otherTitle?: string } = {},
) {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/135.0 Safari/537.36",
  );
  context.mocks.browser.platform("MacIntel");
  context.mocks.browser.matchMedia((q) => {
    return q.includes("min-width");
  });
  const threads = [
    release,
    { ...incident, title: options.otherTitle ?? incident.title },
  ];
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 807,
    threads,
  });
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      threads: options.unread ? { [incident.id]: "unread" } : {},
      unreadAt: options.unread ? { [incident.id]: "2026-09-11T00:15:00Z" } : {},
    });
  });
  await setupPage({
    context,
    ...pageOptions,
    path: route(options.active ?? release.id),
  });
  await findFastControl("link", "Release plan");
  await waitFor(() => {
    const title = options.otherTitle ?? "Incident notes";
    expect(
      queryAllByRoleFast("link").some((link) => {
        return link.textContent?.includes(title);
      }),
    ).toBeTruthy();
  });
}
function unreadKey() {
  const key = new KeyboardEvent("keydown", {
    key: "U",
    code: "KeyU",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(document.activeElement ?? document.body, key);
  return key;
}
test("unread-only-shortcut-001 Filtering an empty inbox keeps the current chat and the advertised composer shortcut restores it", async () => {
  await openDesk();
  click(await findFastControl("button", "Open chat list menu"));
  const entry = await waitFor(() => {
    const item = queryAllByRoleFast("menuitem").find((el) => {
      return el.textContent?.includes("Unread");
    });
    expect(item).toBeDefined();
    return item!;
  });
  const bindings = entry
    .getAttribute("aria-keyshortcuts")
    ?.toLowerCase()
    .split(" ");
  expect(bindings).toStrictEqual(
    expect.arrayContaining(["meta+shift+u", "control+shift+u"]),
  );
  expect(entry).toHaveTextContent("⌘⇧U");
  click(entry);
  await screen.findByText("No unread chats");
  expect(location.pathname).toBe(route(release.id));
  (await findComposer()).focus();
  expect(unreadKey().defaultPrevented).toBeTruthy();
  await findFastControl("link", "Release plan");
});
test("unread-only-shortcut-003 Meta Shift U activates the first unread conversation", async () => {
  await openDesk({ unread: true, otherTitle: "Incident follow-up" });
  unreadKey();
  await waitFor(() => {
    return expect(location.pathname).toBe(route(incident.id));
  });
  await expect(
    findFastControl("link", /Incident follow-up/),
  ).resolves.toHaveAttribute("aria-current", "page");
});
test("unread-only-shortcut-004 Two consecutive filter shortcuts preserve the original chat and its visible row", async () => {
  await openDesk({ unread: true, otherTitle: "Incident follow-up" });
  act(() => {
    unreadKey();
    unreadKey();
  });
  await waitFor(() => {
    return expect(queryFastControl("link", "Release plan")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(location.pathname).toBe(route(release.id));
});
test("sidebar-inline-rename-004 Cancelling a title edit and submitting an empty title both restore focus to the unchanged conversation", async () => {
  await openDesk({ active: incident.id });
  const user = userEvent.setup({ delay: null });
  for (const mode of ["escape", "empty"] as const) {
    const link = await findFastControl("link", "Incident notes");
    await user.dblClick(link);
    const input = await screen.findByRole("textbox", { name: "Rename chat" });
    await fill(input, mode === "escape" ? "Discarded" : "");
    if (mode === "escape") {
      await user.keyboard("{Escape}");
    } else {
      await user.keyboard("{Enter}");
    }
    await waitFor(() => {
      return expect(input).not.toBeInTheDocument();
    });
    await waitFor(() => {
      return expect(queryFastControl("link", "Incident notes")).toHaveFocus();
    });
  }
});
test("sidebar-inline-rename-006 Only an unmodified double-click opens the existing conversation title for editing", async () => {
  await openDesk({ active: incident.id });
  const link = await findFastControl("link", "Incident notes");
  for (const keys of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ]) {
    const gesture = new MouseEvent("dblclick", {
      ...keys,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, gesture);
    expect(gesture.defaultPrevented).toBeFalsy();
    expect(screen.queryByRole("textbox", { name: "Rename chat" })).toBeNull();
  }
  await userEvent.setup({ delay: null }).dblClick(link);
  await expect(
    screen.findByRole("textbox", { name: "Rename chat" }),
  ).resolves.toHaveValue("Incident notes");
});
test("sidebar-inline-rename-002 A rename waiting for Clerk survives switching to another conversation", async () => {
  await openDesk({ active: incident.id });
  const auth = context.mocks.deferred<void>(),
    tokenStarted = context.mocks.deferred<void>(),
    committed = context.mocks.deferred<{ id: string; title: string }>();
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ params, body, respond }) => {
      committed.resolve({ id: params.id, title: body.title });
      return respond(204);
    },
  );
  const user = userEvent.setup({ delay: null });
  await user.dblClick(await findFastControl("link", "Incident notes"));
  const field = await screen.findByRole("textbox", { name: "Rename chat" });
  await fill(field, "Postmortem");
  const original = mockedClerk.sessionGetToken.getMockImplementation()!;
  mockedClerk.sessionGetToken.mockImplementation(async (...args) => {
    if (!tokenStarted.settled()) {
      tokenStarted.resolve();
    }
    await auth.promise;
    return original(...args);
  });
  try {
    await user.click(await findFastControl("link", "Release plan"));
    await tokenStarted.promise;
    await waitFor(() => {
      return expect(location.pathname).toBe(route(release.id));
    });
    expect(committed.settled()).toBeFalsy();
    auth.resolve();
    await expect(committed.promise).resolves.toStrictEqual({
      id: incident.id,
      title: "Postmortem",
    });
    await findFastControl("link", "Postmortem");
    expect(screen.queryByRole("textbox", { name: "Rename chat" })).toBeNull();
  } finally {
    if (!auth.settled()) {
      auth.resolve();
    }
    mockedClerk.sessionGetToken.mockImplementation(original);
  }
});
test("sidebar-pinned-links-010 Alt-click opens the other conversation beside the current one", async () => {
  await openDesk();
  fireEvent.click(await findFastControl("link", "Incident notes"), {
    altKey: true,
  });
  await waitFor(() => {
    return expect(new URLSearchParams(location.search).get("sidebar")).toBe(
      incident.id,
    );
  });
  expect(location.pathname).toBe(route(release.id));
  await expect(
    screen.findByText("Incident notes", {
      selector: '[data-testid="chat-thread-header-title"]',
    }),
  ).resolves.toBeVisible();
});
