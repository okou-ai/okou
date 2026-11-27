import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  holdElementAnimations,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { chatListThread } from "./chat-list-test-helpers.ts";
import { installContinuityWorkspace } from "./chat-continuity-test-helpers.ts";
import { threadLinkByTitle } from "./sidebar-test-helpers.tsx";

const context = testContext();
const key = FeatureSwitchKey.ChatListHoverPreview;

async function waitForChatListExit(list: HTMLElement) {
  await waitFor(() => {
    expect(list).not.toBeInTheDocument();
  });
}

async function collapsedChatList({
  enabled = true,
  ownAccount = true,
  retainExit = false,
} = {}) {
  context.mocks.browser.userAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  );
  const threads = [
    chatListThread(1, "Release plan"),
    chatListThread(2, "Design review"),
  ];
  const { pageOptions } = installContinuityWorkspace(context, {
    caseId: 923,
    threads,
  });
  await setupPage({
    context,
    ...pageOptions,
    auth: {
      ...pageOptions.auth,
      user: {
        id: ownAccount ? "user_3EWY21Oe3f15kfs3yYmbGgDb3NV" : "another-user",
        fullName: ownAccount ? "Bingjie" : "Another user",
      },
    },
    featureSwitches: { [key]: enabled },
    path: "/chats/" + threads[0]!.id,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(document.title).toBe("Release plan | Okou");
  });
  const list = await screen.findByTestId("chat-list-column");
  await within(list).findByText("Release plan");
  if (retainExit) {
    const panel = list.parentElement!;
    panel.style.setProperty("transition-duration", "200ms", "important");
    Object.defineProperties(panel, {
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 720 },
    });
  }
  const finishExit = retainExit
    ? holdElementAnimations(list.parentElement!)
    : () => {};
  click(within(list).getByLabelText("Hide chat list"));
  if (!retainExit) {
    await waitForChatListExit(list);
  }
  const rail = screen.getByTestId("labeled-nav-rail");
  const trigger = await within(rail).findByLabelText("Show chat list");
  return { trigger, composer, threads, list, finishExit };
}

test.each([
  { ownAccount: true, scenario: "Bingjie" },
  { ownAccount: false, scenario: "Another user who opts in" },
])(
  "$scenario can preview the hidden chat list without moving composer focus",
  async ({ ownAccount }) => {
    const { trigger, composer } = await collapsedChatList({ ownAccount });
    const user = userEvent.setup();
    await user.click(composer);
    await user.hover(trigger);
    const preview = await screen.findByRole("region", {
      name: "Show chat list",
    });
    expect(within(preview).getByText("Release plan")).toBeInTheDocument();
    expect(within(preview).getByText("Design review")).toBeInTheDocument();
    expect(composer).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
    await user.hover(preview);
    await user.hover(composer);
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(composer).toHaveFocus();
  },
);

test.each(["Escape", "outside click"])(
  "%s dismisses the preview without expanding the normal chat list",
  async (action) => {
    const { trigger, composer } = await collapsedChatList();
    const user = userEvent.setup();
    await user.click(composer);
    await user.hover(trigger);
    const preview = await screen.findByRole("region", {
      name: "Show chat list",
    });
    if (action === "Escape") {
      trigger.focus();
      await user.keyboard("{Escape}");
    } else {
      await user.click(composer);
    }
    await waitFor(() => {
      expect(preview).not.toBeInTheDocument();
    });
    expect(trigger).toBeInTheDocument();
    expect(action === "Escape" ? trigger : composer).toHaveFocus();
    expect(screen.queryByTestId("chat-list-column")).toBeNull();
  },
);

test("The preview stays transient after opening and dismissing a nested menu", async () => {
  const { trigger, composer } = await collapsedChatList();
  const user = userEvent.setup();
  await user.hover(trigger);
  const preview = await screen.findByRole("region", {
    name: "Show chat list",
  });
  await user.click(within(preview).getByLabelText("Open chat list menu"));
  const menu = await screen.findByRole("menu");
  await user.hover(within(menu).getByText("Archived"));
  expect(preview).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
  expect(preview).toBeInTheDocument();
  await user.hover(preview);
  await user.hover(composer);
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
});

