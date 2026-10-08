import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_THREAD_ID,
  ATTACHMENT_RUN_ID,
  artifactFile,
  findNamedLink,
  getNamedButton,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
warmMermaidParser();

async function openDocument() {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const browser = context.mocks.browser.blobDownload();
  const url = publicArtifactUrl("diagram-notes.md");
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Deployment notes\n\nParagraph 1\n\nParagraph 2\n\nParagraph 3\n\nParagraph 4\n\nParagraph 5\n\nParagraph 6\n\n```mermaid\nflowchart LR\n  Build --> Deploy\n```",
    );
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: "diagram-artifact-message",
        role: "assistant",
        content: `[Deployment notes](${url})`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: "diagram-artifact-event",
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: [
      artifactFile("diagram-notes.md", { contentType: "text/markdown" }),
    ],
  });
  await setupPage({ context, path: `/chats/${ATTACHMENT_THREAD_ID}` });
  const card = await findNamedLink("Deployment notes");
  click(card);
  const documentDialog = await screen.findByTestId("attachment-lightbox");
  await within(documentDialog).findByRole("img", { name: "Diagram" });
  return { browser, documentDialog };
}

test.each([false, true])(
  "closing an expanded diagram preserves its document, source and reading position (fullscreen: %s)",
  async (fullscreen) => {
    const { browser, documentDialog } = await openDocument();
    if (fullscreen) {
      click(getNamedButton("Enter fullscreen", documentDialog));
    }
    await waitFor(() => {
      expect(documentDialog).toHaveAttribute(
        "data-mode",
        fullscreen ? "fullscreen" : "windowed",
      );
    });
    const viewport = within(documentDialog).getByTestId(
      "artifact-dialog-stage",
    );
    viewport.scrollTop = 120;
    click(within(documentDialog).getByText("Diagram source"));
    const trigger = getNamedButton("Expand diagram", documentDialog);
    const inlineUrl = within(documentDialog)
      .getByRole("img", { name: "Diagram" })
      .getAttribute("src");
    click(trigger);
    const diagram = await screen.findByTestId("artifact-diagram-lightbox");
    const image = within(diagram).getByAltText("diagram.svg");
    const expandedUrl = image.getAttribute("src");
    expect(expandedUrl).not.toBe(inlineUrl);
    expect(
      within(documentDialog).getByText("Deployment notes", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(documentDialog).toHaveAttribute(
      "data-mode",
      fullscreen ? "fullscreen" : "windowed",
    );
    await waitFor(() => {
      return expect(diagram.contains(document.activeElement)).toBeTruthy();
    });
    click(getNamedButton("Fill view", diagram));
    await waitFor(() => {
      return expect(diagram).toHaveAttribute("data-mode", "fullscreen");
    });
    click(getNamedButton("Download", diagram));
    await waitFor(() => {
      return expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]).toMatchObject({
      filename: "diagram.svg",
      url: expandedUrl,
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(
        screen.queryByTestId("artifact-diagram-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(documentDialog).toHaveAttribute(
      "data-mode",
      fullscreen ? "fullscreen" : "windowed",
    );
    expect(viewport.scrollTop).toBe(120);
    expect(
      within(documentDialog).getByText("Diagram source").closest("details"),
    ).toHaveAttribute("open");
    expect(trigger).toHaveFocus();
    expect(browser.revokedUrls).toContain(expandedUrl);
    expect(browser.revokedUrls).not.toContain(inlineUrl);

    click(trigger);
    const reopened = await screen.findByTestId("artifact-diagram-lightbox");
    const reopenedUrl = within(reopened)
      .getByAltText("diagram.svg")
      .getAttribute("src");
    expect(reopenedUrl).not.toBe(expandedUrl);
    expect(browser.revokedUrls).not.toContain(reopenedUrl);
    click(getNamedButton("Close", reopened));
    await waitFor(() => {
      return expect(
        screen.queryByTestId("artifact-diagram-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(documentDialog).toBeInTheDocument();
    click(getNamedButton("Close", documentDialog));
    await waitFor(() => {
      return expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(browser.revokedUrls).toContain(inlineUrl);
  },
);

test("changing document fullscreen preserves the paragraph currently being read", async () => {
  const { documentDialog } = await openDocument();
  const viewport = within(documentDialog).getByTestId("artifact-dialog-stage");
  const wide = () => {
    return documentDialog.getAttribute("data-mode") === "fullscreen";
  };
  vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => {
    return new DOMRect(0, 10, wide() ? 800 : 400, 100);
  });
  for (let index = 0; index < 6; index++) {
    const paragraph = within(documentDialog).getByText(
      `Paragraph ${index + 1}`,
    );
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(() => {
      return new DOMRect(
        0,
        10 + index * (wide() ? 60 : 100) - viewport.scrollTop,
        wide() ? 800 : 400,
        wide() ? 40 : 80,
      );
    });
  }
  viewport.scrollTop = 190;
  click(getNamedButton("Enter fullscreen", documentDialog));
  await waitFor(() => {
    expect(documentDialog).toHaveAttribute("data-mode", "fullscreen");
  });
  expect(viewport.scrollTop).toBe(110);
  viewport.scrollTop = 295;
  click(getNamedButton("Exit fullscreen", documentDialog));
  await waitFor(() => {
    expect(documentDialog).toHaveAttribute("data-mode", "windowed");
  });
  expect(viewport.scrollTop).toBe(495);
});
