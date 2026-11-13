import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { initSentry } from "../../../lib/sentry.ts";

import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";

const context = testContext();
const threadId = "11111111-1111-4111-8111-111111111111";

function mockViewer(
  windowId = 0,
  unavailableTargets?: readonly string[],
  extensionAvailable = true,
  nativeBase64 = true,
) {
  const session: BrowserSession = {
    threadId,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${threadId}`,
    liveUrl: "https://viewer.example/live",
    screenshotUrl: null,
    timeoutMinutes: 240,
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    window: {
      instanceId: "22222222-2222-4222-8222-222222222222",
      primaryWindowId: windowId,
    },
  };
  const cdpUrl = "wss://browser.example/interactions";
  const browser = mockBrowserCdp(context, cdpUrl, {
    nativeBase64,
    extensionAvailable,
    unavailableTargets,
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 0,
      },
      {
        targetId: "other-page",
        title: "Other",
        url: "https://other.example.com",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: session,
      viewer: {
        browser: session,
        cdpUrl,
        extension: TEST_BROWSER_EXTENSION,
      },
    });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return browser;
}

async function openViewer() {
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

async function setupViewer(windowId = 0, nativeBase64 = true) {
  const browser = mockViewer(windowId, undefined, true, nativeBase64);
  await openViewer();
  return browser;
}

async function setupMultiTabViewer() {
  const browser = mockViewer();
  browser.move("other-page", 0);
  await openViewer();
  return browser;
}

async function expectDisabled(element: HTMLElement, disabled: boolean) {
  await waitFor(() => {
    expect(element).toHaveProperty("disabled", disabled);
  });
}

function reportedCleanupError(
  sentry: ReturnType<typeof context.mocks.sentry>,
): Error {
  const report = sentry.reports.find((report) => {
    return (
      report.type === "exception" &&
      report.error instanceof Error &&
      report.error.message === "Original input cleanup is unconfirmed."
    );
  });
  if (report?.type !== "exception" || !(report.error instanceof Error)) {
    throw new Error("Expected the retained cleanup error to be reported");
  }
  return report.error;
}

test("A selected membership refresh preserves address selection before the first edit", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Address",
  });
  await userEvent.click(address);
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  const proof = browser.holdNextMembership("example-page");
  act(() => {
    browser.duplicate("example-page");
  });
  await proof.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(address).toBeEnabled();
  expect(address).toHaveFocus();
  expect(address).toHaveValue("https://example.com");
  expect(address.selectionStart).toBe(2);
  await act(async () => {
    await proof.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveValue("https://example.com");
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(2);
  await userEvent.keyboard("x");
  expect(address).toHaveValue("htxtps://example.com");
  expect(address.selectionStart).toBe(3);
});

test("A selected membership refresh preserves local address text, focus and caret", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Address",
  });
  await fill(address, "draft.example/path");
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  const proof = browser.holdNextMembership("example-page");
  act(() => {
    browser.duplicate("example-page");
  });
  await proof.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(address).toBeEnabled();
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(2);
  await userEvent.keyboard("x{Enter}");
  expect(address).toHaveValue("drxaft.example/path");
  expect(browser.targets[0]?.url).toBe("https://example.com");
  await act(async () => {
    await proof.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(3);
  expect(address).toHaveValue("drxaft.example/path");
  expect(browser.targets[0]?.url).toBe("https://example.com");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://drxaft.example/path");
  });
  expect(browser.targets[0]?.url).toBe("http://drxaft.example/path");
});

test("A submission blocked by native readiness explains why it did not navigate", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByLabelText("Address");
  await fill(address, "native-admission.example/path");
  const form = address.closest("form");
  if (!form) {
    throw new Error("Address form missing");
  }
  const proof = browser.holdNextMembership("example-page");
  await act(async () => {
    browser.duplicate("example-page");
    await proof.received;
    fireEvent.submit(form);
  });
  const notice = await screen.findByText(
    "The browser is not ready. Try again shortly.",
  );
  expect(notice).toBeInTheDocument();
  expect(address).toHaveFocus();
  expect(address).toHaveValue("native-admission.example/path");
  expect(browser.targets[0]?.url).toBe("https://example.com");
  await act(async () => {
    await proof.release();
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Reload", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(browser.targets[0]?.url).toBe("https://example.com");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://native-admission.example/path");
  });
});

test("Address blur releases an unchanged baseline but retains an unsent edit", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByLabelText("Address");
  await userEvent.click(address);
  act(() => {
    browser.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "example-frame",
          loaderId: "background-loader",
          url: "https://background.example/",
        },
      },
      browser.pageSession("example-page"),
    );
  });
  expect(address).toHaveValue("https://example.com");
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  expect(address).not.toHaveFocus();
  expect(address).toHaveValue("https://background.example/");
  await fill(address, "unsent.example/path");
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  act(() => {
    browser.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "example-frame",
          loaderId: "later-background-loader",
          url: "https://later-background.example/",
        },
      },
      browser.pageSession("example-page"),
    );
  });
  expect(address).not.toHaveFocus();
  expect(address).toHaveValue("unsent.example/path");
});

test("Escape resets the address without surrendering its selected text to a document update", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByLabelText<HTMLInputElement>("Address");
  await fill(address, "discarded.example/path");
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("https://example.com");
  expect(address.selectionStart).toBe(0);
  expect(address.selectionEnd).toBe("https://example.com".length);
  act(() => {
    browser.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "example-frame",
          loaderId: "after-reset",
          url: "https://background.example/",
        },
      },
      browser.pageSession("example-page"),
    );
  });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("https://example.com");
  expect(address.selectionStart).toBe(0);
  expect(address.selectionEnd).toBe("https://example.com".length);
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  expect(address).toHaveValue("https://background.example/");
});

test("An invalid local address remains a draft across membership reattachment", async () => {
  const browser = await setupViewer(0);
  const address = screen.getByLabelText<HTMLInputElement>("Address");
  await fill(address, "///invalid");
  fireEvent.submit(address.form!);
  await screen.findByRole("alert");
  const proof = browser.holdNextMembership("example-page");
  act(() => {
    browser.duplicate("example-page");
  });
  await proof.received;
  await act(async () => {
    await proof.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveValue("///invalid");
  expect(address).toHaveFocus();
  expect(browser.targets[0]?.url).toBe("https://example.com");
});

test.each(["untouched", "focused", "blurred", "edited-after-failure"] as const)(
  "Creation failure preserves active editing and releases only clean interactions (editor=%s)",
  async (editor) => {
    const browser = await setupViewer(0);
    const receipt = browser.holdNextNative("createTab");
    await userEvent.click(
      screen.getByLabelText("New tab", { selector: "button" }),
    );
    await receipt.received;
    const address = screen.getByLabelText<HTMLInputElement>("Address");
    const settings = screen.getByLabelText("Browser settings");
    if (editor !== "untouched") {
      await userEvent.keyboard("{Home}");
    }
    if (editor === "blurred") {
      await userEvent.click(settings);
      await userEvent.keyboard("{Escape}");
    }
    act(() => {
      browser.move("created-1", 1);
    });
    await act(async () => {
      await receipt.release();
    });
    await screen.findByRole("alert");
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(address).toBeEnabled();
    const active = editor === "focused" || editor === "edited-after-failure";
    expect(address).toHaveValue(active ? "" : "https://example.com");
    const focused = editor === "blurred" ? settings : address;
    expect(focused).toHaveFocus();
    if (editor === "edited-after-failure") {
      await userEvent.keyboard("retained.example/path{Enter}");
    }
    const retained = editor === "edited-after-failure";
    expect(address).toHaveValue(
      retained ? "retained.example/path" : active ? "" : "https://example.com",
    );
    expect(browser.targets[0]?.url).toBe("https://example.com");
    await userEvent.click(settings);
    await userEvent.keyboard("{Escape}");
    expect(address).toHaveValue(
      retained ? "retained.example/path" : "https://example.com",
    );
    expect(settings).toHaveFocus();
    if (retained) {
      await userEvent.click(address);
      await userEvent.keyboard("{Escape}");
    }
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    await fill(address, "after-failure.example/path");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://after-failure.example/path");
    });
    expect(browser.targets[0]?.url).toBe("http://after-failure.example/path");
  },
);

test("A failed creation retains its typed address without navigating the restored page", async () => {
  const browser = await setupViewer(0);
  const receipt = browser.holdNextNative("createTab");
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await receipt.received;
  const address = screen.getByLabelText("Address");
  await fill(address, "retained.example/path");
  act(() => {
    browser.move("created-1", 1);
  });
  await act(async () => {
    await receipt.release();
  });
  await screen.findByRole("alert");
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveValue("retained.example/path");
  expect(address).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(browser.targets[0]?.url).toBe("https://example.com");
  expect(address).toHaveValue("retained.example/path");
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("https://example.com");
  await fill(address, "chosen.example/path");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://chosen.example/path");
  });
  expect(browser.targets[0]?.url).toBe("http://chosen.example/path");
});

test("A failed creation in an empty window cannot bind its draft to an arriving tab", async () => {
  const browser = mockViewer(0);
  browser.targets.splice(0, 1);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("No tabs open");
  const receipt = browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await receipt.received;
  const address = screen.getByLabelText("Address");
  await fill(address, "failed-intent.example/path");
  act(() => {
    browser.move("created-1", 1);
  });
  await act(async () => {
    await receipt.release();
  });
  await screen.findByRole("alert");
  act(() => {
    browser.move("other-page", 0);
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveValue("failed-intent.example/path");
  await userEvent.keyboard("{Enter}");
  expect(browser.targets[0]?.url).toBe("https://other.example.com");
  expect(address).toHaveValue("failed-intent.example/path");
  await userEvent.keyboard("{Escape}");
  expect(address).toHaveValue("https://other.example.com");
});

test.each([0, 1])(
  "New tabs stay blank through creation and can be closed in window %s",
  async (windowId) => {
    const browser = await setupViewer(windowId);
    const created = browser.holdNextNative("createTab");
    const image = browser.holdTargetFrames("created-1");
    click(screen.getByLabelText("New tab", { selector: "button" }));
    expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
    await act(async () => {
      await created.received;
    });
    await screen.findByText("Nothing open yet");
    expect(screen.queryByText("Browser view unavailable")).toBeNull();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(screen.getByLabelText("Address")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await fill(screen.getByLabelText("Address"), "draft.example/path");
    await userEvent.keyboard("{Enter}");
    expect(
      screen.getByText("The browser is not ready. Try again shortly."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Address")).toHaveFocus();
    await userEvent.keyboard("x{Backspace}");
    expect(screen.getByLabelText("Address")).toHaveValue("draft.example/path");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      await created.release();
      await image.received;
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByLabelText("Address")).toHaveValue("draft.example/path");
    expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
    expect(screen.queryByText("Browser view unavailable")).toBeNull();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(screen.getByLabelText("Address")).toBeEnabled();
    act(() => {
      image.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(screen.getByLabelText("Address")).toHaveFocus();
    });
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject({ url: "about:blank", windowId });
    expect(screen.getByLabelText("Address")).toHaveValue("draft.example/path");
    await userEvent.click(screen.getByLabelText("Close New tab"));
    const successor = windowId === 0 ? "Example" : "Other";
    await waitFor(() => {
      expect(
        screen.getByLabelText(successor, { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText(successor, { selector: '[role="tab"]' }),
      ).toHaveFocus();
    });
    expect(
      browser.targets.map((target) => {
        return target.targetId;
      }),
    ).toStrictEqual(["example-page", "other-page"]);
  },
);

test.each([0, 1])(
  "Closing the last tab retains a usable blank tab in assigned window %s",
  async (windowId) => {
    const browser = await setupViewer(windowId);
    const title = windowId === 0 ? "Example" : "Other";
    click(screen.getByLabelText(`Close ${title}`));
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(queryAllByRoleFast("tab")).toHaveLength(1);
    expect(screen.getByLabelText("Address")).toHaveValue("");
    expect(
      browser.targets.filter((target) => {
        return target.windowId === windowId;
      }),
    ).toMatchObject([{ windowId, url: "about:blank" }]);
    expect(
      browser.targets.find((target) => {
        return target.windowId !== windowId;
      }),
    ).toMatchObject({
      targetId: windowId === 0 ? "other-page" : "example-page",
      url: windowId === 0 ? "https://other.example.com" : "https://example.com",
    });
    await fill(
      screen.getByLabelText("Address"),
      "https://continued.example.com/ready",
    );
    await userEvent.keyboard("{Enter}");
    await expect(
      screen.findByLabelText("continued.example.com", {
        selector: '[role="tab"]',
      }),
    ).resolves.toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://continued.example.com/ready",
    );
  },
);

test("Closing the last established tab does not rely on an unfinished native creation", async () => {
  const browser = await setupViewer(0);
  const creation = browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await creation.received;
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(2);
  });
  click(screen.getByLabelText("Close Example"));
  await waitFor(() => {
    expect(
      screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
  });
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(2);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  // The confirmed replacement already keeps the window alive.
  click(screen.getAllByLabelText("Close New tab")[0]!);
  await creation.release();
  await waitFor(() => {
    expect(
      browser.targets.some((target) => {
        return target.targetId === "created-1";
      }),
    ).toBeFalsy();
  });
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(1);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
});

test("The last tab stays open until its blank replacement is confirmed", async () => {
  const browser = await setupViewer(0);
  const preparation = browser.holdNext("Page.navigate");
  click(screen.getByLabelText("Close Example"));
  await preparation.received;
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Close Example")).toBeDisabled();
  await preparation.release();
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(1);
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Overlapping closes retain one blank tab in the assigned window", async () => {
  const browser = await setupViewer(0);
  act(() => {
    browser.move("other-page", 0);
  });
  await screen.findByLabelText("Other", { selector: '[role="tab"]' });
  const close = browser.holdNext("Target.closeTarget");
  // Start both closes before either remote operation completes.
  click(screen.getByLabelText("Close Example"));
  click(screen.getByLabelText("Close Other"));
  await close.received;
  await waitFor(() => {
    expect(queryAllByRoleFast("tab")).toHaveLength(1);
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toBeInTheDocument();
  });
  await close.release();
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(browser.targets).toMatchObject([{ windowId: 0, url: "about:blank" }]);
});

test("A failed final-tab replacement leaves the original page usable", async () => {
  const browser = await setupViewer(0);
  browser.failNext(
    "Page.navigate",
    "The replacement tab could not be prepared",
  );
  click(screen.getByLabelText("Close Example"));
  await screen.findByRole("alert");
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Close Example")).toBeEnabled();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(browser.targets).toMatchObject([
    { targetId: "example-page", windowId: 0 },
    { targetId: "other-page", windowId: 1 },
  ]);
});

test("Selecting a blank tab covers the previous page before its first image", async () => {
  const browser = mockViewer(0);
  browser.targets.push({
    targetId: "blank-page",
    title: "about:blank",
    url: "about:blank",
    windowId: 0,
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const image = browser.holdFrames("blank-page-session");
  click(screen.getByLabelText("New tab", { selector: '[role="tab"]' }));
  expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    await image.received;
  });
  expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await fill(screen.getByLabelText("Address"), "https://new.example.com/page");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://new.example.com/page",
    );
  });
  expect(screen.queryByText("Nothing open yet")).toBeNull();
});

test("Selecting another tab clears a delayed creation's blank presentation", async () => {
  const browser = await setupMultiTabViewer();
  const created = browser.holdNextNative("createTab");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await act(async () => {
    await created.received;
  });
  await screen.findByText("Nothing open yet");
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  await fill(screen.getByLabelText("Address"), "later-choice.example/draft");
  await act(async () => {
    await created.release();
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
  expect(screen.getByLabelText("Address")).toHaveFocus();
  expect(screen.getByLabelText("Address")).toHaveValue(
    "later-choice.example/draft",
  );
});

test("A pending creation preserves a later toolbar-control focus choice", async () => {
  const browser = await setupViewer(0);
  const create = screen.getByLabelText("New tab", { selector: "button" });
  const created = browser.holdNextNative("createTab");
  const image = browser.holdTargetFrames("created-1");
  await userEvent.click(create);
  await created.received;
  const settings = screen.getByLabelText("Browser settings");
  await userEvent.click(settings);
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(settings).toHaveFocus();
  });
  await act(async () => {
    await created.release();
  });
  await image.received;
  expect(screen.getByLabelText("Address")).toBeEnabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toBeEnabled();
    expect(create).toBeEnabled();
  });
  expect(settings).toHaveFocus();
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
});

test.each(["created", "existing"] as const)(
  "A blank tab (%s) navigated before its first image does not expose the previous page",
  async (origin) => {
    const browser = mockViewer(0);
    if (origin === "existing") {
      browser.targets.push({
        targetId: "blank-page",
        title: "about:blank",
        url: "about:blank",
        windowId: 0,
      });
    }
    await setupPage({ context, path: `/browsers/${threadId}` });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const targetId = origin === "created" ? "created-1" : "blank-page";
    const image = browser.holdTargetFrames(targetId);
    click(
      screen.getByLabelText("New tab", {
        selector: origin === "created" ? "button" : '[role="tab"]',
      }),
    );
    await act(async () => {
      await image.received;
    });
    await screen.findByText("Nothing open yet");
    act(() => {
      // The attached document can change before target metadata catches up.
      browser.event(
        "Page.frameNavigated",
        {
          frame: {
            id: "example-frame",
            loaderId: "external-navigation",
            url: "https://destination.example.com/page",
          },
        },
        browser.pageSession(targetId),
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(
        "https://destination.example.com/page",
      );
    });
    expect(screen.queryByText("Nothing open yet")).toBeNull();
    expect(screen.getByText("Connecting to browser…")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.queryByText("Connecting to browser…")).toBeNull();
  },
);

test.each([false, true])(
  "A new tab distinguishes automatic focus from interaction before its creation receipt (interaction=%s)",
  async (interact) => {
    const browser = await setupViewer(0);
    const creation = browser.holdNextNative("createTab");
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await creation.received;
    const address = screen.getByLabelText<HTMLInputElement>("Address");
    expect(address).toHaveFocus();
    expect(address).toHaveValue("");
    if (interact) {
      await userEvent.keyboard("{Home}");
    }
    await act(async () => {
      await creation.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    for (const page of ["first", "second"]) {
      act(() => {
        browser.event(
          "Page.frameNavigated",
          {
            frame: {
              id: "example-frame",
              loaderId: `external-${page}`,
              url: `https://${page}.example/`,
            },
          },
          browser.pageSession("created-1"),
        );
      });
      const expected = interact ? "" : `https://${page}.example/`;
      expect(address).toHaveValue(expected);
      expect(address).toHaveFocus();
      expect(address.selectionStart).toBe(expected.length);
    }
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    expect(address).toHaveValue("https://second.example/");
  },
);

