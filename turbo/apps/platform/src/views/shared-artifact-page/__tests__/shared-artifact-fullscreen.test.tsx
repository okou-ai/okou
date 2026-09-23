import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
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
  createDeferredPromise,
  type DeferredPromise,
} from "../../../signals/utils.ts";

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

function mockFullscreen(mode: "native" | "unsupported" | "denied") {
  const stack: Element[] = [];
  let deferRequest = false;
  let deferExit = false;
  let pendingRequest: ({ target: Element } & DeferredPromise<void>) | undefined;
  let pendingExit: DeferredPromise<void> | undefined;
  const changed = () => {
    document.dispatchEvent(new Event("fullscreenchange"));
  };
  const enterFromBrowser = (target: Element) => {
    const previousIndex = stack.indexOf(target);
    if (previousIndex !== -1) {
      stack.splice(previousIndex, 1);
    }
    stack.push(target);
    changed();
  };
  const exitFromBrowser = () => {
    stack.length = 0;
    changed();
  };
  const exitTopFromBrowser = () => {
    stack.pop();
    changed();
  };

  context.signal.addEventListener(
    "abort",
    () => {
      exitFromBrowser();
    },
    { once: true },
  );

  mockBrowserProperty(document, "fullscreenEnabled", {
    value: mode !== "unsupported",
  });
  mockBrowserProperty(document, "fullscreenElement", {
    get: () => {
      return stack.at(-1) ?? null;
    },
  });
  // happy-dom has no browser fullscreen stack. Model its observable flags,
  // including a root retained underneath another native fullscreen surface.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ":fullscreen"
      ? stack.includes(this)
      : matches.call(this, selector);
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
            if (deferRequest) {
              deferRequest = false;
              pendingRequest = {
                target: this,
                ...createDeferredPromise<void>(context.signal),
              };
              return pendingRequest.promise;
            }
            enterFromBrowser(this);
            return Promise.resolve();
          },
  });
  mockBrowserProperty(document, "exitFullscreen", {
    value: () => {
      exitTopFromBrowser();
      if (deferExit) {
        deferExit = false;
        pendingExit = createDeferredPromise<void>(context.signal);
        return pendingExit.promise;
      }
      return Promise.resolve();
    },
  });

  return {
    changed,
    enterFromBrowser,
    exitFromBrowser,
    exitTopFromBrowser,
    deferNextRequest: () => {
      deferRequest = true;
    },
    deferNextExit: () => {
      deferExit = true;
    },
    finishExit: () => {
      const pending = pendingExit;
      if (!pending) {
        throw new Error("No browser fullscreen exit is pending");
      }
      pendingExit = undefined;
      pending.resolve();
    },
    finishRequest: (result: "accepted" | "denied") => {
      const pending = pendingRequest;
      if (!pending) {
        throw new Error("No browser fullscreen request is pending");
      }
      pendingRequest = undefined;
      if (result === "accepted") {
        enterFromBrowser(pending.target);
        pending.resolve();
      } else {
        pending.reject(
          new DOMException("Fullscreen denied", "NotAllowedError"),
        );
      }
    },
  };
}

function mockArtifact({
  name = filename,
  contentType = "text/html",
  url = previewUrl,
}: {
  name?: string;
  contentType?: string;
  url?: string;
} = {}): void {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: name,
      contentType,
      target: {
        kind: contentType === "text/html" ? "html" : "file",
        id: artifactId,
      },
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
}

