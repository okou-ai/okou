import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactSummary } from "./chat-navigation-artifact-test-helpers.ts";
import { mailContract } from "@okouai/api-contracts/contracts/mail";
import {
  screen,
  within,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import {
  mockSplitAttachmentChats,
  mockAttachmentChat,
  artifactFile,
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  privateAttachmentUrl,
} from "./chat-attachment-test-helpers.ts";
const context = testContext(),
  left = ATTACHMENT_THREAD_ID,
  right = SECOND_ATTACHMENT_THREAD_ID,
  stamp = "2026-08-15T12:00:00.000Z";
function id(n: number) {
  return "c0920000-0000-4000-8000-" + String(n).padStart(12, "0");
}
function mailbox() {
  const drafts = new Set([id(1), id(2)]);
  function envelope(n: number) {
    const mailDraftId = id(n);
    return {
      mailDraftId,
      subject: "Proposal " + n,
      from: "studio@example.invalid",
      createdAt: stamp,
      status: drafts.has(mailDraftId) ? ("draft" as const) : ("sent" as const),
    };
  }
  function detail(n: number) {
    const e = envelope(n);
    return {
      mailDraftId: e.mailDraftId,
      mailDraftUrl: "https://app.okou.ai/mail/drafts/" + e.mailDraftId,
      mailDraft: {
        provider: "gmail" as const,
        version: 3 as const,
        gmailDraftId: "draft-" + n,
        gmailThreadId: "topic-" + n,
        gmailMessageId: "message-" + n,
        from: e.from,
        subject: e.subject,
        body: "Message contents " + n,
        cc: [],
        bcc: [],
        to: ["operator@example.invalid"],
        references: [],
        status: e.status,
        detailAvailable: true,
        createdAt: stamp,
        updatedAt: stamp,
        attachments: [],
      },
    };
  }
  context.mocks.api(mailContract.getDraft, ({ params, respond }) => {
    return respond(200, detail(Number(params.mailDraftId.slice(-4))));
  });
  context.mocks.api(mailContract.listThreadMail, ({ params, respond }) => {
    return respond(200, {
      mails: Array.from(
        { length: params.threadId === left ? 13 : 12 },
        (_, i) => {
          return envelope(i + 1);
        },
      ),
    });
  });
  return { drafts, detail };
}
async function mount(split = false, mobile = false) {
  if (mobile) {
    context.mocks.browser.matchMedia(false);
  }
  const mail = mailbox();
  const file = artifactSummary(id(77), "file", "missing-plan.md");
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    return respond(200, {
      artifacts: query.chatThreadId === left ? [file] : [],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "ARTIFACT_NOT_FOUND",
        message: "Archived file unavailable",
      },
    });
  });
  const url = "https://app.okou.ai/mail/drafts/" + id(1);
  const move = {
    id: id(61),
    role: "assistant" as const,
    content: "Review [email proposal](" + url + ")",
    createdAt: stamp,
  };
  const missing = artifactFile("missing-plan.md", {
    id: id(77),
    url: privateAttachmentUrl(id(77)),
  });
  if (split) {
    mockSplitAttachmentChats(
      context,
      {
        threadId: left,
        title: "Planning conversation",
        events: [move],
        artifacts: [missing],
      },
      { threadId: right, title: "Review conversation", events: [] },
    );
  } else {
    mockAttachmentChat(context, {
      threadId: left,
      threadTitle: "Planning conversation",
      chatEvents: [move],
    });
  }
  await setupPage({
    context,
    path: "/chats/" + left + (split ? "?sidebar=" + right : ""),
  });
  return mail;
}
const press = async (name: string | RegExp, box?: HTMLElement) => {
  return click(await findFastControl("button", name, box));
};
function list() {
  return screen.getByRole("dialog", { name: "Emails" });
}
async function manage(pane: "left" | "right" = "left") {
  const actions = await waitFor(() => {
    const buttons = queryAllByRoleFast("button").filter((b) => {
      return b.getAttribute("aria-label") === "More actions";
    });
    const match = pane === "left" ? buttons[0] : buttons[1];
    if (!match) {
      throw new Error("Missing " + pane + " chat actions");
    }
    return match;
  });
  await userEvent.setup({ delay: null }).click(actions);
  const menu = await screen.findByRole("menu");
  await userEvent
    .setup({ delay: null })
    .click(await within(menu).findByText("Manage emails"));
  await screen.findByRole("dialog", { name: "Emails" });
}
async function openMail(n: number) {
  const link = await findFastControl(
    "link",
    "Open email: Proposal " + n,
    list(),
  );
  click(link);
  await screen.findByText("Message contents " + n);
  return link;
}
const query = () => {
  return within(list()).getByRole("textbox", {
    name: "Search by subject or sender",
  });
};
function params() {
  return new URLSearchParams(location.search);
}
test("thread-mail-009 The left chat opens its own unfiltered email manager after navigating the right chat's filtered list", async () => {
  await mount(true);
  await manage("right");
  await fill(query(), "Proposal 12");
  await press("Sent", list());
  await openMail(12);
  click(await findFastControl("link", "Back to emails"));
  await screen.findByRole("dialog", { name: "Emails" });
  expect(query()).toHaveValue("Proposal 12");
  await manage("left");
  await waitFor(() => {
    return expect(params().get("mailThread")).toBe(left);
  });
  expect(query()).toHaveValue("");
  await expect(
    findFastControl("button", "All", list()),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  expect(params().get("sidebar")).toBe(right);
  expect(params().get("mailFilter")).toBeNull();
  expect(params().get("mailQuery")).toBeNull();
});
test("thread-mail-004 Opening a sent proposal keeps the list scroll and search, while returning to a transcript email has no list backlink", async () => {
  await mount();
  const transcript = await findFastControl(
    "link",
    /email proposal|Proposal 1|Open.*email/i,
  );
  click(transcript);
  await screen.findByText("Message contents 1");
  expect(queryFastControl("link", "Back to emails")).toBeNull();
  await press(/Close/);
  await manage();
  await fill(query(), "Proposal");
  const first = await within(list()).findByRole("checkbox", {
    name: "Select email: Proposal 1",
  });
  await userEvent.setup({ delay: null }).click(first);
  await press("Sent", list());
  const link = await findFastControl("link", "Open email: Proposal 12", list());
  const area = link.closest<HTMLElement>(".overflow-y-auto")!;
  area.scrollTop = 180;
  fireEvent.scroll(area);
  const url = new URL(link.getAttribute("href")!, location.href);
  expect(url.pathname).toBe("/chats/" + left);
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    mailThread: left,
    mailView: "detail",
    mailId: id(12),
    mailFilter: "sent",
    mailQuery: "Proposal",
    mailFrom: "list",
  });
  click(link);
  await screen.findByText("Message contents 12");
  click(await findFastControl("link", "Back to emails"));
  await screen.findByRole("dialog", { name: "Emails" });
  expect(query()).toHaveValue("Proposal");
  await expect(
    findFastControl("button", "Sent", list()),
  ).resolves.toHaveAttribute("aria-pressed", "true");
  const restored = await findFastControl(
    "link",
    "Open email: Proposal 12",
    list(),
  );
  expect(restored.closest(".overflow-y-auto")?.scrollTop).toBe(180);
  await press("All", list());
  await expect(
    within(list()).findByRole("checkbox", { name: "Select email: Proposal 1" }),
  ).resolves.toBeChecked();
  await press(/Close/);
  await expect(
    findFastControl("link", /email proposal|Proposal 1|Open.*email/i),
  ).resolves.toBeVisible();
});
test("thread-mail-013 A pending send survives navigation and retry sends only the previously rejected proposal", async () => {
  const mail = await mount();
  const gate = context.mocks.deferred<void>(),
    received = context.mocks.deferred<void>(),
    sent = new Set<string>(),
    duplicate = context.mocks.deferred<string>();
  let retry = false;
  context.mocks.api(mailContract.sendDraft, async ({ params, respond }) => {
    const target = params.mailDraftId;
    if (target === id(1)) {
      received.resolve();
      await gate.promise;
    }
    if (target === id(2) && !retry) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Mail unavailable" },
      });
    }
    if (sent.has(target)) {
      duplicate.resolve(target);
    }
    sent.add(target);
    mail.drafts.delete(target);
    return respond(200, mail.detail(Number(target.slice(-4))));
  });
  try {
    await manage();
    const user = userEvent.setup({ delay: null });
    for (const n of [1, 2]) {
      await user.click(
        await within(list()).findByRole("checkbox", {
          name: "Select email: Proposal " + n,
        }),
      );
    }
    await press("Send", list());
    let dialog = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    await press("Send", dialog);
    await received.promise;
    await expect(
      findFastControl("button", "Cancel", dialog),
    ).resolves.toBeDisabled();
    await expect(
      findFastControl("button", /Send/, dialog),
    ).resolves.toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    window.history.back();
    await waitFor(() => {
      return expect(params().get("mailView")).toBeNull();
    });
    window.history.forward();
    await screen.findByRole("dialog", { name: "Emails" });
    const pendingSend = queryFastControl("button", "Send", list());
    expect(
      pendingSend === null || pendingSend.hasAttribute("disabled"),
    ).toBeTruthy();
    gate.resolve();
    await screen.findByText("1 completed · 1 failed");
    expect([...sent]).toStrictEqual([id(1)]);
    retry = true;
    await press("Send", list());
    dialog = await screen.findByRole("dialog", {
      name: "Send selected drafts?",
    });
    await press("Send", dialog);
    await waitFor(() => {
      return expect(within(list()).queryAllByRole("checkbox")).toHaveLength(0);
    });
    expect(queryFastControl("button", "Send", list())).toBeNull();
    expect(sent).toStrictEqual(new Set([id(1), id(2)]));
    expect(duplicate.settled()).toBeFalsy();
  } finally {
    if (!gate.settled()) {
      gate.resolve();
    }
  }
});
test("thread-mail-010 Two browser Back operations restore right email detail then list after opening an unavailable left artifact", async () => {
  await mount(true);
  await manage("right");
  await openMail(12);
  await press("Artifacts and chats");
  const link = await screen.findByText("missing-plan.md");
  click(link);
  await screen.findByTestId("thread-sidebar-artifact-unavailable");
  window.history.back();
  await screen.findByText("Message contents 12");
  expect(params().get("mailThread")).toBe(right);
  window.history.back();
  await screen.findByRole("dialog", { name: "Emails" });
  await findFastControl("link", "Open email: Proposal 12", list());
  expect(
    screen.queryByTestId("thread-sidebar-artifact-unavailable"),
  ).toBeNull();
  expect(params().get("mailThread")).toBe(right);
});