test.each(["rail", "preview"] as const)(
  "Clicking the %s toggle pins the normal chat list and preserves the toggle focus",
  async (target) => {
    const { trigger } = await collapsedChatList();
    const user = userEvent.setup();
    await user.hover(trigger);
    const preview = await screen.findByRole("region", {
      name: "Show chat list",
    });
    await user.click(
      target === "rail"
        ? trigger
        : within(preview).getByLabelText("Show chat list"),
    );
    const list = await screen.findByTestId("chat-list-column");
    expect(within(list).getByLabelText("Hide chat list")).toHaveFocus();
    expect(within(list).getByText("Release plan")).toBeInTheDocument();
    expect(preview).not.toBeInTheDocument();
  },
);

test("A hover waits for the normal chat list's actual exit before mounting another viewport", async () => {
  const { trigger, list, finishExit } = await collapsedChatList({
    retainExit: true,
  });
  const user = userEvent.setup();
  try {
    await user.hover(trigger);
    await expect(
      screen.findByRole("tooltip", { name: /Show chat list/ }),
    ).resolves.toBeInTheDocument();
    expect(list).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Show chat list" })).toBeNull();
  } finally {
    finishExit();
  }
  await waitForChatListExit(list);
  const collapsedTrigger = within(
    screen.getByTestId("labeled-nav-rail"),
  ).getByLabelText("Show chat list");
  await user.hover(collapsedTrigger);
  const preview = await screen.findByRole("region", {
    name: "Show chat list",
  });
  expect(within(preview).getByText("Release plan")).toBeInTheDocument();
  await user.click(within(preview).getByLabelText("Show chat list"));
  const pinned = await screen.findByTestId("chat-list-column");
  expect(within(pinned).getByText("Release plan")).toBeInTheDocument();
  expect(within(pinned).getByLabelText("Hide chat list")).toHaveFocus();
  expect(preview).not.toBeInTheDocument();
});

test("Selecting a previewed chat opens its conversation without pinning the list", async () => {
  const { trigger, threads } = await collapsedChatList();
  const user = userEvent.setup();
  await user.hover(trigger);
  const preview = await screen.findByRole("region", {
    name: "Show chat list",
  });
  await user.click(threadLinkByTitle("Design review", preview));
  await waitFor(() => {
    expect(location.pathname).toBe("/chats/" + threads[1]!.id);
    expect(document.title).toBe("Design review | Okou");
  });
  expect(
    within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
      "Show chat list",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).toBeNull();
});

test("The keyboard shortcut expands the normal chat list while keeping the composer focused", async () => {
  const { trigger, composer } = await collapsedChatList();
  const user = userEvent.setup();
  await user.click(composer);
  await user.hover(trigger);
  const preview = await screen.findByRole("region", {
    name: "Show chat list",
  });
  await user.keyboard("{Meta>}b{/Meta}");
  const list = await screen.findByTestId("chat-list-column");
  expect(within(list).getByLabelText("Hide chat list")).toBeInTheDocument();
  expect(composer).toHaveFocus();
  expect(preview).not.toBeInTheDocument();
});

test.each([
  { enabled: false, ownAccount: true, scenario: "the owner opts out" },
  { enabled: false, ownAccount: false, scenario: "another user keeps it off" },
])(
  "The legacy tooltip and click remain available when $scenario",
  async ({ enabled, ownAccount }) => {
    const { trigger } = await collapsedChatList({ enabled, ownAccount });
    const user = userEvent.setup();
    await user.hover(trigger);
    await expect(
      screen.findByRole("tooltip", { name: /Show chat list/ }),
    ).resolves.toBeInTheDocument();
    await user.click(trigger);
    const list = await screen.findByTestId("chat-list-column");
    expect(within(list).getByText("Release plan")).toBeInTheDocument();
    expect(within(list).getByLabelText("Hide chat list")).toBeInTheDocument();
  },
);