test.each(["first image", "input initialization"] as const)(
  "Selecting a tab waits for its %s before accepting another browser action",
  async (waitingFor) => {
    const browser = await setupMultiTabViewer();
    const pending =
      waitingFor === "first image"
        ? browser.holdFrames("other-page-session")
        : browser.holdNext("Runtime.enable");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await act(async () => {
      await pending.received;
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Other", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(screen.getByLabelText("Address")).toBeEnabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();

    await act(async () => {
      await pending.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeEnabled();
  },
);

test("A created tab with a failed first image retries the image without creating another tab", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  const browser = await setupViewer(0);
  const image = browser.holdTargetFrames("created-1");
  const created = browser.holdNextNative("createTab");
  const newTab = screen.getByLabelText("New tab", { selector: "button" });
  click(newTab);
  await created.received;
  expect(browser.targets).toContainEqual(
    expect.objectContaining({
      targetId: "created-1",
      url: expect.stringMatching(/^about:blank#okou-create-/),
    }),
  );
  expect(newTab).toBeDisabled();
  await userEvent.click(newTab);

  await act(async () => {
    await created.release();
  });
  await image.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(newTab).toBeDisabled();
  await userEvent.click(newTab);

  act(() => {
    image.release("!");
  });
  await screen.findByText("Reconnecting…");
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  expect(newTab).toBeDisabled();
  advanceRecovery(1000);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example", "New tab"]);
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(screen.getByText("Nothing open yet")).toBeInTheDocument();
});

test.each([true, false])(
  "Submitting an address navigates the selected remote page (native base64: %s)",
  async (nativeBase64) => {
    const browser = await setupViewer(0, nativeBase64);
    const address = screen.getByLabelText("Address");
    await fill(address, "example.test/path");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://example.test/path");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(browser.targets[0]?.url).toBe("http://example.test/path");
    expect(browser.targets[1]?.url).toBe("https://other.example.com");
  },
);

test.each(["keyboard", "pointer", "composition"] as const)(
  "A %s interaction after submission protects the still-focused address before another character",
  async (interaction) => {
    const browser = await setupViewer(0);
    const navigation = browser.holdNext("Page.navigate");
    const address = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Address",
    });
    await fill(address, "submitted.example/path");
    await userEvent.keyboard("{Enter}");
    await navigation.received;
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(address).toHaveFocus();
    if (interaction === "keyboard") {
      await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
    } else if (interaction === "pointer") {
      await userEvent.pointer({
        target: address,
        keys: "[MouseLeft]",
        offset: 2,
      });
    } else {
      address.setSelectionRange(2, 2);
      fireEvent.compositionStart(address);
    }
    expect(address.selectionStart).toBe(2);
    await act(async () => {
      await navigation.release();
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Reload", { selector: "button" }),
      ).toBeEnabled();
    });
    expect(address).toBeEnabled();
    expect(address).toHaveFocus();
    expect(address).toHaveValue("submitted.example/path");
    expect(address.selectionStart).toBe(2);
    if (interaction === "composition") {
      fireEvent.compositionEnd(address);
    }
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    expect(address).toHaveValue("http://submitted.example/path");
    expect(browser.targets[0]?.url).toBe("http://submitted.example/path");
  },
);

test("Refocusing a submitted address protects selection until the user leaves it", async () => {
  const browser = await setupViewer(0);
  const navigation = browser.holdNext("Page.navigate");
  const address = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Address",
  });
  await fill(address, "submitted.example/path");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.keyboard("{Escape}");
  await userEvent.click(address);
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Reload", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(address).toHaveValue("submitted.example/path");
  expect(address).toHaveFocus();
  expect(address.selectionStart).toBe(2);
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  expect(address).toHaveValue("http://submitted.example/path");
  expect(browser.targets[0]?.url).toBe("http://submitted.example/path");
});

test("Leaving a clean refocus retains the pending navigation until its own receipt", async () => {
  const browser = await setupViewer(0);
  const navigation = browser.holdNext("Page.navigate");
  const address = screen.getByLabelText("Address");
  await fill(address, "submitted.example/path");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("submitted.example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  await userEvent.click(address);
  await userEvent.keyboard("{Home}{ArrowRight}{ArrowRight}");
  await userEvent.click(screen.getByLabelText("Remote browser input"));
  expect(address).not.toHaveFocus();
  expect(address).toHaveValue("submitted.example/path");
  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Reload", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(address).toHaveValue("http://submitted.example/path");
});

test("An address submission waits for its navigation receipt across its own document change", async () => {
  const browser = await setupViewer(0);
  const navigation = browser.holdNext("Page.navigate");
  const address = screen.getByLabelText("Address");
  await fill(address, "first.example/path");
  await userEvent.keyboard("{Enter}");
  await navigation.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("first.example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(address).toBeEnabled();
  await fill(address, "second.example/ready");
  await userEvent.keyboard("{Enter}");
  expect(
    screen.getByText("A page is still opening. Try again shortly."),
  ).toBeInTheDocument();
  expect(browser.targets[0]?.url).toBe("http://first.example/path");
  await act(async () => {
    await navigation.release();
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Reload", { selector: "button" }),
    ).toBeEnabled();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(address).toHaveValue("second.example/ready");
  expect(address).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://second.example/ready");
  });
  expect(browser.targets[0]?.url).toBe("http://second.example/ready");
});

test("Moving another page into the window preserves the selected page and input", async () => {
  const browser = await setupViewer(0);
  const membership = browser.holdNext("Browser.getWindowForTarget");
  act(() => {
    browser.move("other-page", 0);
  });
  await membership.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  await membership.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "false");
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A selected page moved away automatically continues on a scoped survivor", async () => {
  const browser = await setupViewer(0);
  act(() => {
    browser.move("other-page", 0);
  });
  await screen.findByLabelText("Other", { selector: '[role="tab"]' });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.move("example-page", 1);
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test.each([
  { code: 1000, wasClean: true },
  { code: 1006, wasClean: false },
])(
  "A native close ($code) preserves the uncertain new-tab result during automatic recovery",
  async ({ code, wasClean }) => {
    const sentry = context.mocks.sentry();
    const advanceRecovery = browserRecoveryClock(context.signal);
    const browser = await setupViewer(0);
    const created = browser.holdNextNative("createTab");
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await created.received;
    await screen.findByLabelText("New tab", { selector: '[role="tab"]' });

    act(() => {
      browser.disconnect({ code, wasClean, reason: "private-close-reason" });
    });
    await screen.findByText("Reconnecting…");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      sentry.breadcrumbs.filter((entry) => {
        return entry.category === "browser.connection";
      }),
    ).toStrictEqual([
      {
        category: "browser.connection",
        level: "info",
        data: {
          source: "native-close",
          role: "control",
          phase: "open",
          ready_state: 3,
          code,
          was_clean: wasClean,
          pending_requests: 1,
          cancelled_awaiting_response: 0,
        },
      },
    ]);

    await act(async () => {
      await created.release();
    });
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
    advanceRecovery(1000);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    // The original remote effect survived; recovery discovers that one tab.
    const tab = await screen.findByLabelText("New tab", {
      selector: '[role="tab"]',
    });
    click(tab);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(tab).toHaveAttribute("aria-selected", "true");
  },
);

test("A native close distinguishes cancelled late attachments from unfinished requests", async () => {
  const sentry = context.mocks.sentry();
  browserRecoveryClock(context.signal);
  const browser = await setupViewer(0);
  act(() => {
    browser.move("other-page", 0);
  });
  await screen.findByLabelText("Other", { selector: '[role="tab"]' });
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await attachment.received;
  act(() => {
    browser.move("other-page", 1);
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });

  act(() => {
    browser.disconnect({ code: 1001, wasClean: true });
  });
  await screen.findByText("Reconnecting…");
  expect(
    sentry.breadcrumbs.find((entry) => {
      return entry.category === "browser.connection";
    }),
  ).toMatchObject({
    data: {
      role: "control",
      phase: "open",
      pending_requests: 0,
      cancelled_awaiting_response: 1,
    },
  });
  await act(async () => {
    await attachment.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
});

test("An empty assigned window can create a native tab without a source document", async () => {
  const browser = mockViewer(0);
  browser.targets.splice(0, 1);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("No tabs open");
  const create = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "New tab";
  });
  if (!create) {
    throw new Error("Missing empty-state New tab control");
  }
  await waitFor(() => {
    expect(create).toBeEnabled();
  });
  await userEvent.click(create);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveFocus();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({ windowId: 0, url: "about:blank" });
});

test("An unavailable required extension never admits CDP-only viewing", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  mockViewer(0, undefined, false);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByLabelText("New tab", { selector: "button" }),
  ).toBeDisabled();
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({
        type: "exception",
        error: expect.objectContaining({
          name: "CdpFault",
          message:
            "The required Okou Browser extension is unavailable. Reconnect the browser.",
        }),
      }),
    );
  });
});

