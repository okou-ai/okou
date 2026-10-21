import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
} from "./chat-capability-test-helpers.ts";

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

function installMails(count = 12) {
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
  context.mocks.api(mailContract.sendDraft, ({ respond, params }) => {
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
  installCapabilityChat({
    events: completedConversation(
      withCard
        ? `[Review proposal](https://app.okou.ai/mail/drafts/${id(1)})`
        : "Prepare the proposals",
    ),
  });
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ThreadEmailManager]: enabled },
  });
  await readyChat();
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

  it("selects every filtered email including sent mail and disables draft actions for sent-only selection", async () => {
    installMails();
    await openChat();
    const list = await openList();
    await click(within(list).getByLabelText("Select email: Proposal 1"));
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
    await click(await button("Sent", list));
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("10 selected");
    await expect(button("Send", list)).resolves.toBeDisabled();
    await expect(button("Delete", list)).resolves.toBeDisabled();
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
    await click(await button("Back to emails"));
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
    await click(await button("Back to emails"));
    await screen.findByRole("dialog", { name: "Emails" });
    expect(transitions.startedTypes).toHaveLength(0);
  });

  it("sends only drafts, retains failures for retry, and never resends successes", async () => {
    const fixture = installMails();
    fixture.reject.add(id(2));
    await openChat();
    const list = await openList();
    await click(within(list).getByRole("checkbox", { name: "Select all" }));
    await click(await button("Send", list));
    const confirmation = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    await click(await button("Send", confirmation));
    await screen.findByText("1 completed · 1 failed");
    expect(fixture.sent).toStrictEqual([id(1)]);
    fixture.reject.delete(id(2));
    await click(await button("Send", list));
    const retry = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    await click(await button("Send", retry));
    await screen.findByText("1 completed · 0 failed");
    expect(fixture.sent).toStrictEqual([id(1), id(2)]);
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
    await screen.findByText("2 completed · 0 failed");
    expect(fixture.deleted).toStrictEqual([id(1), id(2)]);
    expect(fixture.mails.get(id(12))?.status).toBe("sent");
    await expect(button("Delete", list)).resolves.toBeDisabled();
  });
});
