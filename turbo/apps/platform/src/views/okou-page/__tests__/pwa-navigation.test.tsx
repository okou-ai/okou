import {
  findFastControl,
  queryFastControl,
  createMessageExperienceHelpers,
} from "./chat-message-experience-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { feedContract } from "@okouai/api-contracts/contracts/feed";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
  swipeBack,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListThread,
  installChatListStream,
} from "./chat-list-test-helpers.ts";

const context = testContext();
test("pwa-navigation-001 A desktop standalone chat list keeps its navigation rail and message composer", async () => {
  installChatListStream(context, {
    caseId: 68,
    snapshot: [chatListThread(1, "Coastal survey")],
  });
  context.mocks.browser.matchMedia((query) => {
    return (
      query === "(display-mode: standalone)" || query === "(min-width: 48rem)"
    );
  });
  await setupPage({
    context,
    path: "/",
    host: "app.okou.ai",
  });
  await expect(
    screen.findByText("Coastal survey"),
  ).resolves.toBeInTheDocument();
  const rail = await screen.findByRole("navigation", { name: "Sidebar" });
  expect(within(rail).getByLabelText("Workflows")).toBeVisible();
  await expect(screen.findByLabelText("Message")).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});

const current = chatListThread(4, "River crossing");
const earlier = chatListThread(8, "Harbor closure", { archived: true });
function mobile(standalone: boolean) {
  installChatListStream(context, { caseId: 69, snapshot: [current, earlier] });
  context.mocks.browser.matchMedia((query) => {
    return standalone && query === "(display-mode: standalone)";
  });
  return context.mocks.browser.viewTransition();
}
function enterMobile(path = "/") {
  return setupPage({
    context,
    path,
    host: "app.okou.ai",
  });
}
function tabBar() {
  return screen.getByRole("navigation", { name: "Main navigation" });
}
async function enterThread(thread: typeof current) {
  click(await screen.findByText(thread.title!));
  await expect(screen.findByLabelText("Message")).resolves.toBeVisible();
  expect(location.pathname).toBe(`/chats/${thread.id}`);
}
async function backToList() {
  click(await findFastControl("link", "Back to chats"));
  await expect(
    findFastControl("button", "Open chat list menu"),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
}

test("Returning from a mobile chat shows a For you card delivered while the list was closed", async () => {
  mobile(false);
  let unread = false;
  const firstSummary = context.mocks.deferred<void>();
  context.mocks.api(feedContract.summary, ({ respond }) => {
    if (!firstSummary.settled()) {
      firstSummary.resolve();
    }
    return respond(200, { hasUnread: unread });
  });
  await enterMobile();
  await firstSummary.promise;
  await enterThread(current);
  unread = true;
  context.mocks.ably.trigger("agentSuggestionsChanged");
  await backToList();
  const row = await findFastControl("link", /For you/);
  await expect(within(row).findByText("Unread")).resolves.toBeInTheDocument();
});

test("pwa-navigation-003 Search opens from the ordered mobile toolbar and Escape restores the list", async () => {
  mobile(false);
  await enterMobile();
  await expect(screen.findByText(current.title!)).resolves.toBeVisible();
  const header = screen.getByRole("banner");
  const labels = [
    "Search workspace",
    "Create Project",
    "New chat",
    "Open chat list menu",
  ];
  expect(
    queryAllByRoleFast("button", header).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual(labels);
  click(await findFastControl("button", "Search workspace", header));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("combobox")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  expect(dialog).not.toBeInTheDocument();
  expect(screen.getByText(current.title!)).toBeVisible();
  expect(location.pathname).toBe("/");
});
test("pwa-navigation-006 Archived filtering, conversation return, composing and Me use the mobile routes", async () => {
  mobile(false);
  await enterMobile();
  await expect(screen.findByText(current.title!)).resolves.toBeVisible();
  expect(screen.queryByText(earlier.title!)).toBeNull();
  const tabs = tabBar();
  await expect(findFastControl("link", "Chats", tabs)).resolves.toHaveAttribute(
    "aria-current",
    "page",
  );
  for (const name of ["Connectors", "Artifacts", "Me"]) {
    await expect(findFastControl("link", name, tabs)).resolves.toBeVisible();
  }
  click(await findFastControl("button", "Open chat list menu"));
  click(await screen.findByText("Archived", { exact: true }));
  await expect(screen.findByText(earlier.title!)).resolves.toBeVisible();
  expect(screen.queryByText(current.title!)).toBeNull();
  expect(location.pathname).toBe("/");
  await enterThread(earlier);
  await backToList();
  click(await findFastControl("button", "New chat"));
  await expect(screen.findByLabelText("Message")).resolves.toBeVisible();
  expect(location.pathname + location.search).toBe("/?compose=1");
  await expect(findFastControl("link", "Back to chats")).resolves.toBeVisible();
  click(await findFastControl("link", "Me", tabBar()));
  await waitFor(() => {
    return expect(queryFastControl("link", "Me", tabBar())).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(location.pathname).toBe("/me");
});
test("pwa-navigation-007 History and Back both animate the return to Chats while Me switches directly", async () => {
  const transition = mobile(true);
  await enterMobile();
  await enterThread(current);
  await backToList();
  expect(transition.startedTypes).toStrictEqual([["push"], ["pop"]]);
  await enterThread(current);
  history.back();
  await expect(
    findFastControl("button", "Open chat list menu"),
  ).resolves.toBeVisible();
  await expect(screen.findByText(current.title!)).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
  click(await findFastControl("link", "Me", tabBar()));
  await waitFor(() => {
    return expect(queryFastControl("link", "Me", tabBar())).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(location.pathname).toBe("/me");
  expect(transition.startedTypes).toStrictEqual([
    ["push"],
    ["pop"],
    ["push"],
    ["pop"],
  ]);
});
test("pwa-navigation-008 The home tab opens a conversation and a fresh compose route with forward transitions", async () => {
  const transition = mobile(true);
  await enterMobile();
  const chats = await findFastControl("link", "Chats", tabBar());
  expect(chats).toHaveAttribute("aria-current", "page");
  expect(chats).toHaveAttribute("href", "/");
  await enterThread(current);
  await backToList();
  click(await findFastControl("button", "New chat"));
  await expect(screen.findByLabelText("Message")).resolves.toBeVisible();
  const back = await findFastControl("link", "Back to chats");
  expect(back).toHaveAttribute("href", "/");
  expect(location.pathname + location.search).toBe("/?compose=1");
  expect(transition.startedTypes).toStrictEqual([["push"], ["pop"], ["push"]]);
  click(back);
  await expect(screen.findByText(current.title!)).resolves.toBeVisible();
  expect(location.pathname).toBe("/");
});
test("pwa-navigation-009 A browser edge swipe restores Chats without a second slide", async () => {
  const transition = mobile(false);
  await enterMobile();
  await enterThread(current);
  swipeBack();
  await expect(
    findFastControl("button", "Open chat list menu"),
  ).resolves.toBeVisible();
  expect(screen.getByText(current.title!)).toBeVisible();
  expect(location.pathname).toBe("/");
  expect(transition.startedTypes).toStrictEqual([["push"]]);
});
test.each([true, false])(
  "The mobile Chats tab reflects whether the other member conversation is unread: %s",
  async (unread) => {
    mobile(false);
    const other = chatListThread(17, "Independent report");
    const server =
      createMessageExperienceHelpers(context).installMessageExperienceChat();
    server.setThreadList(
      [current, other].map((thread) => {
        return {
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
        };
      }),
    );
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        threads: {},
        unreadAt: unread ? { [other.id]: other.updatedAt } : {},
      });
    });
    await enterMobile();
    await expect(screen.findByText(other.title!)).resolves.toBeVisible();
    const tabs = tabBar();
    const chats = within(await findFastControl("link", /Chats/, tabs));
    if (unread) {
      await chats.findByLabelText("Unread");
    }
    expect(Boolean(chats.queryByLabelText("Unread"))).toBe(unread);
    expect(
      within(await findFastControl("link", "Me", tabs)).queryByLabelText(
        "Unread",
      ),
    ).toBeNull();
  },
);
test("pwa-navigation-015 A home prompt opens a populated mobile composer alongside the tab bar", async () => {
  mobile(true);
  await enterMobile("/?prompt=Draft+a+launch+plan");
  const input = await screen.findByLabelText("Message");
  expect(input).toHaveTextContent("Draft a launch plan");
  expect(location.pathname).toBe("/");
  expect(tabBar()).toBeVisible();
});
