import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const RUN_ID = "d0000000-0000-4000-a000-000000000811";

function draft(index: number, status: "draft" | "sent" = "draft"): MailDraft {
  return {
    version: 3,
    provider: "gmail",
    from: "sender@example.com",
    to: [`recipient${index}@example.com`],
    cc: [],
    bcc: [],
    subject: `Proposal ${index}`,
    body: `Proposal details ${index}`,
    references: [],
    status,
    detailAvailable: true,
    accessStatus: "ready",
    gmailDraftId: `draft-${index}`,
    gmailThreadId: `thread-${index}`,
    gmailMessageId: `message-${index}`,
    attachments: [],
    createdAt: "2026-10-20T10:00:00.000Z",
    updatedAt: "2026-10-20T10:00:00.000Z",
  };
}

function id(index: number): string {
  return `e0000000-0000-4000-a000-${String(index).padStart(12, "0")}`;
}

function response(mailDraftId: string, mailDraft: MailDraft) {
  return {
    mailDraftId,
    mailDraftUrl: `https://app.okou.ai/mail/drafts/${mailDraftId}`,
    mailDraft,
  };
}

function installMails(count = 12, sendReady?: Promise<void>) {
  const mails = new Map(
    Array.from({ length: count }, (_, index) => {
      return [id(index + 1), draft(index + 1, index < 2 ? "draft" : "sent")];
    }),
  );
  const sent: string[] = [];
  const deleted: string[] = [];
  const reject = new Set<string>();
  context.mocks.api(mailContract.listThreadMail, ({ respond }) => {
    return respond(200, {
      mails: [...mails]
        .filter(([, mail]) => {
          return mail.status !== "deleted";
        })
        .map(([mailDraftId, mail]) => {
          return {
            mailDraftId,
            status:
              mail.status === "sent" ? ("sent" as const) : ("draft" as const),
            subject: mail.subject,
            from: mail.from,
            createdAt: mail.createdAt,
          };
        }),
    });
  });
  context.mocks.api(mailContract.getDraft, ({ respond, params }) => {
    const mail = mails.get(params.mailDraftId);
    if (!mail || mail.status === "deleted") {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    }
    return respond(200, response(params.mailDraftId, mail));
  });
  context.mocks.api(mailContract.sendDraft, async ({ respond, params }) => {
    await sendReady;
    const mail = mails.get(params.mailDraftId);
    if (!mail || mail.status !== "draft" || reject.has(params.mailDraftId)) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Unable to send this draft" },
      });
    }
    const updated = { ...mail, status: "sent" as const };
    mails.set(params.mailDraftId, updated);
    sent.push(params.mailDraftId);
    return respond(200, response(params.mailDraftId, updated));
  });
  context.mocks.api(mailContract.deleteDraft, ({ respond, params }) => {
    const mail = mails.get(params.mailDraftId);
    if (!mail || mail.status !== "draft") {
      return respond(409, {
        error: { code: "CONFLICT", message: "Only drafts can be deleted" },
      });
    }
    mails.set(params.mailDraftId, { ...mail, status: "deleted" });
    deleted.push(params.mailDraftId);
    return respond(204);
  });
  return { mails, sent, deleted, reject };
}

async function button(name: string, container: ParentNode = document.body) {
  return await waitFor(() => {
    const found = queryAllByRoleFast("button", container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        element.textContent?.trim() === name
      );
    });
    if (!found) {
      throw new Error(`Missing button: ${name}`);
    }
    return found;
  });
}

