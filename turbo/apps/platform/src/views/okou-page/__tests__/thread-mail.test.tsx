import { selectDesktopHeaderAction } from "./chat-header-test-helpers.ts";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
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
import { describe, expect, it, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  artifactSummary,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000801";
const RIGHT_THREAD_ID = "b0000000-0000-4000-a000-000000000802";
const RUN_ID = "d0000000-0000-4000-a000-000000000811";

function draft(
  index: number,
  status: "draft" | "sent" = "draft",
): Extract<MailDraft, { provider: "gmail" }> {
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
  const mails = new Map<string, MailDraft>(
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
              mail.status === "sent"
                ? ("sent" as const)
                : mail.status === "sending"
                  ? ("sending" as const)
                  : ("draft" as const),
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
  });
  await waitFor(() => {
    expect(screen.getAllByRole("textbox", { name: "Message" })).toHaveLength(
      sidebarThreadId ? 2 : 1,
    );
  });
}

async function openList() {
  await selectDesktopHeaderAction("Manage emails");
  return await screen.findByRole("dialog", { name: "Emails" });
}

function installNarrowMailScrollGeometry(container: HTMLElement) {
  const anchors = () => {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        "[data-chat-scroll-anchor-event-id]",
      ),
    );
  };
  const covered = () => {
    return (
      document.querySelector(
        '[data-testid="chat-thread-sidebar-pane"][aria-hidden="false"]',
      ) !== null
    );
  };
  const rect = (top: number, height: number): DOMRect => {
    return {
      top,
      bottom: top + height,
      left: 0,
      right: 390,
      x: 0,
      y: top,
      width: 390,
      height,
      toJSON: () => {
        return {};
      },
    };
  };
  let scrollTop = 0;
  const writes: number[] = [];
  Object.defineProperties(container, {
    clientWidth: {
      configurable: true,
      get: () => {
        return 390;
      },
    },
    clientHeight: {
      configurable: true,
      get: () => {
        return covered() ? 0 : 300;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        return anchors().length * 400 + 100;
      },
    },
    scrollTop: {
      configurable: true,
      get: () => {
        return scrollTop;
      },
      set: (top: number) => {
        writes.push(top);
        scrollTop = top;
      },
    },
    scrollTo: {
      configurable: true,
      value: (options: ScrollToOptions | number, y?: number) => {
        container.scrollTop =
          typeof options === "number"
            ? (y ?? scrollTop)
            : (options.top ?? scrollTop);
        fireEvent.scroll(container);
        fireEvent(container, new Event("scrollend"));
      },
    },
  });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this === container) {
        return rect(0, container.clientHeight);
      }
      const index = anchors().indexOf(this);
      return index === -1
        ? originalRect.call(this)
        : rect(index * 400 - scrollTop, 380);
    });
  let wasCovered = covered();
  const observer = new MutationObserver(() => {
    const isCovered = covered();
    if (wasCovered && !isCovered) {
      // Native layout reset bypasses the JavaScript setter/application writes.
      scrollTop = 0;
      fireEvent.scroll(container);
    }
    wasCovered = isCovered;
  });
  observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden"],
    childList: true,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      bounds.mockRestore();
    },
    { once: true },
  );
  return {
    writes,
    readingAnchor: () => {
      const anchor = anchors().find((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return bounds.bottom > 0 && bounds.top < container.clientHeight;
      });
      if (!anchor) {
        throw new Error("Missing visible transcript anchor");
      }
      return anchor;
    },
  };
}

function controlMailRevealFrames() {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((id) => {
      callbacks.delete(id);
    });
  context.signal.addEventListener(
    "abort",
    () => {
      request.mockRestore();
      cancel.mockRestore();
    },
    { once: true },
  );
  return {
    paint: async () => {
      await act(() => {
        const frame = [...callbacks];
        for (const [id, callback] of frame) {
          if (callbacks.delete(id)) {
            callback(performance.now());
          }
        }
      });
    },
  };
}