test("thread-mail-007 Back from narrow email detail restores the visible message at the second paint on both trips", async () => {
  await mount(false, true);
  await findFastControl("link", /email proposal/i);
  const anchor = document.querySelector<HTMLElement>(
    "[data-chat-scroll-anchor-event-id]",
  )!;
  const viewport = anchor.closest<HTMLElement>("[data-scroll-container]")!;
  expect(viewport).toBeInTheDocument();
  const rect = (top: number, height: number) => {
    return new DOMRect(0, top, 390, height);
  };
  const covered = () => {
    return viewport.closest("[class~='hidden'][class~='xl:flex']") !== null;
  };
  let top = 0;
  const writes: number[] = [];
  Object.defineProperties(viewport, {
    scrollTop: {
      configurable: true,
      get: () => {
        return top;
      },
      set: (y: number) => {
        top = y;
        writes.push(y);
      },
    },
    clientWidth: {
      configurable: true,
      get: () => {
        return covered() ? 0 : 390;
      },
    },
    clientHeight: {
      configurable: true,
      get: () => {
        return covered() ? 0 : 600;
      },
    },
    scrollHeight: {
      configurable: true,
      get: () => {
        return 1700;
      },
    },
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => {
    return rect(0, 600);
  });
  vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() => {
    return rect(525 - top, 30);
  });
  const place = (y: number) => {
    fireEvent.wheel(viewport, { deltaY: y - top });
    top = y;
    fireEvent.scroll(viewport);
  };
  place(275);
  await press("Manage emails");
  await screen.findByRole("dialog", { name: "Emails" });
  await openMail(2);
  let frames = new Map<number, FrameRequestCallback>();
  let seq = 0;
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((fn) => {
      frames.set(++seq, fn);
      return seq;
    });
  const cancel = vi
    .spyOn(window, "cancelAnimationFrame")
    .mockImplementation((n) => {
      frames.delete(n);
    });
  async function paint() {
    const batch = [...frames.values()];
    frames = new Map();
    await act(() => {
      for (const fn of batch) {
        fn(performance.now());
      }
    });
  }
  try {
    for (const y of [275, 475]) {
      expect(viewport.clientWidth).toBe(0);
      top = 0;
      writes.length = 0;
      window.history.back();
      await screen.findByRole("dialog", { name: "Emails" });
      expect(viewport.clientWidth).toBe(390);
      expect(viewport.scrollTop).toBe(0);
      await paint();
      expect(viewport.scrollTop).toBe(0);
      await paint();
      expect(viewport.scrollTop).toBe(y);
      expect(anchor.getBoundingClientRect().top).toBe(525 - y);
      expect(writes).toStrictEqual([y]);
      await paint();
      expect(writes).toStrictEqual([y]);
      if (y === 275) {
        place(475);
        window.history.forward();
        await screen.findByText("Message contents 2");
      }
    }
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});
