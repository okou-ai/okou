import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
warmMermaidParser();

function browserProperty(
  target: object,
  name: string,
  descriptor: PropertyDescriptor,
) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, ...descriptor });
  context.signal.addEventListener(
    "abort",
    () => {
      if (original) {
        Object.defineProperty(target, name, original);
      } else {
        Reflect.deleteProperty(target, name);
      }
    },
    { once: true },
  );
}

function mockFullscreen(enabled: boolean) {
  let fullscreen: Element | null = null;
  const change = (element: Element | null) => {
    fullscreen = element;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
  browserProperty(document, "fullscreenEnabled", { value: enabled });
  browserProperty(document, "fullscreenElement", {
    get: () => {
      return fullscreen;
    },
  });
  browserProperty(Element.prototype, "requestFullscreen", {
    value: enabled
      ? function (this: Element) {
          return change(this);
        }
      : undefined,
  });
  browserProperty(document, "exitFullscreen", {
    value: () => {
      return change(null);
    },
  });
}

function button(name: string, container: ParentNode = document.body) {
  const match = queryAllByRoleFast("button", container).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
  if (!match) {
    throw new Error(`Missing ${name} action`);
  }
  return match;
}

async function openHtml() {
  const url = "https://sh-launch.okou.app/index.html";
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      preview: { filename: "launch.html", contentType: "text/html" },
    });
  });
  await setupPage({
    context,
    path: "/artifacts/abcdef1234.html#details",
    host: "app.okou.ai",
    auth: null,
  });
  const frame = await screen.findByTitle("launch.html preview");
  expect(frame).toHaveAttribute("src", `${url}#details`);
  return frame;
}

async function enterViewerFullscreen() {
  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toBeEnabled();
  });
  expect(screen.getByRole("banner", { hidden: true })).not.toBeVisible();
}

async function leaveViewerFullscreen() {
  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(screen.getByRole("banner")).toBeVisible();
}

test("A browser without native fullscreen still offers a reversible full-view preview", async () => {
  mockFullscreen(false);
  const frame = await openHtml();
  const originalSource = frame.getAttribute("src");
  const title = screen.getByRole("heading", { name: "launch.html" });

  await enterViewerFullscreen();

  expect(title).not.toBeVisible();
  expect(document.fullscreenElement).toBeNull();
  expect(frame).toBeVisible();
  expect(frame).toHaveAttribute("src", originalSource);
  await leaveViewerFullscreen();
  expect(title).toBeVisible();
  expect(frame).toHaveAttribute("src", originalSource);
  expect(document.fullscreenElement).toBeNull();
});

test("Native fullscreen keeps both the preview and its exit action inside the fullscreen element", async () => {
  mockFullscreen(true);
  const frame = await openHtml();
  const originalSource = frame.getAttribute("src");

  await enterViewerFullscreen();

  expect(document.fullscreenElement).toContainElement(frame);
  expect(document.fullscreenElement).toContainElement(
    button("Exit fullscreen"),
  );
  await leaveViewerFullscreen();
  expect(document.fullscreenElement).toBeNull();
  expect(frame).toHaveAttribute("src", originalSource);
});

test("Closing a diagram keeps the document fullscreen and restores focus to its diagram control", async () => {
  mockFullscreen(true);
  const url = "https://files.example.test/launch.md";
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, {
      url,
      downloadUrl: url,
      preview: { filename: "launch.md", contentType: "text/markdown" },
    });
  });
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Launch\n\n```mermaid\nflowchart LR\n  Draft --> Review\n```",
    );
  });

  await setupPage({
    context,
    path: "/artifacts/abcdef1234.md",
    host: "app.okou.ai",
    auth: null,
  });
  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeInTheDocument();
  await enterViewerFullscreen();

  const expand = button("Expand diagram");
  click(expand);
  const diagram = await screen.findByRole("dialog");
  expect(document.fullscreenElement).toContainElement(diagram);
  click(button("Close", diagram));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(expand).toHaveFocus();
  });
  expect(document.fullscreenElement).toContainElement(expand);
  expect(screen.getByRole("banner", { hidden: true })).not.toBeVisible();

  await leaveViewerFullscreen();
  expect(document.fullscreenElement).toBeNull();
});
