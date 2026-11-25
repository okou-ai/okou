import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
  browserTab,
} from "./browser-native-page-fixture.ts";
import { queryFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";

const context = testContext(),
  url = "https://example.com",
  target = "example-page";

async function fit() {
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Window size"));
  click(await screen.findByText("Fit window to panel"));
}

const input = () => {
  return screen.getByLabelText("Remote browser input");
};

test("browser-display-regression-013 Fitting a recovered image normalizes the primary window after a decoded frame precedes its capture receipt", async () => {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 900, 600));
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt(url);
  const reply = cdp.holdNext("Page.startScreencast"),
    frame = cdp.holdTargetFrames(target);
  vi.spyOn(globalThis, "createImageBitmap").mockRejectedValueOnce(
    new Error("Local unreadable picture"),
  );
  cdp.frame("AAAA", cdp.pageSession(target));
  await reply.received;
  await frame.received;
  frame.release();
  expect(input()).toBeDisabled();
  await reply.release();
  await expectStreamingAt(url);
  Object.assign(cdp.viewport, { width: 1280, height: 720 });
  cdp.setWindowState("maximized", 101, { width: 1280, height: 720 });
  await fit();
  await waitFor(() => {
    return expect(cdp.windowState(101)).toBe("normal");
  });
  await waitFor(() => {
    return expect(cdp.viewport).toStrictEqual({ width: 900, height: 600 });
  });
  await expectStreamingAt(url);
});

const notes = Object.freeze({
  targetId: "project-notes",
  title: "Notes",
  url: "https://notes.example",
  windowId: 101,
});

const statusPage = Object.freeze({
  targetId: "project-status",
  title: "Status",
  url: "https://status.example",
  windowId: 101,
});

type Chromium = ReturnType<typeof arrangeNativePage>["cdp"];

function destroy(cdp: Chromium, targetId: string) {
  const i = cdp.targets.findIndex((t) => {
    return t.targetId === targetId;
  });
  const removed = cdp.targets.splice(i, 1)[0]!;
  cdp.event("Target.targetDestroyed", { targetId });
  cdp.nativeEvent("tab-removed", removed);
}

function announce(cdp: Chromium) {
  const page = {
    targetId: "release-notes",
    title: "Release",
    url: "https://release.example",
    windowId: 101,
  };
  cdp.targets.push(page);
  cdp.event("Target.targetCreated", { targetInfo: { ...page, type: "page" } });
  cdp.nativeEvent("tab-created", page);
  return page;
}

test("browser-discovery-startup-040 Discovery keeps the viewer connecting after both known tabs are destroyed", async () => {
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [notes, statusPage],
  });
  await openPage();
  await expectStreamingAt(notes.url);
  await waitFor(() => {
    return expect(browserTab("Status")).toBeInTheDocument();
  });
  const membership = cdp.holdNextMembership("release-notes");
  const page = announce(cdp);
  await membership.received;
  destroy(cdp, notes.targetId);
  destroy(cdp, statusPage.targetId);
  await waitFor(() => {
    return expect(browserTab("Status")).toBeNull();
  });
  await screen.findByText(/Connecting to browser|Updating view/);
  expect(input()).toBeDisabled();
  expect(queryFastControl("button", "New tab")).toBeDisabled();
  await membership.release();
  await expectStreamingAt(page.url);
  expect(browserTab(page.title)).toHaveAttribute("aria-selected", "true");
});

test("browser-discovery-startup-054 Returning from a hidden discovery reports the removed assigned window", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const { cdp, openPage } = arrangeNativePage(context, { targets: [notes] });
  await openPage();
  await expectStreamingAt(notes.url);
  visibility.changeTo("hidden");
  await screen.findByText("Viewing paused");
  announce(cdp);
  cdp.closeWindow(101);
  visibility.changeTo("visible");
  await screen.findByText(/assigned browser window.*unavailable/i);
  expect(input()).toBeDisabled();
  expect(queryFastControl("button", "New tab")).toBeDisabled();
});

function canvasSize(width: number, height: number) {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, width, height));
}

test("browser-display-regression-016 Returning to the visible browser resumes the measured live picture without an unavailable notice", async () => {
  const vis = context.mocks.browser.visibilityState("visible");
  canvasSize(900, 600);
  const { cdp, openPage } = arrangeNativePage(context, { targets: [notes] });
  await openPage();
  await expectStreamingAt(notes.url);
  const failures: string[] = [];
  const record = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const content = node.textContent ?? "";
        if (
          /browser view unavailable|unable to display the browser/i.test(
            content,
          )
        ) {
          failures.push(content);
        }
      }
    }
  };
  const observer = new MutationObserver(record);
  observer.observe(document.body, { subtree: true, childList: true });
  try {
    vis.changeTo("hidden");
    await screen.findByText("Viewing paused");
    expect(input()).toBeDisabled();
    vis.changeTo("visible");
    await expectStreamingAt(notes.url);
    await waitFor(() => {
      return expect(cdp.viewport).toStrictEqual({ width: 900, height: 600 });
    });
    expect(screen.queryByText("Viewing paused")).toBeNull();
    record(observer.takeRecords());
    expect(failures).toStrictEqual([]);
  } finally {
    observer.disconnect();
  }
});
