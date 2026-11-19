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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import { openQualityInput } from "./browser-settings-test-helpers.ts";
const context = testContext();

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
  const threadId = "a0000000-0000-4000-a000-000000000345";
  const path = `/browsers/${threadId}`;
  const cdpUrl = "wss://cdp.example.test/browser";
  const time = "2026-08-01T10:00:00.000Z";
  const viewer: BrowserViewerConnection = {
    browser: {
      threadId,
      name: "Research",
      status: "active",
      viewerUrl: `https://app.okou.ai${path}`,
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
    cdpUrl,
    extension: TEST_BROWSER_EXTENSION,
  };
  const browser = mockBrowserCdp(context, cdpUrl, { targets });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: viewer.browser, viewer });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: viewer.browser });
  });

  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
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
