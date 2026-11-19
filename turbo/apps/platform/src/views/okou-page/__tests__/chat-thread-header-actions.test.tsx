import { mailContract } from "@okouai/api-contracts/contracts/mail";
import {
  chatThreadArchiveContract,
  chatThreadMuteContract,
  chatThreadPinContract,
  chatThreadUnpinContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import { AGENT_ID, setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  promptEvent,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const { installRunChat } = createChatRunFixtures(context);

const RUN_ID = "a0000000-0000-4000-a000-000000000631";
const THREAD_TEXT = "Weekly metrics are ready for review";

type Viewport = "mobile" | "desktop";

function useViewport(viewport: Viewport) {
  return context.mocks.browser.matchMedia((query) => {
    return viewport === "desktop" && query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
}

async function openThread(): Promise<ReturnType<typeof installRunChat>> {
  const control = installRunChat({
    chatEvents: [
      promptEvent({
        id: "metrics-request",
        runId: RUN_ID,
        seqId: 1,
        text: "Prepare the weekly metrics",
      }),
      assistantEvent({
        id: "metrics-reply",
        runId: RUN_ID,
        seqId: 2,
        text: THREAD_TEXT,
      }),
      completedEvent({ id: "metrics-complete", runId: RUN_ID, seqId: 3 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await screen.findByText(THREAD_TEXT);
  return control;
}

function headerButton(name: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!button) {
    throw new Error(`Missing header button ${name}`);
  }
  return button;
}

async function openMoreActions(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(headerButton("More actions")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  click(headerButton("More actions"));
  return screen.findByRole("menu");
}

function menuItemNames(menu: HTMLElement): string[] {
  return queryAllByRoleFast("menuitem", menu).map((item) => {
    return item.textContent?.replace(/\s+/gu, " ").trim() ?? "";
  });
}

function menuItem(menu: HTMLElement, name: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === name;
  });
  if (!item) {
    throw new Error(`Missing menu item ${name}`);
  }
  return item;
}

async function chooseMenuItem(name: string): Promise<void> {
  const menu = await openMoreActions();
  click(menuItem(menu, name));
}

function mockArchive(
  respond: "succeed" | { status: 500; message: string },
): string[] {
  const requests: string[] = [];
  context.mocks.api(
    chatThreadArchiveContract.archive,
    ({ params, respond: reply }) => {
      requests.push(`archive:${params.id}`);
      return respond === "succeed"
        ? reply(204)
        : reply(respond.status, {
            error: { code: "INTERNAL_SERVER_ERROR", message: respond.message },
          });
    },
  );
  context.mocks.api(
    chatThreadArchiveContract.unarchive,
    ({ params, respond: reply }) => {
      requests.push(`unarchive:${params.id}`);
      return reply(204);
    },
  );
  return requests;
}

test("Undo a header archive from its toast and return to the thread", async () => {
  useViewport("mobile");
  const requests = mockArchive("succeed");
  await openThread();

  await chooseMenuItem("Archive chat");

  await waitFor(() => {
    expect(location.pathname).toBe(`/agents/${AGENT_ID}/chat`);
  });
  const toast = await screen.findByText("Chat archived.");
  const undo = queryAllByRoleFast(
    "button",
    toast.closest("[data-sonner-toast]") ?? document.body,
  ).find((button) => {
    return button.textContent?.trim() === "Undo";
  });
  if (!undo) {
    throw new Error("Archive toast has no Undo action");
  }
  click(undo);

  await waitFor(() => {
    expect(location.pathname).toBe(RUN_PATH);
  });
  await expect(screen.findByText(THREAD_TEXT)).resolves.toBeVisible();
  expect(requests).toStrictEqual([
    `archive:${RUN_THREAD_ID}`,
    `unarchive:${RUN_THREAD_ID}`,
  ]);
  const menu = await openMoreActions();
  expect(menuItem(menu, "Archive chat")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Show the archive API error after leaving the thread", async () => {
  useViewport("mobile");
  mockArchive({ status: 500, message: "Archive is temporarily unavailable" });
  await openThread();

  await chooseMenuItem("Archive chat");

  await waitFor(() => {
    expect(location.pathname).toBe(`/agents/${AGENT_ID}/chat`);
  });
  await expect(
    screen.findByText("Archive is temporarily unavailable"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText(THREAD_TEXT)).not.toBeInTheDocument();
});

test("Mute from the mobile header and unmute from the desktop header", async () => {
  const viewport = useViewport("mobile");
  const requests: string[] = [];
  context.mocks.api(chatThreadMuteContract.mute, ({ params, respond }) => {
    requests.push(`mute:${params.id}`);
    return respond(204);
  });
  context.mocks.api(chatThreadMuteContract.unmute, ({ params, respond }) => {
    requests.push(`unmute:${params.id}`);
    return respond(204);
  });
  await openThread();

  await chooseMenuItem("Mute chat");

  await expect(
    screen.findByText(
      "Chat muted. New replies won't show as unread or send push notifications.",
    ),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe(RUN_PATH);
  expect(screen.getByText(THREAD_TEXT)).toBeVisible();
  const menu = await openMoreActions();
  expect(menuItem(menu, "Unmute chat")).toBeInTheDocument();
  click(headerButton("More actions"));
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  viewport.setMatches((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const unmute = await waitFor(() => {
    return headerButton("Unmute chat");
  });
  click(unmute);

  await expect(screen.findByText("Chat unmuted")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.getAttribute("aria-label") === "Unmute chat";
      }),
    ).toBeFalsy();
  });
  expect(requests).toStrictEqual([
    `mute:${RUN_THREAD_ID}`,
    `unmute:${RUN_THREAD_ID}`,
  ]);
});

test("Keep Share and More in the header and match the sidebar menu order", async () => {
  useViewport("mobile");
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, {
      mails: [
        {
          mailDraftId: "e0000000-0000-4000-a000-000000000631",
          status: "draft",
          subject: "Weekly metrics",
          from: "metrics@example.com",
          createdAt: "2026-08-01T10:00:00.000Z",
        },
      ],
    });
  });
  await openThread();

  await waitFor(() => {
    expect(headerButton("More actions")).toBeInTheDocument();
  });
  const header = headerButton("More actions").parentElement;
  if (!header) {
    throw new Error("Header actions are not rendered");
  }
  expect(
    queryAllByRoleFast("button", header).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual([
    "Share messages",
    "Manage emails",
    "Artifacts and chats",
    "More actions",
  ]);
  expect(
    queryAllByRoleFast("link").some((link) => {
      return link.getAttribute("aria-label") === "Back to chats";
    }),
  ).toBeTruthy();

  const menu = await openMoreActions();
  expect(menuItemNames(menu)).toStrictEqual([
    "Pin chat",
    "Rename chat",
    "Mute chat",
    "Archive chat",
    "Automations",
    "Open browser",
  ]);
  click(menuItem(menu, "Rename chat"));
  const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
  expect(within(dialog).getByRole("textbox")).toHaveValue("Run conversation");
});

test("Keep primary icon actions accessible and open emails from the desktop menu", async () => {
  useViewport("desktop");
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, { mails: [] });
  });
  await openThread();

  for (const name of [
    "Share messages",
    "Artifacts and chats",
    "More actions",
  ]) {
    expect(headerButton(name)).toHaveAccessibleName(name);
  }
  const menu = await openMoreActions();
  expect(menuItemNames(menu)).toStrictEqual([
    "Automations",
    "Manage emails",
    "Open browser",
  ]);
  click(menuItem(menu, "Manage emails"));
  const emails = await screen.findByRole("dialog", { name: "Emails" });
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  await within(emails).findByText("No emails yet");
  const closeEmails = queryAllByRoleFast("button", emails).find((button) => {
    return button.getAttribute("aria-label") === "Close emails";
  });
  if (!closeEmails) {
    throw new Error("Email list has no close control");
  }
  click(closeEmails);
  await waitFor(() => {
    expect(headerButton("More actions")).toHaveFocus();
  });

  const reopened = await openMoreActions();
  click(menuItem(reopened, "Automations"));
  await expect(
    screen.findByRole("complementary", { name: "Automations" }),
  ).resolves.toBeInTheDocument();
});

test("Keep menu pin changes responsive across resize and save", async () => {
  const viewport = useViewport("desktop");
  const pinReleased = context.mocks.deferred<void>();
  const requests: string[] = [];
  context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
    requests.push("pin");
    await pinReleased.promise;
    return respond(204);
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
    requests.push("unpin");
    return respond(204);
  });
  const control = await openThread();

  viewport.setMatches(false);
  await chooseMenuItem("Pin chat");
  await waitFor(() => {
    expect(requests).toStrictEqual(["pin"]);
  });
  viewport.setMatches((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  await waitFor(() => {
    expect(headerButton("Share messages")).toBeInTheDocument();
  });
  viewport.setMatches(false);
  const pending = await openMoreActions();
  expect(menuItem(pending, "Unpin chat")).toBeInTheDocument();
  click(menuItem(pending, "Unpin chat"));

  pinReleased.resolve();
  await waitFor(() => {
    expect(requests).toStrictEqual(["pin", "unpin"]);
  });
  control.setThreadList([
    {
      id: RUN_THREAD_ID,
      title: "Metrics review",
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:05:00Z",
      pinnedAt: null,
    },
  ]);
  changeChatThreadList();
  await waitFor(() => {
    expect(screen.getByTestId("chat-thread-header-title")).toHaveTextContent(
      "Metrics review",
    );
  });
  const settled = await openMoreActions();
  expect(menuItem(settled, "Pin chat")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Continue saving the next pin change after an earlier request fails", async () => {
  useViewport("mobile");
  const pinReleased = context.mocks.deferred<void>();
  const requests: string[] = [];
  context.mocks.api(chatThreadPinContract.pin, async ({ respond }) => {
    requests.push("pin");
    await pinReleased.promise;
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Pinning failed" },
    });
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ respond }) => {
    requests.push("unpin");
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Unpinning failed" },
    });
  });
  await openThread();

  await chooseMenuItem("Pin chat");
  await waitFor(() => {
    expect(requests).toStrictEqual(["pin"]);
  });
  await chooseMenuItem("Unpin chat");
  pinReleased.resolve();

  await expect(
    screen.findByText("Pinning failed"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText("Unpinning failed"),
  ).resolves.toBeInTheDocument();
  expect(requests).toStrictEqual(["pin", "unpin"]);
  const menu = await openMoreActions();
  expect(menuItem(menu, "Pin chat")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
