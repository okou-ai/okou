import { sharedThreadsContract } from "@okouai/api-contracts/client/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
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

function diagramAction(name: string, scope: ParentNode = document.body) {
  const button = queryAllByRoleFast("button", scope).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`Missing diagram action: ${name}`);
  }
  return button;
}

test("A shared conversation renders and downloads its expanded diagram locally", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content:
              "Review this workflow.\n\n```mermaid\nflowchart LR\n  Draft --> Review\n```",
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  await waitFor(() => expect(diagramAction("Expand diagram")).toBeEnabled());
  click(diagramAction("Expand diagram"));

  const dialog = await screen.findByRole("dialog");
  const svg = await within(dialog).findByRole("img", { name: "diagram.svg" });
  await waitFor(() => expect(svg).toBeVisible());
  const source = svg.getAttribute("src") ?? "";
  expect(browser.blobForUrl(source)?.type).toBe("image/svg+xml");
  const labels = queryAllByRoleFast("button", dialog).map((item) => {
    return item.getAttribute("aria-label") ?? item.textContent?.trim();
  });
  expect(labels).toStrictEqual(
    expect.arrayContaining(["Close", "Download", "Fill view"]),
  );
  expect(labels).not.toContain("Share");
  expect(labels).not.toContain("Copy link");
  expect(labels).not.toContain("Open in split view");
  for (const name of ["Zoom in", "Zoom out", "Reset zoom"]) {
    expect(diagramAction(name, dialog)).toBeEnabled();
  }

  click(diagramAction("Download", dialog));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  const download = browser.downloads[0];
  expect(download).toMatchObject({ filename: "diagram.svg", url: source });
  await expect(download?.blob?.text()).resolves.toContain("<svg");
});
