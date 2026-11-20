import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
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

function colorPreviews(container: ParentNode = document) {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-markdown-color-preview]"),
  );
}

test("A blockquote remains recognizable when HTML is treated as text", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "> Quoted passage",
    "> <DangerousWidget>literal HTML-like content</DangerousWidget>",
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

  const quotedText = await screen.findByText(/Quoted passage/);
  const blockquote = quotedText.closest("blockquote");
  if (!blockquote) {
    throw new Error("Expected the quoted passage inside a blockquote");
  }
  expect(blockquote).toHaveTextContent("Quoted passage");
  expect(blockquote).toHaveTextContent(
    /<dangerouswidget>literal HTML-like content<\/dangerouswidget>/i,
  );
  expect(blockquote.textContent?.trim().startsWith("> ")).toBeFalsy();
});

test("Common Markdown features remain recognizable", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "**Bold feature** and *italic feature* and ~~deleted feature~~",
    "",
    "| Name | State |",
    "| --- | --- |",
    "| Report | Ready |",
    "",
    "- [x] Completed item",
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

  const bold = await screen.findByText("Bold feature");
  const frame = markdownFrameFor(bold);
  expect(bold.tagName).toBe("STRONG");
  expect(screen.getByText("italic feature").tagName).toBe("EM");
  expect(screen.getByText("deleted feature").tagName).toBe("DEL");

  const table = frame.querySelector("table");
  expect(table).not.toBeNull();
  expect(table).toHaveTextContent("Name");
  expect(table).toHaveTextContent("Report");
  expect(table).toHaveTextContent("Ready");

  const completedItem = frame.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(completedItem).not.toBeNull();
  expect(completedItem).toBeChecked();
});

test("Email contacts and compose templates keep their native mail destinations", async () => {
  const chat = createMarkdownChatFixture(context);
  const contacts = [
    { text: "jane@example.com", href: "mailto:jane@example.com" },
    { text: "Alex Rivera", href: "mailto:alex@example.com" },
    {
      text: "Contact the team",
      href: "mailto:first@example.com,second@example.com?subject=Hello",
    },
  ];
  const rows = completedMessageRows(
    chat,
    [
      "Jane Doe — Growth Lead — jane@example.com",
      "",
      "- [Alex Rivera](mailto:alex@example.com)",
      "- [Contact the team](mailto:first@example.com,second@example.com?subject=Hello)",
    ].join("\n"),
  );
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({ context, path: chat.path, host: "app.okou.ai" });

  const frame = markdownFrameFor(await screen.findByText("Alex Rivera"));
  for (const { text, href } of contacts) {
    const link = queryAllByRoleFast("link", frame).find((candidate) => {
      return candidate.textContent === text;
    });
    expect(link).toHaveAttribute("href", href);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
});

test("A complete HEX color has a preview in a plain assistant response", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = "Primary color #12ABef is ready.";
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
    expect(colorPreviews()).toHaveLength(1);
  });
  const preview = colorPreviews()[0];
  if (!preview) {
    throw new Error("Expected a visible HEX color preview");
  }
  expect(preview).toHaveAttribute("data-markdown-color-preview", "#12ABef");
  expect(preview).toBeVisible();
  expect(markdownFrameFor(preview)).toHaveTextContent(source);
});

test("Media links keep their text while image syntax shows a preview", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "[Product screenshot](https://media.example.com/product.png)",
    "",
    "![Embedded screenshot](https://media.example.com/product.png)",
    "",
    "[Walkthrough video](https://media.example.com/walkthrough.mp4)",
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

  const image = await screen.findByRole("img", {
    name: "Embedded screenshot",
  });
  fireEvent.load(image);
  expect(image).toBeVisible();
  expect(image).toHaveAttribute("src", "https://media.example.com/product.png");

  const frame = markdownFrameFor(image);
  const links = queryAllByRoleFast("link", frame);
  expect(
    links.find((link) => {
      return link.textContent === "Product screenshot";
    }),
  ).toHaveAttribute("href", "https://media.example.com/product.png");
  expect(
    links.find((link) => {
      return link.textContent === "Walkthrough video";
    }),
  ).toHaveAttribute("href", "https://media.example.com/walkthrough.mp4");
});
