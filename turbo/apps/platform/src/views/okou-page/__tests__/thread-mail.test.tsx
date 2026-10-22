import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  mailContract,
  type MailDraft,
} from "@okouai/api-contracts/contracts/mail";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const RIGHT_THREAD_ID = "b0000000-0000-4000-a000-000000000802";
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

function installMails(count = 12) {
  const mails = new Map(
    Array.from({ length: count }, (_, index) => {
      return [id(index + 1), draft(index + 1, index < 2 ? "draft" : "sent")];
    }),
  );
  const sent: string[] = [];
  const deleted: string[] = [];
  const reject = new Set<string>();
  const listing: { fail: boolean; wait: Promise<void> | null } = {
    fail: false,
    wait: null,
  };
  const sending: { wait: Promise<void> | null } = { wait: null };
  context.mocks.api(mailContract.listThreadMail, async ({ respond }) => {
    await listing.wait;
    if (listing.fail) {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Temporary email list failure" },
      });
    }
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
    await sending.wait;
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
  return { mails, sent, deleted, reject, listing, sending };
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

async function link(name: string, container: ParentNode = document.body) {
  return await waitFor(() => {
    const found = queryAllByRoleFast("link", container).find((element) => {
      return (
        element.getAttribute("aria-label") === name ||
        element.textContent?.trim() === name
      );
    });
    if (!found) {
      throw new Error(`Missing link: ${name}`);
    }
    return found;
  });
}

async function openChat(
  enabled = true,
  withCard = true,
  path = `/chats/${THREAD_ID}`,
  sidebarThreadId?: string,
) {
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
  const lifecycle = mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Email review",
    selectedModel: "claude-sonnet-5",
    chatEvents: sidebarThreadId
      ? []
      : [
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
  if (sidebarThreadId) {
    lifecycle.setThreadList(
      [THREAD_ID, sidebarThreadId].map((threadId) => {
        return {
          id: threadId,
          title: "Email review",
          agent: {
            id: "c0000000-0000-4000-a000-000000000001",
            avatarUrl: null,
          },
          createdAt: "2026-10-20T10:00:00.000Z",
          updatedAt: "2026-10-20T10:00:00.000Z",
          selectedModel: "claude-sonnet-5",
        };
      }),
    );
  }
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.ThreadEmailManager]: enabled },
  });
  await waitFor(() => {
    expect(screen.getAllByRole("textbox", { name: "Message" })).toHaveLength(
      sidebarThreadId ? 2 : 1,
    );
  });
}

async function openList() {
  click(await button("Manage emails"));
  return await screen.findByRole("dialog", { name: "Emails" });
}