async function openChat(enabled = true, withCard = true) {
  context.mocks.data.agents([
    {
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: "Email review",
    },
  ]);
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "BROWSER_NOT_FOUND", message: "No managed browser" },
    });
  });
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Email review",
    selectedModel: "claude-sonnet-5",
    chatEvents: [
      {
        id: "mail-user-message",
        role: "user",
        content: "Prepare the proposals",
        runId: RUN_ID,
        seqId: 1,
        createdAt: "2026-10-20T10:00:00.000Z",
      },
      {
        id: "mail-assistant-message",
        role: "assistant",
        content: withCard
          ? `[Review proposal](https://app.okou.ai/mail/drafts/${id(1)})`
          : "Prepare the proposals",
        runId: RUN_ID,
        seqId: 2,
        createdAt: "2026-10-20T10:00:01.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ThreadEmailManager]: enabled },
  });
  await screen.findByRole("textbox", { name: "Message" });
}

async function openList() {
  await click(await button("Manage emails"));
  return await screen.findByRole("dialog", { name: "Emails" });
}

describe("thread email manager", () => {
  it("shows the entry only when enabled and the thread has emails", async () => {
    installMails();
    await openChat(false);
    await screen.findByText("Proposal 1");
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.getAttribute("aria-label") === "Manage emails";
      }),
    ).toBeFalsy();
  });

  it("hides the entry for an empty thread", async () => {
    installMails(0);
    await openChat(true, false);
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.getAttribute("aria-label") === "Manage emails";
      }),
    ).toBeFalsy();
  });

  it("navigates filters with arrow keys, selects with Enter or Space, and restores focus on Escape", async () => {
    installMails();
    await openChat();
    const entry = await button("Manage emails");
    const list = await openList();
    const user = userEvent.setup({ delay: null });
    await user.click(await button("All", list));
    await user.keyboard("{ArrowRight}");
    await expect(button("Drafts", list)).resolves.toHaveFocus();
    await expect(button("All", list)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{Enter}");
    await expect(button("Drafts", list)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.keyboard("{ArrowRight}");
    await expect(button("Sent", list)).resolves.toHaveFocus();
    await user.keyboard(" ");
    await expect(button("Sent", list)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await within(list).findByLabelText("Select email: Proposal 12");
    expect(
      within(list).queryByLabelText("Select email: Proposal 1"),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  it("selects every filtered email and shows draft actions only while drafts are selected", async () => {
    installMails();
    await openChat();
    const list = await openList();
    expect(within(list).queryByText("Send")).not.toBeInTheDocument();
    expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    expect(
      within(list).queryByText("Actions apply to selected drafts"),
    ).not.toBeInTheDocument();
    await click(within(list).getByLabelText("Select email: Proposal 1"));
    await within(list).findByText("Actions apply to selected drafts");
    expect(
      within(list).getByRole("checkbox", { name: "Select all" }),
    ).toHaveAttribute("aria-checked", "mixed");
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("12 selected");
    await expect(button("Send", list)).resolves.toBeEnabled();
    await expect(button("Delete", list)).resolves.toBeEnabled();
    expect(
      within(list).getByLabelText("Select email: Proposal 12"),
    ).toHaveAttribute("aria-checked", "true");
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("0 selected");
    await waitFor(() => {
      expect(within(list).queryByText("Send")).not.toBeInTheDocument();
      expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
      expect(
        within(list).queryByText("Actions apply to selected drafts"),
      ).not.toBeInTheDocument();
    });
    await click(await button("Sent", list));
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("10 selected");
    expect(within(list).queryByText("Send")).not.toBeInTheDocument();
    expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    expect(
      within(list).queryByText("Actions apply to selected drafts"),
    ).not.toBeInTheDocument();
  });

  it("preserves selection, search and scroll when returning from list details; chat details have no list navigation", async () => {
    installMails();
    const transitions = context.mocks.browser.viewTransition();
    await openChat();
    await click(await button("Open draft email: Proposal 1"));
    await screen.findByText("Proposal details 1");
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.textContent?.trim() === "Back to emails";
      }),
    ).toBeFalsy();
    await click(await button("Close email details"));
    const list = await openList();
    const search = within(list).getByLabelText("Search by subject or sender");
    fireEvent.change(search, { target: { value: "Proposal" } });
    await click(within(list).getByLabelText("Select email: Proposal 1"));
    await click(await button("Sent", list));
    const row = await button("Open email: Proposal 12", list);
    const scroller = row.parentElement?.parentElement;
    if (!scroller) {
      throw new Error("Missing email scroll viewport");
    }
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);
    await click(row);
    await screen.findByText("Proposal details 12");
    const back = await button("Back to emails");
    await waitFor(() => {
      expect(back).toBeEnabled();
    });
    click(back);
    const restored = await screen.findByRole("dialog", { name: "Emails" });
    expect(
      within(restored).getByLabelText("Search by subject or sender"),
    ).toHaveValue("Proposal");
    await expect(button("Sent", restored)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const restoredRow = await button("Open email: Proposal 12", restored);
    expect(restoredRow.parentElement?.parentElement?.scrollTop).toBe(180);
    await click(await button("All", restored));
    await expect(
      within(restored).findByLabelText("Select email: Proposal 1"),
    ).resolves.toHaveAttribute("aria-checked", "true");
    expect(transitions.startedTypes).toHaveLength(2);
  });

  it("opens details and returns to the list with reduced motion", async () => {
    installMails(2);
    const transitions = context.mocks.browser.viewTransition();
    context.mocks.browser.matchMedia((query) => {
      return (
        query.includes("min-width") ||
        query === "(prefers-reduced-motion: reduce)"
      );
    });
    await openChat();
    const list = await openList();
    await click(await button("Open email: Proposal 2", list));
    await screen.findByText("Proposal details 2");
    const back = await button("Back to emails");
    await waitFor(() => {
      expect(back).toBeEnabled();
    });
    click(back);
    await screen.findByRole("dialog", { name: "Emails" });
    expect(transitions.startedTypes).toHaveLength(0);
  });

  it("keeps pending sends confirmed, retains failures for retry, and never resends successes", async () => {
    const sending = context.mocks.deferred<void>();
    const fixture = installMails(12, sending.promise);
    fixture.reject.add(id(2));
    await openChat();
    const list = await openList();
    const selectAll = within(list).getByRole("checkbox", {
      name: "Select all",
    });
    click(selectAll);
    const bulkSend = await button("Send", list);
    click(bulkSend);
    const confirmation = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    const send = await button("Send", confirmation);
    click(send);
    await waitFor(() => {
      expect(send).toBeDisabled();
    });
    await expect(button("Cancel", confirmation)).resolves.toBeDisabled();
    expect(bulkSend).toBeDisabled();
    expect(selectAll).toHaveAttribute("aria-disabled", "true");
    expect(selectAll).toBeChecked();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Escape}");
    expect(confirmation).toBeInTheDocument();
    sending.resolve();
    await screen.findByText("1 completed · 1 failed");
    expect(fixture.sent).toStrictEqual([id(1)]);
    fixture.reject.delete(id(2));
    await click(await button("Send", list));
    const retry = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    await click(await button("Send", retry));
    await within(list).findByText("10 selected");
    expect(fixture.sent).toStrictEqual([id(1), id(2)]);
    await waitFor(() => {
      expect(within(list).queryByText("Send")).not.toBeInTheDocument();
    });
  });

  it("confirms bulk deletion of drafts and keeps all selected sent emails", async () => {
    const fixture = installMails();
    await openChat();
    const list = await openList();
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await click(await button("Delete", list));
    const confirmation = await screen.findByRole("dialog", {
      name: "Delete selected drafts?",
    });
    await click(await button("Cancel", confirmation));
    expect(fixture.deleted).toStrictEqual([]);
    await click(await button("Delete", list));
    const second = await screen.findByRole("dialog", {
      name: "Delete selected drafts?",
    });
    await click(await button("Delete", second));
    await within(list).findByText("10 selected");
    expect(fixture.deleted).toStrictEqual([id(1), id(2)]);
    expect(fixture.mails.get(id(12))?.status).toBe("sent");
    await waitFor(() => {
      expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    });
  });
});
