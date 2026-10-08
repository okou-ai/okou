import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
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

function markdownFrameFor(element: Element): HTMLElement {
  const frame = element.closest<HTMLElement>(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected content inside a Markdown frame");
  }
  return frame;
}

function getButtonByName(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

function getLinkByName(
  name: string,
  container: ParentNode = document.body,
): HTMLAnchorElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name
    );
  });
  if (!link) {
    throw new Error(`Expected link named "${name}"`);
  }
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Expected link named "${name}" to be an anchor`);
  }
  return link;
}

async function openCodeCopyBlocks() {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "```typescript",
    'const first = "alpha";',
    "```",
    "",
    "```typescript",
    'const second = "beta";',
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  const clipboard = context.mocks.browser.clipboardWriteText();
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

  const [firstBlock, secondBlock] = await waitFor(() => {
    const codeBlocks = Array.from(
      document.querySelectorAll<HTMLElement>("pre"),
    ).filter((block) => {
      return block.querySelector("code.language-typescript") !== null;
    });
    expect(codeBlocks).toHaveLength(2);
    const first = codeBlocks[0];
    const second = codeBlocks[1];
    if (!first || !second) {
      throw new Error("Expected two TypeScript code blocks");
    }
    getButtonByName("Copy to clipboard", first);
    getButtonByName("Copy to clipboard", second);
    return [first, second] as const;
  });
  const firstCopy = getButtonByName("Copy to clipboard", firstBlock);
  const secondCopy = getButtonByName("Copy to clipboard", secondBlock);
  return { firstCopy, secondCopy, clipboard };
}

test("Copying one of several code blocks confirms only that block", async () => {
  const { firstCopy, secondCopy, clipboard } = await openCodeCopyBlocks();
  click(secondCopy);
  await waitFor(() => {
    expect(secondCopy).toHaveAttribute("aria-label", "Copied");
  });
  expect(firstCopy).toHaveAttribute("aria-label", "Copy to clipboard");
  expect(clipboard.writes).toStrictEqual(['const second = "beta";\n']);
});

test("External links open safely in a new context", async () => {
  const chat = createMarkdownChatFixture(context);
  const rows = completedMessageRows(
    chat,
    "Read the [Example website](https://example.com).",
  );
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

  await screen.findByText("Example website");
  const link = getLinkByName("Example website");

  click(link);

  expect(link.href).toBe("https://example.com/");
  expect(link.target).toBe("_blank");
  expect(link.rel.split(/\s+/)).toStrictEqual(
    expect.arrayContaining(["noopener", "noreferrer"]),
  );
});

test("Repeated rendering keeps rich message content stable", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "## Stable report",
    "",
    "A **bold conclusion** with *supporting emphasis*.",
    "",
    "```typescript",
    "const stable = true;",
    "```",
    "",
    "| Item | State |",
    "| --- | --- |",
    "| Layout | Stable |",
    "",
    "> Quoted evidence",
    "",
    "- First point",
    "- Second point",
    "",
    String.raw`Math source: $$x^2 + y^2$$`,
    "",
    "[Reference](https://example.com/reference)",
    "",
    "![Stable image](https://media.example.com/stable.png)",
    "",
    "<custom-note>Literal raw HTML</custom-note>",
  ].join("\n");
  const rows = [chat.outputMessage(source, { seqId: 1 })];
  const updateRequested = context.mocks.deferred<void>();
  chat.install({
    rows: () => {
      return rows;
    },
    onRowsRequest: (sinceSeqId) => {
      if (sinceSeqId > 0 && !updateRequested.settled()) {
        updateRequested.resolve();
      }
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
  });

  const heading = await screen.findByRole("heading", {
    name: "Stable report",
  });
  const frame = markdownFrameFor(heading);
  const image = await screen.findByRole("img", { name: "Stable image" });
  fireEvent.load(image);
  expect(frame.querySelectorAll("h2")).toHaveLength(1);
  expect(frame.querySelectorAll("strong")).toHaveLength(1);
  expect(frame.querySelectorAll("pre code.language-typescript")).toHaveLength(
    1,
  );
  expect(frame.querySelectorAll("table")).toHaveLength(1);
  expect(frame.querySelectorAll("blockquote")).toHaveLength(1);
  expect(frame.querySelectorAll("ul")).toHaveLength(1);
  expect(frame).toHaveTextContent("$$x^2 + y^2$$");
  expect(getLinkByName("Reference", frame)).toHaveAttribute(
    "href",
    "https://example.com/reference",
  );
  expect(frame).toHaveTextContent(
    /<custom-note>Literal raw HTML<\/custom-note>/i,
  );

  rows.push(chat.runCompleted({ seqId: 2, sequenceNumber: 2 }));
  context.mocks.ably.trigger(chat.realtimeTopic);
  await updateRequested.promise;

  await waitFor(() => {
    const currentHeading = screen.getByRole("heading", {
      name: "Stable report",
    });
    const currentFrame = markdownFrameFor(currentHeading);
    expect(currentFrame.querySelectorAll("h2")).toHaveLength(1);
    expect(currentFrame.querySelectorAll("strong")).toHaveLength(1);
    expect(
      currentFrame.querySelectorAll("pre code.language-typescript"),
    ).toHaveLength(1);
    expect(currentFrame.querySelectorAll("table")).toHaveLength(1);
    expect(currentFrame.querySelectorAll("blockquote")).toHaveLength(1);
    expect(currentFrame.querySelectorAll("ul")).toHaveLength(1);
    expect(currentFrame).toHaveTextContent("$$x^2 + y^2$$");
    expect(currentFrame).toHaveTextContent("Literal raw HTML");
    expect(
      currentFrame.querySelectorAll('img[alt="Stable image"]'),
    ).toHaveLength(1);
  });
});

test("A user can copy a code block", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "```typescript",
    'const greeting: string = "hello";',
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  const clipboard = context.mocks.browser.clipboardWriteText();
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

  const code = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      "code.language-typescript",
    );
    if (!element) {
      throw new Error("Expected the TypeScript code block");
    }
    expect(element.textContent).toBe('const greeting: string = "hello";\n');
    return element;
  });
  const codeBlock = code.closest("pre");
  if (!codeBlock) {
    throw new Error("Expected code inside a preformatted block");
  }
  const copy = getButtonByName("Copy to clipboard", codeBlock);

  click(copy);

  await waitFor(() => {
    expect(copy).toHaveAttribute("aria-label", "Copied");
  });
  expect(clipboard.writes).toStrictEqual([
    'const greeting: string = "hello";\n',
  ]);
});
