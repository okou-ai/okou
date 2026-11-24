import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  setupPage,
  queryAllByRoleFast,
  click,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  mockAttachmentChat,
  ATTACHMENT_THREAD_ID,
  ATTACHMENT_RUN_ID,
} from "./chat-attachment-test-helpers.ts";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { installCorrespondence } from "./correspondence-test-fixtures.ts";
import {
  RUN_PATH,
  RUN_THREAD_ID,
  findEnabledButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

test("chat-thread-link-chips-001 preserves the destination and authored label of chat references in the transcript", async () => {
  const path = "/chats/0cc5555b-52a2-4b68-80f7-b30145551234";
  const chat = `https://app.okou.ai${path}`;
  const deep = path + "?view=notes#decision";
  const deepUrl = `https://app.okou.ai${deep}`;
  const external = "https://studio.example.com/calendar";
  mockAttachmentChat(context, {
    chatEvents: [
      {
        role: "user",
        content: `Read ${chat} and start at ${deepUrl} alongside ${external}`,
        runId: ATTACHMENT_RUN_ID,
        seqId: 1,
        createdAt: "2026-08-02T02:00:00Z",
      },
      {
        role: "assistant",
        content: `See ${chat}, [Decision notes](${deep}) and [Calendar](${external}). Literal: \`${chat}\``,
        runId: ATTACHMENT_RUN_ID,
        seqId: 2,
        createdAt: "2026-08-02T02:10:00Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const label = await screen.findByLabelText("Open chat Decision notes");
  const reply = label.closest<HTMLElement>("[data-role='assistant']")!;
  const message = await screen.findByText(chat, {
    selector: "[data-role='user'] a span",
  });
  const userTurn = message.closest<HTMLElement>("[data-role='user']")!;
  for (const turn of [userTurn, reply]) {
    const scoped = within(turn);
    expect(scoped.getByLabelText(`Open chat ${chat}`)).toHaveAttribute(
      "href",
      path,
    );
    const outbound = queryAllByRoleFast("link", turn).find((link) => {
      return link.getAttribute("href") === external;
    });
    expect(outbound).toHaveAttribute("target", "_blank");
    expect(outbound?.getAttribute("rel")?.split(/\s+/)).toStrictEqual(
      expect.arrayContaining(["noopener", "noreferrer"]),
    );
  }
  expect(
    within(userTurn).getByLabelText(`Open chat ${deepUrl}`),
  ).toHaveAttribute("href", deep);
  expect(label).toHaveTextContent("Decision notes");
  expect(label).toHaveAttribute("href", deep);
  const code = within(reply).getByText(chat, { selector: "code" });
  expect(code.closest("a")).toBeNull();
  expect(queryAllByRoleFast("link", reply)).toHaveLength(3);
});

const peer = "6e06ce72-c28d-42b2-b958-5828787cce82";

const memberRun = "0857bfa2-44f3-4e13-b200-2a97717357b2";

async function readCorrespondence(doc: UserMessageDocument) {
  const clipboard = context.mocks.browser.clipboardWrite();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        ...promptEvent({
          id: crypto.randomUUID(),
          runId: memberRun,
          seqId: 1,
          text: "Recorded correspondence",
        }),
        userMessage: doc,
      },
    ],
  });
  const display = installCorrespondence(context, RUN_THREAD_ID, () => {
    return doc;
  });
  await setupPage({ context, path: RUN_PATH });
  click(await findEnabledButton("Copy message"));
  const item = await waitFor(() => {
    const copied = clipboard.writes.at(-1)?.[0];
    if (!copied) {
      throw new Error("Waiting for the copied message");
    }
    return copied;
  });
  const prompt = await (await item.getType("text/plain")).text();
  return { prompt, display: await display() };
}

test.each([
  ["draft with note", "draft", ["Budget sign-off"], ["Add the updated figure"]],
  ["sent correspondence", "sent", ["Release approved"], [""]],
  [
    "two draft excerpts",
    "draft",
    ["Delivery date", "Warranty period"],
    ["", "Use two years"],
  ],
] as const)(
  "user-message-document-006 Forwarding %s preserves its source and the order of its quotes",
  async (_case, status, quotes, notes) => {
    const source = {
      type: "mail",
      status,
      id: "local-correspondence",
      ...(status === "sent" ? { sentId: "local-sent-receipt" } : {}),
    } as const;
    const parts: UserMessageDocument["parts"] = [
      {
        type: "chat_thread",
        threadId: peer,
        runId: memberRun,
        titleSnapshot: "Source launch plan",
      },
    ];
    for (const [i, quote] of quotes.entries()) {
      const note = notes[i];
      parts.push({
        type: "feedback",
        source,
        quote,
        note: note ? [{ type: "text", text: note }] : [],
      });
    }
    const { prompt, display } = await readCorrespondence({ version: 1, parts });
    for (const text of [prompt, display]) {
      expect(text).toContain("Source launch plan");
      expect(text).toContain("local-correspondence");
      expect(text.includes("local-sent-receipt")).toBe(status === "sent");
      const positions = quotes.map((quote) => {
        return text.indexOf(quote);
      });
      expect(
        positions.every((p) => {
          return p >= 0;
        }),
      ).toBeTruthy();
      expect(positions).toStrictEqual(
        [...positions].sort((a, b) => {
          return a - b;
        }),
      );
      expect(text.includes("2 parts")).toBe(quotes.length === 2);
      for (const note of notes.filter(Boolean)) {
        expect(text).toContain(note);
      }
    }
  },
);
