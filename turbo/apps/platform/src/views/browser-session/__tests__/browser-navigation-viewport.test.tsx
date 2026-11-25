import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click } from "../../../__tests__/page-helper.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
  browserTab,
} from "./browser-native-page-fixture.ts";
import { createCanvas } from "@napi-rs/canvas";
import userEvent from "@testing-library/user-event";
import { queryFastControl } from "../../okou-page/__tests__/chat-message-experience-test-helpers.ts";

const context = testContext();

test("browser-navigation-regression-02 delivers text to the active page before its history is ready", async () => {
  const url = "https://meeting.example/agenda";
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      { targetId: "agenda", windowId: 101, url, title: "Planning agenda" },
    ],
  });
  const history = cdp.holdNext("Page.getNavigationHistory");
  await openPage();
  await history.received;
  const input = await screen.findByLabelText("Remote browser input");
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  input.focus();
  fireEvent.input(input, {
    inputType: "insertText",
    target: { value: "Review agenda" },
    data: "Review agenda",
  });
  await waitFor(() => {
    expect(cdp.input).toContainEqual(
      expect.objectContaining({
        method: "Input.insertText",
        params: { text: "Review agenda" },
        sessionId: cdp.pageSession("agenda"),
      }),
    );
  });
  expect(screen.getByLabelText("Address")).toBeEnabled();
  expect(screen.getByLabelText("Back")).toBeDisabled();
  await history.release({
    currentIndex: 1,
    entries: [
      {
        id: 40,
        url: "https://meeting.example/",
        title: "Overview",
        userTypedURL: "",
        transitionType: "link",
      },
      {
        id: 41,
        url,
        userTypedURL: url,
        title: "Confirmed agenda",
        transitionType: "link",
      },
    ],
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Back")).toBeEnabled();
  });
  await waitFor(() => {
    expect(screen.getByLabelText("Address")).toHaveValue(url);
  });
});

function openAddress(destination: string) {
  const field = screen.getByRole("textbox", { name: "Address" });
  fireEvent.change(field, { target: { value: destination } });
  click(screen.getByLabelText("Open address"));
  return field;
}

test("browser-navigation-regression-04.01 opening a working URL dismisses the reload failure", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  cdp.failNext("Page.reload", "Reload unavailable");
  click(screen.getByLabelText("Reload"));
  const failure = await screen.findByText(
    /browser action could not be completed/i,
  );
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  const destination = "https://manual.example/troubleshooting";
  const field = openAddress(destination);
  await screen.findByLabelText("manual.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  await waitFor(() => {
    expect(field).toHaveValue(destination);
    expect(failure).not.toBeInTheDocument();
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("browser-navigation-regression-05 the download receipt returns the address field to the selected document", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  const history = cdp.holdNext("Page.getNavigationHistory");
  await openPage();
  await history.received;
  await expectStreamingAt("https://example.com");
  const documentTab = screen.getByLabelText("Example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  cdp.downloadNextNavigation();
  const download = cdp.holdNext("Page.navigate");
  const field = openAddress("https://exports.example/plan.zip");
  await download.received;
  expect(screen.getByLabelText("Reload")).toBeDisabled();
  await download.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Reload")).toBeEnabled();
    expect(field).toHaveValue("https://example.com");
    expect(field).toBeEnabled();
    expect(
      screen.getByLabelText("Example", {
        selector: '[role="tab"][aria-selected="true"]',
      }),
    ).toBe(documentTab);
  });
});

test("browser-navigation-regression-06 a redirect selects its committed page before the held receipt settles", async () => {
  const { openPage, cdp } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  const finalUrl = "https://reports.example/weekly";
  cdp.redirectNextNavigation(finalUrl);
  const receipt = cdp.holdNext("Page.navigate");
  const field = openAddress("https://short.example/week");
  await receipt.received;
  await screen.findByLabelText("reports.example", {
    selector: '[role="tab"][aria-selected="true"]',
  });
  expect(field).toBeEnabled();
  expect(screen.getByLabelText("Reload")).toBeDisabled();
  await receipt.release();
  await waitFor(() => {
    expect(screen.getByLabelText("Reload")).toBeEnabled();
    expect(field).toHaveValue(finalUrl);
  });
});