test.each(["Runtime.removeBinding", "Target.detachFromTarget"])(
  "Bridge loss with unacknowledged %s still releases its page and reconnects",
  async (cleanupMethod) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const browser = await setupViewer(0);
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
    await waitFor(() => {
      expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
        }),
      );
    });
    // Neither original input release nor bridge/session cleanup is acknowledged.
    const release = browser.holdNext("Input.dispatchKeyEvent");
    browser.holdNext(cleanupMethod);
    act(() => {
      browser.resetWorker();
    });
    await release.received;
    await screen.findByText("Reconnecting…");
    await waitFor(() => {
      expect(browser.detached).toContain("example-page-session");
    });
    // The release was written before its page was detached.
    const keyUp = browser.requests.findIndex((request) => {
      return (
        request.method === "Input.dispatchKeyEvent" &&
        request.params?.type === "keyUp"
      );
    });
    const pageDetach = browser.requests.findIndex((request) => {
      return (
        request.method === "Target.detachFromTarget" &&
        request.params?.sessionId === "example-page-session"
      );
    });
    expect(keyUp).toBeGreaterThan(-1);
    expect(keyUp).toBeLessThan(pageDetach);
    expect(browser.targets).toHaveLength(2);
    // The closed incarnation no longer blocks reconnecting to the same browser.
    advanceRecovery(1000);
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(browser.targets).toHaveLength(2);
  },
);

test("Revalidation does not wait for an unacknowledged release before another tab can be used", async () => {
  const browser = await setupMultiTabViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  // Revalidation revokes admission; the remote never acknowledges the release.
  const release = browser.holdNext("Input.dispatchKeyEvent");
  act(() => {
    context.mocks.ably.trigger("browserSessionChanged", { threadId });
  });
  await release.received;
  await userEvent.click(
    await screen.findByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test.each(["movement", "pending navigation"])(
  "A delayed creation receipt preserves another caller's %s",
  async (change) => {
    const browser = await setupViewer(0);
    const receipt = browser.holdNextNative("createTab");
    await userEvent.click(
      screen.getByLabelText("New tab", { selector: "button" }),
    );
    await receipt.received;
    act(() => {
      if (change === "movement") {
        browser.move("created-1", 1);
      } else {
        browser.beginNavigation(
          "created-1",
          "https://user-navigation.example.com",
        );
      }
    });
    await receipt.release();
    await screen.findByText(
      "The browser action could not be completed. Check the browser before trying again.",
    );
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject(
      change === "movement"
        ? { windowId: 1 }
        : { pendingUrl: "https://user-navigation.example.com" },
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  },
);

test("A fresh native tab read covers preceding metadata updates during creation", async () => {
  const browser = await setupViewer(0);
  browser.updateBeforeNextTabRead();
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({ url: "about:blank", windowId: 0 });
});

test.each(["native getTab", "Browser.getWindowForTarget"])(
  "A delayed creation check (%s) preserves another caller's pending navigation",
  async (method) => {
    const browser = await setupViewer(0);
    const attachment = browser.holdNext("Target.attachToTarget");
    click(screen.getByLabelText("New tab", { selector: "button" }));
    await attachment.received;
    const observation =
      method === "native getTab"
        ? browser.holdNextNative("getTab")
        : browser.holdNextMembership("created-1");
    await attachment.release();
    await observation.received;
    act(() => {
      browser.beginNavigation(
        "created-1",
        "https://user-navigation.example.com",
      );
    });
    await observation.release();
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", {
          selector: 'button:not([role="tab"])',
        }),
      ).toBeEnabled();
    });
    expect(
      browser.targets.find((target) => {
        return target.targetId === "created-1";
      }),
    ).toMatchObject({
      url: expect.stringMatching(/^about:blank#okou-create-/),
      pendingUrl: "https://user-navigation.example.com",
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(
      screen.getByText(
        "The browser action could not be completed. Check the browser before trying again.",
      ),
    ).toBeInTheDocument();
  },
);

test("A delayed failed-create cleanup preserves another caller's pending navigation", async () => {
  const browser = await setupViewer(0);
  browser.corruptNextPageAttachment();
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await attachment.received;
  const cleanup = browser.holdNextNative("getTab");
  await attachment.release();
  await cleanup.received;
  act(() => {
    browser.beginNavigation("created-1", "https://user-navigation.example.com");
  });
  await cleanup.release();
  await waitFor(() => {
    expect(
      screen.getByLabelText("New tab", {
        selector: 'button:not([role="tab"])',
      }),
    ).toBeEnabled();
  });
  expect(
    browser.targets.find((target) => {
      return target.targetId === "created-1";
    }),
  ).toMatchObject({
    url: expect.stringMatching(/^about:blank#okou-create-/),
    pendingUrl: "https://user-navigation.example.com",
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    screen.getByText(
      "The browser action could not be completed. Check the browser before trying again.",
    ),
  ).toBeInTheDocument();
});

test("A malformed new-page attachment preserves the established browser pages", async () => {
  const browser = await setupViewer(0);
  browser.corruptNextPageAttachment();
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    browser.targets.map((target) => {
      return target.targetId;
    }),
  ).toStrictEqual(["example-page", "other-page"]);
});

test("A duplicate marker during creation never takes over the other caller's page", async () => {
  const browser = await setupViewer(0);
  const receipt = browser.holdNextNative("createTab");
  await userEvent.click(
    screen.getByLabelText("New tab", { selector: "button" }),
  );
  await receipt.received;
  act(() => {
    browser.duplicate("created-1");
  });
  await receipt.release();
  await screen.findByText(
    "The browser action could not be completed. Check the browser before trying again.",
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(
    browser.targets.map((target) => {
      return target.targetId;
    }),
  ).toStrictEqual(["example-page", "other-page", "created-2"]);
  expect(browser.targets.at(-1)?.url).toMatch(/^about:blank#okou-create-/);
});

test.each([
  ["[::1]:8080/path", "http://[::1]:8080/path"],
  ["例子.测试/你好", "http://xn--fsqu00a.xn--0zwm56d/%E4%BD%A0%E5%A5%BD"],
  ["custom:payload", "custom:payload"],
])(
  "The address field normalizes %s for the remote page",
  async (address, expected) => {
    const browser = await setupViewer(0);
    await fill(screen.getByLabelText("Address"), address);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByLabelText("Address")).toHaveValue(expected);
    });
    expect(browser.targets[0]?.url).toBe(expected);
  },
);

test("Remote editing context updates keyboard hints without interrupting composition", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  for (const [type, inputMode, enterKeyHint] of [
    ["search", "search", "search"],
    ["email", "email", "enter"],
    ["url", "url", "enter"],
    ["tel", "tel", "enter"],
    ["number", "decimal", "enter"],
    ["textarea", "text", "enter"],
    ["password", "text", "enter"],
  ]) {
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type,
        multiline: type === "textarea",
        inputMode: "",
        enterKeyHint: "",
        autoCapitalize: "characters",
        lang: "zh-CN",
      },
    });
    fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
    fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
    await waitFor(() => {
      expect(input).toHaveAttribute("inputmode", inputMode);
      expect(input).toHaveAttribute("enterkeyhint", enterKeyHint);
      expect(input).toHaveAttribute(
        "type",
        type === "password" ? "password" : "text",
      );
    });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("lang", "zh-CN");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  }
  expect(input).toHaveAttribute("autocapitalize", "none");
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "text",
      multiline: false,
      inputMode: "numeric",
      enterKeyHint: "send",
      autoCapitalize: "words",
      lang: "en-US",
    },
  });
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("enterkeyhint", "send");
  });
  expect(input).toHaveAttribute("autocapitalize", "words");
  fireEvent.compositionStart(input);
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "password",
      multiline: false,
      inputMode: "",
      enterKeyHint: "done",
      autoCapitalize: "characters",
      lang: "ja",
    },
  });
  const reading = browser.holdNext("Runtime.evaluate");
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await reading.received;
  await act(async () => {
    await reading.release();
  });
  expect(input).toHaveAttribute("type", "text");
  expect(input).toHaveAttribute("inputmode", "numeric");
  expect(input).toHaveValue("中");
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  await waitFor(() => {
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("enterkeyhint", "done");
  });
  expect(input).toHaveFocus();
  browser.setFocusedEditing(null);
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "enter");
    expect(input).toHaveAttribute("lang", "");
  });
  expect(input).toHaveFocus();
});

test("Remote password keyboard hints survive native editing and tab updates", async () => {
  const browser = await setupViewer(0);
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "password",
      multiline: false,
      inputMode: "numeric",
      enterKeyHint: "done",
      autoCapitalize: "none",
      lang: "ja",
    },
  });
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  await waitFor(() => {
    expect(input).toHaveAttribute("type", "password");
  });
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中" },
    data: "中",
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.imeSetComposition",
      params: { text: "中", selectionStart: 1, selectionEnd: 1 },
      sessionId: "example-page-session",
    });
  });
  expect(input).toHaveAttribute("type", "password");
  expect(input).toBeEnabled();
  expect(input).toHaveAttribute("inputmode", "numeric");
  expect(input).toHaveAttribute("enterkeyhint", "done");
  expect(input).toHaveAttribute("lang", "ja");
  expect(input).toHaveValue("中");
  expect(input).toHaveFocus();
  const target = browser.targets[0]!;
  act(() => {
    target.title = "Updated Example";
    browser.event("Target.targetInfoChanged", {
      targetInfo: { ...target, type: "page" },
    });
    browser.nativeEvent("tab-updated", target);
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Updated Example", { selector: '[role="tab"]' }),
    ).toBeInTheDocument();
  });
  expect(input).toHaveAttribute("type", "password");
  expect(input).toHaveAttribute("inputmode", "numeric");
  expect(input).toHaveValue("中");
  expect(input).toHaveFocus();
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "中" },
    });
  });
});

