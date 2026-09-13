import mermaid from "@okouai/mermaid-lite";
import {
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
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

function diagramButtons(container: ParentNode = document.body): HTMLElement[] {
  return queryAllByRoleFast("button", container).filter((button) => {
    return button.getAttribute("aria-label") === "Expand diagram";
  });
}

async function openMermaidSplitView() {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    900,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    600,
  );
  const chat = createMarkdownChatFixture(context);
  const source = [
    "```mermaid",
    "flowchart TD",
    "  First --> Preview",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Reader->>Platform: Expand second",
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    locale: "en-US",
    context,
    path: chat.path,
    host: "app.okou.ai",
  });

  const [inlineImages, expandActions] = await waitFor(() => {
    const images = screen.getAllByRole("img", { name: "Diagram" });
    const actions = diagramButtons();
    expect(images).toHaveLength(2);
    expect(actions).toHaveLength(2);
    return [images, actions] as const;
  });
  const firstExpand = expandActions[0];
  const secondExpand = expandActions[1];
  if (!firstExpand || !secondExpand) {
    throw new Error("Expected two diagram expand actions");
  }
  expect(firstExpand).toBeEnabled();
  expect(secondExpand).toBeEnabled();
  expect(inlineImages).toHaveLength(2);

  click(firstExpand);

  const dialog = await screen.findByRole("dialog", {
    name: "diagram.svg preview",
  });
  expect(getButtonByName("Open in split view", dialog)).toBeVisible();
  expect(
    queryAllByRoleFast("button", dialog).some((button) => {
      return button.getAttribute("aria-label") === "Share";
    }),
  ).toBeFalsy();

  const dialogRemoved = waitForElementToBeRemoved(dialog);
  click(getButtonByName("Open in split view", dialog));

  const sidebar = await screen.findByTestId("artifact-sidebar");
  expect(within(sidebar).getByText("diagram.svg")).toBeVisible();
  const firstSidebarImage = await within(sidebar).findByRole("img", {
    name: "diagram.svg",
  });
  const firstSidebarSource = firstSidebarImage.getAttribute("src");
  await dialogRemoved;
  return { sidebar, firstSidebarSource, secondExpand };
}

test("Opening another Mermaid diagram replaces the current artifact split view", async () => {
  const { sidebar, firstSidebarSource, secondExpand } =
    await openMermaidSplitView();
  click(secondExpand);

  await waitFor(() => {
    const currentImage = within(sidebar).getByRole("img", {
      name: "diagram.svg",
    });
    expect(currentImage.getAttribute("src")).not.toBe(firstSidebarSource);
  });
  expect(
    screen.queryByRole("dialog", { name: "diagram.svg preview" }),
  ).toBeNull();
});

test("Closing a Mermaid artifact split view preserves both inline diagrams and sources", async () => {
  const { sidebar } = await openMermaidSplitView();
  const sidebarRemoved = waitForElementToBeRemoved(sidebar);
  click(getButtonByName("Close artifact", sidebar));

  await sidebarRemoved;
  expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
  expect(screen.getAllByText("Diagram source")).toHaveLength(2);
});

test("Completed Mermaid diagrams remain accessible and inspectable", async () => {
  const chat = createMarkdownChatFixture(context);
  const renderGate = context.mocks.deferred<void>();
  const renderDiagram = mermaid.render.bind(mermaid);
  vi.spyOn(mermaid, "render").mockImplementation(async (...args) => {
    await renderGate.promise;
    return await renderDiagram(...args);
  });
  const diagramSource = ["flowchart TD", "  Accessible --> Diagram"].join("\n");
  const source = [
    "```mermaid",
    diagramSource,
    "```",
    "",
    "```mermaid",
    diagramSource,
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

  const pendingActions = await waitFor(() => {
    const actions = diagramButtons();
    expect(actions).toHaveLength(2);
    return actions;
  });
  for (const pendingAction of pendingActions) {
    expect(pendingAction).toBeDisabled();
  }
  expect(screen.getAllByText("Diagram source")).toHaveLength(2);
  const sourceBlocks = Array.from(
    document.querySelectorAll<HTMLElement>(".mermaid-diagram-source code"),
  );
  expect(sourceBlocks).toHaveLength(2);
  expect(
    sourceBlocks.every((sourceBlock) => {
      return sourceBlock.textContent === diagramSource;
    }),
  ).toBeTruthy();

  renderGate.resolve();

  await waitFor(() => {
    expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
    expect(diagramButtons()).toHaveLength(2);
    expect(
      diagramButtons().every((button) => {
        return !button.hasAttribute("disabled");
      }),
    ).toBeTruthy();
  });
});

test("A streaming Mermaid diagram stays readable until complete", async () => {
  const chat = createMarkdownChatFixture(context);
  const streamingEventId = "markdown-streaming-event";
  const partialSource = [
    "```mermaid",
    "flowchart TD",
    "  Completed --> Independent",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  Reader->>Platform: Partial",
  ].join("\n");
  const completeSource = `${partialSource}\n\`\`\``;
  const rows = [
    chat.outputMessage(partialSource, {
      id: streamingEventId,
      seqId: 1,
      runEventId: "markdown-streaming-message",
    }),
  ];
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

  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeVisible();
  const partialCode = document.querySelector("code.language-mermaid");
  expect(partialCode).not.toBeNull();
  expect(partialCode).toHaveTextContent("sequenceDiagram");
  expect(partialCode).toHaveTextContent("Reader->>Platform: Partial");
  expect(partialCode).toBeVisible();
  expect(diagramButtons()).toHaveLength(1);

  rows[0] = chat.outputMessage(completeSource, {
    id: streamingEventId,
    seqId: 2,
    sequenceNumber: 1,
    runEventId: "markdown-streaming-message",
  });
  rows.push(
    chat.runCompleted({
      seqId: 3,
      sequenceNumber: 2,
    }),
  );
  context.mocks.ably.trigger(chat.realtimeTopic);

  await waitFor(() => {
    expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
    expect(document.querySelector("code.language-mermaid")).toBeNull();
    expect(diagramButtons()).toHaveLength(2);
  });
});
