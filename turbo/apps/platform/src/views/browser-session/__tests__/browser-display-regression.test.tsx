import { createCanvas } from "@napi-rs/canvas";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
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
  await waitFor(() => expect(picture).toHaveAttribute("width", "900"));
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