test.each([
  ["password", "Page.frameStartedNavigating", { frameId: "example-frame" }],
  [
    "password",
    "Page.frameNavigated",
    {
      frame: {
        id: "example-frame",
        loaderId: "next-loader",
        url: "https://example.com/next",
      },
    },
  ],
  [
    "text",
    "Page.navigatedWithinDocument",
    { frameId: "example-frame", url: "https://example.com/#next" },
  ],
] as const)(
  "Navigation from a %s field hands input focus to the viewer on %s",
  async (type, method, params) => {
    const browser = await setupViewer(0);
    const remoteEditing = {
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type,
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "done",
        autoCapitalize: "none",
        lang: "ja",
      },
    };
    browser.setFocusedEditing(remoteEditing);
    const input = screen.getByLabelText("Remote browser input");
    const surface = screen.getByRole("img", {
      name: "Live browser view",
    }).parentElement!;
    await userEvent.click(input);
    await waitFor(() => {
      expect(input).toHaveAttribute("lang", "ja");
    });
    expect(input).toHaveAttribute("type", type);
    expect(input).toHaveFocus();

    browser.setFocusedEditing(null);
    act(() => {
      browser.event(method, params, "example-page-session");
    });
    expect(surface).toHaveFocus();
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveValue("");
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "ArrowDown" },
      });
    });

    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    paste.clipboardData!.setData("text/plain", "pasted on the new page");
    Object.defineProperty(paste, "isTrusted", { value: true });
    fireEvent(surface, paste);
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "pasted on the new page" },
      });
    });
    expect(surface).toHaveFocus();

    browser.setFocusedEditing({
      ...remoteEditing,
      editing: { ...remoteEditing.editing, type: "email", lang: "en" },
    });
    await userEvent.keyboard("{Tab}");
    await waitFor(() => {
      expect(input).toHaveAttribute("lang", "en");
    });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("autocapitalize", "none");
    await userEvent.keyboard("{F8}");
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveFocus();
  },
);

test.each(["pre-navigation", "current-page"])(
  "A delayed %s editing read cannot reclaim chosen address focus",
  async (source) => {
    const browser = await setupViewer(0);
    const remoteEditing = {
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type: "password",
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "done",
        autoCapitalize: "none",
        lang: "ja",
      },
    };
    browser.setFocusedEditing(remoteEditing);
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    await waitFor(() => {
      expect(input).toHaveAttribute("type", "password");
    });
    const reading = browser.holdNext("Runtime.evaluate");
    const address = screen.getByLabelText("Address");
    if (source === "pre-navigation") {
      await userEvent.keyboard("{ArrowDown}");
      await reading.received;
      await userEvent.click(address);
    }
    browser.setFocusedEditing(null);
    act(() => {
      browser.event(
        "Page.navigatedWithinDocument",
        { frameId: "example-frame", url: "https://example.com/#next" },
        "example-page-session",
      );
    });
    const navigationFocus =
      source === "pre-navigation"
        ? address
        : screen.getByRole("img", { name: "Live browser view" }).parentElement;
    expect(navigationFocus).toHaveFocus();
    if (source === "current-page") {
      browser.setFocusedEditing(remoteEditing);
      await userEvent.keyboard("{Tab}");
      await reading.received;
    }
    await fill(address, "chosen.example");
    await act(async () => {
      await reading.release();
    });
    expect(address).toHaveFocus();
    expect(address).toHaveValue("chosen.example");
    expect(input).toHaveAttribute("type", "text");
  },
);

test("A failed editing-context read clears stale keyboard hints without disabling input", async () => {
  const browser = await setupViewer(0);
  browser.setFocusedEditing({
    x: 40,
    y: 50,
    width: 1440,
    height: 900,
    offsetX: 0,
    offsetY: 0,
    editing: {
      type: "text",
      multiline: false,
      inputMode: "none",
      enterKeyHint: "done",
      autoCapitalize: "characters",
      lang: "ja",
    },
  });
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "none");
  });
  browser.setFocusedEditing(null);
  browser.failNext("Runtime.evaluate", "Cannot find context with specified id");
  fireEvent.keyDown(input, { key: "Tab", code: "Tab", keyCode: 9 });
  fireEvent.keyUp(input, { key: "Tab", code: "Tab", keyCode: 9 });
  await waitFor(() => {
    expect(input).toHaveAttribute("inputmode", "text");
    expect(input).toHaveAttribute("enterkeyhint", "enter");
    expect(input).toHaveAttribute("lang", "");
  });
  expect(input).toBeEnabled();
  expect(input).toHaveFocus();
  fireEvent.input(input, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh" },
    });
  });
});

test.each(["success", "failure"])(
  "A retired tab's delayed %s cannot alter the successor editing context",
  async (outcome) => {
    const browser = await setupMultiTabViewer();
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type: "password",
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "done",
        autoCapitalize: "none",
        lang: "ja",
      },
    });
    if (outcome === "failure") {
      browser.failNext(
        "Runtime.evaluate",
        "Cannot find context with specified id",
      );
    }
    const reading = browser.holdNext("Runtime.evaluate");
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    await expect(reading.received).resolves.toContain(
      outcome === "failure" ? '"error"' : '"password"',
    );
    browser.setFocusedEditing({
      x: 40,
      y: 50,
      width: 1440,
      height: 900,
      offsetX: 0,
      offsetY: 0,
      editing: {
        type: "text",
        multiline: false,
        inputMode: "numeric",
        enterKeyHint: "send",
        autoCapitalize: "none",
        lang: "en",
      },
    });
    await userEvent.click(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    await waitFor(() => {
      expect(input).toHaveAttribute("inputmode", "numeric");
      expect(input).toHaveAttribute("enterkeyhint", "send");
    });
    await act(async () => {
      await reading.release();
    });
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("enterkeyhint", "send");
    expect(input).toHaveAttribute("lang", "en");
  },
);

test("Native form actions forward Enter once without submitting an IME candidate", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  const form = input.closest("form")!;
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Unidentified", keyCode: 229 });
  expect(fireEvent.submit(form)).toBeFalsy();
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.submit(form);
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertParagraph",
    }),
  );
  fireEvent.keyUp(input, { key: "Enter", code: "Enter", keyCode: 13 });
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent.submit(form);
  expect(
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertParagraph",
      }),
    ),
  ).toBeTruthy();
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "insertCompositionText",
  });
  fireEvent.input(input, { inputType: "insertLineBreak" });
  for (const inputType of ["insertLineBreak", "insertParagraph"]) {
    expect(
      fireEvent(
        input,
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType,
        }),
      ),
    ).toBeFalsy();
  }
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: "first\nsecond",
    }),
  );
  fireEvent.input(input, {
    target: { value: "last" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "last" },
    });
  });
  const keys = browser.input.filter((request) => {
    return request.method === "Input.dispatchKeyEvent";
  });
  expect(keys).toHaveLength(10);
  for (let index = 0; index < keys.length; index += 2) {
    expect(keys[index]).toMatchObject({
      params: {
        type: "keyDown",
        key: "Enter",
        text: "\r",
        unmodifiedText: "\r",
      },
    });
    expect(keys[index + 1]).toMatchObject({
      params: { type: "keyUp", key: "Enter" },
    });
  }
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toStrictEqual([
    expect.objectContaining({ params: { text: "中" } }),
    expect.objectContaining({ params: { text: "first\nsecond" } }),
    expect.objectContaining({ params: { text: "last" } }),
  ]);
});

test("Soft-keyboard deletion forwards after committed text without duplicating desktop Backspace", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "d" },
    data: "d",
    inputType: "insertText",
  });
  fireEvent.keyDown(input, {
    key: "Unidentified",
    keyCode: 229,
  });
  for (let index = 0; index < 2; index++) {
    fireEvent(
      input,
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "deleteContentBackward",
      }),
    );
  }
  fireEvent.keyDown(input, {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
  });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.keyUp(input, {
    key: "Backspace",
    code: "Backspace",
    keyCode: 8,
  });
  fireEvent.input(input, {
    target: { value: "next" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "next" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual(
    Array.from({ length: 3 }, () => {
      return [
        {
          method: "Input.dispatchKeyEvent",
          sessionId: "example-page-session",
          params: expect.objectContaining({
            type: "rawKeyDown",
            key: "Backspace",
          }),
        },
        {
          method: "Input.dispatchKeyEvent",
          sessionId: "example-page-session",
          params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
        },
      ];
    }).flat(),
  );
});

test("Queued soft-keyboard deletion and Enter cannot reach a replacement tab", async () => {
  const browser = await setupMultiTabViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  // A pending native preedit keeps the subsequent commit and deletion queued.
  const pending = browser.holdNext("Input.imeSetComposition");
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "old" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await pending.received;
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "old",
    }),
  );
  fireEvent.submit(input.closest("form")!);
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await pending.release();
  const successor = screen.getByLabelText("Remote browser input");
  await userEvent.click(successor);
  fireEvent(
    successor,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.input(successor, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toStrictEqual({
      method: "Input.insertText",
      params: { text: "fresh" },
      sessionId: "other-page-session",
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual([
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "other-page-session",
      params: expect.objectContaining({ type: "rawKeyDown", key: "Backspace" }),
    },
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "other-page-session",
      params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
    },
  ]);
});

test("Backward deletion preserves preedit and consumes committed composition residuals", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中国" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
      isComposing: true,
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    inputType: "deleteCompositionText",
    isComposing: true,
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "deleteContentBackward",
    }),
  );
  fireEvent.input(input, {
    inputType: "deleteContentBackward",
  });
  fireEvent.input(input, {
    target: { value: "fresh" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toStrictEqual([
    {
      method: "Input.insertText",
      sessionId: "example-page-session",
      params: { text: "中" },
    },
    {
      method: "Input.insertText",
      sessionId: "example-page-session",
      params: { text: "fresh" },
    },
  ]);
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toStrictEqual([
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "example-page-session",
      params: expect.objectContaining({ type: "rawKeyDown", key: "Backspace" }),
    },
    {
      method: "Input.dispatchKeyEvent",
      sessionId: "example-page-session",
      params: expect.objectContaining({ type: "keyUp", key: "Backspace" }),
    },
  ]);
});

test("IME preedit and confirmation progress while keyboard metadata is pending", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  const metadata = browser.holdNext("Runtime.evaluate");
  await userEvent.click(input);
  await metadata.received;
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "中" },
    data: "中",
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.imeSetComposition",
      params: { text: "中", selectionStart: 1, selectionEnd: 1 },
      sessionId: "example-page-session",
    });
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "中",
    }),
  );
  fireEvent.input(input, {
    target: { value: "中" },
    data: "中",
    inputType: "insertCompositionText",
    isComposing: false,
  });
  await waitFor(() => {
    expect(
      browser.input.filter((request) => {
        return request.method === "Input.insertText";
      }),
    ).toStrictEqual([
      {
        method: "Input.insertText",
        params: { text: "中" },
        sessionId: "example-page-session",
      },
    ]);
  });
  expect(input).toHaveFocus();
  await act(async () => {
    await metadata.release();
  });
});

test("A payload-less context reset retires composition before accepting new remote text", async () => {
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "old" },
    data: "old",
    inputType: "insertCompositionText",
    isComposing: true,
  });
  act(() => {
    browser.event(
      "Runtime.executionContextsCleared",
      undefined,
      "example-page-session",
    );
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "old",
    }),
  );
  expect(
    screen.getByRole("img", { name: "Live browser view" }).parentElement,
  ).toHaveFocus();
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "fresh" },
    data: "fresh",
    inputType: "insertText",
    isComposing: false,
  });
  await waitFor(() => {
    expect(
      browser.input.filter((request) => {
        return request.method === "Input.insertText";
      }),
    ).toStrictEqual([
      {
        method: "Input.insertText",
        sessionId: "example-page-session",
        params: { text: "fresh" },
      },
    ]);
  });
});

