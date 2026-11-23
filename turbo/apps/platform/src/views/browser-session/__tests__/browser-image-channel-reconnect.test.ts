import userEvent from "@testing-library/user-event";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserTab,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
import {
  scopedViewer,
  firstUrl,
  nextUrl,
  input,
} from "./scoped-browser-transport-fixtures.ts";
const context = testContext();
test("browser-frames-recovery-001 Each scoped image loss waits for fresh imagery while the same window retains its address, Other tab and duplicate", async () => {
  const view = scopedViewer(context);
  await view.start(true);
  const attached = view.control(),
    { cdp } = view;
  for (let cycle = 0; cycle < 2; cycle++) {
    const frames = cdp.holdTargetFrames(view.first);
    view.disconnectImage();
    await frames.received;
    expect(input()).toBeDisabled();
    expect(browserTab("Other")).toBeEnabled();
    expect(screen.getByLabelText("Address")).toHaveValue(firstUrl);
    frames.release();
    await expectStreamingAt(firstUrl);
    expect(browserTab("Example")).toHaveAttribute("aria-selected", "true");
  }
  cdp.duplicate(view.other);
  await waitFor(() => {
    return expect(queryAllByRoleFast("tab")).toHaveLength(3);
  });
  expect(browserTab("Outside")).toBeNull();
  expect(
    cdp.targets.filter((t) => {
      return t.url === nextUrl;
    }),
  ).toHaveLength(2);
  expect(
    cdp.requests.filter((r) => {
      return r.method === "Target.closeTarget";
    }),
  ).toStrictEqual([]);
  expect(view.control()).toBe(attached);
});
test("browser-frames-recovery-006 A failed replacement image socket can recover with the original control bindings", async () => {
  const v = scopedViewer(context);
  await v.start(true);
  const cdp = v.cdp,
    original = v.control();
  cdp.setAutoOpen(false);
  const firstAttempt = v.nextConnection();
  v.disconnectImage();
  await firstAttempt;
  expect(input()).toBeDisabled();
  const retry = v.nextConnection();
  cdp.disconnect({ code: 1006, reason: "Replacement refused" }, 1);
  const pending = await retry;
  expect(input()).toBeDisabled();
  pending.open();
  await expectStreamingAt(firstUrl);
  expect(
    cdp.requests.filter((r) => {
      return r.method === "Runtime.addBinding";
    }),
  ).toHaveLength(2);
  expect(v.control()).toBe(original);
});
test("browser-frames-recovery-013 A control loss during image-only recovery revokes input and new-tab actions together", async () => {
  const v = scopedViewer(context);
  await v.start(true);
  const { cdp } = v;
  cdp.setAutoOpen(false);
  v.disconnectImage();
  await waitFor(() => {
    return expect(input()).toBeDisabled();
  });
  const newTab = screen.getByLabelText("New tab");
  cdp.disconnect({ code: 1006, reason: "Window channel lost" }, 0);
  await waitFor(() => {
    return expect(newTab).toBeDisabled();
  });
  expect(input()).toBeDisabled();
  await expect(screen.findByText(/Reconnecting/)).resolves.toBeVisible();
});

test("The other tab remains navigable after a failed in-flight text entry on the separate image channel", async () => {
  const viewer = scopedViewer(context);
  await viewer.start(true);
  const { cdp } = viewer;
  const original = viewer.control();
  cdp.failNext("Input.insertText", "Held text rejected", -32_000);
  const inputSession = cdp.pageSession(viewer.first);
  const sent = cdp.holdNext("Input.insertText");
  const text = "Rejected entry";
  await userEvent.click(input());
  fireEvent.input(input(), {
    target: { value: text },
    inputType: "insertText",
    data: text,
  });
  await expect(sent.received).resolves.toContain("Held text rejected");
  cdp.setAutoOpen(false);
  viewer.disconnectImage();
  await waitFor(() => {
    expect(input()).toBeDisabled();
  });
  await sent.release();
  await expect(screen.findByText(/Reconnecting/)).resolves.toBeVisible();
  expect(screen.queryByText("Retry live image")).toBeNull();
  cdp.setAutoOpen(true);
  click(browserTab("Other")!);
  cdp.openConnection();
  await expectStreamingAt(nextUrl);
  expect(cdp.requests).toContainEqual(
    expect.objectContaining({
      method: "Input.insertText",
      sessionId: inputSession,
      params: { text },
    }),
  );
  expect(viewer.control()).toBe(original);
});
