import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();

warmMermaidParser();

const FILE_ID = "f0000000-0000-4000-a000-000000000943";
const NOTE = "https://app.okou.ai/artifacts/diagnote01.md";
const NOTE_URL = "https://artifacts.example.com/diagram-note.md";
const DIAGRAM = "```mermaid\nflowchart LR\n  Draft --> Review\n```";

function actionNames(container: ParentNode): readonly string[] {
  return queryAllByRoleFast("button", container)
    .map((button) => {
      return button.getAttribute("aria-label") ?? button.textContent?.trim();
    })
    .sort();
}

function getButtonByName(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Expected button named "${name}"`);
  }
  return button;
}

function getExpandButton(container: ParentNode = document.body): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === "Expand diagram";
  });
  if (!button) {
    throw new Error("Expected an expandable diagram");
  }
  return button;
}

async function findDiagramDialog(): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByTestId("attachment-lightbox-image");
  return dialog;
}

test("a diagram in a shared conversation expands in the conversation", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: `Here is the flow.\n\n${DIAGRAM}`,
            runIndex: 0,
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByText("Here is the flow."),
  ).resolves.toBeInTheDocument();
  const expand = await waitFor(() => {
    return getExpandButton();
  });
  await waitFor(() => {
    expect(expand).toBeEnabled();
  });

  click(expand);

  const dialog = await findDiagramDialog();
  const image = within(dialog).getByTestId("attachment-lightbox-image");
  const source = image.getAttribute("src");
  if (!source) {
    throw new Error("Expected the expanded diagram to have a source");
  }
  expect(browser.blobForUrl(source)?.type).toBe("image/svg+xml");
  expect(within(dialog).getByText("diagram.svg")).toBeInTheDocument();
  // The diagram was drawn in this browser, so its address is dead anywhere
  // else and the dialog offers the copy that is worth something instead.
  expect(actionNames(dialog)).toStrictEqual([
    "Close",
    "Download",
    "Enter fullscreen",
  ]);

  click(getButtonByName("Download", dialog));

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  // The rendered bytes are already in the page, so saving them needs no fetch.
  expect(browser.downloads[0]?.url).toBe(source);
  expect(browser.downloads[0]?.filename).toBe("diagram.svg");
  await expect(browser.downloads[0]?.blob?.text()).resolves.toContain("<svg");
});

test("a diagram inside a shared Markdown artifact expands in the conversation", async () => {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: NOTE_URL,
      filename: "diagram-note.md",
      contentType: "text/markdown",
      expiresAt: "2099-01-01T00:00:00Z",
      sharedThreadSnapshot: true,
      target: { kind: "file", id: FILE_ID },
    });
  });
  context.mocks.http.get(NOTE_URL, () => {
    return HttpResponse.text(`Review the flow.\n\n${DIAGRAM}`, {
      headers: { "Content-Type": "text/markdown" },
    });
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content: `![Review notes](${NOTE})`,
            runIndex: 0,
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  click(await screen.findByTestId("markdown-artifact-preview-markdown"));

  const noteDialog = await screen.findByRole("dialog");
  await expect(
    within(noteDialog).findByText("Review the flow."),
  ).resolves.toBeInTheDocument();
  const expand = await waitFor(() => {
    return getExpandButton(noteDialog);
  });
  await waitFor(() => {
    expect(expand).toBeEnabled();
  });

  click(expand);

  const dialog = await findDiagramDialog();
  expect(within(dialog).getByText("diagram.svg")).toBeInTheDocument();
});
