import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  findNamedButton,
  findNamedLink,
  mockAttachmentChat,
  publicArtifactUrl,
} from "./chat-attachment-test-helpers.ts";

const context = testContext();
warmMermaidParser();

/** A chat whose assistant links the given Markdown document. */
async function openDocument(filename: string, markdown: string) {
  const url = publicArtifactUrl(filename);
  context.mocks.http.get(url, () => {
    return HttpResponse.text(markdown);
  });
  mockAttachmentChat(context, {
    chatEvents: [
      {
        id: `${filename}-message`,
        role: "assistant",
        content: `The [${filename}](${url}) is ready.`,
        runId: ATTACHMENT_RUN_ID,
        runEventId: `${filename}-output`,
        sequenceNumber: 1,
        createdAt: "2026-03-10T00:00:01Z",
      },
    ],
    artifacts: [artifactFile(filename, { contentType: "text/markdown" })],
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ArtifactSidebarPreview]: false },
  });
  click(await findNamedLink(filename));
  const preview = await screen.findByTestId("attachment-lightbox");
  return {
    preview,
    stage: within(preview).getByTestId("artifact-dialog-stage"),
  };
}

function pressEscape(): void {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key: "Escape",
  });
}

test("closing an expanded diagram preserves its document, source and reading position (fullscreen: false)", async () => {
  const browser = context.mocks.browser.blobDownload();
  const { preview, stage } = await openDocument(
    "release-flow.md",
    [
      "# Release flow",
      "Every release follows the same review path.",
      "```mermaid\nflowchart LR\n  Draft --> Review --> Publish\n```",
      "Publishing waits for the final review.",
    ].join("\n\n"),
  );
  const trigger = await findNamedButton("Expand diagram", preview);
  const inlineUrl = await waitFor(() => {
    const src = within(trigger)
      .getByRole("img", { name: "Diagram" })
      .getAttribute("src");
    expect(src).toMatch(/^blob:/u);
    return src as string;
  });
  const source = preview.querySelector<HTMLDetailsElement>(
    '[data-slot="mermaid-diagram-source"]',
  );
  if (!source) {
    throw new Error("Expected the diagram source disclosure");
  }
  click(within(source).getByText("Diagram source"));
  await waitFor(() => {
    expect(source.open).toBeTruthy();
  });
  stage.scrollTop = 120;

  click(trigger);
  const expanded = await screen.findByTestId("artifact-diagram-lightbox");
  const expandedUrl = await waitFor(() => {
    const src = within(expanded)
      .getByRole("img", { name: "diagram.svg" })
      .getAttribute("src");
    expect(src).toMatch(/^blob:/u);
    return src as string;
  });
  expect(expandedUrl).not.toBe(inlineUrl);
  click(await findNamedButton("Fill view", expanded));
  await findNamedButton("Restore view", expanded);
  click(await findNamedButton("Download", expanded));
  await waitFor(() => {
    expect(
      browser.downloads.map(({ filename }) => {
        return filename;
      }),
    ).toStrictEqual(["diagram.svg"]);
  });
  pressEscape();

  await waitFor(() => {
    expect(expanded).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(browser.revokedUrls).toContain(expandedUrl);
  });
  expect(browser.revokedUrls).not.toContain(inlineUrl);
  expect(preview).toBeInTheDocument();
  expect(preview).toHaveAttribute("data-mode", "windowed");
  expect(stage.scrollTop).toBe(120);
  expect(source.open).toBeTruthy();
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });

  click(trigger);
  const reopened = await screen.findByTestId("artifact-diagram-lightbox");
  const reopenedUrl = await waitFor(() => {
    const src = within(reopened)
      .getByRole("img", { name: "diagram.svg" })
      .getAttribute("src");
    expect(src).toMatch(/^blob:/u);
    return src as string;
  });
  expect(reopenedUrl).not.toBe(expandedUrl);
  expect(browser.revokedUrls).not.toContain(reopenedUrl);
  click(await findNamedButton("Close", reopened));
  await waitFor(() => {
    expect(reopened).not.toBeInTheDocument();
  });
  expect(preview).toBeInTheDocument();

  pressEscape();
  await waitFor(() => {
    expect(preview).not.toBeInTheDocument();
  });
});

test("changing document fullscreen preserves the paragraph currently being read", async () => {
  // Wider fullscreen lines wrap less, so each paragraph is shorter there.
  const paragraphHeight = { windowed: 90, fullscreen: 50 } as const;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function measured(this: HTMLElement) {
      const stage = this.closest<HTMLElement>(
        '[data-testid="artifact-dialog-stage"]',
      );
      if (stage === this) {
        return new DOMRect(0, 0, 800, 100);
      }
      const mode = this.closest<HTMLElement>(
        '[data-testid="attachment-lightbox"]',
      )?.dataset.mode;
      if (!stage || this.tagName !== "P" || !mode) {
        return new DOMRect(0, 0, 0, 0);
      }
      const height =
        mode === "fullscreen"
          ? paragraphHeight.fullscreen
          : paragraphHeight.windowed;
      const index = [...stage.querySelectorAll("p")].indexOf(
        this as HTMLParagraphElement,
      );
      return new DOMRect(0, index * height - stage.scrollTop, 800, height);
    },
  );
  const { preview, stage } = await openDocument(
    "reading-notes.md",
    Array.from({ length: 6 }, (_, index) => {
      return `Reading note ${index + 1} explains one step of the launch.`;
    }).join("\n\n"),
  );
  await expect(
    within(preview).findByText(
      "Reading note 6 explains one step of the launch.",
    ),
  ).resolves.toBeInTheDocument();
  expect(preview).toHaveAttribute("data-mode", "windowed");
  stage.scrollTop = 190;

  click(await findNamedButton("Enter fullscreen", preview));

  await waitFor(() => {
    expect(preview).toHaveAttribute("data-mode", "fullscreen");
  });
  expect(stage.scrollTop).toBe(110);
  stage.scrollTop = 295;

  click(await findNamedButton("Exit fullscreen", preview));

  await waitFor(() => {
    expect(preview).toHaveAttribute("data-mode", "windowed");
  });
  expect(stage.scrollTop).toBe(495);
});
