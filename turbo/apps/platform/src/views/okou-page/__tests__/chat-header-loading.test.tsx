import { selectDesktopHeaderAction } from "./chat-header-test-helpers.ts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { chatThreadMetadataContract } from "@okouai/api-contracts/contracts/chat-threads";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

const context = testContext();
const threads = [
  continuityThread(76, 1, "Previous header"),
  continuityThread(76, 2, "Destination header"),
] as const;
const [previous, destination] = threads;

function pane(threadId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!element) {
    throw new Error(`Missing chat pane ${threadId}`);
  }
  return element;
}

function menuItem(name: string, container: ParentNode) {
  const item = queryAllByRoleFast("menuitem", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Missing menu item ${name}`);
  }
  return item;
}

async function navigate(threadId: string, desktop = true) {
  if (!desktop) {
    click(screen.getByLabelText("Back to chats"));
  }
  const link = await waitFor(() => {
    const found = document.querySelector<HTMLAnchorElement>(
      `a[data-sidebar-chat-thread-id="${threadId}"]`,
    );
    if (!found) {
      throw new Error(`Missing chat navigation ${threadId}`);
    }
    return found;
  });
  click(link);
  await waitFor(() => {
    expect(pane(threadId)).toBeInTheDocument();
  });
}

async function closeMailList(list: HTMLElement) {
  click(fastButton("Close emails", list));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Emails" })).toBeNull();
  });
}

async function openAutomations(desktop: boolean, container: ParentNode) {
  if (desktop) {
    await selectDesktopHeaderAction("Automations", container);
  } else {
    click(fastButton("More actions"));
    click(menuItem("Automations", await screen.findByRole("menu")));
  }
  return await screen.findByRole("complementary", { name: "Automations" });
}

async function setupHeaders({
  desktop = true,
  mailThreads = [previous.id],
  automationThreads = [previous.id],
  mailGates = new Map<string, Promise<void>>(),
  automationGates = new Map<string, Promise<void>>(),
  mailFailures = new Set<string>(),
  automationFailures = new Set<string>(),
  path = `/chats/${previous.id}`,
} = {}) {
  context.mocks.browser.matchMedia(desktop);
  const workspace = installContinuityWorkspace(context, {
    caseId: 76,
    threads,
    chatEventRows: [],
  });
  context.mocks.api(
    mailContract.listThreadMail,
    async ({ params, respond }) => {
      await mailGates.get(params.threadId);
      if (mailFailures.has(params.threadId)) {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Header mail request failed" },
        });
      }
      return respond(200, {
        mails: mailThreads.includes(params.threadId)
          ? [
              {
                mailDraftId: "e0000000-0000-4000-a000-000000000976",
                status: "draft",
                subject: "Current header mail",
                from: "sender@example.com",
                createdAt: "2026-10-20T10:00:00.000Z",
              },
            ]
          : [],
      });
    },
  );
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    async ({ params, respond }) => {
      await automationGates.get(params.threadId);
      if (automationFailures.has(params.threadId)) {
        return respond(403, {
          error: {
            code: "FORBIDDEN",
            message: "Header automation request failed",
          },
        });
      }
      return respond(
        200,
        automationThreads.includes(params.threadId)
          ? [
              {
                id: "a0000000-0000-4000-a000-000000000976",
                ownerUserId: "header-owner",
                enabled: true,
                chatThreadId: params.threadId,
                nextRunAt: null,
                lastRunAt: null,
                official: null,
                kind: "schedule",
                schedule: { type: "loop", intervalSeconds: 7200 },
                scheduleSummary: "Every two hours",
                workflow: {
                  id: "a0000000-0000-4000-a000-000000000977",
                  agentId: previous.agentId,
                  name: "header-schedule",
                  displayName: "Header schedule",
                  description: null,
                },
              },
            ]
          : [],
      );
    },
  );
  await setupPage({
    context,
    path,
    ...workspace.pageOptions,
  });
  await waitFor(() => {
    expect(fastButton("Share messages")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });
}

test("Keep every desktop header action for a chat without mail or automations", async () => {
  await setupHeaders({ mailThreads: [], automationThreads: [] });
  const group = fastButton("Share messages", pane(previous.id)).parentElement;
  if (!group) {
    throw new Error("Header action group is missing");
  }
  expect(
    queryAllByRoleFast("button", group).map((button) => {
      return button.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Share messages", "Artifacts and chats", "More actions"]);
});

test.each([true, false])(
  "Open mail and automation empty states in a chat with neither (desktop=%s)",
  async (desktop) => {
    await setupHeaders({ desktop, mailThreads: [], automationThreads: [] });
    const header = desktop ? pane(previous.id) : document;

    if (desktop) {
      await selectDesktopHeaderAction("Manage emails", header);
    } else {
      click(fastButton("Manage emails", header));
    }
    const list = await screen.findByRole("dialog", { name: "Emails" });
    await expect(
      within(list).findByText("No emails yet"),
    ).resolves.toBeInTheDocument();
    expect(
      within(list).getByText(
        "Email drafts and sent emails from this chat will show up here.",
      ),
    ).toBeInTheDocument();
    expect(
      within(list).queryByRole("textbox", {
        name: "Search by subject or sender",
      }),
    ).toBeNull();
    await closeMailList(list);

    const sidebar = await openAutomations(desktop, header);
    await expect(
      within(sidebar).findByText("No automations yet"),
    ).resolves.toBeInTheDocument();
    expect(
      within(sidebar).getByText(
        "Automations that run in this chat will show up here.",
      ),
    ).toBeInTheDocument();
  },
);

test("Open the destination's loading lists as soon as its pane replaces the previous chat", async () => {
  const mail = context.mocks.deferred<void>();
  const automations = context.mocks.deferred<void>();
  await setupHeaders({
    mailThreads: [destination.id],
    automationThreads: [destination.id],
    mailGates: new Map([[destination.id, mail.promise]]),
    automationGates: new Map([[destination.id, automations.promise]]),
  });
  await navigate(destination.id);
  const header = pane(destination.id);
  await selectDesktopHeaderAction("Manage emails", header);
  const list = await screen.findByRole("dialog", { name: "Emails" });
  await within(list).findByRole("status", { name: "Loading emails" });
  // The first load shows placeholders, not search, filters or a count.
  const heading = within(list).getByRole("heading", { name: "Emails" });
  expect(heading).toHaveTextContent(/^Emails$/);
  expect(
    within(list).queryByPlaceholderText("Search by subject or sender"),
  ).toBeNull();
  mail.resolve();
  await expect(
    within(list).findByText("Current header mail"),
  ).resolves.toBeInTheDocument();
  expect(heading).toHaveTextContent(/^Emails1$/);
  expect(
    within(list).getByPlaceholderText("Search by subject or sender"),
  ).toBeInTheDocument();
  await closeMailList(list);

  const sidebar = await openAutomations(true, header);
  automations.resolve();
  await expect(
    within(sidebar).findByText("Header schedule"),
  ).resolves.toBeInTheDocument();
});

test("Mark every header button as settling while the previous chat is still on screen", async () => {
  const serviceWorker = context.mocks.browser.serviceWorker();
  await setupHeaders();
  const names = ["Share messages", "Artifacts and chats", "More actions"];
  for (const name of names) {
    expect(fastButton(name, pane(previous.id))).toHaveAttribute(
      "aria-busy",
      "false",
    );
  }
  // A chat outside the list resolves its details first, so the previous
  // chat's header briefly stays on screen while the route asks for another.
  const pending = continuityThread(76, 3, "Pending header");
  const detailsRequested = context.mocks.deferred<void>();
  const details = context.mocks.deferred<void>();
  context.mocks.api(chatThreadMetadataContract.get, async ({ respond }) => {
    detailsRequested.resolve();
    await details.promise;
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });
  serviceWorker.dispatchMessage({
    type: "NOTIFICATION_CLICK",
    url: `/chats/${pending.id}`,
  });
  await detailsRequested.promise;
  // Settling buttons stay focusable (aria-disabled, not disabled) and busy;
  // Base UI's disabled Button takes no presses.
  await waitFor(() => {
    for (const name of names) {
      const button = fastButton(name, pane(previous.id));
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(button).not.toHaveAttribute("disabled");
    }
  });
  details.resolve();
});

test("Show failed first mail and automation reads instead of empty states", async () => {
  await setupHeaders({
    mailFailures: new Set([previous.id]),
    automationFailures: new Set([previous.id]),
  });
  const header = pane(previous.id);

  await selectDesktopHeaderAction("Manage emails", header);
  const list = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(list).findByText("Unable to load emails"),
  ).resolves.toBeInTheDocument();
  expect(within(list).queryByText("No emails yet")).toBeNull();
  await closeMailList(list);

  const sidebar = await openAutomations(true, header);
  await expect(
    within(sidebar).findByText("Could not load automations"),
  ).resolves.toBeInTheDocument();
  expect(within(sidebar).queryByText("No automations yet")).toBeNull();
});

test("Open the destination's browser from the mobile menu after navigating", async () => {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  await setupHeaders({ desktop: false });
  await navigate(destination.id, false);
  click(fastButton("More actions"));
  const browserItem = menuItem("Open browser", await screen.findByRole("menu"));
  expect(browserItem).not.toHaveAttribute("aria-disabled", "true");
  click(browserItem);
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  const pageLink = queryAllByRoleFast("link", sidebar).find((link) => {
    return (
      link.getAttribute("aria-label") === "Open this browser in a new page"
    );
  });
  expect(pageLink).toHaveAttribute("href", `/browsers/${destination.id}`);
});

test("Let each pane open its own chat's mail", async () => {
  await setupHeaders({
    mailThreads: [destination.id],
    automationThreads: [],
    path: `/chats/${previous.id}?sidebar=${destination.id}`,
  });
  await waitFor(() => {
    expect(fastButton("Share messages", pane(destination.id))).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  await selectDesktopHeaderAction("Manage emails", pane(previous.id));
  const primaryList = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(primaryList).findByText("No emails yet"),
  ).resolves.toBeInTheDocument();
  await closeMailList(primaryList);

  await selectDesktopHeaderAction("Manage emails", pane(destination.id));
  const secondaryList = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(secondaryList).findByText("Current header mail"),
  ).resolves.toBeInTheDocument();
});
