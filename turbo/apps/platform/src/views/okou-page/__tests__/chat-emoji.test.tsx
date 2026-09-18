import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000001";

function setupEmojiPage(
  threadTitle = "Emoji planning",
  archiveEnabled?: boolean,
): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle,
  });
  if (archiveEnabled) {
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, { unreads: [] });
    });
  }
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches:
      archiveEnabled === undefined
        ? undefined
        : { [FeatureSwitchKey.ChatThreadArchiving]: archiveEnabled },
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = screen.getByLabelText(label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function categoryTab(label: string): HTMLButtonElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(tab instanceof HTMLButtonElement)) {
    throw new Error(`Emoji category tab not found: ${label}`);
  }
  return tab;
}

function emojiButton(label: string): HTMLButtonElement {
  const button = document.querySelector(
    `[data-chat-thread-emoji][aria-label="${label}"]`,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Emoji button not found: ${label}`);
  }
  return button;
}

function emojiFeed(): HTMLElement {
  const feed = document.querySelector("[data-chat-thread-emoji-feed]");
  if (!(feed instanceof HTMLElement)) {
    throw new Error("Emoji feed not found");
  }
  return feed;
}

async function openEmojiPicker(): Promise<HTMLInputElement> {
  await setupEmojiPage();
  await waitFor(() => {
    expect(buttonByLabel("Change icon")).toBeInTheDocument();
  });

  click(buttonByLabel("Change icon"));

  const searchInput = await screen.findByLabelText("Search emoji");
  if (!(searchInput instanceof HTMLInputElement)) {
    throw new Error("Emoji search is not an input");
  }
  return searchInput;
}

function setCategoryLayout(feed: HTMLElement): void {
  const sections = Array.from(
    feed.querySelectorAll<HTMLElement>("[data-chat-thread-emoji-section]"),
  );
  for (const [index, section] of sections.entries()) {
    Object.defineProperty(section, "offsetTop", {
      configurable: true,
      value: index * 100,
    });
  }
}

function nextAnimationFrame(): Promise<void> {
  const frame = createDeferredPromise<void>(context.signal);
  window.requestAnimationFrame(() => {
    frame.resolve();
  });
  return frame.promise;
}

test("Keep the check-mark thread icon Done when archiving is disabled", async () => {
  await setupEmojiPage("Emoji planning", false);
  await waitFor(() => {
    expect(buttonByLabel("Change icon")).toBeInTheDocument();
  });

  click(buttonByLabel("Change icon"));
  await screen.findByLabelText("Search emoji");

  expect(emojiButton("Done")).toHaveTextContent("✅");
  expect(
    document.querySelector('[data-chat-thread-emoji][aria-label="Archive"]'),
  ).not.toBeInTheDocument();
});

test("Name the check-mark thread icon Archive when archiving is enabled", async () => {
  await setupEmojiPage("Emoji planning", true);
  await waitFor(() => {
    expect(buttonByLabel("Change icon")).toBeInTheDocument();
  });

  click(buttonByLabel("Change icon"));
  await screen.findByLabelText("Search emoji");

  expect(emojiButton("Archive")).toHaveTextContent("✅");
  expect(
    document.querySelector('[data-chat-thread-emoji][aria-label="Done"]'),
  ).not.toBeInTheDocument();
});

test("Retain a thread icon when resizing from mobile to desktop", async () => {
  const viewport = context.mocks.browser.matchMedia(false);
  await setupEmojiPage("😀 Emoji planning");
  await waitFor(() => {
    expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    expect(buttonByLabel("Change icon")).toHaveTextContent("😀");
  });

  act(() => {
    viewport.setMatches(true);
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Open browser")).toBeInTheDocument();
    expect(buttonByLabel("Change icon")).toHaveTextContent("😀");
  });
  expect(screen.queryByLabelText("Open menu")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
});

test("Change a thread icon before its save finishes", async () => {
  context.mocks.browser.matchMedia(false);
  const renameResponse = context.mocks.deferred<void>();
  context.mocks.api(chatThreadRenameContract.rename, async ({ respond }) => {
    await renameResponse.promise;
    return respond(204);
  });

  await setupEmojiPage();
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Emoji planning",
    );
    expect(buttonByLabel("Open menu")).toBeInTheDocument();
  });
  expect(screen.queryByTestId("agent-avatar")).not.toBeInTheDocument();
  const changeIcon = buttonByLabel("Change icon");

  click(changeIcon);
  const searchInput = await screen.findByLabelText("Search emoji");
  click(emojiButton("grinning face"));
  await waitFor(() => {
    expect(changeIcon).toHaveTextContent("😀");
  });
  expect(searchInput).toBeInTheDocument();
  renameResponse.resolve();
  await waitFor(() => {
    expect(searchInput).not.toBeInTheDocument();
  });
});

test("Restore chat focus after closing the mobile emoji picker", async () => {
  context.mocks.browser.matchMedia(false);
  await setupEmojiPage();
  await waitFor(() => {
    expect(buttonByLabel("Change icon")).toBeInTheDocument();
  });
  const chatThread = screen.getByRole("region", { name: "Chat thread" });
  const changeIcon = buttonByLabel("Change icon");

  click(changeIcon);
  const searchInput = await screen.findByLabelText("Search emoji");
  click(changeIcon);
  await waitFor(() => {
    expect(searchInput).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(chatThread).toHaveFocus();
  });
});

test.each([
  { from: "mobile", to: "desktop", desktop: false },
  { from: "desktop", to: "mobile", desktop: true },
])(
  "Keep one focused emoji picker when resizing from $from to $to",
  async ({ desktop }) => {
    const viewport = context.mocks.browser.matchMedia(desktop);
    const searchInput = await openEmojiPicker();

    // "eye" has 20 matches in the production emoji data. Search through the
    // page before remounting so this responsive contract does not repeatedly
    // build the unrelated full emoji grid.
    await fill(searchInput, "eye");
    await waitFor(() => {
      expect(queryAllByRoleFast("button", emojiFeed())).toHaveLength(20);
    });

    act(() => {
      viewport.setMatches(!desktop);
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(desktop ? "Open menu" : "Open browser"),
      ).toBeInTheDocument();
      const searchInputs = screen.getAllByLabelText("Search emoji");
      expect(searchInputs).toHaveLength(1);
      expect(searchInputs[0]).toHaveFocus();
      expect(searchInputs[0]).toHaveValue("eye");
      expect(queryAllByRoleFast("button", emojiFeed())).toHaveLength(20);
    });
    expect(screen.getAllByTestId("chat-thread-header-title")).toHaveLength(1);
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Emoji planning",
    );
  },
);

test("Choosing an emoji category exits search results", async () => {
  const user = userEvent.setup();
  const searchInput = await openEmojiPicker();
  await user.type(searchInput, "watermelon");
  await waitFor(() => {
    expect(searchInput).toHaveValue("watermelon");
    expect(emojiButton("watermelon")).toBeInTheDocument();
  });
  expect(screen.queryByText("Food & Drink")).toBeNull();

  click(categoryTab("Food & Drink"));

  await waitFor(() => {
    expect(searchInput).toHaveValue("");
    expect(screen.getByText("Food & Drink")).toBeInTheDocument();
    expect(categoryTab("Food & Drink")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

test("Choosing an emoji category updates the category rail", async () => {
  await openEmojiPicker();
  const feed = emojiFeed();
  setCategoryLayout(feed);
  Object.defineProperties(feed, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1200 },
    scrollTo: {
      configurable: true,
      value: ({ top }: ScrollToOptions) => {
        feed.scrollTop = top ?? 0;
      },
    },
  });

  click(categoryTab("Food & Drink"));
  await nextAnimationFrame();

  expect(categoryTab("Food & Drink")).toHaveAttribute("aria-selected", "true");
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "false",
  );
  expect(screen.getByText("Food & Drink")).toBeInTheDocument();
  expect(feed.scrollTop).toBeGreaterThan(0);
});

test("Emoji categories can be navigated with arrow keys", async () => {
  await openEmojiPicker();
  const categoryList = screen.getByRole("tablist", {
    name: "Emoji categories",
  });
  const frequent = categoryTab("Frequently used");
  const smileys = categoryTab("Smileys & Emotion");
  frequent.focus();

  fireEvent.keyDown(categoryList, { key: "ArrowRight" });

  await waitFor(() => {
    expect(smileys).toHaveAttribute("aria-selected", "true");
    expect(smileys).toHaveFocus();
  });
  expect(smileys).toHaveAttribute("tabindex", "0");
  expect(frequent).toHaveAttribute("tabindex", "-1");
  expect(
    queryAllByRoleFast("tab").filter((tab) => {
      return tab.getAttribute("tabindex") === "0";
    }),
  ).toHaveLength(1);
});

test("The emoji picker names the emoji under the pointer", async () => {
  await openEmojiPicker();
  expect(screen.getByText("Pick an emoji")).toBeInTheDocument();

  fireEvent.mouseOver(emojiButton("grinning face"));

  await waitFor(() => {
    expect(screen.getByText(":grinning_face:")).toBeInTheDocument();
  });

  fireEvent.mouseOver(emojiButton("watermelon"));

  await waitFor(() => {
    expect(screen.getByText(":watermelon:")).toBeInTheDocument();
  });
  expect(screen.queryByText(":grinning_face:")).toBeNull();
});

test("The emoji category rail resumes following manual scrolling", async () => {
  await openEmojiPicker();
  const feed = emojiFeed();
  setCategoryLayout(feed);
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "true",
  );

  click(categoryTab("Frequently used"));
  await nextAnimationFrame();
  feed.scrollTop = 100;
  fireEvent.scroll(feed);

  await waitFor(() => {
    expect(categoryTab("Smileys & Emotion")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  expect(categoryTab("Frequently used")).toHaveAttribute(
    "aria-selected",
    "false",
  );
});