async function openHtmlViewer(): Promise<void> {
  mockArtifact();
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

async function openMarkdownViewer(): Promise<void> {
  context.mocks.browser.blobDownload();
  const name = "layer-audit.md";
  const url = "https://artifacts.example.com/layer-audit.md";
  context.mocks.http.get(url, () => {
    return HttpResponse.text(
      "# Layer audit\n\n```mermaid\nflowchart LR\n  Fullscreen --> Diagram\n```",
    );
  });
  mockArtifact({ name, contentType: "text/markdown", url });
  await setupPage({
    context,
    path: artifactReferencePath(artifactId, name),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });
  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeInTheDocument();
  expect(button("Expand diagram")).toBeEnabled();
}

async function leaveViewer(): Promise<void> {
  act(() => {
    window.history.pushState(null, "", "/_/error");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    screen.findByText("Oops! Something went sideways"),
  ).resolves.toBeInTheDocument();
}

test("fullscreen is last in the artifact icon actions", async () => {
  await openHtmlViewer();

  const share = button("Share");
  const download = button("Download options");
  const fullscreen = button("Enter fullscreen");
  expect(share.compareDocumentPosition(download)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(download.compareDocumentPosition(fullscreen)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

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

test("closing a windowed diagram restores focus to its document trigger", async () => {
  const user = userEvent.setup();
  await openMarkdownViewer();
  const trigger = button("Expand diagram");

  await user.click(trigger);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toBeInTheDocument();
  await user.click(button("Close", dialog));

  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(button("Enter fullscreen")).toBeEnabled();
});

test("a delayed native exit restores focus after the enter control is enabled again", async () => {
  const browser = mockFullscreen("native");
  browser.deferNextExit();
  await openHtmlViewer();
  const header = screen.getByRole("banner");
  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });

  click(button("Exit fullscreen"));

  await waitFor(() => {
    expect(document.fullscreenElement).toBeNull();
  });
  // A fullscreenchange event can precede the browser's exit promise. Keep the
  // current controls until that promise releases the pending enter action.
  expect(header).not.toBeVisible();
  expect(button("Exit fullscreen")).toHaveFocus();
  act(() => {
    browser.finishExit();
  });

  await waitFor(() => {
    expect(button("Enter fullscreen")).toBeEnabled();
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(header).toBeVisible();
  expect(screen.getByTitle(`${filename} preview`)).toHaveAttribute(
    "src",
    previewSrc,
  );
});

test("native fullscreen includes the diagram portal and preserves the document when it closes", async () => {
  mockFullscreen("native");
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
    1600,
  );
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(
    900,
  );
  const user = userEvent.setup();
  await openMarkdownViewer();
  const header = screen.getByRole("banner");
  const main = screen.getByRole("main");

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen", main)).toHaveFocus();
  });
  const trigger = button("Expand diagram", main);
  await user.click(trigger);

  const dialog = await screen.findByRole("dialog");
  await expect(
    within(dialog).findByTestId("attachment-lightbox-image"),
  ).resolves.toBeInTheDocument();
  // This covers the fullscreen subtree contract. A deployed browser separately
  // verifies top-layer painting and hit testing, which happy-dom cannot model.
  expect(document.fullscreenElement).toContainElement(dialog);
  expect(header).not.toBeVisible();

  click(button("Zoom in", dialog));
  await waitFor(() => {
    expect(
      within(dialog).getByTestId("artifact-dialog-image-zoom-level"),
    ).not.toHaveTextContent("100%");
  });
  click(button("Enter fullscreen", dialog));
  expect(button("Exit fullscreen", dialog)).toBeEnabled();
  expect(document.fullscreenElement).toContainElement(dialog);
  click(button("Exit fullscreen", dialog));
  expect(button("Enter fullscreen", dialog)).toBeEnabled();

  await user.click(button("Close", dialog));
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(header).not.toBeVisible();
  expect(document.fullscreenElement).toContainElement(main);
  expect(button("Exit fullscreen", main)).toBeEnabled();

  click(button("Exit fullscreen", main));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toBeNull();
});

test("browser native exit leaves an open diagram and its focus lifecycle usable", async () => {
  const browser = mockFullscreen("native");
  const user = userEvent.setup();
  await openMarkdownViewer();
  const header = screen.getByRole("banner");
  const trigger = button("Expand diagram");

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBeTruthy();
  });

  act(() => {
    browser.exitFromBrowser();
  });

  await waitFor(() => {
    expect(header).toBeVisible();
  });
  expect(document.fullscreenElement).toBeNull();
  await user.click(button("Enter fullscreen", dialog));
  expect(dialog.contains(document.activeElement)).toBeTruthy();
  await user.click(button("Close", dialog));
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(button("Enter fullscreen")).toBeEnabled();
});

test("Escape dismisses dialog layers without leaving immersive fallback", async () => {
  mockFullscreen("unsupported");
  const user = userEvent.setup();
  await openMarkdownViewer();
  const header = screen.getByRole("banner");
  const trigger = button("Expand diagram");

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(dialog.contains(document.activeElement)).toBeTruthy();
  });

  await user.keyboard("{Escape}");

  expect(header).not.toBeVisible();
  // Base UI can consume this Escape in the focused control's tooltip before
  // dismissing its dialog. Either layer must leave the page immersive and the
  // dialog's explicit close action usable.
  const remainingDialog = screen.queryByRole("dialog");
  if (remainingDialog) {
    await user.click(button("Close", remainingDialog));
  }
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(header).not.toBeVisible();
  expect(button("Exit fullscreen")).toBeEnabled();

  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(header).toBeVisible();
});

