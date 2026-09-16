import mermaid from "@okouai/mermaid-lite";
import {
  act,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import { expect, test, vi, describe, beforeEach, it } from "vitest";

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

describe.each(["settings", "system"] as const)(
  "an idle diagram remains available when the app theme changes through %s",
  (entry) => {
    async function prepareScenario() {
      const media = context.mocks.browser.matchMedia((query) => {
        return query === "(min-width: 48rem)";
      });
      const chat = createMarkdownChatFixture(context);
      const rows = completedMessageRows(
        chat,
        ["```mermaid", "flowchart TD", "  Plan --> Launch", "```"].join("\n"),
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
        locale: "en-US",
      });
      const image = await screen.findByRole("img", { name: "Diagram" });
      const source = image.getAttribute("src");
      let settingsDialog: HTMLElement | undefined;
      let darkButton: HTMLElement | undefined;
      expect(getButtonByName("Expand diagram")).toBeEnabled();

      if (entry === "settings") {
        const rail = await screen.findByTestId("labeled-nav-rail");
        click(within(rail).getByLabelText("Test User"));
        const menu = await screen.findByRole("menu");
        click(within(menu).getByText("Settings"));
        settingsDialog = await screen.findByRole("dialog", {
          name: "Settings",
        });
        darkButton = await waitFor(() => {
          return getButtonByName("Dark", settingsDialog);
        });
      }
      return { media, source, settingsDialog, darkButton };
    }
    let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
    beforeEach(async () => {
      preparedScenario = await prepareScenario();
    });
    it("keeps the same diagram available after changing the theme", async () => {
      const { media, source, settingsDialog, darkButton } = preparedScenario;
      if (entry === "settings") {
        if (!settingsDialog || !darkButton) {
          throw new Error("Expected the diagram theme settings to be ready");
        }
        click(darkButton);
        const settingsRemoved = waitForElementToBeRemoved(settingsDialog);
        click(within(settingsDialog).getByLabelText("Close"));
        await settingsRemoved;
      } else {
        act(() => {
          media.setMatches((query) => {
            return (
              query === "(min-width: 48rem)" ||
              query === "(prefers-color-scheme: dark)"
            );
          });
        });
      }

      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(screen.getByRole("img", { name: "Diagram" })).toHaveAttribute(
        "src",
        source,
      );
      expect(getButtonByName("Expand diagram")).toBeEnabled();
      click(getButtonByName("Expand diagram"));
      await expect(
        screen.findByRole("dialog", { name: "diagram.svg preview" }),
      ).resolves.toBeInTheDocument();
    });
  },
);

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

describe("with an expanded diagram", () => {
  async function prepareScenario() {
    const { sidebar, firstSidebarSource, secondExpand } =
      await openMermaidSplitView();
    if (!firstSidebarSource) {
      throw new Error("Expected the first sidebar diagram to have a blob URL");
    }
    return { secondExpand, sidebar, firstSidebarSource };
  }
  let preparedScenario: Awaited<ReturnType<typeof prepareScenario>>;
  beforeEach(async () => {
    preparedScenario = await prepareScenario();
  });
  it("opening another Mermaid diagram releases and replaces the current artifact split view", async () => {
    const { secondExpand, sidebar, firstSidebarSource } = preparedScenario;
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    click(secondExpand);

    const secondSidebarSource = await waitFor(() => {
      const currentImage = within(sidebar).getByRole("img", {
        name: "diagram.svg",
      });
      const source = currentImage.getAttribute("src");
      if (!source) {
        throw new Error("Expected the replacement diagram to have a blob URL");
      }
      expect(source).not.toBe(firstSidebarSource);
      return source;
    });
    expect(revokeObjectUrl).toHaveBeenCalledWith(firstSidebarSource);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith(secondSidebarSource);
    expect(
      screen.queryByRole("dialog", { name: "diagram.svg preview" }),
    ).toBeNull();
  });
});

test("Closing a Mermaid artifact split view releases its blob and preserves the inline diagrams", async () => {
  const { sidebar, firstSidebarSource } = await openMermaidSplitView();
  if (!firstSidebarSource) {
    throw new Error("Expected the sidebar diagram to have a blob URL");
  }
  const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
  const sidebarRemoved = waitForElementToBeRemoved(sidebar);
  click(getButtonByName("Close artifact", sidebar));

  await sidebarRemoved;
  expect(revokeObjectUrl).toHaveBeenCalledWith(firstSidebarSource);
  expect(screen.getAllByRole("img", { name: "Diagram" })).toHaveLength(2);
  expect(screen.getAllByText("Diagram source")).toHaveLength(2);
});

test("Leaving the page releases the active Mermaid artifact split view blob", async () => {
  const { firstSidebarSource } = await openMermaidSplitView();
  if (!firstSidebarSource) {
    throw new Error("Expected the sidebar diagram to have a blob URL");
  }
  const agentsLink = queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === "Agents";
  });
  if (!agentsLink) {
    throw new Error("Expected the Agents navigation link");
  }
  const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");

  click(agentsLink);

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeInTheDocument();
  expect(revokeObjectUrl).toHaveBeenCalledWith(firstSidebarSource);
});

test("Completed Mermaid diagrams remain accessible and inspectable", async () => {
  const browser = context.mocks.browser.blobDownload();
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
  const rows = [chat.outputMessage("Preparing diagrams.", { seqId: 1 })];
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
  await expect(screen.findByText("Preparing diagrams.")).resolves.toBeVisible();

  rows.push(
    chat.outputMessage(source, { seqId: 2 }),
    chat.runCompleted({ seqId: 3 }),
  );
  context.mocks.ably.trigger(chat.realtimeTopic);

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
    document.querySelectorAll<HTMLElement>(
      '[data-slot="mermaid-diagram-source"] code',
    ),
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
  const urls = screen.getAllByRole("img", { name: "Diagram" }).map((image) => {
    return image.getAttribute("src");
  });
  expect(new Set(urls).size).toBe(2);
  for (const url of urls) {
    if (!url) {
      throw new Error("Expected an independently owned diagram image URL");
    }
    expect(browser.blobForUrl(url)?.type).toBe("image/svg+xml");
    expect(browser.revokedUrls).not.toContain(url);
  }
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