const home = "https://local.example/start";
function workstation() {
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 900, 600));
  return arrangeNativePage(
    context,
    {
      targets: [
        { targetId: "reading", title: "Local", url: home, windowId: 12 },
        {
          targetId: "foreign",
          title: "Other",
          url: "https://other.example/",
          windowId: 77,
        },
      ],
    },
    12,
  );
}
type Remote = ReturnType<typeof workstation>["cdp"];
async function fitOption() {
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await screen.findByText("Window size"));
  return screen.findByText("Fit window to panel");
}
async function fitted(remote: Remote) {
  await waitFor(() => {
    expect(remote.windowState(12)).toBe("normal");
    expect(remote.viewport).toStrictEqual({ width: 900, height: 600 });
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
}
test("browser-display-regression-001 Opening restores and fits only the assigned minimized window", async () => {
  const { cdp, openPage } = workstation();
  cdp.setWindowState("minimized", 12);
  cdp.setWindowState("fullscreen", 77);
  await openPage();
  await expectStreamingAt(home);
  await fitted(cdp);
  expect(cdp.windowState(77)).toBe("fullscreen");
  const restores = cdp.requests.filter((request) => {
    return request.method === "Browser.setWindowBounds";
  });
  expect(
    restores.map((request) => {
      return request.params;
    }),
  ).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        windowId: 12,
        bounds: { windowState: "normal" },
      }),
    ]),
  );
  for (const restore of restores) {
    expect(restore.params).toMatchObject({ windowId: 12 });
  }
});