test("Retrying an image waits for both original input and capture cleanup", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const pendingInput = browser.holdNext("Input.insertText");
  fireEvent.input(input, {
    target: { value: "typed" },
    inputType: "insertText",
  });
  await pendingInput.received;
  const pendingStop = browser.holdNext("Page.stopScreencast");
  act(() => {
    browser.frame("!");
  });
  await pendingStop.received;
  await screen.findByText("Reconnecting…");
  expect(input).toBeDisabled();
  await pendingInput.release();
  expect(input).toBeDisabled();
  await pendingStop.release();
  advanceRecovery(1000);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("Closing a tab preserves address focus chosen while the close is pending", async () => {
  const browser = await setupMultiTabViewer();
  const closed = browser.holdNext("Target.closeTarget");
  await userEvent.click(screen.getByLabelText("Close Other"));
  await closed.received;
  const address = screen.getByLabelText("Address");
  await fill(address, "draft.example");
  await closed.release();
  await waitFor(() => {
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("draft.example");
  expect(
    browser.targets.map((target) => {
      return target.title;
    }),
  ).toStrictEqual(["Example"]);
});

test.each(["latest-close", "address-choice"] as const)(
  "An older close failure preserves the %s focus while its selected trigger is disabled",
  async (choice) => {
    const browser = await setupMultiTabViewer();
    browser.failNext("Target.closeTarget", "The first close was refused");
    const older = browser.holdNext("Target.closeTarget");
    await userEvent.click(screen.getByLabelText("Close Example"));
    await older.received;
    const latest = browser.holdNext("Target.closeTarget");
    await userEvent.click(screen.getByLabelText("Close Other"));
    await latest.received;
    await act(async () => {
      await latest.release();
    });
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-disabled", "true");
    if (choice === "address-choice") {
      await fill(screen.getByLabelText("Address"), "chosen.example/draft");
    }
    await act(async () => {
      await older.release();
    });
    await screen.findByRole("alert");
    await waitFor(() => {
      expect(
        screen.getByLabelText("Example", { selector: '[role="tab"]' }),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
    const destination =
      choice === "address-choice"
        ? screen.getByLabelText("Address")
        : screen.getByLabelText("Example", { selector: '[role="tab"]' });
    await waitFor(() => {
      expect(destination).toHaveFocus();
    });
    expect(screen.getByLabelText("Address")).toHaveValue(
      choice === "address-choice"
        ? "chosen.example/draft"
        : "https://example.com",
    );
  },
);

test("A removed keyboard-focus origin recovers once without reclaiming a later address draft", async () => {
  const browser = await setupMultiTabViewer();
  await userEvent.click(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  );
  await userEvent.keyboard("{ArrowRight}");
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveFocus();
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  act(() => {
    browser.event("Target.targetDestroyed", { targetId: "other-page" });
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveFocus();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "chosen.example/draft");
  const target = browser.targets[0]!;
  act(() => {
    target.title = "Updated Example";
    browser.event("Target.targetInfoChanged", {
      targetInfo: { ...target, type: "page" },
    });
    browser.nativeEvent("tab-updated", target);
  });
  await screen.findByLabelText("Updated Example", { selector: '[role="tab"]' });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("chosen.example/draft");
});

test("A close receipt returns focus before the successor has a live image", async () => {
  const browser = await setupMultiTabViewer();
  const image = browser.holdFrames("other-page-session");
  const closed = browser.holdNext("Target.closeTarget");
  await userEvent.click(screen.getByLabelText("Close Example"));
  await closed.received;
  await act(async () => {
    await closed.release();
  });
  await image.received;
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveFocus();
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other"]);

  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("Shared tab controls support keyboard selection and address Escape", async () => {
  const browser = await setupMultiTabViewer();
  await userEvent.click(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  );
  await userEvent.keyboard("{ArrowRight}");
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveFocus();
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toBeEnabled();
  });
  await fill(screen.getByLabelText("Address"), "unfinished.example");
  await userEvent.keyboard("{Escape}");
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
  expect(screen.getByLabelText("Address")).toHaveFocus();
  expect(browser.targets[1]?.url).toBe("https://other.example.com");
});

test("A hidden page pauses input and resumes the selected tab when visible", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupMultiTabViewer();
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
  });
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const image = browser.holdTargetFrames("other-page");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await image.received;
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.queryByText("Connecting to browser…")).toBeNull();
  const updating = screen.getByText("Updating view…");
  expect(updating).toHaveAttribute("role", "status");
  expect(updating.parentElement).toHaveTextContent(
    "Kept while open; reclaimed after 10 idle minutes.",
  );
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    browser.event(
      "Page.screencastFrame",
      {
        data: "AAAA",
        sessionId: 991,
        metadata: {
          timestamp: 0.5,
          offsetTop: 0,
          pageScaleFactor: 1,
          deviceWidth: browser.viewport.width,
          deviceHeight: browser.viewport.height,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      },
      browser.pageSession("other-page"),
    );
    await waitFor(() => {
      expect(browser.requests).toContainEqual(
        expect.objectContaining({
          method: "Page.screencastFrameAck",
          params: { sessionId: 991 },
        }),
      );
    });
  });
  expect(screen.getByText("Updating view…")).toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
  expect(screen.queryByText("Updating view…")).not.toBeInTheDocument();
});

test("Rapid visibility changes retain the preview until original capture cleanup and a new image finish", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupMultiTabViewer();
  const stop = browser.holdNext("Page.stopScreencast");
  act(() => {
    visibility.changeTo("hidden");
  });
  await stop.received;
  await screen.findByText("Viewing paused");
  act(() => {
    visibility.changeTo("visible");
    visibility.changeTo("hidden");
    visibility.changeTo("visible");
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.queryByText("Connecting to browser…")).toBeNull();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const image = browser.holdTargetFrames("example-page");
  await act(async () => {
    await stop.release();
    await image.received;
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "after-visibility.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://after-visibility.example/ready");
  });
});

test.each([
  "original stop",
  "pending original stop",
  "resume preparation",
] as const)(
  "A resume after a failed %s recovers before accepting input",
  async (failure) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const visibility = context.mocks.browser.visibilityState("visible");
    const browser = await setupViewer(0);
    if (failure !== "resume preparation") {
      browser.failNext("Page.stopScreencast", "Original stop failed");
    }
    const stop = browser.holdNext("Page.stopScreencast");
    act(() => {
      visibility.changeTo("hidden");
    });
    await stop.received;
    await screen.findByText("Viewing paused");
    if (failure === "resume preparation") {
      browser.failNext("Page.createIsolatedWorld", "Resume preparation failed");
    }
    act(() => {
      visibility.changeTo("visible");
      if (failure === "original stop") {
        visibility.changeTo("hidden");
        visibility.changeTo("visible");
      }
    });
    await act(stop.release);
    await screen.findByText(
      failure === "resume preparation"
        ? "Browser view unavailable"
        : "Reconnecting…",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    const image = browser.holdTargetFrames("example-page");
    if (failure === "resume preparation") {
      const retry = screen.getByText("Reconnect", { selector: "button" });
      await expectDisabled(retry, false);
      click(retry);
    } else {
      advanceRecovery(1000);
    }
    await act(async () => {
      await image.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    act(() => {
      visibility.changeTo("hidden");
    });
    await screen.findByText("Viewing paused");
    act(() => {
      visibility.changeTo("visible");
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
  },
);

async function startCaptureDuringNavigation(
  previouslyPaused = true,
  failedReply = true,
) {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupViewer(0);
  if (previouslyPaused) {
    act(() => {
      visibility.changeTo("hidden");
    });
    await screen.findByText("Viewing paused");
    act(() => {
      visibility.changeTo("visible");
    });
  }
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Image format"));
  const menu = await screen.findByRole("menu", { name: "Image format" });
  const png = queryAllByRoleFast("menuitemradio", menu).find((item) => {
    return item.textContent?.trim() === "PNG";
  });
  if (!png) {
    throw new Error("Missing PNG option");
  }
  if (failedReply) {
    browser.failNext("Page.startScreencast", "Capture raced with navigation");
  }
  const capture = browser.holdNext("Page.startScreencast");
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    browser.event(
      "Page.frameStartedNavigating",
      { frameId: "example-frame" },
      browser.pageSession("example-page"),
    );
  });
  await userEvent.click(png);
  await capture.received;
  return { browser, capture, visibility, image };
}

test("An unchanged capture retries its navigation-related failure after navigation ends", async () => {
  const { browser, capture, image } = await startCaptureDuringNavigation();
  await act(capture.release);
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
  act(() => {
    browser.event(
      "Page.frameStoppedLoading",
      { frameId: "example-frame" },
      browser.pageSession("example-page"),
    );
  });
  await act(async () => {
    await image.received;
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(browser.captures.at(-1)).toMatchObject({ format: "png" });
});

test.each(
  (["first pause", "later pause"] as const).flatMap((history) => {
    return (["success", "failure"] as const).flatMap((reply) => {
      return (["before reply", "after reply"] as const).map((order) => {
        return { history, reply, order };
      });
    });
  }),
)(
  "A $history $order cancels the obsolete capture $reply and preserves its session",
  async ({ history, reply, order }) => {
    const { browser, capture, visibility, image } =
      await startCaptureDuringNavigation(
        history === "later pause",
        reply === "failure",
      );
    const canvas = screen.getByRole("img", { name: "Live browser view" });
    const attachments = browser.requests.filter((request) => {
      return request.method === "Target.attachToTarget";
    }).length;
    if (order === "after reply") {
      await act(capture.release);
    }
    const resumed = browser.holdNext("Page.startScreencast");
    act(() => {
      visibility.changeTo("hidden");
      visibility.changeTo("visible");
    });
    expect(screen.getByRole("img", { name: "Live browser view" })).toBe(canvas);
    expect(screen.queryByText("Connecting to browser…")).toBeNull();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await act(async () => {
      await resumed.received;
      await resumed.release();
    });
    expect(screen.getByText("Updating view…")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    expect(browser.captures.at(-1)).toMatchObject({ format: "png" });
    const stops = browser.requests.filter((request) => {
      return request.method === "Page.stopScreencast";
    }).length;
    if (order === "before reply") {
      await act(capture.release);
    }
    act(() => {
      browser.event(
        "Page.frameStoppedLoading",
        { frameId: "example-frame" },
        browser.pageSession("example-page"),
      );
    });
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    fireEvent.input(screen.getByLabelText("Remote browser input"), {
      target: { value: "after capture navigation retry" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "after capture navigation retry" },
      });
    });
    expect(screen.queryByText("Browser view unavailable")).toBeNull();
    expect(
      browser.requests.filter((request) => {
        return request.method === "Target.attachToTarget";
      }),
    ).toHaveLength(attachments);
    expect(
      browser.requests.filter((request) => {
        return request.method === "Page.stopScreencast";
      }),
    ).toHaveLength(stops);
  },
);

test.each(["preparation", "first image"] as const)(
  "Pausing automatic image recovery during %s leaves its replacement owner usable",
  async (phase) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const visibility = context.mocks.browser.visibilityState("visible");
    const browser = await setupViewer(0);
    act(() => {
      browser.frame("!");
    });
    await screen.findByText("Reconnecting…");
    const old =
      phase === "preparation"
        ? browser.holdNext("Page.createIsolatedWorld")
        : browser.holdTargetFrames("example-page");
    advanceRecovery(1000);
    await act(async () => {
      await old.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      visibility.changeTo("hidden");
    });
    await screen.findByText("Viewing paused");
    const fresh = browser.holdNext("Page.startScreencast");
    const image = browser.holdTargetFrames("example-page");
    act(() => {
      visibility.changeTo("visible");
    });
    await act(async () => {
      await fresh.received;
      await fresh.release();
      await image.received;
    });
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      image.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    await act(async () => {
      await old.release();
    });
    await userEvent.click(screen.getByLabelText("Remote browser input"));
    fireEvent.input(screen.getByLabelText("Remote browser input"), {
      target: { value: "after interrupted image retry" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.insertText",
        params: { text: "after interrupted image retry" },
      });
    });
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(screen.queryByText("Browser view unavailable")).toBeNull();
  },
);

test("A visibility pause preserves local address editing without queuing an early submission", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupViewer(0);
  const address = screen.getByLabelText("Address");
  await fill(address, "local-draft.example/path");
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await image.received;
  });
  expect(address).toBeEnabled();
  expect(address).toHaveValue("local-draft.example/path");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await userEvent.click(address);
  await userEvent.keyboard("{Enter}");
  expect(
    screen.getByText("The browser is not ready. Try again shortly."),
  ).toBeInTheDocument();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(address).toHaveValue("local-draft.example/path");
  expect(browser.targets[0]?.url).toBe("https://example.com");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://local-draft.example/path");
  });
});

test("A visibility pause during membership revalidation retains the initialized preview until fresh proof and image", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupViewer(0);
  const proof = browser.holdNextMembership("example-page");
  act(() => {
    browser.nativeEvent("tab-created", undefined, { tabId: 12, windowId: 0 });
  });
  await proof.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.queryByText("Connecting to browser…")).toBeNull();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    await proof.release();
    await image.received;
  });
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("A document navigated while hidden is observed before the retained viewer accepts new input", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupMultiTabViewer();
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    browser.targets[0]!.url = "https://background.example/changed";
    browser.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "replacement-document-frame",
          loaderId: "background-loader",
          url: "https://background.example/changed",
        },
      },
      browser.pageSession("example-page"),
    );
  });
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await image.received;
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://background.example/changed",
  );
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "after-background-navigation.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue(
      "http://after-background-navigation.example/ready",
    );
  });
});