test("leaving the viewer releases its document fullscreen", async () => {
  mockFullscreen("native");
  await openHtmlViewer();
  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });

  await leaveViewer();

  await waitFor(() => {
    expect(document.fullscreenElement).toBeNull();
  });
  expect(screen.queryByTitle(`${filename} preview`)).not.toBeInTheDocument();
});

test.each(["accepted", "denied"] as const)(
  "a fullscreen request %s after navigation cannot capture the next route",
  async (result) => {
    const browser = mockFullscreen("native");
    browser.deferNextRequest();
    await openHtmlViewer();
    click(button("Enter fullscreen"));
    await leaveViewer();

    act(() => {
      browser.finishRequest(result);
    });

    await waitFor(() => {
      expect(document.fullscreenElement).toBeNull();
    });
    expect(
      screen.getByText("Oops! Something went sideways"),
    ).toBeInTheDocument();

    act(() => {
      window.history.back();
    });
    await expect(
      screen.findByTitle(`${filename} preview`),
    ).resolves.toHaveAttribute("src", previewSrc);
    click(button("Enter fullscreen"));
    await waitFor(() => {
      expect(button("Exit fullscreen")).toHaveFocus();
    });
    expect(document.fullscreenElement).toContainElement(
      screen.getByTitle(`${filename} preview`),
    );
    click(button("Exit fullscreen"));
    await waitFor(() => {
      expect(button("Enter fullscreen")).toHaveFocus();
    });
  },
);

test("repeated pending entry and rapid exit keep later browser events from reopening fullscreen", async () => {
  const browser = mockFullscreen("native");
  browser.deferNextRequest();
  await openHtmlViewer();
  const enter = button("Enter fullscreen");
  const header = screen.getByRole("banner");

  click(enter);
  click(enter);
  expect(header).toBeVisible();
  act(() => {
    browser.finishRequest("accepted");
  });
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });

  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toBeNull();
  act(() => {
    browser.changed();
  });
  expect(header).toBeVisible();

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toContainElement(
    screen.getByTitle(`${filename} preview`),
  );
  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toBeNull();
});

test("fallback exit and route cleanup do not exit another surface's native fullscreen", async () => {
  const browser = mockFullscreen("native");
  await openHtmlViewer();
  act(() => {
    browser.enterFromBrowser(document.body);
  });

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toBe(document.body);

  await leaveViewer();
  expect(document.fullscreenElement).toBe(document.body);
});

test("route cleanup waits for a nested native surface before releasing the owned root", async () => {
  const browser = mockFullscreen("native");
  await openHtmlViewer();
  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  const ownedRoot = document.fullscreenElement;
  act(() => {
    browser.enterFromBrowser(document.body);
  });
  expect(screen.getByRole("banner", { hidden: true })).not.toBeVisible();

  await leaveViewer();

  expect(document.fullscreenElement).toBe(document.body);
  expect(ownedRoot?.matches(":fullscreen")).toBeTruthy();
  act(() => {
    browser.exitTopFromBrowser();
  });
  await waitFor(() => {
    expect(document.fullscreenElement).toBeNull();
  });
  expect(screen.getByText("Oops! Something went sideways")).toBeInTheDocument();
});

test("a new viewer can enter after a previous route's pending request is cleaned up", async () => {
  const browser = mockFullscreen("native");
  browser.deferNextRequest();
  await openHtmlViewer();
  click(button("Enter fullscreen"));
  await leaveViewer();

  act(() => {
    window.history.back();
  });
  await expect(
    screen.findByTitle(`${filename} preview`),
  ).resolves.toHaveAttribute("src", previewSrc);
  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });

  act(() => {
    browser.finishRequest("accepted");
  });
  await waitFor(() => {
    expect(document.fullscreenElement).toBeNull();
  });
  expect(button("Exit fullscreen")).toBeEnabled();
  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });

  click(button("Enter fullscreen"));
  await waitFor(() => {
    expect(button("Exit fullscreen")).toHaveFocus();
  });
  expect(document.fullscreenElement).toContainElement(
    screen.getByTitle(`${filename} preview`),
  );
  click(button("Exit fullscreen"));
  await waitFor(() => {
    expect(button("Enter fullscreen")).toHaveFocus();
  });
});
