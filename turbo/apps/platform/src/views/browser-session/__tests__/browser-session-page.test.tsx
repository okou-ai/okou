import {
  browserContract,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import {
  mockBrowserCdp,
  TEST_BROWSER_EXTENSION,
} from "../../../__tests__/browser-cdp-fixture.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { changeChatThreadList } from "../../../mocks/mock-helpers.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { openQualityInput } from "./browser-settings-test-helpers.ts";
import {
  cachedChatListEvents,
  chatListEvent,
  chatListThread,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";

const context = testContext();
const THREAD_ID = "a0000000-0000-4000-a000-000000000345";

function viewerConnection(threadId = THREAD_ID): BrowserViewerConnection {
  const time = "2026-08-01T10:00:00.000Z";
  return {
    browser: {
      threadId,
      name: "Research",
      status: "active",
      viewerUrl: `https://app.okou.ai/browsers/${threadId}`,
      liveUrl: null,
      screenshotUrl: null,
      timeoutMinutes: 10,
      idleExpiresAt: null,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: time,
      updatedAt: time,
      window: {
        instanceId: "a0000000-0000-4000-a000-000000000346",
        primaryWindowId: 1,
      },
    },
    cdpUrl: "wss://cdp.example.test/browser",
    extension: TEST_BROWSER_EXTENSION,
  };
}

async function openBrowserPage(threadId = THREAD_ID): Promise<void> {
  await setupPage({
    context,
    path: `/browsers/${threadId}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
}

async function openViewer(
  targets: NonNullable<Parameters<typeof mockBrowserCdp>[2]>["targets"] = [
    {
      targetId: "example-page",
      title: "Example",
      url: "https://example.com",
      windowId: 1,
    },
  ],
) {
  const viewer = viewerConnection();
  const browser = mockBrowserCdp(context, viewer.cdpUrl, { targets });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });

  await openBrowserPage();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  return browser;
}

function viewerControl(role: "menuitemradio" | "tab", name: string) {
  return queryAllByRoleFast(role).find((item) => {
    return (
      item.getAttribute("aria-label") === name ||
      item.textContent?.trim() === name
    );
  });
}

async function findViewerControl(role: "menuitemradio" | "tab", name: string) {
  return await waitFor(() => {
    const control = viewerControl(role, name);
    if (!control) {
      throw new Error(`Expected ${role} named ${name}`);
    }
    return control;
  });
}

test("Window size settings retain each selected mode when reopened", async () => {
  await openViewer();
  const settings = screen.getByLabelText("Browser settings");
  const openWindowSize = async () => {
    click(settings);
    click(await screen.findByText("Window size"));
  };
  await openWindowSize();
  await expect(
    findViewerControl("menuitemradio", "Follow panel"),
  ).resolves.toBeChecked();

  for (const label of ["On connection", "Follow panel", "Off"]) {
    const option = await findViewerControl("menuitemradio", label);
    await waitFor(() => {
      expect(option).not.toHaveAttribute("aria-disabled", "true");
    });
    click(option);
    await waitFor(() => {
      expect(viewerControl("menuitemradio", label)).toBeUndefined();
    });
    await openWindowSize();
    await expect(
      findViewerControl("menuitemradio", label),
    ).resolves.toBeChecked();
  }
});

test("The Okou viewer shows its host blank page only while the blank tab is selected", async () => {
  await openViewer([
    {
      targetId: "blank-page",
      title: "about:blank",
      url: "about:blank",
      windowId: 1,
    },
    {
      targetId: "example-page",
      title: "Example",
      url: "https://example.com",
      windowId: 1,
    },
  ]);
  const emptyTitle = "Nothing open yet";
  const guidance =
    "Okou opens pages here as it works. Enter a URL above to browse yourself.";
  await expect(screen.findByText(emptyTitle)).resolves.toBeInTheDocument();
  expect(screen.getByText(guidance)).toBeInTheDocument();

  click(await findViewerControl("tab", "Example"));
  const address = screen.getByLabelText("Address");
  await waitFor(() => {
    expect(address).toHaveValue("https://example.com");
    expect(address).toBeEnabled();
    expect(screen.queryByText(emptyTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(guidance)).not.toBeInTheDocument();
  });

  click(await findViewerControl("tab", "New tab"));
  await expect(screen.findByText(emptyTitle)).resolves.toBeInTheDocument();
  expect(screen.getByText(guidance)).toBeInTheDocument();
  expect(address).toBeEnabled();
});

test("Apply numeric quality on Enter and blur while preserving IME editing", async () => {
  const { captures } = await openViewer();
  const input = await openQualityInput();
  expect(input).toHaveValue("70");
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  await fill(input, "");
  expect(input).toHaveValue("");
  await fill(input, "100");
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(input).toBeInTheDocument();
  expect(input).toHaveValue("100");
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ quality: 100 });
    expect(input).not.toHaveAttribute("readonly");
  });
  await fill(input, "0");
  expect(captures.at(-1)).toMatchObject({ quality: 100 });
  input.blur();
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ quality: 0 });
  });
});

test("Apply quality presets and slider keys while preserving Escape focus", async () => {
  const { captures } = await openViewer();
  const input = await openQualityInput();
  await expect(
    findViewerControl("menuitemradio", "Balanced"),
  ).resolves.toBeChecked();
  expect(captures.at(-1)).toMatchObject({ quality: 70 });

  for (const [label, quality] of [
    ["Data saver", 40],
    ["Sharper", 90],
    ["Balanced", 70],
  ] as const) {
    click(await findViewerControl("menuitemradio", label));
    await waitFor(() => {
      expect(captures.at(-1)).toMatchObject({ quality });
      expect(input).not.toHaveAttribute("readonly");
    });
  }

  const slider = screen.getByRole("slider", { name: "Image quality" });
  slider.focus();
  for (const [key, quality] of [
    ["End", 100],
    ["Home", 0],
  ] as const) {
    fireEvent.keyDown(slider, { key });
    await waitFor(() => {
      expect(captures.at(-1)).toMatchObject({ quality });
      expect(input).not.toHaveAttribute("readonly");
    });
    expect(slider).toHaveFocus();
  }
  await fill(input, "85");
  fireEvent.keyDown(input, { key: "Escape" });
  const qualityItem = await screen.findByText("Image quality");
  await waitFor(() => {
    expect(input).not.toBeInTheDocument();
    expect(qualityItem.closest('[role="menuitem"]')).toHaveFocus();
  });
  expect(captures.at(-1)).toMatchObject({ quality: 0 });
  fireEvent.keyDown(document.activeElement ?? qualityItem, { key: "Escape" });
  await waitFor(() => {
    expect(screen.getByLabelText("Browser settings")).toHaveFocus();
  });
});

test("Preserve a chosen quality preset through lossless PNG and JPEG", async () => {
  const { captures } = await openViewer();
  const input = await openQualityInput();
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  await fill(input, "85");
  click(await findViewerControl("menuitemradio", "Sharper"));
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ quality: 90 });
    expect(input).toHaveValue("90");
  });
  fireEvent.keyDown(input, { key: "Escape" });
  const openFormat = async () => {
    if (!screen.queryByText("Image format")) {
      click(screen.getByLabelText("Browser settings"));
    }
    click(await screen.findByText("Image format"));
  };
  await openFormat();
  click(await findViewerControl("menuitemradio", "PNG"));
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ format: "png" });
  });
  if (!screen.queryByText("Lossless")) {
    click(screen.getByLabelText("Browser settings"));
  }
  expect(
    (await screen.findByText("Lossless")).closest('[role="menuitem"]'),
  ).toHaveAttribute("aria-disabled", "true");
  await openFormat();
  click(await findViewerControl("menuitemradio", "JPEG"));
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ format: "jpeg", quality: 90 });
  });
  await openFormat();
  await expect(
    findViewerControl("menuitemradio", "JPEG"),
  ).resolves.toBeChecked();
});

function qualityDrag() {
  const slider = screen.getByRole("slider", { name: "Image quality" });
  const track = slider.closest('[data-slot="slider"]')?.firstElementChild;
  if (!(track instanceof HTMLElement)) {
    throw new Error("Expected an image quality slider control");
  }
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 16),
  );
  const mouse = {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
  };
  return {
    slider,
    start(value: number) {
      fireEvent.pointerDown(track, { ...mouse, buttons: 1, clientX: value });
    },
    move(value: number) {
      fireEvent.pointerMove(track, { ...mouse, buttons: 1, clientX: value });
    },
    release(value: number) {
      fireEvent.pointerUp(track, { ...mouse, buttons: 0, clientX: value });
    },
  };
}

test("Commit an image quality drag from the numeric field only on release", async () => {
  const { captures } = await openViewer();
  const input = await openQualityInput();
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  await fill(input, "85");
  expect(input).toHaveFocus();
  const drag = qualityDrag();

  drag.start(25);
  await waitFor(() => {
    expect(input).toHaveValue("25");
    expect(drag.slider).toHaveFocus();
  });
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  drag.move(60);
  expect(input).toHaveValue("60");
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  drag.release(60);
  await waitFor(() => {
    expect(captures.at(-1)).toMatchObject({ quality: 60 });
  });
});

test("Ignore queued drag events when Escape dismisses image quality", async () => {
  const { captures } = await openViewer();
  const input = await openQualityInput();
  const drag = qualityDrag();
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
  drag.start(25);
  await waitFor(() => {
    expect(input).toHaveValue("25");
    expect(drag.slider).toHaveFocus();
  });

  fireEvent.keyDown(drag.slider, { key: "Escape" });
  drag.move(90);
  drag.release(90);
  await waitFor(() => {
    expect(input).not.toBeInTheDocument();
  });
  const item = await screen.findByText("Image quality");
  expect(item.closest('[role="menuitem"]')).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(item);
  await expect(
    screen.findByRole("textbox", { name: "Image quality" }),
  ).resolves.toHaveValue("70");
  expect(captures.at(-1)).toMatchObject({ quality: 70 });
});

test("Restore the active native viewer when chat authorization returns", async () => {
  const caseId = 789;
  const thread = chatListThread(1, "Browser conversation", {
    cloudBrowserEnabled: false,
  });
  const viewer = viewerConnection(thread.id);
  const source = installChatListStream(context, { caseId, snapshot: [thread] });
  mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 1,
      },
    ],
  });
  let enabled = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return enabled
      ? respond(200, { browser: viewer.browser, viewer })
      : respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: "Cloud browser is not enabled for this chat",
          },
        });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });

  const denied = "Cloud browser is not enabled for this chat";
  await openBrowserPage(thread.id);
  await expect(screen.findByText(denied)).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();

  enabled = true;
  const grant = chatListEvent(
    caseId,
    2,
    "computer_use_host_updated",
    thread.id,
    { computerUseHostId: null, cloudBrowserEnabled: true },
  );
  source.setEvents([grant]);
  changeChatThreadList();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.queryByText(denied)).not.toBeInTheDocument();

  enabled = false;
  source.setEvents([
    grant,
    chatListEvent(caseId, 3, "computer_use_host_updated", thread.id, {
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    }),
  ]);
  changeChatThreadList();
  await expect(screen.findByText(denied)).resolves.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Remote browser input"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
});

test("Remove live input when renewal is denied without a native disconnect", async () => {
  const viewer = viewerConnection();
  const cdp = mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 1,
      },
    ],
  });
  const renewing = context.mocks.deferred<void>();
  const denial = context.mocks.deferred<void>();
  let revoked = false;
  const authorizationError = {
    error: {
      code: "BROWSER_AUTHORIZATION_REQUIRED",
      message: "Cloud browser is not enabled for this chat",
    },
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return revoked
      ? respond(403, authorizationError)
      : respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    renewing.resolve();
    await denial.promise;
    return respond(403, authorizationError);
  });

  await openBrowserPage();
  await renewing.promise;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(cdp.activeConnections()).toBeGreaterThan(0);

  revoked = true;
  denial.resolve();

  await waitFor(() => {
    expect(
      screen.getByText(authorizationError.error.message),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Address")).not.toBeInTheDocument();
    expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
  });
});

test("Show unavailable when native browser acquisition reports a reclaimed lifetime", async () => {
  context.mocks.api(browserContract.get, ({ query, respond }) => {
    expect(query?.viewer).toBe("native");
    return respond(409, {
      error: {
        code: "BROWSER_RECLAIMING",
        message:
          "This Browser lifetime is unavailable; retry after its current setup or cleanup completes",
      },
    });
  });

  await openBrowserPage();

  await expect(
    screen.findByText("Browser view unavailable"),
  ).resolves.toBeInTheDocument();
});

async function openReplaceableViewer(liveUrl: string | null = null) {
  const initial = viewerConnection();
  const initialBrowser = {
    ...initial.browser,
    liveUrl,
    window: { ...initial.browser.window, primaryWindowId: 0 },
  };
  let viewer = { ...initial, browser: initialBrowser };
  const cdp = mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "old-page",
        title: "Old page",
        url: "https://old.example.test",
        windowId: 0,
      },
      {
        targetId: "new-page",
        title: "New page",
        url: "https://new.example.test",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });
  await openBrowserPage();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      context.mocks.ably.hasSubscription("browserSessionChanged"),
    ).toBeTruthy();
  });
  return {
    cdp,
    revalidate(replacementWindow: number) {
      cdp.setAutoOpen(false);
      viewer = {
        ...viewer,
        browser: {
          ...viewer.browser,
          window: {
            instanceId: "a0000000-0000-4000-a000-000000000347",
            primaryWindowId: replacementWindow,
          },
        },
      };
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    },
  };
}

function typeRemote(text: string) {
  const input = screen.getByLabelText("Remote browser input");
  input.focus();
  fireEvent.input(input, {
    target: { value: text },
    data: text,
    inputType: "insertText",
  });
}

test("Synchronize the replacement display measured while the viewer is concealed", async () => {
  let size = new DOMRect(0, 0, 900, 600);
  const fallback = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return Object.hasOwn(this.dataset, "browserCanvas")
        ? size
        : fallback.call(this);
    },
  );
  const { cdp, revalidate } = await openReplaceableViewer();
  const resize = (width: number, height: number) => {
    return expect.objectContaining({
      method: "Browser.setContentsSize",
      params: expect.objectContaining({ width, height }),
    });
  };
  await waitFor(() => {
    expect(cdp.requests).toContainEqual(resize(900, 600));
  });
  const oldConnectionCount = cdp.connections();

  revalidate(1);
  await waitFor(() => {
    expect(cdp.connections()).toBeGreaterThan(oldConnectionCount);
    expect(
      screen.queryByRole("img", { name: "Live browser view" }),
    ).not.toBeInTheDocument();
  });
  size = new DOMRect(0, 0, 720, 480);
  fireEvent.resize(window);
  const beforeReveal = cdp.requests.length;
  cdp.openConnection();

  await waitFor(() => {
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toBeInTheDocument();
    expect(cdp.requests.slice(beforeReveal)).toContainEqual(resize(720, 480));
  });
});

test("Send fresh input only to the replacement runtime", async () => {
  const { cdp, revalidate } = await openReplaceableViewer();
  expect(screen.getByLabelText("Address")).toHaveValue(
    "https://old.example.test",
  );
  const oldSession = cdp.pageSession("old-page");
  const pending = cdp.holdNext("Input.insertText");
  typeRemote("old pending text");
  await pending.received;
  expect(cdp.input).toContainEqual({
    method: "Input.insertText",
    params: { text: "old pending text" },
    sessionId: oldSession,
  });
  const oldConnectionCount = cdp.connections();

  revalidate(1);
  await waitFor(() => {
    expect(cdp.connections()).toBeGreaterThan(oldConnectionCount);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  cdp.openConnection();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://new.example.test",
    );
  });
  const fresh = {
    method: "Input.insertText",
    params: { text: "replacement text" },
    sessionId: cdp.pageSession("new-page"),
  };
  await pending.release();
  typeRemote("replacement text");
  await waitFor(() => {
    expect(cdp.input).toContainEqual(fresh);
  });
  expect(cdp.input).not.toContainEqual({ ...fresh, sessionId: oldSession });
});

test.each([
  { label: "provider URL", liveUrl: "https://viewer.example/live" },
  { label: "null provider URL", liveUrl: null },
])(
  "Revalidation in window zero with $label suspends input until the viewer returns",
  async ({ liveUrl }) => {
    const { cdp, revalidate } = await openReplaceableViewer(liveUrl);
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://old.example.test",
    );
    const oldConnectionCount = cdp.connections();

    revalidate(0);
    await waitFor(() => {
      expect(cdp.connections()).toBeGreaterThan(oldConnectionCount);
      expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    });
    typeRemote("stale text");
    cdp.openConnection();
    await waitFor(() => {
      expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    });
    typeRemote("current text");

    await waitFor(() => {
      expect(cdp.input).toContainEqual({
        method: "Input.insertText",
        params: { text: "current text" },
        sessionId: cdp.pageSession("old-page"),
      });
    });
    expect(cdp.input).not.toContainEqual(
      expect.objectContaining({ params: { text: "stale text" } }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

function heartbeatErrors() {
  const spy = vi.spyOn(console, "error");
  const original = spy.getMockImplementation();
  const start = spy.mock.calls.length;
  spy.mockImplementation((...args: unknown[]) => {
    if (
      args[1] !== "Browser heartbeat failed; scheduled renewal will continue"
    ) {
      original?.(...args);
    }
  });
  return () => {
    return spy.mock.calls.slice(start).filter((args) => {
      return (
        args[1] === "Browser heartbeat failed; scheduled renewal will continue"
      );
    });
  };
}

function expiredSession(browser: BrowserViewerConnection["browser"]) {
  const { window: _window, ...previous } = browser;
  return {
    ...previous,
    status: "suspended" as const,
    liveUrl: null,
    idleExpiresAt: null,
    suspendedAt: "2026-08-01T11:00:00.000Z",
    suspensionReason: "idle" as const,
  };
}

async function openViewerWithRenewal(
  failure: 502 | 503,
  outcome: "continue" | "suspend" | "missing",
) {
  const viewer = viewerConnection();
  const suspended = expiredSession(viewer.browser);
  let expired = false;
  let renewals = 0;
  const firstRenewal = context.mocks.deferred<void>();
  const retry = context.mocks.deferred<void>();
  const retryStarted = context.mocks.deferred<void>();
  const renewed = context.mocks.deferred<void>();
  const logged = heartbeatErrors();
  mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return expired
      ? respond(200, { browser: suspended, viewer: null })
      : respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    renewals += 1;
    if (renewals === 1) {
      await firstRenewal.promise;
      return respond(failure, {
        error: {
          code: "BROWSER_UNAVAILABLE",
          message: "Browser service temporarily unavailable",
        },
      });
    }
    if (renewals === 2) {
      retryStarted.resolve();
    }
    if (renewals === 3) {
      renewed.resolve();
    }
    await retry.promise;
    expired = outcome !== "continue";
    if (outcome === "missing") {
      return respond(404, {
        error: {
          code: "BROWSER_NOT_FOUND",
          message: "Browser no longer exists",
        },
      });
    }
    return respond(200, { browser: expired ? suspended : viewer.browser });
  });

  await openBrowserPage();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  firstRenewal.resolve();
  await retryStarted.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();

  return { retry, renewed, logged };
}

test.each([
  { label: "a suspended-session response", outcome: "suspend" },
  { label: "an expired-session 404", outcome: "missing" },
] as const)(
  "Pause the viewer when $label confirms expiry after a temporary outage",
  async ({ outcome }) => {
    const { retry, logged } = await openViewerWithRenewal(503, outcome);
    retry.resolve();

    await expect(
      screen.findByText("Browser not live"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Start browser").closest("button")).toBeEnabled();
    expect(
      screen.queryByText("Cloud browser is not enabled for this chat"),
    ).not.toBeInTheDocument();
    expect(logged()).toStrictEqual([
      expect.arrayContaining([expect.objectContaining({ status: 503 })]),
    ]);
  },
);

test("Keep the mounted viewer usable after a temporary 502 renewal failure", async () => {
  const { retry, renewed, logged } = await openViewerWithRenewal(
    502,
    "continue",
  );
  retry.resolve();
  await renewed.promise;

  const address = screen.getByLabelText("Address");
  await fill(address, "https://example.comx");
  expect(address).toHaveValue("https://example.comx");
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(logged()).toContainEqual(
    expect.arrayContaining([expect.objectContaining({ status: 502 })]),
  );
});

test("Switch to the reopened native window and keep renewing its viewer", async () => {
  const initial = viewerConnection();
  const windowZero = {
    ...initial,
    browser: {
      ...initial.browser,
      window: { ...initial.browser.window, primaryWindowId: 0 },
    },
  };
  let viewer = windowZero;
  let renewals = 0;
  const firstRenewal = context.mocks.deferred<void>();
  const replacementRenewal = context.mocks.deferred<void>();
  mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "first-window",
        title: "Current chat",
        url: "https://example.com",
        windowId: 0,
      },
      {
        targetId: "other-window",
        title: "Other chat",
        url: "https://other.example.com",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    renewals += 1;
    if (renewals === 1) {
      await firstRenewal.promise;
      return respond(200, { browser: viewer.browser });
    }
    if (renewals === 2) {
      replacementRenewal.resolve();
    }
    return respond(200, { browser: viewer.browser });
  });

  await openBrowserPage();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(renewals).toBe(1);
  });
  await expect(
    findViewerControl("tab", "Current chat"),
  ).resolves.toBeInTheDocument();

  viewer = initial;
  firstRenewal.resolve();

  await replacementRenewal.promise;
  await waitFor(() => {
    expect(viewerControl("tab", "Other chat")).toBeInTheDocument();
    expect(viewerControl("tab", "Current chat")).toBeUndefined();
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("Search from the address field after restarting a browser used with an IME", async () => {
  const viewer = viewerConnection();
  const suspended = expiredSession(viewer.browser);
  let live = false;
  mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "blank-page",
        title: "about:blank",
        url: "about:blank",
        windowId: 1,
      },
    ],
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return live
      ? respond(200, { browser: viewer.browser, viewer })
      : respond(200, { browser: suspended, viewer: null });
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    live = true;
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });

  await openBrowserPage();
  const start = await screen.findByText("Start browser");
  const initialAddress = screen.getByLabelText("Address");
  fireEvent.compositionStart(initialAddress);
  fireEvent.change(initialAddress, { target: { value: "composing search" } });
  fireEvent.keyDown(initialAddress, { key: "Enter", isComposing: true });
  expect(initialAddress).toHaveValue("composing search");
  expect(start).toBeInTheDocument();
  click(start);

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "annual report");
  const search = screen.getByLabelText("Search Google");
  expect(search).toBeEnabled();
  await userEvent.setup({ delay: null }).keyboard("{Enter}");

  await waitFor(() => {
    expect(address).toHaveValue(
      "https://www.google.com/search?q=annual+report",
    );
  });
});

const BLOCKED_BROWSER = "Cloud browser is not enabled for this chat";

async function openViewerWithRevocableLease() {
  const caseId = 794;
  const thread = chatListThread(1, "Browser conversation", {
    cloudBrowserEnabled: true,
  });
  const viewer = viewerConnection(thread.id);
  const source = installChatListStream(context, { caseId, snapshot: [thread] });
  const cdp = mockBrowserCdp(context, viewer.cdpUrl, {
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 1,
      },
    ],
  });
  const denied = {
    error: { code: "BROWSER_AUTHORIZATION_REQUIRED", message: BLOCKED_BROWSER },
  };
  const firstStarted = context.mocks.deferred<void>();
  const denyFirst = context.mocks.deferred<void>();
  const laterStarted = context.mocks.deferred<void>();
  const denyLater = context.mocks.deferred<boolean>();
  let renewals = 0;
  let granted = true;
  let sequence = 2;
  const events: ReturnType<typeof chatListEvent>[] = [];

  context.mocks.api(browserContract.get, ({ respond }) => {
    return granted
      ? respond(200, { browser: viewer.browser, viewer })
      : respond(403, denied);
  });
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    renewals += 1;
    if (renewals === 1) {
      firstStarted.resolve();
      await denyFirst.promise;
      return respond(403, denied);
    }
    if (renewals === 2) {
      laterStarted.resolve();
    }
    return (await denyLater.promise)
      ? respond(403, denied)
      : respond(200, { browser: viewer.browser });
  });
  await setupPage({
    context,
    path: `/browsers/${thread.id}`,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
    cachedChatThreadEvents: cachedChatListEvents(caseId, [thread]),
  });
  await firstStarted.promise;
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });

  return {
    cdp,
    denyFirst,
    denyLater,
    laterStarted,
    access(...updates: boolean[]) {
      for (const enabled of updates) {
        granted = enabled;
        events.push(
          chatListEvent(
            caseId,
            sequence++,
            "computer_use_host_updated",
            thread.id,
            {
              computerUseHostId: null,
              cloudBrowserEnabled: enabled,
            },
          ),
        );
      }
      source.setEvents(events);
      changeChatThreadList();
    },
  };
}

test("Renew a fresh grant while the previous lease is still pending", async () => {
  const setup = await openViewerWithRevocableLease();
  setup.access(false);
  await expect(screen.findByText(BLOCKED_BROWSER)).resolves.toBeInTheDocument();
  setup.access(true);

  await setup.laterStarted.promise;
  setup.denyLater.resolve(true);

  await waitFor(() => {
    expect(screen.getByText(BLOCKED_BROWSER)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
  });
});

test("Keep a renewed grant streaming when the superseded lease is denied", async () => {
  const setup = await openViewerWithRevocableLease();
  const oldConnections = setup.cdp.connections();
  setup.access(false);
  await expect(screen.findByText(BLOCKED_BROWSER)).resolves.toBeInTheDocument();
  setup.cdp.setAutoOpen(false);
  setup.access(true);
  await waitFor(() => {
    expect(setup.cdp.connections()).toBeGreaterThan(oldConnections);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  setup.denyFirst.resolve();
  setup.cdp.openConnection();

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.queryByText(BLOCKED_BROWSER)).not.toBeInTheDocument();
  });
});

test("Clear a denied lease after a batched revoke and grant", async () => {
  const setup = await openViewerWithRevocableLease();
  setup.denyFirst.resolve();
  await waitFor(() => {
    expect(screen.getByText(BLOCKED_BROWSER)).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
  });

  setup.access(false, true);

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.queryByText(BLOCKED_BROWSER)).not.toBeInTheDocument();
  });
});

async function openViewerWithOldRenewalPending() {
  const initial = viewerConnection();
  const previous = {
    ...initial,
    browser: {
      ...initial.browser,
      window: { ...initial.browser.window, primaryWindowId: 0 },
    },
  };
  let active = previous;
  const cdp = mockBrowserCdp(context, previous.cdpUrl, {
    targets: [
      {
        targetId: "first-window",
        title: "Current chat",
        url: "https://example.com",
        windowId: 0,
      },
      {
        targetId: "other-window",
        title: "Other chat",
        url: "https://other.example.com",
        windowId: 1,
      },
    ],
  });
  const failure = context.mocks.deferred<void>();
  const oldRenewal = context.mocks.deferred<Request>();
  const releaseOld = context.mocks.deferred<void>();
  const renewed = context.mocks.deferred<void>();
  const requests: string[] = [];
  const logged = heartbeatErrors();

  context.mocks.api(browserContract.get, ({ params, respond }) => {
    const browser = { ...active.browser, threadId: params.threadId };
    return respond(200, { browser, viewer: { ...active, browser } });
  });
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ request, params, respond }) => {
      const thread = params.threadId;
      requests.push(thread);
      if (requests.length === 1) {
        await failure.promise;
        return respond(503, {
          error: {
            code: "BROWSER_UNAVAILABLE",
            message: "Temporary browser service outage",
          },
        });
      }
      if (requests.length === 2) {
        oldRenewal.resolve(request);
        await releaseOld.promise;
        return respond(200, { browser: previous.browser });
      }
      if (requests.length === 3) {
        renewed.resolve();
      }
      return respond(200, { browser: { ...active.browser, threadId: thread } });
    },
  );

  await openBrowserPage();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(
      context.mocks.ably.hasSubscription("browserSessionChanged"),
    ).toBeTruthy();
  });
  failure.resolve();
  const pending = await oldRenewal.promise;
  return {
    cdp,
    pending,
    releaseOld,
    renewed,
    requests,
    logged,
    switchInstance() {
      active = {
        ...previous,
        browser: {
          ...previous.browser,
          window: {
            ...previous.browser.window,
            instanceId: "a0000000-0000-4000-a000-000000000349",
          },
        },
      };
      cdp.setAutoOpen(false);
      context.mocks.ably.trigger("browserSessionChanged", {
        threadId: THREAD_ID,
      });
    },
    navigate(threadId: string) {
      active = viewerConnection(threadId);
      window.history.pushState({}, "", `/browsers/${threadId}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  };
}

test("Keep the replacement instance live when an older renewal arrives late", async () => {
  const setup = await openViewerWithOldRenewalPending();
  const connections = setup.cdp.connections();

  setup.switchInstance();
  await waitFor(() => {
    expect(setup.cdp.connections()).toBeGreaterThan(connections);
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  setup.releaseOld.resolve();
  setup.cdp.openConnection();
  await setup.renewed.promise;

  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const address = screen.getByLabelText("Address");
  await fill(address, "https://example.comx");
  expect(address).toHaveValue("https://example.comx");
  expect(
    setup.logged().map((entry) => {
      return entry[2];
    }),
  ).toStrictEqual([{ threadId: THREAD_ID, status: 503 }]);
});

test("Cancel the old heartbeat on navigation and renew only the new chat", async () => {
  const setup = await openViewerWithOldRenewalPending();
  const nextThread = "a0000000-0000-4000-a000-000000000350";

  setup.navigate(nextThread);
  await waitFor(() => {
    expect(setup.pending.signal.aborted).toBeTruthy();
    expect(viewerControl("tab", "Other chat")).toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  setup.releaseOld.resolve();
  await setup.renewed.promise;
  expect(setup.requests.slice(0, 3)).toStrictEqual([
    THREAD_ID,
    THREAD_ID,
    nextThread,
  ]);
  expect(
    setup.requests.slice(2).every((thread) => {
      return thread === nextThread;
    }),
  ).toBeTruthy();
});

test("Discard the old blocked address hint when chat authorization renews", async () => {
  const setup = await openViewerWithRevocableLease();
  const hint = "The browser is not ready. Try again shortly.";
  const earlierMembership = setup.cdp.holdNextMembership("example-page");
  setup.access(true);
  await earlierMembership.received;
  const earlierAddress = screen.getByLabelText("Address");
  await fill(earlierAddress, "https://old-address.example.test");
  fireEvent.keyDown(earlierAddress, { key: "Enter" });
  await expect(screen.findByText(hint)).resolves.toBeInTheDocument();

  const membership = setup.cdp.holdNextMembership("example-page");
  setup.access(true);
  await membership.received;
  await earlierMembership.release();
  expect(screen.queryByText(hint)).not.toBeInTheDocument();
  const address = screen.getByLabelText("Address");
  await fill(address, "https://new-address.example.test");
  fireEvent.keyDown(address, { key: "Enter" });
  await expect(screen.findByText(hint)).resolves.toBeInTheDocument();

  await membership.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
  });
  expect(setup.cdp.targets[0]?.url).toBe("https://example.com");
  expect(setup.cdp.requests).not.toContainEqual(
    expect.objectContaining({ method: "Page.navigate" }),
  );
});

const INSTANCE_ID = "22222222-2222-4222-8222-222222222222";

const AUTHORIZATION_REQUIRED = "Cloud browser is not enabled for this chat";

function browserSession(
  overrides: Partial<BrowserViewerConnection["browser"]> = {},
): BrowserViewerConnection["browser"] {
  return {
    threadId: THREAD_ID,
    name: "booking",
    status: "active",
    viewerUrl: `https://viewer.example/browsers/${THREAD_ID}`,
    liveUrl: "https://viewer.example/live?token=private",
    screenshotUrl: null,
    timeoutMinutes: 240,
    window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
    idleExpiresAt: "2026-09-01T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function browserAcquisition(
  session: BrowserSession,
  cdpUrl = "wss://cdp.browser-use.com/shared-viewer",
) {
  return {
    browser: session,
    viewer:
      session.status === "active"
        ? { browser: session, cdpUrl, extension: TEST_BROWSER_EXTENSION }
        : null,
  };
}

function mockBrowserSession(session: BrowserSession | null): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return session
      ? respond(200, browserAcquisition(session))
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Browser not found" },
        });
  });
}

async function expectStreamingViewer(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
}

function mockSharedViewer(liveUrl: string | null = null) {
  const session = browserSession({
    liveUrl,
    window: { instanceId: INSTANCE_ID, primaryWindowId: 0 },
  });
  const cdpUrl = "wss://cdp.browser-use.com/shared-viewer";
  const browser = mockBrowserCdp(context, cdpUrl, {
    streaming: true,
    targets: [
      {
        targetId: "example-page",
        title: "Example",
        url: "https://example.com",
        windowId: 0,
      },
      {
        targetId: "other-chat-page",
        title: "Other chat",
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
  return { session, cdpUrl, browser };
}

test.each(["session", "connection"] as const)(
  "An authorization denial from the %s keeps the panel with a distinct placeholder",
  async (source) => {
    const { session } = mockSharedViewer();
    mockBrowserSession(session);
    if (source === "session") {
      context.mocks.api(browserContract.get, ({ respond }) => {
        return respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
      });
    } else {
      context.mocks.api(browserContract.get, ({ respond }) => {
        return respond(403, {
          error: {
            code: "BROWSER_AUTHORIZATION_REQUIRED",
            message: AUTHORIZATION_REQUIRED,
          },
        });
      });
    }
    const hold = context.mocks.deferred<void>();
    context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
      await hold.promise;
      return respond(200, { browser: session });
    });
    await setupPage({ context, path: `/browsers/${THREAD_ID}` });
    await expect(
      screen.findByText(AUTHORIZATION_REQUIRED),
    ).resolves.toBeInTheDocument();
    expect(
      document.querySelector("[data-browser-session-panel]"),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Remote browser input"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Browser not live")).not.toBeInTheDocument();
    expect(screen.queryByText("Start browser")).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "This browser does not belong to this chat or has been removed.",
      ),
    ).not.toBeInTheDocument();
  },
);

test("A denied renewal from a previous reload cannot revoke the current same-window viewer", async () => {
  const { session } = mockSharedViewer();
  mockBrowserSession(session);
  const first = context.mocks.deferred<void>();
  const deny = context.mocks.deferred<void>();
  const renewed = context.mocks.deferred<void>();
  const hold = context.mocks.deferred<void>();
  let initial = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (initial) {
      initial = false;
      first.resolve();
      await deny.promise;
      return respond(403, {
        error: {
          code: "BROWSER_AUTHORIZATION_REQUIRED",
          message: AUTHORIZATION_REQUIRED,
        },
      });
    }
    renewed.resolve();
    await hold.promise;
    return respond(200, { browser: session });
  });
  await setupPage({ context, path: `/browsers/${THREAD_ID}` });
  await expectStreamingViewer();
  await first.promise;
  context.mocks.ably.trigger("browserSessionChanged", { threadId: THREAD_ID });
  await expectStreamingViewer();
  deny.resolve();
  await renewed.promise;
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(screen.queryByText(AUTHORIZATION_REQUIRED)).not.toBeInTheDocument();
});
