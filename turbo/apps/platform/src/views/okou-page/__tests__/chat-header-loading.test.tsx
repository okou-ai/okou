import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, startPage, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";
import {
  completedConversation,
  createChatCapabilityHelpers,
  findButton,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

import {
  findNamedLink,
  findNamedMenuItem,
  getNamedButton,
  getNamedLink,
} from "./chat-attachment-test-helpers.ts";

import { cachedChatListEvents } from "./chat-list-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

test("Open empty email and automation lists in a desktop chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  installCapabilityChat({ events: completedConversation("Ready to help.") });
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, { mails: [] });
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const more = await findButton("More actions");
  await waitFor(() => {
    expect(more).not.toHaveAttribute("aria-disabled", "true");
  });

  click(more);
  click(await findNamedMenuItem("Manage emails"));
  const emailDialog = await screen.findByRole("dialog", { name: "Emails" });
  const emails = within(emailDialog);
  await expect(emails.findByText("No emails yet")).resolves.toBeInTheDocument();
  expect(
    emails.getByText(
      "Email drafts and sent emails from this chat will show up here.",
    ),
  ).toBeInTheDocument();
  expect(
    emails.queryByLabelText("Search by subject or sender"),
  ).not.toBeInTheDocument();
  click(getNamedButton("Close emails", emailDialog));
  await waitFor(() => {
    expect(more).toHaveFocus();
  });

  click(more);
  click(await findNamedMenuItem("Automations"));
  const automations = within(
    await screen.findByRole("complementary", { name: "Automations" }),
  );
  await expect(
    automations.findByText("No automations yet"),
  ).resolves.toBeInTheDocument();
  expect(
    automations.getByText(
      "Automations that run in this chat will show up here.",
    ),
  ).toBeInTheDocument();
});

test("Open the destination's browser from the mobile menu after navigating", async () => {
  const previous = continuityThread(74, 1, "Previous chat");
  const destination = continuityThread(74, 2, "Destination chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 74,
    threads: [previous, destination],
  });
  let destinationLookups = 0;
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    if (params.threadId === destination.id) {
      destinationLookups += 1;
    }
    return respond(404, {
      error: { code: "BROWSER_NOT_FOUND", message: "Browser not found" },
    });
  });
  context.mocks.browser.matchMedia(false);
  await setupPage({
    context,
    path: `/chats/${previous.id}`,
    ...workspace.pageOptions,
  });
  click(await findNamedLink("Back to chats"));
  click(await findNamedLink("Destination chat"));
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${destination.id}`);
  });

  const more = await findButton("More actions");
  await waitFor(() => {
    expect(more).not.toHaveAttribute("aria-disabled", "true");
  });
  click(more);
  click(await findNamedMenuItem("Open browser"));

  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  const pane = within(sidebar);
  await expect(
    pane.findByText("Browser not live"),
  ).resolves.toBeInTheDocument();
  expect(
    getNamedLink("Open this browser in a new page", sidebar),
  ).toHaveAttribute("href", `/browsers/${destination.id}`);
  expect(destinationLookups).toBeGreaterThan(0);
});

test("Let each pane open its own chat's mail", async () => {
  const previous = continuityThread(75, 1, "Previous chat");
  const destination = continuityThread(75, 2, "Destination chat");
  const workspace = installContinuityWorkspace(context, {
    caseId: 75,
    threads: [previous, destination],
  });
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
  context.mocks.api(mailContract.listThreadMail, ({ params, respond }) => {
    return respond(200, {
      mails:
        params.threadId === destination.id
          ? [
              {
                mailDraftId: "a0000000-0000-4000-a000-000000000619",
                status: "draft",
                subject: "Destination status meeting",
                from: "sender@example.com",
                createdAt: "2026-08-01T10:00:00.000Z",
              },
            ]
          : [],
    });
  });
  await setupPage({
    context,
    path: `/chats/${previous.id}`,
    ...workspace.pageOptions,
  });
  const link = await waitFor(() => {
    return continuitySidebarLink(destination.id);
  });
  fireEvent.click(link, { altKey: true });
  const chat = (id: string) => {
    const container = document.querySelector<HTMLElement>(
      `section[data-chat-thread-container-id="${id}"]`,
    );
    if (!container) {
      throw new Error(`Expected a chat pane for ${id}`);
    }
    return container;
  };
  const openMail = async (id: string) => {
    const more = await waitFor(() => {
      const button = getNamedButton("More actions", chat(id));
      expect(button).not.toHaveAttribute("aria-disabled", "true");
      return button;
    });
    click(more);
    click(await findNamedMenuItem("Manage emails"));
    return await screen.findByRole("dialog", { name: "Emails" });
  };

  const previousMail = await openMail(previous.id);
  await expect(
    within(previousMail).findByText("No emails yet"),
  ).resolves.toBeInTheDocument();
  click(getNamedButton("Close emails", previousMail));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Emails" }),
    ).not.toBeInTheDocument();
  });
  const destinationMail = await openMail(destination.id);
  await expect(
    within(destinationMail).findByText("Destination status meeting"),
  ).resolves.toBeInTheDocument();
});

test("Keep header actions focusable and busy while the next chat loads", async () => {
  const previous = continuityThread(76, 1, "Previous chat");
  const destination = continuityThread(76, 2, "Destination chat");
  const metadataStarted = context.mocks.deferred<void>();
  const releaseMetadata = context.mocks.deferred<void>();
  const releaseDirectory = context.mocks.deferred<void>();
  const workspace = installContinuityWorkspace(context, {
    caseId: 76,
    threads: [previous, destination],
    chatListRemoteGate: releaseDirectory.promise,
    async beforeMetadataResponse(id) {
      if (id === destination.id) {
        metadataStarted.resolve();
        await releaseMetadata.promise;
      }
    },
  });
  context.mocks.browser.matchMedia((query) => {
    return query === SIDEBAR_DESKTOP_MEDIA_QUERY;
  });
  const page = await startPage({
    context,
    path: `/chats/${previous.id}`,
    ...workspace.pageOptions,
    cachedChatThreadEvents: cachedChatListEvents(76, [previous]),
  });
  await page.content;
  const actions = await Promise.all(
    ["Share messages", "Artifacts and chats", "More actions"].map((name) => {
      return findButton(name);
    }),
  );
  for (const action of actions) {
    expect(action).toHaveAttribute("aria-busy", "false");
    expect(action).not.toHaveAttribute("aria-disabled", "true");
  }

  window.history.pushState({}, "", `/chats/${destination.id}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await metadataStarted.promise;

  await waitFor(() => {
    for (const action of actions) {
      expect(action).toBeInTheDocument();
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(action).toHaveAttribute("aria-disabled", "true");
      expect(action).not.toHaveAttribute("disabled");
    }
  });
  expect(
    document.querySelector(
      `section[data-chat-thread-container-id="${previous.id}"]`,
    ),
  ).toBeInTheDocument();
  for (const action of actions) {
    action.focus();
    expect(action).toHaveFocus();
  }
  releaseMetadata.resolve();
  releaseDirectory.resolve();
  await page.ready;
  await waitFor(() => {
    expect(
      document.querySelector(
        `section[data-chat-thread-container-id="${destination.id}"]`,
      ),
    ).toBeInTheDocument();
  });
});
