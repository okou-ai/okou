import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
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
  continuityThread(76, 3, "Latest header"),
] as const;
const [previous, destination, latest] = threads;

function pane(threadId: string) {
  const element = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${threadId}"]`,
  );
  if (!element) {
    throw new Error(`Missing chat pane ${threadId}`);
  }
  return element;
}

function entry(name: string, container: ParentNode = document.body) {
  return queryAllByRoleFast("button", container).find((button) => {
    return button.getAttribute("aria-label") === name;
  });
}

async function navigate(threadId: string, desktop = true) {
  if (!desktop) {
    click(fastButton("Open menu"));
    await screen.findByRole("dialog", { name: "Sidebar" });
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

async function setupHeaders({
  desktop = true,
  mailThreads = [previous.id],
  automationThreads = [previous.id],
  mailGates = new Map<string, Promise<void>>(),
  automationGates = new Map<string, Promise<void>>(),
  mailFailures = new Set<string>(),
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
  await setupPage({ context, path, ...workspace.pageOptions });
  await waitFor(() => {
    expect(fastButton("Share messages")).toBeEnabled();
  });
}

test.each([true, false])(
  "Keep the preceding mail layout until an unvisited destination settles (desktop=%s)",
  async (desktop) => {
    const mail = context.mocks.deferred<void>();
    const automations = context.mocks.deferred<void>();
    await setupHeaders({
      desktop,
      mailGates: new Map([[destination.id, mail.promise]]),
      automationGates: new Map([[destination.id, automations.promise]]),
    });
    expect(entry("Manage emails")).toBeInTheDocument();
    await navigate(destination.id, desktop);
    const retainedMail = fastButton("Manage emails");
    expect(retainedMail).toHaveAttribute("aria-busy", "true");
    expect(retainedMail).toHaveAttribute("aria-disabled", "true");
    click(retainedMail);
    retainedMail.focus();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Enter} ");
    expect(screen.queryByRole("dialog", { name: "Emails" })).toBeNull();
    await act(async () => {
      mail.resolve();
      await mail.promise;
    });
    expect(entry("Manage emails")).toBeInTheDocument();
    automations.resolve();
    await waitFor(() => {
      expect(entry("Manage emails")).toBeUndefined();
      expect(entry("Automations")).toBeUndefined();
    });
    expect(screen.queryByRole("dialog", { name: "Emails" })).toBeNull();
    expect(entry("Artifacts and chats")).toBeInTheDocument();
    await navigate(previous.id, desktop);
    await waitFor(() => {
      expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "false");
    });
  },
);

test("Keep preceding hidden entries until current mail is ready, then open the current list", async () => {
  const mail = context.mocks.deferred<void>();
  await setupHeaders({
    mailThreads: [destination.id],
    automationThreads: [],
    mailGates: new Map([[destination.id, mail.promise]]),
  });
  expect(entry("Manage emails")).toBeUndefined();
  await navigate(destination.id);
  expect(entry("Manage emails")).toBeUndefined();
  mail.resolve();
  await waitFor(() => {
    expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "false");
  });
  click(fastButton("Manage emails"));
  const list = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(list).findByText("Current header mail"),
  ).resolves.toBeInTheDocument();
});

test("Retain automation presence and suppress activation until both current sources settle", async () => {
  const mail = context.mocks.deferred<void>();
  const automations = context.mocks.deferred<void>();
  await setupHeaders({
    mailGates: new Map([[destination.id, mail.promise]]),
    automationGates: new Map([[destination.id, automations.promise]]),
  });
  expect(fastButton("Automations")).toBeEnabled();
  await navigate(destination.id);
  expect(fastButton("Automations")).toBeDisabled();
  click(fastButton("Automations"));
  expect(screen.queryByTestId("automation-sidebar")).toBeNull();
  await act(async () => {
    automations.resolve();
    await automations.promise;
  });
  expect(fastButton("Automations")).toBeDisabled();
  expect(entry("Manage emails")).toBeInTheDocument();
  mail.resolve();
  await waitFor(() => {
    expect(entry("Automations")).toBeUndefined();
    expect(entry("Manage emails")).toBeUndefined();
  });
  expect(screen.queryByTestId("automation-sidebar")).toBeNull();
});

test("End pending state after a failed destination request and keep its mail error accessible", async () => {
  const mail = context.mocks.deferred<void>();
  await setupHeaders({
    mailGates: new Map([[destination.id, mail.promise]]),
    mailFailures: new Set([destination.id]),
  });
  await navigate(destination.id);
  expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "true");
  mail.resolve();
  await waitFor(() => {
    expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "false");
  });
  click(fastButton("Manage emails"));
  const list = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(list).findByText("Unable to load emails"),
  ).resolves.toBeInTheDocument();
});

test("Ignore the destination's late result after navigating to another chat", async () => {
  const mail = context.mocks.deferred<void>();
  await setupHeaders({
    mailThreads: [previous.id, latest.id],
    mailGates: new Map([[destination.id, mail.promise]]),
  });
  await navigate(destination.id);
  expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "true");
  await navigate(latest.id);
  await waitFor(() => {
    expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "false");
  });
  await act(async () => {
    mail.resolve();
    await mail.promise;
  });
  expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "false");
  expect(pane(latest.id)).toBeInTheDocument();
  expect(entry("Automations")).toBeUndefined();
});

test.each([true, false])(
  "Release the preceding workspace's header while an organization changes (desktop=%s)",
  async (desktop) => {
    const mail = context.mocks.deferred<void>();
    await setupHeaders({
      desktop,
      mailGates: new Map([[destination.id, mail.promise]]),
    });
    await navigate(destination.id, desktop);
    expect(fastButton("Manage emails")).toHaveAttribute("aria-busy", "true");
    act(() => {
      context.mocks.clerk().organization({
        activeOrg: { id: "org_header_changed", name: "Changed workspace" },
      });
      context.mocks.clerk().stateChanged();
    });
    await waitFor(() => {
      expect(entry("Manage emails")).toBeUndefined();
    });
    expect(pane(destination.id)).toBeInTheDocument();
    mail.resolve();
    await waitFor(() => {
      expect(fastButton("Share messages")).toBeEnabled();
    });
  },
);

test("Let the primary header settle independently of a pending secondary pane", async () => {
  const mail = context.mocks.deferred<void>();
  await setupHeaders({
    mailThreads: [previous.id, destination.id],
    automationThreads: [],
    mailGates: new Map([[destination.id, mail.promise]]),
    path: `/chats/${previous.id}?sidebar=${destination.id}`,
  });
  expect(fastButton("Manage emails", pane(previous.id))).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(entry("Manage emails", pane(destination.id))).toBeUndefined();
  mail.resolve();
  await waitFor(() => {
    expect(fastButton("Manage emails", pane(destination.id))).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
  expect(fastButton("Manage emails", pane(previous.id))).toHaveAttribute(
    "aria-busy",
    "false",
  );
});
