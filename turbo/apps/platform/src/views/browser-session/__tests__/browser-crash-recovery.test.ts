import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  expectStreamingAt,
  browserTab,
  arrangeNativePage,
} from "./browser-native-page-fixture.ts";
import {
  scopedViewer,
  firstUrl,
  input,
} from "./scoped-browser-transport-fixtures.ts";

const context = testContext();

const reload = () => {
  return screen.getByText("Reload", { selector: "button" });
};
async function navigate(url: string) {
  const field = screen.getByLabelText("Address");
  fireEvent.change(field, { target: { value: url } });
  fireEvent.submit(field.closest("form")!);
  await expectStreamingAt(url);
}
async function reloadAfterDecode(split: boolean) {
  const v = scopedViewer(context);
  await v.start(split);
  const { cdp } = v;
  const old = cdp.requests
      .filter((r) => {
        return r.method === "Page.startScreencast";
      })
      .at(-1)!.sessionId!,
    windowConnection = v.control();
  const decoding = context.mocks.deferred<void>(),
    releaseDecode = context.mocks.deferred<void>(),
    retired = context.mocks.deferred<void>();
  const decode = globalThis.createImageBitmap.bind(globalThis);
  vi.spyOn(globalThis, "createImageBitmap").mockImplementationOnce(
    async (source: ImageBitmapSource) => {
      const image = await decode(source);
      vi.spyOn(image, "close").mockImplementation(() => {
        return retired.resolve();
      });
      decoding.resolve();
      await releaseDecode.promise;
      return image;
    },
  );
  expect(cdp.frame("AQID", old)).toBeTruthy();
  await decoding.promise;
  cdp.event("Inspector.targetCrashed", {}, old);
  await screen.findByText("Browser view unavailable");
  expect(input()).toBeDisabled();
  releaseDecode.resolve();
  await retired.promise;
  expect(reload()).toBeEnabled();
  expect(input()).toBeDisabled();
  const receipt = cdp.holdNext("Page.reload");
  click(reload());
  await receipt.received;
  expect(input()).toBeDisabled();
  await receipt.release();
  await expectStreamingAt(firstUrl);
  expect(browserTab("Other")).toBeEnabled();
  expect(v.control()).toBe(windowConnection);
  return { v, cdp, old };
}
test("browser-page-crash-001 Reload resets the crashed tab and a retired session's late crash notification leaves it usable", async () => {
  const { cdp, old } = await reloadAfterDecode(false);
  act(() => {
    cdp.event("Inspector.targetCrashed", {}, old);
  });
  expect(input()).toBeEnabled();
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
});
test("browser-page-crash-003 A crash on the separate image channel stays unavailable through stale decode and Reload restores navigation", async () => {
  const { v, cdp } = await reloadAfterDecode(true);
  const next = "https://example.com/after-reload";
  await navigate(next);
  expect(
    cdp.targets.find((t) => {
      return t.targetId === v.first;
    })?.url,
  ).toBe(next);
});

test.each([
  ["browser-page-crash-005", "delivered"],
  ["Withheld control", "withheld"],
] as const)(
  "%s Reload keeps the recovered tab navigable with the old frame tree %s",
  async (_label, delivery) => {
    const viewer = scopedViewer(context);
    const { cdp, first } = viewer;
    const oldFrame = cdp.holdNext("Page.getFrameTree", first);
    await viewer.openPage();
    await oldFrame.received;
    const connection = [...cdp.requests].reverse().find((request) => {
      return request.method === "Page.getFrameTree";
    })?.connectionId;
    expect(connection).toBeDefined();
    cdp.event("Inspector.targetCrashed", {}, cdp.pageSession(first));
    await screen.findByText("Browser view unavailable");
    expect(input()).toBeDisabled();
    click(reload());
    await expectStreamingAt(firstUrl);
    const recovered = "https://survey.example/resumed";
    await navigate(recovered);
    if (delivery === "delivered") {
      const receipt = context.mocks.deferred<void>();
      await oldFrame.release(
        {
          frameTree: {
            frame: {
              id: "example-frame",
              loaderId: "retired-loader",
              url: "https://retired.example/old-document",
            },
          },
        },
        () => {
          if (!receipt.settled()) {
            receipt.resolve();
          }
        },
      );
      await receipt.promise;
    }
    expect(screen.getByLabelText("Address")).toHaveValue(recovered);
    expect(input()).toBeEnabled();
    expect(
      [...cdp.requests].reverse().find((request) => {
        return (
          request.method === "Page.navigate" &&
          request.params?.url === recovered
        );
      })?.connectionId,
    ).toBe(connection);
  },
);

