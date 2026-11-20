import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  SECOND_ATTACHMENT_THREAD_ID,
  findNamedLink,
  getNamedLink,
  mockSplitAttachmentChats,
  type AttachmentChatEvent,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
const sourceChat = "fafdf133-ca5d-4ed7-8b5b-1e170a99c239";
const author = "cc255d19-87df-42fc-9f12-f7df818a2445";
const portrait = "https://cdn.vm7.io/avatars/review-author.png";
const reference = {
  type: "chat_thread",
  threadId: sourceChat,
  titleSnapshot: "Project Alpha",
} as const;

function entry(
  parts: UserMessageDocument["parts"],
  runId?: string,
): AttachmentChatEvent {
  return {
    role: "user",
    content: null,
    createdAt: "2026-09-11T11:00:00Z",
    runId,
    userMessage: { version: 1, parts },
  };
}
async function openReview(events: AttachmentChatEvent[]) {
  context.mocks.data.agents([
    { agentId: author, displayName: "Ada", avatarUrl: portrait },
  ]);
  mockSplitAttachmentChats(
    context,
    { threadId: ATTACHMENT_THREAD_ID, title: "Review desk", events },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Companion desk",
      events: [entry([{ type: "text", text: "Companion checklist" }])],
    },
  );
  await setupPage({ context, path: "/chats/" + SECOND_ATTACHMENT_THREAD_ID });
  await screen.findByText("Companion checklist");
  click(await findNamedLink("Review desk"));
}
async function messageAt(text: string) {
  return (await screen.findByText(text)).closest<HTMLElement>(
    '[data-role="user"]',
  )!;
}

test("chat-message-structured-content-001 identifies Ada in the request and its feedback", async () => {
  const ada = { type: "agent", agentId: author, nameSnapshot: "Ada" } as const;
  await openReview([
    entry([
      { type: "text", text: "Assign review to " },
      ada,
      {
        type: "feedback",
        quote: "Check the totals",
        note: [{ type: "text", text: "Reviewed by " }, ada],
      },
    ]),
  ]);
  const message = await messageAt("Check the totals");
  for (const caption of ["Assign review to", "Reviewed by"]) {
    const section = within(message).getByText(caption).nextElementSibling!;
    const link = getNamedLink("Open agent Ada", section);
    expect(link).toHaveTextContent("Ada");
    expect(link).toHaveAttribute("href", "/agents/" + author + "/chat");
    await waitFor(() => {
      return expect(link.querySelector("img")).toHaveAttribute("src", portrait);
    });
  }
  expect(message).not.toHaveTextContent(author);
});

test("chat-message-structured-content-002 associates each prompt with its own MCP client badge", async () => {
  const longName =
    "Quarterly reconciliation workstation for consolidated international reporting";
  const clients = [
    ["Audit bookings", "Claude Code"],
    ["Check receipts", undefined],
    ["Publish balances", longName],
  ] as const;
  await openReview(
    clients.map(([text, name], i) => {
      return entry([
        {
          type: "source",
          kind: "mcp",
          clientId: "internal-client-" + i,
          ...(name ? { clientName: name } : {}),
        },
        { type: "text", text },
      ]);
    }),
  );
  const named = await messageAt("Audit bookings");
  const badge = within(named).getByText("Claude Code");
  expect(
    badge.parentElement?.querySelector("svg[aria-hidden=true]"),
  ).toBeInTheDocument();
  expect(queryAllByRoleFast("link", named)).toHaveLength(0);
  expect(named).not.toHaveTextContent("internal-client-0");
  const fallback = within(await messageAt("Check receipts")).getByText("MCP");
  expect(fallback.parentElement?.querySelector("svg")).toBeInTheDocument();
  expect(
    within(await messageAt("Publish balances")).getByText(longName, {
      exact: true,
    }),
  ).toBeInTheDocument();
});