test("browser-display-regression-004 Fit waits for a replacement frame before changing the viewport", async () => {
  const { cdp, openPage } = workstation();
  await openPage();
  await expectStreamingAt(home);
  await fitted(cdp);
  const ack = cdp.holdNext("Page.screencastFrameAck");
  cdp.frame("AAAA", cdp.pageSession("reading"));
  await ack.received;
  await ack.release();
  const large = { width: 1280, height: 720 };
  Object.assign(cdp.viewport, large);
  cdp.setWindowState("maximized", 12, large);
  const fresh = cdp.holdTargetFrames("reading");
  await userEvent.click(await fitOption());
  await fresh.received;
  expect(cdp.windowState(12)).toBe("normal");
  expect(cdp.viewport).toStrictEqual(large);
  const pending = await fitOption();
  expect(pending.closest('[role="menuitem"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  fresh.release();
  await fitted(cdp);
});

test("browser-display-regression-005 An explicit fit recovers from capture preparation failure", async () => {
  const { cdp, openPage } = workstation();
  cdp.setWindowState("maximized", 12);
  cdp.failNext("Browser.setWindowBounds", "Native restore declined");
  await openPage();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("The browser action could not be completed");
  cdp.setWindowState("minimized", 12);
  await userEvent.click(await fitOption());
  await fitted(cdp);
});

test("browser-display-regression-006 A resize supersedes the held calibration of a minimized window", async () => {
  const { cdp, openPage } = workstation();
  await openPage();
  await expectStreamingAt(home);
  await fitted(cdp);
  const ack = cdp.holdNext("Page.screencastFrameAck");
  cdp.frame("AAAA", cdp.pageSession("reading"));
  await ack.received;
  await ack.release();
  const large = { width: 1280, height: 720 };
  Object.assign(cdp.viewport, large);
  cdp.setWindowState("maximized", 12, large);
  const fresh = cdp.holdTargetFrames("reading");
  await userEvent.click(await fitOption());
  await fresh.received;
  const observation = cdp.holdNext("Browser.getWindowForTarget");
  fresh.release();
  await observation.received;
  cdp.event("Page.frameResized", {}, cdp.pageSession("reading"));
  cdp.setWindowState("minimized", 12);
  await observation.release();
  await fitted(cdp);
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
});

async function resizeWithPendingFrame() {
  const { cdp, openPage } = workstation();
  const sentry = context.mocks.sentry();
  const backing = createCanvas(900, 600);
  const paint = backing.getContext("2d");
  const graphics = document.createElement("canvas").getContext("2d")!;
  vi.spyOn(graphics, "drawImage").mockImplementation(() => {
    paint.fillStyle = "#ac310f";
    paint.fillRect(0, 0, backing.width, backing.height);
  });
  vi.spyOn(graphics, "clearRect").mockImplementation((x, y, w, h) => {
    return paint.clearRect(x, y, w, h);
  });
  const sample = () => {
    return Array.from(paint.getImageData(32, 32, 1, 1).data);
  };
  await openPage();
  await expectStreamingAt(home);
  await fitted(cdp);
  const picture = screen.getByRole("img", { name: "Live browser view" });
  await waitFor(() => {
    return expect(sample()).toStrictEqual([172, 49, 15, 255]);
  });
  cdp.frame("AAEC", cdp.pageSession("reading"), 900, 47);
  await waitFor(() => {
    return expect(picture).toHaveAttribute("width", "900");
  });
  const frame = cdp.holdTargetFrames("reading");
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 720, 480));
  const start = cdp.requests.length;
  window.dispatchEvent(new Event("resize"));
  await frame.received;

  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    screen.getByRole("img", { name: "Live browser view" }),
  ).toHaveAttribute("width", "900");
  expect(sample()).toStrictEqual([172, 49, 15, 255]);
  expect(picture).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  const expectHealthy = () => {
    expect(sentry.reports).toStrictEqual([]);
    expect(
      cdp.requests.slice(start).map(({ method }) => {
        return method;
      }),
    ).not.toContain("Browser.setWindowBounds");
  };
  return { cdp, frame, expectHealthy };
}
test("browser-display-regression-015 the accepted image survives resize until a 720 by 480 frame enables input", async () => {
  const { cdp, frame, expectHealthy } = await resizeWithPendingFrame();
  frame.release();
  await waitFor(() => {
    return expect(cdp.viewport).toStrictEqual({ width: 720, height: 480 });
  });
  await expectStreamingAt(home);
  const visible = screen.getByRole("img", { name: "Live browser view" });
  await waitFor(() => {
    return expect(visible).toHaveAttribute("width", "720");
  });
  expect(visible).toHaveAttribute("height", "480");
  expectHealthy();
});
test("browser-display-regression-015 withholding the replacement leaves the earlier picture on screen", async () => {
  const { frame, expectHealthy } = await resizeWithPendingFrame();
  try {
    expect(
      screen.getByRole("img", { name: "Live browser view" }),
    ).toHaveAttribute("height", "600");
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expectHealthy();
  } finally {
    frame.release();
  }
});

test.each([
  ["browser-display-regression-007", "deliver"],
  ["Withheld control", "withhold"],
] as const)(
  "%s %s the restore reply after the viewed page moves fullscreen",
  async (_label, response) => {
    const { cdp, openPage } = workstation();
    await openPage();
    await fitted(cdp);
    cdp.setWindowState("fullscreen", 77);
    await expectStreamingAt(home);
    const painted = cdp.holdNext("Page.screencastFrameAck");
    cdp.frame("AAAA", cdp.pageSession("reading"));
    await painted.received;
    await painted.release();
    cdp.setWindowState("maximized", 12, { width: 1440, height: 900 });
    const restore = cdp.holdNext("Browser.setWindowBounds");
    await userEvent.click(await fitOption());
    await restore.received;
    const afterMove = cdp.requests.length;
    cdp.move("reading", 77);
    await screen.findByText("No tabs open");
    const consumed = context.mocks.deferred<void>();
    if (response === "deliver") {
      await restore.release(undefined, () => {
        if (!consumed.settled()) {
          consumed.resolve();
        }
      });
      await consumed.promise;
    }
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    expect(cdp.windowState(77)).toBe("fullscreen");
    expect(
      cdp.requests.slice(afterMove).map((command) => {
        return command.method;
      }),
    ).not.toContain("Emulation.clearDeviceMetricsOverride");
  },
);

const url = "https://example.com",
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
