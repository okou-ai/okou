import { fireEvent, screen, waitFor, act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserTab,
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import { browserRecoveryClock } from "../../../__tests__/browser-recovery-clock.ts";
import {
  scopedViewer,
  firstUrl,
  input,
} from "./scoped-browser-transport-fixtures.ts";

const context = testContext();

const active = "example-page";

const next = "other-page";

async function viewer() {
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      {
        targetId: active,
        url: "https://example.com",
        title: "Example",
        windowId: 101,
      },
      {
        targetId: next,
        url: "https://other.example",
        title: "Other",
        windowId: 101,
      },
    ],
  });
  await openPage();
  await expectStreamingAt("https://example.com");
  click(screen.getByLabelText("Browser settings"));
  const mode = await screen.findByText("Connection mode");
  fireEvent.keyDown(mode, { key: "ArrowRight" });
  click(await screen.findByText("Separate image connection"));
  await waitFor(() => {
    const streams = new Set(
      cdp.requests
        .filter((r) => {
          return r.method === "Page.startScreencast";
        })
        .map((r) => {
          return r.connectionId;
        }),
    );
    expect(streams.size).toBeGreaterThan(1);
  });
  await expectStreamingAt("https://example.com");
  const control = cdp.requests
    .filter((r) => {
      return r.method === "Browser.getWindowForTarget";
    })
    .at(-1)?.connectionId;
  const frames = cdp.requests
    .filter((r) => {
      return r.method === "Page.startScreencast";
    })
    .at(-1)?.connectionId;
  if (control === undefined || frames === undefined || control === frames) {
    throw new Error("The live image and control transport must be distinct");
  }
  return {
    cdp,
    control,
    dropImage() {
      cdp.disconnect({ code: 1006, reason: "Image transport lost" }, 1);
    },
  };
}

test("browser-frames-recovery-016 Moving the old tab out of the window during image recovery leaves the healthy sibling selected", async () => {
  const { cdp, dropImage } = await viewer();
  const held = cdp.holdTargetFrames(active);
  dropImage();
  await waitFor(() => {
    expect(input()).toBeDisabled();
  });
  await held.received;
  cdp.move(active, 202);
  await expectStreamingAt("https://other.example");
  held.release();
  expect(browserTab("Other")).toHaveAttribute("aria-selected", "true");
  expect(browserTab("Example")).toBeNull();
});

test("browser-frames-recovery-002 Image recovery respects an outstanding navigation receipt", async () => {
  const { cdp, control, dropImage } = await viewer();
  const receipt = cdp.holdNext("Page.navigate");
  const address = screen.getByLabelText("Address");
  fireEvent.change(address, { target: { value: "http://next.example/" } });
  const form = address.closest("form");
  if (!form) {
    throw new Error("Address has no form");
  }
  fireEvent.submit(form);
  await receipt.received;
  const held = cdp.holdTargetFrames(active);
  dropImage();
  await waitFor(() => {
    expect(input()).toBeDisabled();
  });
  await receipt.release();
  await held.received;
  expect(input()).toBeDisabled();
  held.release();
  await expectStreamingAt("http://next.example/");
  expect(
    cdp.requests
      .filter((r) => {
        return r.method === "Page.navigate";
      })
      .map((r) => {
        return { url: r.params?.url, connection: r.connectionId };
      }),
  ).toStrictEqual([{ url: "http://next.example/", connection: control }]);
});

test("browser-frames-recovery-007 Closing the last tab during image loss selects a fresh blank tab on the same control transport", async () => {
  const { cdp, control, dropImage } = await viewer();
  click(screen.getByLabelText("Close Other"));
  await waitFor(() => {
    expect(browserTab("Other")).toBeNull();
  });
  const held = cdp.holdTargetFrames(active);
  dropImage();
  await waitFor(() => {
    expect(input()).toBeDisabled();
  });
  await held.received;
  click(screen.getByLabelText("Close Example"));
  await expectStreamingAt("");
  expect(browserTab("New tab")).toHaveAttribute("aria-selected", "true");
  expect(
    cdp.requests
      .filter((r) => {
        return r.method === "Target.closeTarget";
      })
      .map((r) => {
        return r.connectionId;
      }),
  ).toStrictEqual([control, control]);
  expect(
    cdp.requests.filter((r) => {
      return r.method === "Runtime.addBinding";
    }),
  ).toHaveLength(2);
});

test("browser-frames-recovery-009 A lost image connection during retry can still deliver a fresh image of Example", async () => {
  const advance = browserRecoveryClock(context.signal);
  const v = scopedViewer(context);
  await v.start(true);
  const cdp = v.cdp;
  vi.spyOn(globalThis, "createImageBitmap").mockRejectedValueOnce(
    new Error("Invalid raster from image transport"),
  );
  const session = cdp.requests
    .filter((r) => {
      return r.method === "Page.startScreencast";
    })
    .at(-1)!.sessionId!;
  const capture = cdp.holdNext("Page.startScreencast");
  expect(cdp.frame("AQID", session)).toBeTruthy();
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  advance(1000);
  await capture.received;
  const fresh = cdp.holdTargetFrames(v.first);
  await act(async () => {
    v.disconnectImage();
    await capture.release();
  });
  advance(2000);
  await fresh.received;
  expect(input()).toBeDisabled();
  expect(browserTab("Example")).toHaveAttribute("aria-selected", "true");
  fresh.release();
  await expectStreamingAt(firstUrl);
  expect(browserTab("Example")).toHaveAttribute("aria-selected", "true");
  await waitFor(() => {
    return expect(screen.queryByText(/retry live image/i)).toBeNull();
  });
});