test("A resumed viewer can pause again while its replacement picture is still pending", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupMultiTabViewer();
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await image.received;
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  const capture = browser.holdNext("Page.startScreencast");
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await capture.received;
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.queryByText("Connecting to browser…")).toBeNull();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await act(async () => {
    await capture.release();
    image.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("A retained viewer waits for its original key release before accepting resumed input", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft", keyCode: 16 });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Shift" },
    });
  });
  const release = browser.holdNext("Input.dispatchKeyEvent");
  act(() => {
    visibility.changeTo("hidden");
  });
  await release.received;
  await screen.findByText("Viewing paused");
  const image = browser.holdTargetFrames("example-page");
  act(() => {
    visibility.changeTo("visible");
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(input).toBeDisabled();
  await act(async () => {
    await release.release();
    await image.received;
  });
  expect(input).toBeDisabled();
  act(() => {
    image.release();
  });
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "after original release" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after original release" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.dispatchKeyEvent";
    }),
  ).toMatchObject([
    { params: { type: "rawKeyDown", key: "Shift" } },
    { params: { type: "keyUp", key: "Shift" } },
  ]);
});

test("An initially hidden viewer establishes usable content after becoming visible", async () => {
  const visibility = context.mocks.browser.visibilityState("hidden");
  mockViewer(0);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await screen.findByText("Viewing paused");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    visibility.changeTo("visible");
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("Hiding during native page initialization restores only the current selection", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = mockViewer(0);
  const initialization = browser.holdNext("Page.enable");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await initialization.received;
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    visibility.changeTo("visible");
  });
  await act(async () => {
    await initialization.release();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("A visibility pause discards an unfinished composition before fresh text is accepted", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const browser = await setupViewer(0);
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  const preedit = browser.holdNext("Input.imeSetComposition");
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "旧" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await preedit.received;
  act(() => {
    visibility.changeTo("hidden");
  });
  await screen.findByText("Viewing paused");
  act(() => {
    visibility.changeTo("visible");
  });
  expect(input).toBeDisabled();
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  await act(async () => {
    await preedit.release();
  });
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "旧",
    }),
  );
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "fresh text" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "fresh text" },
    });
  });
  expect(
    browser.input.filter((request) => {
      return request.method === "Input.insertText";
    }),
  ).toMatchObject([{ params: { text: "fresh text" } }]);
});

test("An old image cleanup cannot replace a newly selected tab", async () => {
  browserRecoveryClock(context.signal);
  const browser = await setupMultiTabViewer();
  const stop = browser.holdNext("Page.stopScreencast");
  act(() => {
    browser.frame("!");
  });
  await stop.received;
  await screen.findByText("Reconnecting…");
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await stop.release();
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test.each(["queued", "reading"])(
  "Blur cancels a %s copy without reporting a failure and permits fresh input",
  async (phase) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const write = context.mocks.deferred<PromiseSettledResult<Blob>>();
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      const [result] = await Promise.allSettled(
        items.map((item) => {
          return item.getType("text/plain");
        }),
      );
      if (!result) {
        throw new Error("Expected a plain-text clipboard item");
      }
      write.resolve(result);
      if (result.status === "rejected") {
        throw result.reason;
      }
    });
    const browser = await setupMultiTabViewer();
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    const pending = browser.holdNext(
      phase === "queued" ? "Input.insertText" : "Page.createIsolatedWorld",
    );
    if (phase === "queued") {
      fireEvent.input(input, {
        target: { value: "before-copy" },
        inputType: "insertText",
      });
      await pending.received;
    }
    // Model the trusted native gesture at the browser event boundary; synthetic
    // happy-dom clipboard events do not carry browser activation themselves.
    const copy = new ClipboardEvent("copy", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(copy, "isTrusted", { value: true });
    fireEvent(input, copy);
    if (phase === "reading") {
      await pending.received;
    }
    await userEvent.click(screen.getByLabelText("Address"));
    await expect(write.promise).resolves.toMatchObject({
      status: "rejected",
      reason: { name: "AbortError", message: "Copy cancelled" },
    });
    await act(async () => {
      await pending.release();
    });
    await userEvent.click(input);
    const fresh = browser.holdNext("Input.insertText");
    fireEvent.input(input, {
      target: { value: "after-blur" },
      inputType: "insertText",
    });
    await fresh.received;
    await act(async () => {
      await fresh.release();
    });
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "after-blur" },
      sessionId: "example-page-session",
    });
    expect(input).toBeEnabled();
    expect(sentry.reports).toStrictEqual([]);
  },
);

test("A late modifier cleanup stays on its original tab while the successor keeps editing", async () => {
  const browser = await setupMultiTabViewer();
  const original = screen.getByLabelText("Remote browser input");
  await userEvent.click(original);
  fireEvent.keyDown(original, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "example-page-session",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  const release = browser.holdNext("Input.dispatchKeyEvent");
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await release.received;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const successor = screen.getByLabelText("Remote browser input");
  await userEvent.click(successor);
  fireEvent.keyDown(successor, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "other-page-session",
        params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
      }),
    );
  });
  await release.release();
  fireEvent.keyUp(successor, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        sessionId: "other-page-session",
        params: expect.objectContaining({ type: "keyUp", key: "Shift" }),
      }),
    );
  });
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test.each([
  { phase: "input", secondaryFailure: false },
  { phase: "input", secondaryFailure: true },
  { phase: "cleanup", secondaryFailure: false },
] as const)(
  "A failed original $phase receipt keeps its attribution and fence (later failure: $secondaryFailure)",
  async ({ phase, secondaryFailure }) => {
    const sentry = context.mocks.sentry();
    initSentry();
    const browser = await setupMultiTabViewer();
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown" },
      });
    });

    if (phase === "input") {
      browser.failNext("Input.insertText", "private-provider-message");
      const receipt = browser.holdNext("Input.insertText");
      fireEvent.input(input, {
        target: { value: "private-remote-text" },
        inputType: "insertText",
      });
      await receipt.received;
      if (secondaryFailure) {
        // A later, different cleanup failure must not replace the original cause.
        browser.failNext(
          "Input.dispatchKeyEvent",
          "secondary-private-message",
          -32_001,
        );
      }
      await receipt.release();
    } else {
      browser.failNext("Input.dispatchKeyEvent", "private-provider-message");
    }

    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(screen.getByLabelText("Address")).toHaveValue(
        "https://other.example.com",
      );
    });
    const successor = screen.getByLabelText("Remote browser input");
    await userEvent.click(successor);
    fireEvent.input(successor, {
      target: { value: "fresh-successor-text" },
      inputType: "insertText",
    });
    await waitFor(() => {
      expect(browser.input.at(-1)).toStrictEqual({
        method: "Input.insertText",
        params: { text: "fresh-successor-text" },
        sessionId: "other-page-session",
      });
    });

    click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
    await screen.findByText("Browser view unavailable");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    const method =
      phase === "input" ? "Input.insertText" : "Input.dispatchKeyEvent";
    await waitFor(() => {
      expect(reportedCleanupError(sentry)).toMatchObject({
        code: undefined,
        request: { method, code: -32_000 },
        cause: {
          message: "Original input retirement failed.",
          cause: {
            message: `Original ${phase} receipt failed: ${method} (CDP -32000).`,
          },
        },
      });
    });
    const diagnostic = JSON.stringify(
      reportedCleanupError(sentry),
      (_key, value: unknown) => {
        return value instanceof Error
          ? {
              ...value,
              message: value.message,
              stack: value.stack,
              cause: value.cause,
            }
          : value;
      },
    );
    expect(diagnostic).not.toMatch(
      /private-|fresh-successor-text|ShiftLeft|example-page|other-page/,
    );
    expect(
      browser.requests.filter((request) => {
        return (
          request.method.startsWith("Input.") &&
          request.sessionId === "other-page-session"
        );
      }),
    ).toStrictEqual([
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "fresh-successor-text" },
      }),
    ]);
  },
);

async function revisitAfterUnsupportedIme(mixed: boolean) {
  const sentry = context.mocks.sentry();
  initSentry();
  const browser = await setupMultiTabViewer();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  if (mixed) {
    const supported = browser.holdNext("Input.imeSetComposition");
    fireEvent.input(input, {
      target: { value: "private-preedit" },
      inputType: "insertCompositionText",
      isComposing: true,
    });
    await supported.received;
    await supported.release();
  }
  browser.failNext("Input.imeSetComposition", "private-ime-message", -32_601);
  const unsupported = browser.holdNext("Input.imeSetComposition");
  fireEvent.input(input, {
    target: { value: "private-preedit-next" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await unsupported.received;
  await unsupported.release();
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "private-committed-text",
    }),
  );
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "private-committed-text" },
    });
  });
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
  });
  click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
  return sentry;
}

test("Unsupported-only IME preserves committed text and permits returning to its tab", async () => {
  await revisitAfterUnsupportedIme(false);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  });
});

test("Mixed IME support retains the safe unsupported receipt and same-tab fence", async () => {
  const sentry = await revisitAfterUnsupportedIme(true);
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await waitFor(() => {
    expect(reportedCleanupError(sentry)).toMatchObject({
      code: undefined,
      request: { method: "Input.imeSetComposition", code: -32_601 },
      cause: {
        message: "Original input retirement failed after mixed IME support.",
        cause: {
          message:
            "Original input receipt failed: Input.imeSetComposition (CDP -32601).",
        },
      },
    });
  });
});