const first = "example-page";
const other = "other-page";
const crashedTabUrl = "https://example.com";
const otherUrl = "https://other.example";
async function twoTabs() {
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      { targetId: first, title: "Example", url: crashedTabUrl, windowId: 101 },
      { targetId: other, title: "Other", url: otherUrl, windowId: 101 },
    ],
  });
  await openPage();
  await expectStreamingAt(crashedTabUrl);
  return cdp;
}
async function navigateTo(
  cdp: Awaited<ReturnType<typeof twoTabs>>,
  targetId: string,
  address: string,
) {
  const field = screen.getByLabelText("Address");
  fireEvent.change(field, { target: { value: address } });
  const form = field.closest("form");
  if (!form) {
    throw new Error("Missing address form");
  }
  fireEvent.submit(form);
  await waitFor(() => {
    expect(
      cdp.targets.find((target) => {
        return target.targetId === targetId;
      })?.url,
    ).toBe(address);
  });
  await expectStreamingAt(address);
}
const tabCrashAddressInput = () => {
  return screen.getByLabelText("Remote browser input");
};
test("browser-page-crash-006 Notifications for a sibling and an unrelated page leave the selected tab navigable on its existing connection", async () => {
  const cdp = await twoTabs();
  const initial = cdp.connections();
  cdp.crash(other, "target");
  cdp.event("Inspector.targetCrashed", {}, "unrelated-session");
  await navigateTo(cdp, first, "https://example.com/continued");
  expect(screen.queryByText("Browser view unavailable")).toBeNull();
  expect(cdp.connections()).toBe(initial);
});
test("browser-page-crash-012 The failed Reload belongs to the crashed tab and the sibling can recover independently", async () => {
  const cdp = await twoTabs();
  const opened = cdp.connections();
  cdp.crash(first, "target");
  await screen.findByText("Browser view unavailable");
  cdp.failNext("Page.reload", "Reload declined for Example");
  click(screen.getByText("Reload", { selector: "button" }));
  await screen.findByText(/The browser action could not be completed/);
  expect(tabCrashAddressInput()).toBeDisabled();
  click(browserTab("Other")!);
  await expectStreamingAt(otherUrl);
  cdp.crash(other, "target");
  await screen.findByText("Browser view unavailable");
  expect(
    screen.queryByText(/The browser action could not be completed/),
  ).toBeNull();
  click(screen.getByText("Reload", { selector: "button" }));
  await expectStreamingAt(otherUrl);
  await navigateTo(cdp, other, "https://other.example/recovered");
  expect(cdp.connections()).toBe(opened);
});
test("browser-page-crash-010 Releasing an abandoned attachment closes it without disturbing the successor tab", async () => {
  const cdp = await twoTabs();
  const opened = cdp.connections();
  cdp.crash(first, "target");
  await screen.findByText("Browser view unavailable");
  const held = cdp.holdNext("Target.attachToTarget", first);
  click(screen.getByText("Reload", { selector: "button" }));
  const receipt = JSON.parse(await held.received) as {
    result: { sessionId: string };
  };
  click(browserTab("Other")!);
  await expectStreamingAt(otherUrl);
  await held.release();
  await waitFor(() => {
    return expect(cdp.detached).toContain(receipt.result.sessionId);
  });
  expect(browserTab("Other")!).toHaveAttribute("aria-selected", "true");
  await expectStreamingAt(otherUrl);
  expect(
    cdp.requests.filter((r) => {
      return r.method === "Page.reload";
    }),
  ).toStrictEqual([]);
  expect(cdp.connections()).toBe(opened);
});
test("browser-page-crash-015 Rejection of a pending Close keeps the crashed tab unavailable until explicit Reload", async () => {
  const cdp = await twoTabs();
  const before = cdp.connections();
  const pending = cdp.holdClose(first);
  click(screen.getByLabelText("Close Example"));
  await pending.received;
  cdp.crash(first, "session");
  await screen.findByText("Browser view unavailable");
  cdp.failNext("Target.closeTarget", "Tab is busy");
  await pending.release();
  await screen.findByText(/The browser action could not be completed/);
  expect(tabCrashAddressInput()).toBeDisabled();
  expect(screen.getByText("Browser view unavailable")).toBeVisible();
  click(screen.getByText("Reload", { selector: "button" }));
  await expectStreamingAt(crashedTabUrl);
  await navigateTo(cdp, first, "https://example.com/after-close");
  expect(cdp.connections()).toBe(before);
});
test("browser-page-crash-013 Pausing a pending reload abandons its attachment and a fresh request recovers on the same connection", async () => {
  const visibility = context.mocks.browser.visibilityState("visible");
  const cdp = await twoTabs();
  const opened = cdp.connections();
  cdp.crash(first, "target");
  await screen.findByText("Browser view unavailable");
  const held = cdp.holdNext("Target.attachToTarget", first);
  click(screen.getByText("Reload", { selector: "button" }));
  const reply = JSON.parse(await held.received) as {
    result: { sessionId: string };
  };
  visibility.changeTo("hidden");
  await screen.findByText(/Viewing paused|Browser view paused/i);
  visibility.changeTo("visible");
  await screen.findByText("Browser view unavailable");
  await held.release();
  await waitFor(() => {
    expect(cdp.detached).toContain(reply.result.sessionId);
  });
  expect(tabCrashAddressInput()).toBeDisabled();
  expect(
    cdp.requests.filter((item) => {
      return item.method === "Page.reload";
    }),
  ).toStrictEqual([]);
  click(screen.getByText("Reload", { selector: "button" }));
  await expectStreamingAt(crashedTabUrl);
  expect(cdp.connections()).toBe(opened);
});
