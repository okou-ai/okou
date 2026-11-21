import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { workflowAutomationsContract } from "@okouai/api-contracts/contracts/workflows";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { test, expect } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  findLink,
  findButton,
  queryButton,
  createChatRunFixtures,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";
const context = testContext(),
  nextTitle = "Customs worksheet",
  firstTitle = "Dispatch brief";
function mailbox(desktop = true, cached = true) {
  const id = crypto.randomUUID();
  context.mocks.browser.matchMedia((q) => {
    return desktop && q.startsWith("(min-width:");
  });
  const runId = crypto.randomUUID();
  const service = createChatRunFixtures(context).installRunChat({
    threadTitle: firstTitle,
    chatEvents: [
      {
        id: crypto.randomUUID(),
        runId,
        role: "assistant",
        seqId: 1,
        content:
          "[Continue to worksheet](https://app.okou.ai/chats/" + id + ")",
        createdAt: "2026-10-01T09:00:00Z",
      },
    ],
  });
  service.setThreadList(
    [
      { id: RUN_THREAD_ID, title: firstTitle },
      ...(cached ? [{ id, title: nextTitle }] : []),
    ].map((t) => {
      return {
        ...t,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-10-01T09:00:00Z",
        updatedAt: "2026-10-02T09:00:00Z",
      };
    }),
  );
  return id;
}
async function enter() {
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
}
async function choose(name: string, scope?: HTMLElement) {
  const trigger = scope
    ? queryButton("More actions", scope)
    : await findButton("More actions");
  click(trigger!);
  const menu = await screen.findByRole("menu");
  const item = queryAllByRoleFast("menuitem", menu).find((el) => {
    return el.textContent?.trim() === name;
  });
  expect(item).toBeDefined();
  click(item!);
}
function header(title: string) {
  return waitFor(() => {
    const el = screen
      .getAllByTestId("chat-thread-header-title")
      .find((n) => {
        return n.textContent === title;
      })
      ?.closest("header");
    expect(el).toBeVisible();
    return el!;
  });
}
test("chat-header-loading-002 empty mail and automation panels explain what will appear", async () => {
  mailbox();
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, { mails: [] });
  });
  context.mocks.api(
    workflowAutomationsContract.listForChatThread,
    ({ respond }) => {
      return respond(200, []);
    },
  );
  await enter();
  const origin = await header(firstTitle);
  await choose("Manage emails", origin);
  const mail = await screen.findByRole("dialog", { name: "Emails" });
  const view = within(mail);
  await expect(view.findByText("No emails yet")).resolves.toBeInTheDocument();
  expect(
    view.getByText(
      "Email drafts and sent emails from this chat will show up here.",
    ),
  ).toBeVisible();
  expect(view.queryByPlaceholderText("Search by subject or sender")).toBeNull();
  click(queryButton("Close emails", mail)!);
  await choose("Automations", origin);
  const panel = await screen.findByRole("complementary", {
    name: "Automations",
  });
  await expect(
    within(panel).findByText("No automations yet"),
  ).resolves.toBeInTheDocument();
  expect(
    within(panel).getByText(
      "Automations that run in this chat will show up here.",
    ),
  ).toBeVisible();
});
test("chat-header-loading-005 the previous header keeps all actions focusable while the next chat is pending", async () => {
  const next = mailbox(true, false),
    gate = context.mocks.deferred<void>();
  await enter();
  const old = await header(firstTitle);
  const opened = await findLink("Continue to worksheet");
  const details = {
    id: next,
    agentId: AGENT_ID,
    title: nextTitle,
    archived: false,
    muted: false,
    modelSettings: {},
    serviceTier: null,
    selectedModel: null,
    computerUseHostId: null,
    cloudBrowserEnabled: false,
    pinnedAt: null,
  };
  context.mocks.api(
    chatThreadMetadataContract.get,
    async ({ params, respond }) => {
      if (params.id !== next) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown chat" },
        });
      }
      await gate.promise;
      return respond(200, details);
    },
  );
  context.mocks.api(chatThreadsContract.events, async ({ respond }) => {
    await gate.promise;
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.snapshot, async ({ respond }) => {
    await gate.promise;
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: [
          {
            ...details,
            createdAt: "2026-10-02T09:00:00Z",
            updatedAt: "2026-10-02T09:00:00Z",
            sortAt: "2026-10-02T09:00:00Z",
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
  const actions = queryAllByRoleFast("button", old).filter((el) => {
    return el.hasAttribute("aria-busy");
  });
  expect(
    actions
      .map((el) => {
        return el.getAttribute("aria-label");
      })
      .sort(),
  ).toStrictEqual(["Artifacts and chats", "More actions", "Share messages"]);
  for (const action of actions) {
    expect(action).toHaveAttribute("aria-busy", "false");
  }
  click(opened);
  await waitFor(() => {
    expect(location.pathname).toBe("/chats/" + next);
    for (const action of actions) {
      expect(action).toHaveAttribute("aria-busy", "true");
      expect(action).toHaveAttribute("aria-disabled", "true");
      expect(action).not.toHaveAttribute("disabled");
      expect(action).toBeEnabled();
    }
    expect(within(old).getByText(firstTitle)).toBeVisible();
  });
  for (const action of actions) {
    action.focus();
    expect(action).toHaveFocus();
  }
  gate.resolve();
  await header(nextTitle);
});
test("chat-header-loading-007 the mobile destination opens its own cloud browser pane", async () => {
  const next = mailbox(false);
  const lookup = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ params, respond }) => {
    if (params.threadId === next) {
      await lookup.promise;
    }
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });
  await enter();
  const mobileLink = await findLink("Continue to worksheet");
  click(mobileLink);
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + next);
  });
  await choose("Open browser");
  const panel = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  lookup.resolve();
  await within(panel).findByText("Browser not live");
  const link = await waitFor(() => {
    const a = queryAllByRoleFast("link", panel).find((el) => {
      return (
        el.getAttribute("aria-label") === "Open this browser in a new page"
      );
    });
    expect(a).toHaveAttribute("href", "/browsers/" + next);
    return a!;
  });
  expect(link).toBeVisible();
});
test("chat-header-loading-008 each open chat pane opens the mail for its own thread", async () => {
  const next = mailbox();
  context.mocks.api(mailContract.listThreadMail, ({ params, respond }) => {
    return respond(200, {
      mails:
        params.threadId === next
          ? [
              {
                mailDraftId: crypto.randomUUID(),
                status: "sent",
                subject: "Customs declaration receipt",
                from: "broker@example.com",
                createdAt: "2026-10-01T09:00:00Z",
              },
            ]
          : [],
    });
  });
  await enter();
  const first = await header(firstTitle);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Alt>}");
  await user.click(await findLink(nextTitle));
  await user.keyboard("{/Alt}");
  const second = await header(nextTitle);
  expect(first).toBeVisible();
  expect(second).toBeVisible();
  await choose("Manage emails", first);
  const empty = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(empty).findByText("No emails yet"),
  ).resolves.toBeInTheDocument();
  click(queryButton("Close emails", empty)!);
  await choose("Manage emails", second);
  const inbox = await screen.findByRole("dialog", { name: "Emails" });
  await expect(
    within(inbox).findByText("Customs declaration receipt"),
  ).resolves.toBeInTheDocument();
});
