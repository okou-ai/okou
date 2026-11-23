import { screen, fireEvent, act } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  expectStreamingAt,
  browserTab,
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
