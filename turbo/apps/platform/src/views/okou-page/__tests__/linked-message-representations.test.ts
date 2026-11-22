import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { installCorrespondence } from "./correspondence-test-fixtures.ts";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  RUN_PATH,
  RUN_THREAD_ID,
  findEnabledButton,
  promptEvent,
} from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
const context = testContext();
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