test.each(["closed", "still open"])(
  "A selected CDP session detaching while its tab is %s automatically revalidates and resumes",
  async (tabState) => {
    const browser = mockViewer(0);
    browser.targets[1]!.windowId = 0;
    await setupPage({ context, path: `/browsers/${threadId}` });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const membership = browser.holdNextMembership("example-page");
    act(() => {
      if (tabState === "closed") {
        browser.targets.splice(0, 1);
      }
      browser.event("Target.detachedFromTarget", {
        sessionId: "example-page-session",
        targetId: "example-page",
      });
    });
    await membership.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    await membership.release();
    const survivor = tabState === "closed" ? "Other" : "Example";
    await waitFor(() => {
      expect(
        screen.getByLabelText(survivor, { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    if (tabState === "closed") {
      act(() => {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      });
    }
    const address = screen.getByLabelText("Address");
    await fill(address, "resumed.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://resumed.example/ready");
    });
    expect(browser.targets[0]?.url).toBe("http://resumed.example/ready");
  },
);

test.each(["closed", "moved away", "still open"])(
  "A session detached before page initialization finishes recovers while its tab is %s",
  async (tabState) => {
    const browser = await setupScopedPair();
    const initialization = browser.holdNext("Page.enable");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await initialization.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      if (tabState === "closed") {
        browser.targets.splice(1, 1);
      } else if (tabState === "moved away") {
        browser.targets[1]!.windowId = 1;
      }
      browser.event("Target.detachedFromTarget", {
        sessionId: "other-page-session",
        targetId: "other-page",
      });
    });
    const survivor = tabState === "still open" ? "Other" : "Example";
    await waitFor(() => {
      expect(
        screen.getByLabelText(survivor, { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    await initialization.release();
    const address = screen.getByLabelText("Address");
    await fill(address, "initialized-session.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://initialized-session.example/ready");
    });
  },
);

test("A received session detaching during membership admission releases its original wait", async () => {
  const browser = await setupScopedPair();
  const attachment = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await attachment.received;
  const membership = browser.holdNextMembership("other-page");
  await attachment.release();
  await membership.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  act(() => {
    browser.event("Target.detachedFromTarget", {
      sessionId: "other-page-session",
      targetId: "other-page",
    });
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await membership.release();
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  const address = screen.getByLabelText("Address");
  await fill(address, "admitted-session.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://admitted-session.example/ready");
  });
});

test("A retired initializing session cannot revoke the newer selected tab", async () => {
  const browser = mockViewer(0);
  browser.targets[1]!.windowId = 0;
  browser.targets.push({
    targetId: "last-page",
    title: "Last",
    url: "https://last.example.com",
    windowId: 0,
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const initialization = browser.holdNext("Page.enable");
  act(() => {
    browser.targets.splice(0, 1);
    browser.event("Target.targetDestroyed", { targetId: "example-page" });
  });
  await initialization.received;
  click(screen.getByLabelText("Last", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  act(() => {
    browser.event("Target.detachedFromTarget", {
      sessionId: "other-page-session",
      targetId: "other-page",
    });
  });
  await initialization.release();
  expect(
    screen.getByLabelText("Last", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  const address = screen.getByLabelText("Address");
  await fill(address, "newer-selection.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://newer-selection.example/ready");
  });
});

test("A split connection recovers if the control session detaches while its image attachment is pending", async () => {
  const browser = await setupScopedPair();
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Connection mode"));
  await userEvent.click(await screen.findByText("Separate image connection"));
  await waitFor(() => {
    expect(browser.connections()).toBe(3);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const control = browser.holdNext("Target.attachToTarget");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await control.received;
  const image = browser.holdNext("Target.attachToTarget");
  await control.release();
  await image.received;
  act(() => {
    browser.event("Target.detachedFromTarget", {
      sessionId: "other-page-session",
      targetId: "other-page",
    });
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await image.release();
  const address = screen.getByLabelText("Address");
  await fill(address, "separate-image.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://separate-image.example/ready");
  });
});

test.each(["Page.enable", "Page.getFrameTree"])(
  "An ordinary initialization failure in %s during opening follows recovery policy",
  async (method) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const browser = mockViewer(0);
    browser.failNext(method, "Page initialization failed");
    await setupPage({ context, path: `/browsers/${threadId}` });
    await screen.findByText(
      method === "Page.getFrameTree"
        ? "Reconnecting…"
        : "Browser view unavailable",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    if (method === "Page.getFrameTree") {
      advanceRecovery(1000);
      await expectDisabled(
        screen.getByLabelText("Remote browser input"),
        false,
      );
    }
  },
);

test("A split viewer retries its selected image after frames loss during page admission", async () => {
  const browser = await setupScopedPair();
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Connection mode"));
  await userEvent.click(await screen.findByText("Separate image connection"));
  await waitFor(() => {
    expect(browser.connections()).toBe(3);
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const admission = browser.holdNext("Page.enable");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await admission.received;
  act(() => {
    browser.disconnect({ code: 1006, wasClean: false }, 1);
  });
  await screen.findByText("Retry live image");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  const reconnect = queryAllByRoleFast("button").find((button) => {
    return button.textContent?.trim() === "Retry live image";
  });
  if (!reconnect) {
    throw new Error("Missing image recovery control");
  }
  click(reconnect);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const current = browser.pageSession("other-page");
  await act(async () => {
    await admission.release();
  });
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "reconnected" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      sessionId: current,
      params: { text: "reconnected" },
    });
  });
});

test.each(["Page.enable", "Page.getFrameTree"])(
  "An initialization failure in %s after opening selection handoff follows recovery policy",
  async (method) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const browser = mockViewer(0);
    const firstCapture = browser.holdNext("Page.startScreencast");
    await setupPage({ context, path: `/browsers/${threadId}` });
    await firstCapture.received;
    browser.failNext(method, "Successor initialization failed");
    const failure = browser.holdNext(method);
    act(() => {
      browser.event("Target.detachedFromTarget", {
        sessionId: "example-page-session",
        targetId: "example-page",
      });
    });
    await failure.received;
    // A transient failure must not publish before retry admission.
    const retry = browser.holdNext("Target.attachToTarget");
    await act(async () => {
      await failure.release();
      await firstCapture.release();
    });
    await screen.findByText(
      method === "Page.getFrameTree"
        ? "Reconnecting…"
        : "Browser view unavailable",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    if (method === "Page.getFrameTree") {
      advanceRecovery(1000);
      await retry.received;
      await expectDisabled(screen.getByLabelText("Remote browser input"), true);
      await act(retry.release);
      await expectDisabled(
        screen.getByLabelText("Remote browser input"),
        false,
      );
    }
  },
);

test("A late detach from a previous visit cannot retire the current same-target session", async () => {
  const browser = await setupScopedPair();
  const original = browser.pageSession("example-page");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const current = browser.pageSession("example-page");
  act(() => {
    browser.event("Target.detachedFromTarget", { sessionId: original });
  });
  const input = screen.getByLabelText("Remote browser input");
  expect(input).toBeEnabled();
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "current visit" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      sessionId: current,
      params: { text: "current visit" },
    });
  });
});

test.each([
  ["membership", "closed"],
  ["page initialization", "closed"],
  ["membership", "moved"],
  ["page initialization", "moved"],
] as const)(
  "A target disappearing during %s (%s) recovers before its delayed lifecycle event",
  async (phase, loss) => {
    const browser = await setupScopedPair();
    if (phase === "page initialization") {
      browser.failNext(
        "Page.enable",
        "Target disappeared during initialization",
      );
    }
    const membership =
      phase === "membership" ? browser.holdNextMembership("other-page") : null;
    const admission = membership ?? browser.holdNext("Page.enable");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await admission.received;
    const lostTarget = browser.targets[1]!;
    if (loss === "closed") {
      browser.targets.splice(1, 1);
    } else {
      lostTarget.windowId = 1;
    }
    await act(async () => {
      if (membership) {
        await membership.releaseFailure();
      } else {
        await admission.release();
      }
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(
        screen.getByLabelText("Example", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    act(() => {
      if (loss === "closed") {
        browser.event("Target.targetDestroyed", { targetId: "other-page" });
      } else {
        browser.nativeEvent("tab-detached", lostTarget, { oldWindowId: 0 });
        browser.nativeEvent("tab-attached", lostTarget);
      }
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const address = screen.getByLabelText("Address");
    await fill(address, "admission-survivor.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://admission-survivor.example/ready");
    });
  },
);

test("Cancelling a lost selection releases tab controls while its old native proof is unacknowledged", async () => {
  const browser = mockViewer(0);
  browser.targets[1]!.windowId = 0;
  browser.targets.push({
    targetId: "last-page",
    title: "Last",
    url: "https://last.example.com",
    windowId: 0,
  });
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const membership = browser.holdNextMembership("other-page");
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await membership.received;
  const proof = browser.holdNextNative("getWindow");
  await membership.releaseFailure();
  await proof.received;
  act(() => {
    browser.targets.splice(1, 1);
    browser.event("Target.targetDestroyed", { targetId: "other-page" });
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      screen.getByLabelText("Last", { selector: '[role="tab"]' }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  click(screen.getByLabelText("Last", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      screen.getByLabelText("Last", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await act(async () => {
    await proof.release();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "after-old-proof.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://after-old-proof.example/ready");
  });
});

test("A detached session releases a held capture request without waiting for its late reply", async () => {
  const browser = mockViewer(0);
  const capture = browser.holdNext("Page.startScreencast");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await capture.received;
  act(() => {
    browser.event("Target.detachedFromTarget", {
      sessionId: "example-page-session",
      targetId: "example-page",
    });
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  await capture.release();
  const address = screen.getByLabelText("Address");
  await fill(address, "fresh-session.example/ready");
  await userEvent.keyboard("{Enter}");
  await waitFor(() => {
    expect(address).toHaveValue("http://fresh-session.example/ready");
  });
});

test("A late session-detachment receipt resolves capture-only retirement uncertainty", async () => {
  const advanceRecovery = browserRecoveryClock(context.signal);
  const browser = await setupViewer(0);
  const proof = browser.holdNextDetach("example-page-session");
  browser.failNext("Page.stopScreencast", "Capture stop unconfirmed");
  act(() => {
    browser.nativeEvent("tab-replaced", undefined, {
      tabId: 12,
      removedTabId: 11,
    });
  });
  await screen.findByText("Reconnecting…");
  await act(async () => {
    await proof.release();
  });
  advanceRecovery(1000);
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

async function setupScopedPair() {
  const browser = mockViewer(0);
  browser.targets[1]!.windowId = 0;
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  return browser;
}

test("A retained selection releases held input and accepts fresh composition after a background change", async () => {
  const browser = await setupScopedPair();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Shift" },
    });
  });
  const proof = browser.holdNextMembership("example-page");
  act(() => {
    browser.nativeEvent("tab-created", undefined, { tabId: 12, windowId: 0 });
  });
  await proof.received;
  expect(input).toBeDisabled();
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key: "Shift", modifiers: 0 },
    });
  });
  await act(proof.release);
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  await userEvent.click(input);
  fireEvent.compositionStart(input);
  fireEvent.input(input, {
    target: { value: "ni" },
    inputType: "insertCompositionText",
    isComposing: true,
  });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.imeSetComposition",
      params: { text: "ni" },
    });
  });
  fireEvent(
    input,
    Object.assign(new Event("compositionend", { bubbles: true }), {
      data: "你",
    }),
  );
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.insertText",
      params: { text: "你" },
    });
  });
});

test.each(["confirmed", "failed"])(
  "A retained selection waits for its original %s input release before readmission",
  async (outcome) => {
    const browser = await setupScopedPair();
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
    await waitFor(() => {
      expect(browser.input.at(-1)).toMatchObject({
        method: "Input.dispatchKeyEvent",
        params: { type: "rawKeyDown", key: "Shift" },
      });
    });
    if (outcome === "failed") {
      browser.failNext("Input.dispatchKeyEvent", "Original key release failed");
    }
    const release = browser.holdNext("Input.dispatchKeyEvent");
    const proof = browser.holdNextNative("getWindow");
    act(() => {
      browser.nativeEvent("tab-created", undefined, { tabId: 12, windowId: 0 });
    });
    await release.received;
    await proof.received;
    await act(proof.release);
    expect(input).toBeDisabled();
    await act(release.release);
    if (outcome === "failed") {
      await screen.findByText("Browser view unavailable");
    }
    await waitFor(() => {
      expect(input).toHaveProperty("disabled", outcome === "failed");
    });
    if (outcome === "failed") {
      click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    }
    await waitFor(() => {
      expect(input).toBeEnabled();
      expect(screen.getByLabelText("Address")).toHaveValue(
        outcome === "failed"
          ? "https://other.example.com"
          : "https://example.com",
      );
    });
  },
);

test("An old retained input release failure cannot revoke the newly selected tab", async () => {
  const browser = await setupScopedPair();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input.at(-1)).toMatchObject({
      method: "Input.dispatchKeyEvent",
      params: { type: "rawKeyDown", key: "Shift" },
    });
  });
  browser.failNext("Input.dispatchKeyEvent", "Original key release failed");
  const release = browser.holdNext("Input.dispatchKeyEvent");
  const proof = browser.holdNextNative("getWindow");
  act(() => {
    browser.nativeEvent("tab-created", undefined, { tabId: 12, windowId: 0 });
  });
  await release.received;
  await proof.received;
  await act(proof.release);
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(
      screen.getByLabelText("Other", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
  });
  await act(release.release);
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
    expect(input).toBeEnabled();
  });
});

async function chooseHealthyTabAfterRetirementFailure(
  browser: ReturnType<typeof mockViewer>,
  method: string,
) {
  const proof = browser.holdNextDetach("example-page-session");
  browser.failNext(method, "Original cleanup unconfirmed");
  act(() => {
    browser.nativeEvent("tab-attached", undefined, { tabId: 12, windowId: 0 });
  });
  await screen.findByText(
    method === "Page.stopScreencast"
      ? "Reconnecting…"
      : "Browser view unavailable",
  );
  click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  return proof;
}

test("A late capture-detachment proof leaves the newer selection live and allows revisiting the retired tab", async () => {
  const browser = await setupScopedPair();
  const proof = await chooseHealthyTabAfterRetirementFailure(
    browser,
    "Page.stopScreencast",
  );
  await act(async () => {
    await proof.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test.each(
  ["capture-end-input", "capture-input-end", "input-capture-end"].flatMap(
    (order) => {
      return [true, false].map((confirmed) => {
        return { order, confirmed };
      });
    },
  ),
)(
  "Original cleanup remains independent for $order (input confirmed=$confirmed)",
  async ({ order, confirmed }) => {
    const browser = await setupScopedPair();
    click(screen.getByLabelText("Browser settings"));
    click(await screen.findByText("Connection mode"));
    click(await screen.findByText("Separate image connection"));
    await waitFor(() => {
      expect(browser.connections()).toBe(3);
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const frameSession = [...browser.requests].reverse().find((request) => {
      return request.method === "Page.startScreencast";
    })?.sessionId;
    if (!frameSession) {
      throw new Error("Missing original frame session");
    }
    const proof = browser.holdNextDetach(frameSession);
    const input = screen.getByLabelText("Remote browser input");
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
    await waitFor(() => {
      expect(browser.input).toContainEqual(
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "rawKeyDown", key: "Shift" }),
        }),
      );
    });
    if (!confirmed) {
      browser.failNext("Input.dispatchKeyEvent", "Input release unconfirmed");
    }
    const release = browser.holdNext("Input.dispatchKeyEvent");
    browser.failNext("Page.stopScreencast", "Capture stop unconfirmed");
    const stop = browser.holdNext("Page.stopScreencast");
    click(screen.getByLabelText("Other", { selector: '[role="tab"]' }));
    await release.received;
    await stop.received;
    if (order === "input-capture-end") {
      await act(async () => {
        await release.release();
      });
    }
    await act(async () => {
      await stop.release();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(screen.getByLabelText("Address")).toHaveValue(
        "https://other.example.com",
      );
    });
    if (order === "capture-end-input") {
      act(() => {
        browser.event("Target.detachedFromTarget", {
          sessionId: frameSession,
          targetId: "example-page",
        });
      });
    } else {
      if (order === "capture-input-end") {
        await act(async () => {
          await release.release();
        });
      }
      await proof.received;
    }
    await act(async () => {
      await proof.release();
    });
    if (order === "capture-end-input") {
      await act(async () => {
        await release.release();
      });
    }
    click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
    if (!confirmed) {
      await screen.findByText("Browser view unavailable");
    }
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toHaveProperty(
        "disabled",
        !confirmed,
      );
    });
    if (!confirmed) {
      return;
    }
    const address = screen.getByLabelText("Address");
    expect(address).toHaveValue("https://example.com");
    await fill(address, "cleanup-proof.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://cleanup-proof.example/ready");
    });
  },
);

