import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  getNamedButton,
  queryNamedButton,
} from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";
import {
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
warmMermaidParser();

test("shared-thread-diagrams-001 downloads the displayed SVG from the conversation viewer", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            role: "assistant",
            messageIndex: 0,
            content:
              "Survey sequence\n\n```mermaid\nflowchart LR\nStart --> Finish\n```",
          },
        ],
      }),
    );
  });
  await setupSharedThreadPage(context);
  await expect(screen.findByAltText("Diagram")).resolves.toBeInTheDocument();
  click(getNamedButton("Expand diagram"));
  const viewer = await screen.findByRole("dialog");
  const preview = await within(viewer).findByRole("img", {
    name: "diagram.svg",
  });
  const imageUrl = preview.getAttribute("src");
  if (!imageUrl) {
    throw new Error("Missing rendered diagram URL");
  }
  const svg = browser.blobForUrl(imageUrl);
  expect(svg?.type).toBe("image/svg+xml");
  for (const name of [
    "Close",
    "Fill view",
    "Zoom in",
    "Zoom out",
    "Reset zoom",
  ]) {
    expect(getNamedButton(name, viewer)).toBeEnabled();
  }
  for (const name of ["Share", "Copy link", "Open in split view"]) {
    expect(queryNamedButton(name, viewer)).toBeNull();
  }

  click(getNamedButton("Download", viewer));
  await waitFor(() => {
    return expect(browser.downloads).toContainEqual({
      url: imageUrl,
      filename: "diagram.svg",
      blob: svg,
    });
  });
  const saved = browser.downloads[0]?.blob;
  if (!saved) {
    throw new Error("Download contained no SVG data");
  }
  const drawing = new DOMParser().parseFromString(
    await saved.text(),
    "image/svg+xml",
  );
  expect(drawing.documentElement.localName).toBe("svg");
});
