import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const artifactId = "00000000-0000-4000-8000-000000000021";
const filename = "for-test.html";
const previewUrl = `https://ps-${"d".repeat(48)}.okou.app/`;
const previewSrc = `${previewUrl}#counter`;

function button(name: string): HTMLElement {
  const element = queryAllByRoleFast("button").find((candidate) => {
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

function mockFullscreen(mode: "native" | "unsupported" | "denied") {
  const browserState: { fullscreenElement: Element | null } = {
    fullscreenElement: null,
  };
  const exitFromBrowser = () => {
    browserState.fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
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
            if (mode === "denied") {
              return Promise.reject(
                new DOMException("Fullscreen denied", "NotAllowedError"),
              );
            }
            browserState.fullscreenElement = this;
            document.dispatchEvent(new Event("fullscreenchange"));
            return Promise.resolve();
          },
  });
  mockBrowserProperty(document, "exitFullscreen", {
    value: () => {
      exitFromBrowser();
      return Promise.resolve();
    },
  });

  return { exitFromBrowser };
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

test.each(["unsupported", "denied"] as const)(
  "fullscreen hides the header and offers an exit when the browser API is %s",
  async (mode) => {
    mockFullscreen(mode);
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
  },
);

test("Escape restores the header when native fullscreen is unavailable", async () => {
  mockFullscreen("unsupported");
  const user = userEvent.setup();
  await openHtmlViewer();
  const header = screen.getByRole("banner");

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toBeVisible();
  });
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(header).toBeVisible();
  expect(button("Enter fullscreen")).toBeEnabled();
  expect(screen.getByTitle(`${filename} preview`)).toHaveAttribute(
    "src",
    previewSrc,
  );
});

test.each(["button", "browser"] as const)(
  "native fullscreen keeps the exit control with the preview and restores the header after a %s exit",
  async (exitMethod) => {
    const browser = mockFullscreen("native");
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

    if (exitMethod === "button") {
      click(button("Exit fullscreen"));
    } else {
      act(() => {
        browser.exitFromBrowser();
      });
    }

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
  },
);
