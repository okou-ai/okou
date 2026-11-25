import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  completedMarkdownReply,
  createMarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";
const context = testContext();
test("markdown-interactions-001 copying the second snippet leaves the first copy action untouched", async () => {
  const sample = 'const second = "beta";';
  const clipboard = context.mocks.browser.clipboardWriteText();
  const path = completedMarkdownReply(
    context,
    [
      "~~~typescript",
      'const first = "alpha";',
      "~~~",
      "",
      "~~~typescript",
      sample,
      "~~~",
    ].join("\n"),
  );
  await setupPage({ context, path });
  const buttons = await screen.findAllByLabelText("Copy to clipboard");
  expect(buttons).toHaveLength(2);
  click(buttons[1]);
  await waitFor(() => {
    return expect(buttons[1]).toHaveAccessibleName("Copied");
  });
  expect(buttons[0]).toHaveAccessibleName("Copy to clipboard");
  expect(clipboard.writes).toStrictEqual([sample + "\n"]);
});
test("markdown-interactions-003 run completion preserves one copy of each rich message element", async () => {
  const chat = createMarkdownChatFixture(context),
    runId = crypto.randomUUID();
  const text = [
    "# Ledger digest",
    "",
    "**Signed** and *reviewed*",
    "",
    "~~~typescript",
    "const total = 2;",
    "~~~",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "> Quoted sum",
    "",
    "- open item",
    "",
    String.raw`\(x+2\) [Record][ref] ![Stable image](https://cdn.example.org/stable.png) <trial>literal</trial>`,
    "",
    "[ref]: https://example.org/record",
  ].join("\n");
  const rows = [
    chat.inputPrompt("Audit the digest", { seqId: 1, runId }),
    chat.outputMessage(text, { seqId: 2, runId }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await setupPage({ context, path: chat.path });
  await screen.findByRole("heading", { name: "Ledger digest" });
  const checkDigest = () => {
    const reply = screen
      .getByRole("heading", { name: "Ledger digest" })
      .closest('[data-role="assistant"]');
    if (!reply) {
      throw new Error("Missing digest response");
    }
    for (const selector of [
      "h1",
      "strong",
      "em",
      "pre code",
      "table",
      "blockquote",
      "ul",
      'img[alt="Stable image"]',
    ]) {
      expect(reply.querySelectorAll(selector)).toHaveLength(1);
    }
    expect(reply.querySelector("annotation")?.textContent).toBe("x+2");
    expect(
      reply.querySelector('a[href="https://example.org/record"]'),
    ).toHaveTextContent("Record");
    expect(reply).toHaveTextContent("<trial>literal</trial>");
  };
  await screen.findByText("x+2", { selector: "annotation" });
  checkDigest();
  await expect(screen.findByLabelText("Stop")).resolves.toBeVisible();
  rows.push(chat.runCompleted({ seqId: 3, runId }));
  context.mocks.ably.trigger(chat.realtimeTopic);
  await waitFor(() => {
    return expect(screen.queryByLabelText("Stop")).toBeNull();
  });
  checkDigest();
});