test("chat-message-structured-content-003 gives the delegated prompt a run anchor and links to the source run", async () => {
  const sourceRun = "02820622-1539-4230-80e0-e613d36bd0d2";
  const destination = "/chats/" + sourceChat + "#run-" + sourceRun;
  await openReview([
    entry(
      [
        {
          type: "source",
          kind: "agent",
          agentId: author,
          threadId: sourceChat,
          runId: sourceRun,
          titleSnapshot: "Source thread",
          href: destination,
        },
        { type: "text", text: "Verify the supplier balance" },
      ],
      sourceRun,
    ),
  ]);
  const turn = await messageAt("Verify the supplier balance");
  const link = getNamedLink("Source thread", turn);
  expect(link).toHaveAttribute("href", destination);
  await waitFor(() => {
    return expect(link.querySelector("img")).toHaveAttribute("src", portrait);
  });
  expect(document.getElementById("run-" + sourceRun)).toContainElement(
    within(turn).getByText("Verify the supplier balance"),
  );
});

test("chat-message-structured-content-004 keeps both attributed quotations between the introduction and conclusion", async () => {
  const quotes = [
    "Estimate freight separately",
    "Confirm the delivery date",
  ] as const;
  await openReview([
    entry([
      { type: "text", text: "Open questions" },
      ...quotes.map((quote) => {
        return {
          type: "feedback" as const,
          quote,
          note: [reference],
        };
      }),
      { type: "text", text: "End of review" },
    ]),
  ]);
  const turn = await messageAt("Open questions");
  const group = within(turn).getByText(
    "Quoted 2 parts of your reply",
  ).parentElement!;
  for (const quote of quotes) {
    const row = within(group).getByText(quote, {
      selector: "blockquote",
    }).parentElement!;
    expect(getNamedLink("Project Alpha", row)).toHaveAttribute(
      "href",
      "/chats/" + sourceChat,
    );
  }
  expect(turn.textContent).toMatch(
    /Open questions.*Quoted 2 parts of your reply.*Estimate freight separately.*Project Alpha.*Confirm the delivery date.*Project Alpha.*End of review/s,
  );
});

test("chat-message-structured-content-008 keeps the original file and source in their chat while opening a companion", async () => {
  const file = "receipts-august.txt";
  const sourceRun = "382e6021-e0d9-4438-8828-f9f5fec471f3";
  const href = "/chats/" + sourceChat + "#run-" + sourceRun;
  await openReview([
    entry([
      { type: "text", text: "Reconcile these receipts" },
      {
        type: "source",
        kind: "agent",
        agentId: author,
        threadId: sourceChat,
        runId: sourceRun,
        titleSnapshot: "Receipts intake",
        href,
      },
      {
        type: "file",
        fileId: "receipts-august",
        filenameSnapshot: file,
        contentType: "text/plain",
      },
    ]),
  ]);
  const origin = await messageAt("Reconcile these receipts");
  expect(within(origin).getByText(file)).toBeInTheDocument();
  expect(getNamedLink("Receipts intake", origin)).toHaveAttribute("href", href);
  const user = userEvent.setup({ delay: null });
  await user.keyboard("{Alt>}");
  await user.click(await findNamedLink("Companion desk"));
  await user.keyboard("{/Alt}");
  await waitFor(() => {
    for (const id of [ATTACHMENT_THREAD_ID, SECOND_ATTACHMENT_THREAD_ID]) {
      const pane = document.querySelector<HTMLElement>(
        `[data-chat-thread-container-id="${id}"]`,
      );
      expect(pane).toBeInTheDocument();
      const composer = within(pane!).getByRole("textbox", { name: "Message" });
      expect(composer).toHaveAttribute("contenteditable", "true");
      expect(composer).toBeEnabled();
    }
  });
  const originalPane = document.querySelector<HTMLElement>(
    `[data-chat-thread-container-id="${ATTACHMENT_THREAD_ID}"]`,
  )!;
  const retained = within(originalPane)
    .getByText("Reconcile these receipts")
    .closest<HTMLElement>('[data-role="user"]')!;
  expect(within(retained).getByText(file)).toBeInTheDocument();
  expect(getNamedLink("Receipts intake", retained)).toHaveAttribute(
    "href",
    href,
  );
});