describe("thread email manager", () => {
  it("keeps draft details available without manager navigation when the switch is disabled", async () => {
    installMails();
    await openChat(
      false,
      false,
      `/chats/${THREAD_ID}?mailThread=${THREAD_ID}&mailView=detail&mailId=${id(1)}&mailFrom=list`,
    );
    await screen.findByText("Proposal details 1");
    expect(
      queryAllByRoleFast("button").some((element) => {
        return element.getAttribute("aria-label") === "Manage emails";
      }),
    ).toBeFalsy();
    expect(
      queryAllByRoleFast("link").some((element) => {
        return element.textContent?.trim() === "Back to emails";
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
    click(within(list).getByLabelText("Select email: Proposal 1"));
    await within(list).findByText("Actions apply to selected drafts");
    expect(
      within(list).getByRole("checkbox", { name: "Select all" }),
    ).toHaveAttribute("aria-checked", "mixed");
    click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("12 selected");
    await expect(button("Send", list)).resolves.toBeEnabled();
    await expect(button("Delete", list)).resolves.toBeEnabled();
    expect(
      within(list).getByLabelText("Select email: Proposal 12"),
    ).toHaveAttribute("aria-checked", "true");
    click(within(list).getByRole("checkbox", { name: "Select all" }));
    await within(list).findByText("0 selected");
    await waitFor(() => {
      expect(within(list).queryByText("Send")).not.toBeInTheDocument();
      expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
      expect(
        within(list).queryByText("Actions apply to selected drafts"),
      ).not.toBeInTheDocument();
    });
    click(await button("Sent", list));
    click(within(list).getByRole("checkbox", { name: "Select all" }));
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
    click(await button("Open draft email: Proposal 1"));
    await screen.findByText("Proposal details 1");
    expect(
      queryAllByRoleFast("link").some((element) => {
        return element.textContent?.trim() === "Back to emails";
      }),
    ).toBeFalsy();
    click(await button("Close email details"));
    const list = await openList();
    const search = within(list).getByLabelText("Search by subject or sender");
    fireEvent.change(search, { target: { value: "Proposal" } });
    click(within(list).getByLabelText("Select email: Proposal 1"));
    click(await button("Sent", list));
    const row = await link("Open email: Proposal 12", list);
    const destination = new URL(
      row.getAttribute("href")!,
      window.location.href,
    );
    expect(destination.searchParams.get("mailThread")).toBe(THREAD_ID);
    expect(destination.searchParams.get("mailView")).toBe("detail");
    expect(destination.searchParams.get("mailId")).toBe(id(12));
    expect(destination.searchParams.get("mailFilter")).toBe("sent");
    expect(destination.searchParams.get("mailQuery")).toBe("Proposal");
    const scroller = row.parentElement?.parentElement;
    if (!scroller) {
      throw new Error("Missing email scroll viewport");
    }
    scroller.scrollTop = 180;
    fireEvent.scroll(scroller);
    click(row);
    await screen.findByText("Proposal details 12");
    expect(window.location.search).toBe(destination.search);
    const back = await link("Back to emails");
    await waitFor(() => {
      expect(back).toHaveFocus();
    });
    click(await link("Back to emails"));
    const restored = await screen.findByRole("dialog", { name: "Emails" });
    expect(
      within(restored).getByLabelText("Search by subject or sender"),
    ).toHaveValue("Proposal");
    await expect(button("Sent", restored)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const restoredRow = await link("Open email: Proposal 12", restored);
    expect(restoredRow.parentElement?.parentElement?.scrollTop).toBe(180);
    click(await button("All", restored));
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
    click(await link("Open email: Proposal 2", list));
    await screen.findByText("Proposal details 2");
    click(await link("Back to emails"));
    await screen.findByRole("dialog", { name: "Emails" });
    expect(transitions.startedTypes).toHaveLength(0);
  });

  it("restores a detail and its list filters from a direct URL without a transcript card", async () => {
    installMails();
    const params = new URLSearchParams({
      mailThread: THREAD_ID,
      mailView: "detail",
      mailId: id(12),
      mailFrom: "list",
      mailFilter: "sent",
      mailQuery: "Proposal 12",
      unrelated: "keep",
    });
    await openChat(true, false, `/chats/${THREAD_ID}?${params}#note`);
    await screen.findByText("Proposal details 12");
    const back = await link("Back to emails");
    click(back);
    const list = await screen.findByRole("dialog", { name: "Emails" });
    await link("Open email: Proposal 12", list);
    expect(
      within(list).getByLabelText("Search by subject or sender"),
    ).toHaveValue("Proposal 12");
    await expect(
      link("Open email: Proposal 12", list),
    ).resolves.toHaveAttribute(
      "href",
      expect.stringContaining("mailFilter=sent"),
    );
    expect(new URLSearchParams(window.location.search).get("unrelated")).toBe(
      "keep",
    );
    expect(window.location.hash).toBe("#note");
  });

  it("uses browser Back and Forward to restore list and detail navigation", async () => {
    installMails();
    await openChat();
    const list = await openList();
    click(within(list).getByLabelText("Select email: Proposal 1"));
    click(await button("Sent", list));
    click(await link("Open email: Proposal 12", list));
    await screen.findByText("Proposal details 12");
    act(() => {
      window.history.back();
    });
    const restored = await screen.findByRole("dialog", { name: "Emails" });
    await expect(button("Sent", restored)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await within(restored).findByText("1 selected");
    act(() => {
      window.history.forward();
    });
    await screen.findByText("Proposal details 12");
    expect(new URLSearchParams(window.location.search).get("mailId")).toBe(
      id(12),
    );
    await link("Back to emails");
  });

  it("leaves modified email-link activation to the browser", async () => {
    installMails(2);
    const transitions = context.mocks.browser.viewTransition();
    await openChat();
    const list = await openList();
    const row = await link("Open email: Proposal 2", list);
    const modifiedClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    act(() => {
      row.dispatchEvent(modifiedClick);
    });
    expect(modifiedClick.defaultPrevented).toBeFalsy();
    expect(list).toBeInTheDocument();
    expect(row).toHaveAttribute(
      "href",
      expect.stringContaining(`mailId=${id(2)}`),
    );
    expect(transitions.startedTypes).toHaveLength(0);
  });

  it("restores the owning pane and clears its filters when opening another pane's manager", async () => {
    installMails();
    const params = new URLSearchParams({
      sidebar: RIGHT_THREAD_ID,
      mailThread: RIGHT_THREAD_ID,
      mailView: "detail",
      mailId: id(12),
      mailFrom: "list",
      mailFilter: "sent",
      mailQuery: "Proposal 12",
    });
    await openChat(
      true,
      false,
      `/chats/${THREAD_ID}?${params}`,
      RIGHT_THREAD_ID,
    );
    await screen.findByText("Proposal details 12");
    const back = await link("Back to emails");
    expect(back).toHaveAttribute(
      "href",
      expect.stringContaining(`mailThread=${RIGHT_THREAD_ID}`),
    );
    click(back);
    const rightList = await screen.findByRole("dialog", { name: "Emails" });
    await link("Open email: Proposal 12", rightList);
    expect(
      within(rightList).getByLabelText("Search by subject or sender"),
    ).toHaveValue("Proposal 12");
    const leftPane = document.querySelector(
      `[data-chat-thread-container-id="${THREAD_ID}"]`,
    );
    if (!leftPane) {
      throw new Error("Missing left chat pane");
    }
    click(await button("Manage emails", leftPane));
    const leftList = await screen.findByRole("dialog", { name: "Emails" });
    await link("Open email: Proposal 1", leftList);
    expect(
      within(leftList).getByLabelText("Search by subject or sender"),
    ).toHaveValue("");
    await expect(button("All", leftList)).resolves.toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const location = new URLSearchParams(window.location.search);
    expect(location.get("sidebar")).toBe(RIGHT_THREAD_ID);
    expect(location.get("mailThread")).toBe(THREAD_ID);
    expect(location.has("mailFilter")).toBeFalsy();
    expect(location.has("mailQuery")).toBeFalsy();
  });

  it("keeps a failed initial list read accessible and retries from the manager", async () => {
    const fixture = installMails();
    fixture.listing.fail = true;
    await openChat(true, false);
    await screen.findAllByText("Temporary email list failure");
    const list = await openList();
    await within(list).findByRole("alert");
    expect(within(list).getByText("Unable to load emails")).toBeInTheDocument();
    fixture.listing.fail = false;
    click(await button("Try again", list));
    await within(list).findByLabelText("Select email: Proposal 1");
  });

  it("returns to the list while its read is pending and exposes failure recovery", async () => {
    const fixture = installMails(2);
    await openChat();
    const list = await openList();
    click(await link("Open email: Proposal 2", list));
    await screen.findByText("Proposal details 2");
    const releaseList = createDeferredPromise<void>(context.signal);
    fixture.listing.wait = releaseList.promise;
    fixture.listing.fail = true;
    click(await link("Back to emails"));
    const returned = await screen.findByRole("dialog", { name: "Emails" });
    await within(returned).findByRole("status", { name: "Loading emails" });
    expect(new URLSearchParams(window.location.search).get("mailView")).toBe(
      "list",
    );
    releaseList.resolve();
    await within(returned).findByRole("alert");
    fixture.listing.fail = false;
    fixture.listing.wait = null;
    click(await button("Try again", returned));
    await within(returned).findByLabelText("Select email: Proposal 2");
  });

  it("sends only drafts, retains failures for retry, and never resends successes", async () => {
    const fixture = installMails();
    fixture.reject.add(id(2));
    const releaseSend = createDeferredPromise<void>(context.signal);
    fixture.sending.wait = releaseSend.promise;
    await openChat();
    let list = await openList();
    click(within(list).getByRole("checkbox", { name: "Select all" }));
    click(await button("Send", list));
    const confirmation = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    click(await button("Send", confirmation));
    await expect(button("Send", confirmation)).resolves.toBeDisabled();
    await expect(button("Cancel", confirmation)).resolves.toBeDisabled();
    const user = userEvent.setup({ delay: null });
    await user.keyboard("{Escape}");
    expect(confirmation).toBeInTheDocument();
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(
        new URLSearchParams(window.location.search).has("mailView"),
      ).toBeFalsy();
    });
    await expect(button("Send", confirmation)).resolves.toBeDisabled();
    act(() => {
      window.history.forward();
    });
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("mailView")).toBe(
        "list",
      );
    });
    releaseSend.resolve();
    await screen.findByText("1 completed · 1 failed");
    list = await screen.findByRole("dialog", { name: "Emails" });
    expect(fixture.sent).toStrictEqual([id(1)]);
    fixture.reject.delete(id(2));
    click(await button("Send", list));
    const retry = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    click(await button("Send", retry));
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
    click(within(list).getByRole("checkbox", { name: "Select all" }));
    click(await button("Delete", list));
    const confirmation = await screen.findByRole("dialog", {
      name: "Delete selected drafts?",
    });
    click(await button("Cancel", confirmation));
    expect(fixture.deleted).toStrictEqual([]);
    click(await button("Delete", list));
    const second = await screen.findByRole("dialog", {
      name: "Delete selected drafts?",
    });
    click(await button("Delete", second));
    await within(list).findByText("10 selected");
    expect(fixture.deleted).toStrictEqual([id(1), id(2)]);
    expect(fixture.mails.get(id(12))?.status).toBe("sent");
    await waitFor(() => {
      expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    });
  });
});
