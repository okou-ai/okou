import mermaid from "@okouai/mermaid-lite";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

warmMermaidParser();

function completedMessageRows(chat: MarkdownChatFixture, content: string) {
  return [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
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

test("Sequence diagrams render in chat", async () => {
  const chat = createMarkdownChatFixture(context);
  const sequenceSource = [
    "sequenceDiagram",
    "  participant Reader",
    "  participant Platform",
    "  Reader->>Platform: Show sequence",
    "  Platform-->>Reader: Render diagram",
  ].join("\n");
  const source = ["```mermaid", sequenceSource, "```"].join("\n");
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

  const diagram = await screen.findByRole("img", { name: "Diagram" });
  expect(diagram).toBeVisible();
  expect(getButtonByName("Expand diagram")).toBeEnabled();
});

test("A failed Mermaid layout leaves its source readable and other diagrams usable", async () => {
  vi.spyOn(mermaid, "render").mockRejectedValueOnce(
    new Error("Diagram layout failed"),
  );
  const chat = createMarkdownChatFixture(context);
  const failedSource = "flowchart TD\n  Failed --> Layout";
  const source = [
    "```mermaid",
    failedSource,
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Reader->>Platform: Surviving diagram",
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
    const fallback = screen.getByText("flowchart TD Failed --> Layout", {
      selector: "pre > code",
    });
    expect(fallback).toBeVisible();
    expect(fallback.closest("details")).toBeNull();
  });
  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeVisible();
  expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(1);
  click(getButtonByName("Expand diagram"));
  await expect(
    screen.findByRole("dialog", { name: "diagram.svg preview" }),
  ).resolves.toBeInTheDocument();
});
