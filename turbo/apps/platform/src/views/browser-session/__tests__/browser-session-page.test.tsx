import {
  browserContract,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  expect(
    await findViewerControl("menuitemradio", "Follow panel"),
  ).toBeChecked();

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
    expect(await findViewerControl("menuitemradio", label)).toBeChecked();
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
  expect(await findViewerControl("menuitemradio", "Balanced")).toBeChecked();
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
  expect(await findViewerControl("menuitemradio", "JPEG")).toBeChecked();
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
  expect(
    await screen.findByRole("textbox", { name: "Image quality" }),
  ).toHaveValue("70");
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
      return this.hasAttribute("data-browser-canvas")
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
