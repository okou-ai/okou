import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

function completedMessageRows(chat: MarkdownChatFixture, content: string) {
  return [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
}

test("Agent formulas render from explicit delimiters without treating currency as math", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "Portfolio value is $2,499 and ticker $ABC$.",
    "",
    String.raw`Inline \(E = mc^2\).`,
    "",
    String.raw`Valid marker \(\text{okou-katex-error}\) renders.`,
    "",
    String.raw`Invalid \(\notARealCommand{x}\) stays readable.`,
    "",
    String.raw`Fatal \(\frac{\) stays readable.`,
    "",
    String.raw`\[`,
    String.raw`\begin{aligned}`,
    String.raw`x &= 1 \\`,
    "y &= 2",
    String.raw`\end{aligned}`,
    String.raw`\]`,
    "",
    String.raw`$$\int_0^1 x^2 \, dx$$`,
    "",
    "`\\(code\\)`",
    "",
    "```text",
    String.raw`\[not math\]`,
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(
      [...document.querySelectorAll("[data-math-status]")].map((element) => {
        return (element as HTMLElement).dataset.mathStatus;
      }),
    ).toStrictEqual([
      "rendered",
      "rendered",
      "hasError",
      "hasError",
      "rendered",
      "rendered",
    ]);
    expect(document.querySelectorAll("math")).toHaveLength(4);
  });
  expect(document.querySelectorAll('math[display="block"]')).toHaveLength(2);
  const message = await screen.findByText(/Portfolio value is/);
  const frame = message.closest(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected the formulas inside a Markdown frame");
  }
  expect(frame).toHaveTextContent("Portfolio value is $2,499");
  expect(frame).toHaveTextContent("ticker $ABC$");
  expect(frame).toHaveTextContent(String.raw`\text{okou-katex-error}`);
  expect(frame).toHaveTextContent(String.raw`\(\notARealCommand{x}\)`);
  expect(frame).toHaveTextContent(String.raw`\(\frac{\)`);
  expect(frame.querySelector("code")).toHaveTextContent(String.raw`\(code\)`);
  expect(frame.querySelector("pre code")).toHaveTextContent(
    String.raw`\[not math\]`,
  );
});

test("Shared Agent formulas render", async () => {
  const sharedThreadId = "30000000-0000-4000-8000-000000000703";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      id: sharedThreadId,
      title: "Shared formula",
      publicBrand: "okou",
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          content: String.raw`Shared \(x^2\) formula.`,
          runIndex: 0,
        },
      ],
    });
  });

  await setupPage({
    context,
    path: `/share/threads/${sharedThreadId}`,
    host: "app.okou.ai",
  });

  await waitFor(() => {
    expect(
      document.querySelector("[data-math-status=rendered]"),
    ).not.toBeNull();
  });
  expect(document.querySelectorAll("math")).toHaveLength(1);
});

test("Dollar prose is left alone", async () => {
  const chat = createMarkdownChatFixture(context);
  const source =
    "Portfolio value is $2,499, ticker $ABC$, and inline $$not math$$.";
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
  });

  await screen.findByText(/Portfolio value is/);
  expect(document.body).toHaveTextContent(source);
  expect(document.querySelector("math")).toBeNull();
});
