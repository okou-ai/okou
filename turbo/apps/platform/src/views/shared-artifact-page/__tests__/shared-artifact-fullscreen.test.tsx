import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import { getNamedButton } from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();
warmMermaidParser();

function fullscreenBrowser(enabled: boolean) {
  let active: Element | null = null;
  function show(element: Element | null) {
    active = element;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  }
  // Only the native Fullscreen API is simulated. React owns the page, dialog and focus.
  const properties: [object, string, PropertyDescriptor][] = [
    [document, "fullscreenEnabled", { value: enabled }],
    [
      document,
      "fullscreenElement",
      {
        get: () => {
          return active;
        },
      },
    ],
    [
      HTMLElement.prototype,
      "requestFullscreen",
      {
        value: function (this: HTMLElement) {
          return show(this);
        },
      },
    ],
    [
      document,
      "exitFullscreen",
      {
        value: () => {
          return show(null);
        },
      },
    ],
  ];
  for (const [target, key, descriptor] of properties) {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { ...descriptor, configurable: true });
    context.signal.addEventListener(
      "abort",
      () => {
        if (previous) {
          Object.defineProperty(target, key, previous);
        } else {
          Reflect.deleteProperty(target, key);
        }
      },
      { once: true },
    );
  }
}

function openArtifact(filename: string, contentType: string, url: string) {
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      preview: { filename, contentType },
    });
  });
  const extension = filename.split(".").pop();
  return setupPage({
    context,
    auth: null,
    host: "app.okou.ai",
    path: `/artifacts/field024ab.${extension}#west`,
  });
}
test.each([
  { id: "001", native: false },
  { id: "002", native: true },
])(
  "shared-artifact-fullscreen-$id restores the HTML reader after leaving fullscreen (native=$native)",
  async ({ native }) => {
    fullscreenBrowser(native);
    const url = "https://field-guide.example.test/index.html";
    await openArtifact("Field guide.html", "text/html", url);
    const title = await screen.findByRole("heading", {
      name: "Field guide.html",
    });
    const banner = screen.getByRole("banner");
    const frame = await screen.findByTitle("Field guide.html preview");
    const destination = url + "#west";
    expect(frame).toHaveAttribute("src", destination);
    click(getNamedButton("Enter fullscreen", banner));
    const exit = await screen.findByLabelText("Exit fullscreen");
    expect(exit).toBeEnabled();
    expect(title).not.toBeVisible();
    expect(banner).not.toBeVisible();
    const readingArea = native
      ? document.fullscreenElement
      : screen.getByRole("main");
    expect(readingArea).toContainElement(exit);
    const fullFrame = screen.getByTitle("Field guide.html preview");
    expect(readingArea).toContainElement(fullFrame);
    expect(fullFrame).toBeVisible();
    expect(fullFrame).toHaveAttribute("src", destination);
    expect(Boolean(document.fullscreenElement)).toBe(native);
    click(exit);
    await waitFor(() => {
      return expect(getNamedButton("Enter fullscreen", banner)).toHaveFocus();
    });
    expect(banner).toBeVisible();
    expect(title).toBeVisible();
    expect(document.fullscreenElement).toBeNull();
    expect(screen.getByTitle("Field guide.html preview")).toHaveAttribute(
      "src",
      destination,
    );
  },
);
test("shared-artifact-fullscreen-003 dismisses the diagram before leaving the fullscreen document", async () => {
  fullscreenBrowser(true);
  const url = "https://media.example.test/route.md";
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "## Field route\n\n```mermaid\nflowchart LR\nBase --> Ridge\n```",
    );
  });
  await openArtifact("Route.md", "text/markdown", url);
  await expect(
    screen.findByRole("heading", { name: "Field route" }),
  ).resolves.toBeInTheDocument();
  const banner = screen.getByRole("banner");
  click(getNamedButton("Enter fullscreen", banner));
  const exit = await screen.findByLabelText("Exit fullscreen");
  const area = screen.getByRole("main");
  expect(document.fullscreenElement).toBe(area);
  await expect(
    within(area).findByAltText("Diagram"),
  ).resolves.toBeInTheDocument();
  click(getNamedButton("Expand diagram", area));
  const overlay = await within(area).findByRole("dialog");
  await expect(
    within(overlay).findByRole("img", { name: "diagram.svg" }),
  ).resolves.toBeInTheDocument();
  click(getNamedButton("Close", overlay));
  await waitFor(() => {
    return expect(getNamedButton("Expand diagram", area)).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(document.fullscreenElement).toBe(area);
  expect(banner).not.toBeVisible();
  click(exit);
  await waitFor(() => {
    return expect(getNamedButton("Enter fullscreen", banner)).toHaveFocus();
  });
  expect(document.fullscreenElement).toBeNull();
  expect(banner).toBeVisible();
});