test("A capture-detachment proof cannot clear unconfirmed input cleanup", async () => {
  const browser = await setupScopedPair();
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.keyDown(input, { key: "Shift", code: "ShiftLeft" });
  await waitFor(() => {
    expect(browser.input).toContainEqual(
      expect.objectContaining({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ type: "rawKeyDown" }),
      }),
    );
  });
  const proof = await chooseHealthyTabAfterRetirementFailure(
    browser,
    "Input.dispatchKeyEvent",
  );
  await act(async () => {
    await proof.release();
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  click(screen.getByLabelText("Example", { selector: '[role="tab"]' }));
  await screen.findByText("Browser view unavailable");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
});

test.each(["before", "after"])(
  "Selected target destruction %s its failed membership response automatically recovers a scoped survivor",
  async (destruction) => {
    const browser = mockViewer(0);
    browser.targets[1]!.windowId = 0;
    browser.targets.push({
      targetId: "foreign-page",
      title: "Foreign",
      url: "https://foreign.example.com",
      windowId: 1,
    });
    await setupPage({ context, path: `/browsers/${threadId}` });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const membership = browser.holdNextMembership("example-page");
    act(() => {
      browser.nativeEvent("tab-removed", undefined, { tabId: 1, windowId: 0 });
    });
    await membership.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    act(() => {
      browser.targets.splice(0, 1);
      if (destruction === "before") {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      }
    });
    await membership.releaseFailure();
    await waitFor(() => {
      expect(
        screen.getByLabelText("Other", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    if (destruction === "after") {
      act(() => {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      });
    }
    expect(
      queryAllByRoleFast("tab").map((tab) => {
        return tab.getAttribute("aria-label");
      }),
    ).toStrictEqual(["Other"]);
    const address = screen.getByLabelText("Address");
    await fill(address, "survivor.example/ready");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(address).toHaveValue("http://survivor.example/ready");
    });
    expect(browser.targets[0]?.url).toBe("http://survivor.example/ready");
    expect(browser.targets[1]?.url).toBe("https://foreign.example.com");
  },
);

test("A background window lookup failure leaves a valid scoped tab usable", async () => {
  mockViewer(0, ["other-page"]);
  await setupPage({ context, path: `/browsers/${threadId}` });
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Example"]);
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});

test("Losing the last scoped target keeps foreign tabs excluded and permits a native new tab", async () => {
  const browser = await setupViewer(0);
  const membership = browser.holdNextMembership("example-page");
  act(() => {
    browser.nativeEvent("tab-removed", undefined, { tabId: 1, windowId: 0 });
  });
  await membership.received;
  browser.targets.splice(0, 1);
  await membership.releaseFailure();
  await screen.findByText("No tabs open");
  expect(queryAllByRoleFast("tab")).toHaveLength(0);
  click(screen.getByLabelText("New tab", { selector: "button" }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.getByLabelText("New tab", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  expect(screen.getByLabelText("Address")).toHaveValue("");
  expect(browser.targets[0]?.url).toBe("https://other.example.com");
});

test.each(["present target", "failed inventory", "unsupported membership"])(
  "A selected membership failure with %s revokes input until fresh proof",
  async (failure) => {
    const advanceRecovery = browserRecoveryClock(context.signal);
    const browser = await setupViewer(0);
    const membership = browser.holdNextMembership("example-page");
    act(() => {
      browser.nativeEvent("tab-removed", undefined, { tabId: 1, windowId: 0 });
    });
    await membership.received;
    if (failure === "failed inventory") {
      browser.targets.splice(0, 1);
      browser.failNext("Target.getTargets", "Inventory unavailable");
    }
    await membership.releaseFailure(
      "Membership unavailable",
      failure === "unsupported membership" ? -32_601 : -32_000,
    );
    await screen.findByText(
      failure === "unsupported membership"
        ? "Browser view unavailable"
        : "Reconnecting…",
    );
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
    if (failure === "unsupported membership") {
      click(screen.getByText("Reconnect", { selector: "button" }));
    } else {
      advanceRecovery(1000);
    }
    if (failure === "failed inventory") {
      await screen.findByText("No tabs open");
    }
    await waitFor(() => {
      expect(
        screen.getByLabelText("New tab", { selector: "button" }),
      ).toBeEnabled();
      expect(screen.getByLabelText("Remote browser input")).toHaveProperty(
        "disabled",
        failure === "failed inventory",
      );
    });
    expect(browser.connections()).toBe(
      failure === "unsupported membership" ? 2 : 1,
    );
  },
);

test.each([
  ["successful", true],
  ["failed", true],
  ["successful", false],
  ["failed", false],
] as const)(
  "A late %s target-loss confirmation (destroyed=%s) cannot revoke a newer selection",
  async (confirmationResult, destroyed) => {
    const browser = mockViewer(0);
    browser.targets[1]!.windowId = 0;
    browser.targets.push({
      targetId: "last-page",
      title: "Last",
      url: "https://last.example.com",
      windowId: 0,
    });
    await setupPage({ context, path: `/browsers/${threadId}` });
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    const membership = browser.holdNextMembership("example-page");
    act(() => {
      browser.nativeEvent("tab-removed", undefined, { tabId: 1, windowId: 0 });
    });
    await membership.received;
    browser.targets.splice(0, 1);
    if (confirmationResult === "failed") {
      browser.failNext("Target.getTargets", "Late inventory failure");
    }
    const confirmation = browser.holdNext("Target.getTargets");
    await membership.releaseFailure();
    await confirmation.received;
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    if (destroyed) {
      act(() => {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      });
    }
    click(screen.getByLabelText("Last", { selector: '[role="tab"]' }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Last", { selector: '[role="tab"]' }),
      ).toHaveAttribute("aria-selected", "true");
    });
    await confirmation.release();
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
      expect(screen.getByLabelText("Address")).toHaveValue(
        "https://last.example.com",
      );
    });
    expect(
      screen.getByLabelText("Last", { selector: '[role="tab"]' }),
    ).toHaveAttribute("aria-selected", "true");
    if (!destroyed) {
      act(() => {
        browser.event("Target.targetDestroyed", { targetId: "example-page" });
      });
    }
    expect(
      screen.queryByLabelText("Example", { selector: '[role="tab"]' }),
    ).not.toBeInTheDocument();
  },
);

test.each(["window removal", "connection loss"])(
  "A pending target-loss confirmation cannot hide %s",
  async (failure) => {
    browserRecoveryClock(context.signal);
    const browser = await setupViewer(0);
    const membership = browser.holdNextMembership("example-page");
    act(() => {
      browser.nativeEvent("tab-removed", undefined, { tabId: 1, windowId: 0 });
    });
    await membership.received;
    browser.targets.splice(0, 1);
    const confirmation = browser.holdNext("Target.getTargets");
    await membership.releaseFailure();
    await confirmation.received;
    act(() => {
      if (failure === "window removal") {
        browser.nativeEvent("window-removed", undefined, { windowId: 0 });
      } else {
        browser.disconnect({ code: 1006, wasClean: false });
      }
    });
    await screen.findByText(
      failure === "window removal" ? "Browser disconnected" : "Reconnecting…",
    );
    await confirmation.release();
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(
      screen.getByLabelText("New tab", { selector: "button" }),
    ).toBeDisabled();
  },
);

test("A retired background membership failure cannot revoke the usable selected page", async () => {
  const browser = await setupViewer(0);
  const membership = browser.holdNextMembership("other-page");
  act(() => {
    browser.move("other-page", 0);
  });
  // This request is after the cold list and targets B specifically, not A or
  // the bridge's nested Target.getTargets lookup.
  await membership.received;
  act(() => {
    const index = browser.targets.findIndex((target) => {
      return target.targetId === "other-page";
    });
    browser.targets.splice(index, 1);
    browser.event("Target.targetDestroyed", { targetId: "other-page" });
  });
  await membership.releaseFailure();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    screen.queryByLabelText("Other", { selector: '[role="tab"]' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByLabelText("Example", { selector: '[role="tab"]' }),
  ).toHaveAttribute("aria-selected", "true");
  const input = screen.getByLabelText("Remote browser input");
  await userEvent.click(input);
  fireEvent.input(input, {
    target: { value: "still usable" },
    inputType: "insertText",
  });
  await waitFor(() => {
    expect(browser.input).toContainEqual({
      method: "Input.insertText",
      sessionId: browser.pageSession("example-page"),
      params: { text: "still usable" },
    });
  });
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("A held initial inventory cannot resurrect a target destroyed before its reply", async () => {
  const browser = mockViewer();
  browser.move("other-page", 0);
  const inventory = browser.holdNext("Target.getTargets");
  await setupPage({ context, path: `/browsers/${threadId}` });
  await inventory.received;
  act(() => {
    browser.event("Target.targetDestroyed", { targetId: "example-page" });
  });
  await inventory.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("tab").map((tab) => {
      return tab.getAttribute("aria-label");
    }),
  ).toStrictEqual(["Other"]);
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://other.example.com",
  );
});

test("The overflow menu keeps hidden tabs reachable through shared controls", async () => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "browserTabBudget")
        ? new DOMRect(0, 0, 70, 36)
        : original.call(this);
    },
  );
  await setupMultiTabViewer();
  await userEvent.click(screen.getByLabelText("All tabs"));
  const menu = await screen.findByRole("menu");
  const other = queryAllByRoleFast("menuitem", menu).find((item) => {
    return item.textContent?.trim() === "Other";
  });
  if (!other) {
    throw new Error("Missing overflow tab");
  }
  await userEvent.click(other);
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://other.example.com",
    );
  });
  expect(screen.getByLabelText("All tabs")).toHaveFocus();
});

test("Widening restores a removed focused picker only to the committed selected tab", async () => {
  let budget = 70;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "browserTabBudget")
        ? new DOMRect(0, 0, budget, 36)
        : original.call(this);
    },
  );
  await setupMultiTabViewer();
  const picker = screen.getByLabelText("All tabs");
  await userEvent.click(picker);
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(picker).toHaveFocus();
  });
  act(() => {
    budget = 800;
    window.dispatchEvent(new Event("resize"));
  });
  await waitFor(() => {
    expect(
      screen.getByLabelText("Example", { selector: '[role="tab"]' }),
    ).toHaveFocus();
  });
  expect(screen.queryByLabelText("All tabs")).not.toBeInTheDocument();

  const address = screen.getByLabelText("Address");
  await fill(address, "chosen.example/draft");
  act(() => {
    budget = 70;
    window.dispatchEvent(new Event("resize"));
  });
  await screen.findByLabelText("All tabs");
  act(() => {
    budget = 800;
    window.dispatchEvent(new Event("resize"));
  });
  await screen.findByLabelText("Example", { selector: '[role="tab"]' });
  expect(address).toHaveFocus();
  expect(address).toHaveValue("chosen.example/draft");
});

test("Capture controls apply the selected format to the remote browser", async () => {
  const browser = await setupViewer(0);
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.click(await screen.findByText("Image format"));
  const menu = await screen.findByRole("menu", { name: "Image format" });
  const png = queryAllByRoleFast("menuitemradio", menu).find((item) => {
    return item.textContent?.trim() === "PNG";
  });
  if (!png) {
    throw new Error("Missing PNG option");
  }
  await userEvent.click(png);
  await waitFor(() => {
    expect(browser.captures.at(-1)).toMatchObject({ format: "png" });
  });
  await userEvent.click(screen.getByLabelText("Browser settings"));
  const lossless = await screen.findByText("Lossless");
  expect(lossless.closest('[role="menuitem"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
});

test("Following the panel applies its display size and leaves remote input usable", async () => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this instanceof HTMLCanvasElement
        ? new DOMRect(0, 0, 900, 600)
        : original.call(this);
    },
  );
  const browser = await setupViewer(0);
  await waitFor(() => {
    expect(browser.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});