describe("thread email manager", () => {
  it("opens an empty state for a thread without email", async () => {
    installMails(0);
    await openChat(false);
    const list = await openList();
    await expect(
      within(list).findByText("No emails yet"),
    ).resolves.toBeInTheDocument();
    expect(
      within(list).queryByRole("textbox", {
        name: "Search by subject or sender",
      }),
    ).toBeNull();
  });

  it("navigates filters with arrow keys, selects with Enter or Space, and restores focus on Escape", async () => {
    installMails();
    await openChat();
    const entry = await button("More actions");
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
    await link("Open email: Proposal 12", list);
    expect(
      within(list).queryByLabelText("Select email: Proposal 1"),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(entry).toHaveFocus();
    });
  });

  it("selects only filtered drafts and shows their bulk actions", async () => {
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
    await within(list).findByText("2 selected");
    await expect(button("Send", list)).resolves.toBeEnabled();
    await expect(button("Delete", list)).resolves.toBeEnabled();
    expect(
      within(list).getByLabelText("Select email: Proposal 2"),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(list).getAllByRole("checkbox")).toHaveLength(3);
    await link("Open email: Proposal 12", list);
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
    await link("Open email: Proposal 12", list);
    expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(list).queryByText("Send")).not.toBeInTheDocument();
    expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    expect(
      within(list).queryByText("Actions apply to selected drafts"),
    ).not.toBeInTheDocument();
  });

  it("preserves selection, search and scroll when returning from list details; chat details have no list navigation", async () => {
    installMails();
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
    await openChat(false, `/chats/${THREAD_ID}?${params}#note`);
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
    await link("Open email: Proposal 12", restored);
    expect(within(restored).queryByText("Send")).not.toBeInTheDocument();
    act(() => {
      window.history.forward();
    });
    await screen.findByText("Proposal details 12");
    expect(new URLSearchParams(window.location.search).get("mailId")).toBe(
      id(12),
    );
    click(await link("Back to emails"));
    const returned = await screen.findByRole("dialog", { name: "Emails" });
    click(await button("Drafts", returned));
    await within(returned).findByText("1 selected");
    expect(
      within(returned).getByLabelText("Select email: Proposal 1"),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("restores the narrow transcript anchor once after two frames on each browser Back from mail detail", async () => {
    context.mocks.browser.matchMedia(() => {
      return false;
    });
    installMails(2);
    await openChat();
    const container = document.querySelector<HTMLElement>(
      "[data-scroll-container]",
    );
    if (!container) {
      throw new Error("Missing transcript scroll viewport");
    }
    const geometry = installNarrowMailScrollGeometry(container);
    container.scrollTop = 240;
    fireEvent.scroll(container);
    click(await button("Manage emails"));
    const list = await screen.findByRole("dialog", { name: "Emails" });
    await link("Open email: Proposal 2", list);
    // Capture the live semantic offset, not the last scroll-event snapshot.
    container.scrollTop = 275;
    let anchor = geometry.readingAnchor();
    let anchorY = anchor.getBoundingClientRect().top;
    click(await link("Open email: Proposal 2", list));
    await screen.findByText("Proposal details 2");
    expect(container.clientWidth).toBe(390);
    expect(container.clientHeight).toBe(0);
    const frames = controlMailRevealFrames();

    for (const top of [275, 475]) {
      geometry.writes.length = 0;
      act(() => {
        window.history.back();
      });
      await screen.findByRole("dialog", { name: "Emails" });
      await waitFor(() => {
        expect(container.clientHeight).toBe(300);
        expect(container.scrollTop).toBe(0);
      });
      await frames.paint();
      expect(container.scrollTop).toBe(0);
      expect(geometry.writes).toStrictEqual([]);
      await frames.paint();
      await waitFor(() => {
        expect(container.scrollTop).toBe(top);
        expect(anchor).toBeInTheDocument();
        expect(anchor.getBoundingClientRect().top).toBe(anchorY);
        expect(geometry.writes).toStrictEqual([top]);
      });
      await frames.paint();
      expect(geometry.writes).toStrictEqual([top]);

      if (top === 275) {
        // Forward must capture again, without stale protection from the reveal.
        container.scrollTop = 475;
        anchor = geometry.readingAnchor();
        anchorY = anchor.getBoundingClientRect().top;
        act(() => {
          window.history.forward();
        });
        await screen.findByText("Proposal details 2");
        await frames.paint();
        await frames.paint();
      }
      expect(container.clientHeight).toBe(top === 275 ? 0 : 300);
    }
  });

  it("leaves modified email-link activation to the browser", async () => {
    installMails(2);
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
    await openChat(false, `/chats/${THREAD_ID}?${params}`, RIGHT_THREAD_ID);
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
    await selectDesktopHeaderAction("Manage emails", leftPane);
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

  it("restores mail history ahead of another pane's utility sidebar", async () => {
    installMails();
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [
          artifactSummary(
            "a0000000-0000-4000-a000-000000000803",
            "file",
            "Proposal notes",
          ),
        ],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact not found" },
      });
    });
    const params = new URLSearchParams({
      sidebar: RIGHT_THREAD_ID,
      mailThread: RIGHT_THREAD_ID,
      mailView: "list",
    });
    await openChat(false, `/chats/${THREAD_ID}?${params}`, RIGHT_THREAD_ID);
    const list = await screen.findByRole("dialog", { name: "Emails" });
    click(await link("Open email: Proposal 12", list));
    await screen.findByText("Proposal details 12");
    const leftPane = document.querySelector(
      `[data-chat-thread-container-id="${THREAD_ID}"]`,
    );
    if (!leftPane) {
      throw new Error("Missing left chat pane");
    }
    await openResourceArtifact("Proposal notes", leftPane);
    await screen.findByTestId("thread-sidebar-artifact-unavailable");
    act(() => {
      window.history.back();
    });
    await screen.findByText("Proposal details 12");
    act(() => {
      window.history.back();
    });
    await screen.findByRole("dialog", { name: "Emails" });
    expect(
      screen.queryByTestId("thread-sidebar-artifact-unavailable"),
    ).not.toBeInTheDocument();
  });

  it("keeps a failed initial list read accessible", async () => {
    const fixture = installMails();
    fixture.listing.fail = true;
    await openChat(false);
    const list = await openList();
    await within(list).findByRole("alert");
    expect(within(list).getByText("Unable to load emails")).toBeInTheDocument();
  });

  it("returns to the list while its read is pending and displays its failure", async () => {
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
    await waitFor(() => {
      expect(within(list).queryByText("Send")).not.toBeInTheDocument();
      expect(within(list).queryByRole("checkbox")).not.toBeInTheDocument();
    });
    expect(fixture.sent).toStrictEqual([id(1), id(2)]);
  });

  it("reports uncertain Outlook sends as awaiting confirmation rather than completed", async () => {
    const fixture = installMails(1);
    const {
      gmailDraftId: _draftId,
      gmailThreadId: _threadId,
      gmailMessageId: _messageId,
      ...common
    } = draft(1);
    const outlook: MailDraft = {
      ...common,
      provider: "outlook",
      outlookMessageId: "immutable-outlook",
      outlookConversationId: "outlook-conversation",
    };
    fixture.mails.set(id(1), outlook);
    context.mocks.api(mailContract.sendDraft, ({ respond }) => {
      const pending: MailDraft = { ...outlook, status: "sending" };
      fixture.mails.set(id(1), pending);
      return respond(200, response(id(1), pending));
    });
    await openChat();
    const list = await openList();
    click(within(list).getByRole("checkbox", { name: "Select all" }));
    click(await button("Send", list));
    const confirmation = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    click(await button("Send", confirmation));
    await waitFor(() => {
      expect(
        screen.getByText("0 completed · 1 awaiting confirmation · 0 failed"),
      ).toBeInTheDocument();
      const refreshedList = screen.getByRole("dialog", { name: "Emails" });
      expect(within(refreshedList).getByText("Sending")).toBeInTheDocument();
      expect(
        within(refreshedList).queryByRole("checkbox"),
      ).not.toBeInTheDocument();
    });
  });

  it("confirms bulk deletion of drafts and keeps sent emails available", async () => {
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
    await waitFor(() => {
      expect(
        queryAllByRoleFast("link", list).some((element) => {
          return (
            element.getAttribute("aria-label") === "Open email: Proposal 1"
          );
        }),
      ).toBeFalsy();
    });
    expect(fixture.deleted).toStrictEqual([id(1), id(2)]);
    await link("Open email: Proposal 12", list);
    await waitFor(() => {
      expect(within(list).queryByText("Delete")).not.toBeInTheDocument();
    });
  });
});
