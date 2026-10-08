import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const artifactId = "00000000-0000-4000-8000-000000000021";
const filename = "for-test.html";
const previewUrl = `https://ps-${"d".repeat(48)}.okou.app/`;
const previewSrc = `${previewUrl}#counter`;

function button(
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!element) {
    throw new Error(`Missing button: ${name}`);
  }
  return element;
}

function mockBrowserProperty(
  target: object,
  name: string,
  descriptor: PropertyDescriptor,
): void {
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

function mockFullscreen(mode: "native" | "unsupported") {
  const browserState: { fullscreenElement: Element | null } = {
    fullscreenElement: null,
  };

  mockBrowserProperty(document, "fullscreenEnabled", {
    value: mode !== "unsupported",
  });
  mockBrowserProperty(document, "fullscreenElement", {
    get: () => {
      return browserState.fullscreenElement;
    },
  });
  mockBrowserProperty(Element.prototype, "requestFullscreen", {
    value:
      mode === "unsupported"
        ? undefined
        : function (this: Element): Promise<void> {
            browserState.fullscreenElement = this;
            document.dispatchEvent(new Event("fullscreenchange"));
            return Promise.resolve();
          },
  });
  mockBrowserProperty(document, "exitFullscreen", {
    value: () => {
      browserState.fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    },
  });
}

async function openHtmlViewer(): Promise<void> {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: previewUrl,
      expiresAt: "2099-01-01T00:00:00Z",
      filename,
      contentType: "text/html",
      target: { kind: "html", id: artifactId },
    });
  });
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });

  await setupPage({
    context,
    path: `${artifactReferencePath(artifactId, filename)}#counter`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });
  await expect(
    screen.findByTitle(`${filename} preview`),
  ).resolves.toHaveAttribute("src", previewSrc);
}

test("fullscreen hides the header and offers an exit when the browser API is unsupported", async () => {
  mockFullscreen("unsupported");
  await openHtmlViewer();

  const header = screen.getByRole("banner");
  const title = screen.getByRole("heading", { name: filename });
  expect(header).toBeVisible();
  click(button("Enter fullscreen"));

  await waitFor(() => {
    expect(button("Exit fullscreen")).toBeVisible();
    expect(button("Exit fullscreen")).toBeEnabled();
  });
  expect(header).not.toBeVisible();
  expect(title).not.toBeVisible();
  expect(document.fullscreenElement).toBeNull();
  expect(screen.getByTitle(`${filename} preview`)).toBeVisible();
  expect(screen.getByTitle(`${filename} preview`)).toHaveAttribute(
    "src",
    previewSrc,
  );

  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(header).toBeVisible();
  expect(title).toBeVisible();
  expect(button("Enter fullscreen")).toBeEnabled();
  expect(screen.getByTitle(`${filename} preview`)).toHaveAttribute(
    "src",
    previewSrc,
  );
});

test("native fullscreen keeps the exit control with the preview and restores the header after exit", async () => {
  mockFullscreen("native");
  await openHtmlViewer();
  const header = screen.getByRole("banner");

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toBeVisible();
    expect(button("Exit fullscreen")).toBeEnabled();
  });
  expect(header).not.toBeVisible();
  expect(document.fullscreenElement).toContainElement(
    screen.getByTitle(`${filename} preview`),
  );
  expect(document.fullscreenElement).toContainElement(
    button("Exit fullscreen"),
  );
  expect(document.fullscreenElement).not.toContainElement(header);

  click(button("Exit fullscreen"));

  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(header).toBeVisible();
  expect(document.fullscreenElement).toBeNull();
  expect(button("Enter fullscreen")).toBeEnabled();
  expect(screen.getByTitle(`${filename} preview`)).toHaveAttribute(
    "src",
    previewSrc,
  );
});

async function openMarkdownViewer() {
  const url = "https://artifacts.example.com/fullscreen-plan.md";
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Fullscreen plan\n\n```mermaid\nflowchart LR\n  Read --> Expand\n```",
    );
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "plan.md",
      contentType: "text/markdown",
      target: { kind: "file", id: artifactId },
    });
  });
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({
    context,
    path: artifactReferencePath(artifactId, "plan.md"),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });
  await screen.findByRole("img", { name: "Diagram" });
}

test.each(["native", "unsupported"] as const)(
  "closing a diagram preserves document fullscreen (%s)",
  async (mode) => {
    mockFullscreen(mode);
    await openMarkdownViewer();
    click(button("Enter fullscreen"));
    await waitFor(() => {
      return expect(button("Exit fullscreen")).toBeInTheDocument();
    });
    const trigger = button("Expand diagram");
    click(trigger);
    const diagram = await screen.findByTestId("artifact-diagram-lightbox");
    expect(document.fullscreenElement?.contains(diagram) ?? false).toBe(
      mode === "native",
    );
    await waitFor(() => {
      expect(diagram.contains(document.activeElement)).toBeTruthy();
    });
    if (mode === "native") {
      click(button("Close", diagram));
    } else {
      await userEvent.keyboard("{Escape}");
    }
    await waitFor(() => {
      return expect(
        screen.queryByTestId("artifact-diagram-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("banner", { hidden: true })).not.toBeVisible();
    expect(button("Exit fullscreen")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.fullscreenElement?.contains(trigger) ?? false).toBe(
      mode === "native",
    );
  },
);

test("browser fullscreen exit leaves the diagram open and focused without restoring fullscreen on close", async () => {
  mockFullscreen("native");
  await openMarkdownViewer();
  click(button("Enter fullscreen"));
  await waitFor(() => {
    return expect(button("Exit fullscreen")).toBeInTheDocument();
  });
  const trigger = button("Expand diagram");
  click(trigger);
  const diagram = await screen.findByTestId("artifact-diagram-lightbox");
  await waitFor(() => {
    return expect(diagram.contains(document.activeElement)).toBeTruthy();
  });
  await act(async () => {
    await document.exitFullscreen();
  });
  expect(document.fullscreenElement).toBeNull();
  expect(within(diagram).getByAltText("diagram.svg")).toBeInTheDocument();
  click(button("Fill view", diagram));
  await waitFor(() => {
    return expect(diagram).toHaveAttribute("data-mode", "fullscreen");
  });
  expect(document.fullscreenElement).toBeNull();
  await waitFor(() => {
    return expect(diagram.contains(document.activeElement)).toBeTruthy();
  });
  click(button("Close", diagram));
  await waitFor(() => {
    return expect(
      screen.queryByTestId("artifact-diagram-lightbox"),
    ).not.toBeInTheDocument();
  });
  expect(screen.getByRole("banner")).toBeVisible();
  expect(document.fullscreenElement).toBeNull();
  expect(trigger).toHaveFocus();
});
