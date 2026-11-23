// @vitest-environment-options {"url":"https://app.okou.ai"}
import { initSentry } from "../../../lib/sentry.ts";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "../../browser-session/__tests__/browser-native-page-fixture.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

async function sidebar() {
  const { cdp, viewer } = arrangeNativePage(context);
  const threadId = viewer.browser.threadId;
  mockChatLifecycle(context, {
    threadId,
    chatEvents: [
      {
        content: "[Browser](" + viewer.browser.viewerUrl + ")",
        role: "assistant",
        createdAt: "2026-08-01T10:00:01Z",
      },
    ],
  });
  const errors = context.mocks.sentry();
  await setupPage({
    context,
    path: "/chats/" + threadId,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
  });
  const card = await findFastControl("button", /Open .*browser/i);
  click(card);
  await expectStreamingAt("https://example.com");
  return {
    cdp,
    errors,
    close: await findFastControl("button", "Close cloud browser"),
  };
}
test("chat-browser-shutdown-004 closing the sidebar releases the button on its original capture", async () => {
  const { cdp, errors, close } = await sidebar();
  const image = screen.getByRole("img", {
    name: "Live browser view",
  }) as HTMLCanvasElement;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 600),
  );
  await userEvent.pointer({
    target: image,
    keys: "[MouseLeft>]",
    coords: { clientX: 200, clientY: 225 },
  });
  await waitFor(() => {
    return expect(cdp.inputForTarget("example-page").at(-1)?.params?.type).toBe(
      "mousePressed",
    );
  });
  const release = cdp.holdNext("Input.dispatchMouseEvent");
  click(close);
  await release.received;
  expect(screen.queryByLabelText("Remote browser input")).toBeNull();
  expect(cdp.activeConnections()).toBe(1);
  await release.release();
  await waitFor(() => {
    return expect(cdp.activeConnections()).toBe(0);
  });
  expect(cdp.inputForTarget("example-page").at(-1)?.params?.type).toBe(
    "mouseReleased",
  );
  expect(errors.reports).toStrictEqual([]);
});

test("chat-browser-shutdown-003 a rejected Shift release preserves the protocol reason after the sidebar disconnects", async () => {
  initSentry();
  const { close, cdp, errors } = await sidebar();
  const user = userEvent.setup({ delay: null });
  await user.click(screen.getByLabelText("Remote browser input"));
  await user.keyboard("{Shift>}");
  await waitFor(() => {
    expect(cdp.inputForTarget("example-page").at(-1)?.params?.key).toBe(
      "Shift",
    );
  });
  cdp.failNext(
    "Input.dispatchKeyEvent",
    "Shift release denied by browser",
    -32_001,
  );
  cdp.holdNext("Page.stopScreencast");
  click(close);
  await waitFor(() => {
    expect(cdp.activeConnections()).toBe(0);
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeEnabled();
  await waitFor(() => {
    const cleanup = errors.reports.find((report) => {
      return (
        report.type === "exception" &&
        report.error instanceof Error &&
        report.error.message === "Original input cleanup is unconfirmed."
      );
    });
    const messages: string[] = [];
    let fault: unknown =
      cleanup?.type === "exception" ? cleanup.error : undefined;
    while (fault instanceof Error && fault.cause instanceof Error) {
      messages.push(fault.message);
      fault = fault.cause;
    }
    expect(messages).toContain("Original input retirement failed.");
    expect(messages).toContain(
      "Original cleanup receipt failed: Input.dispatchKeyEvent (CDP -32001).",
    );
    expect(fault).toMatchObject({
      code: -32_001,
      request: { method: "Input.dispatchKeyEvent", code: -32_001 },
    });
  });
});
