import { fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserTab,
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
const context = testContext();
const first = "example-page";
const other = "other-page";
const firstUrl = "https://example.com";
const otherUrl = "https://other.example";
async function twoTabs() {
  const { cdp, openPage } = arrangeNativePage(context, {
    targets: [
      { targetId: first, title: "Example", url: firstUrl, windowId: 101 },
      { targetId: other, title: "Other", url: otherUrl, windowId: 101 },
    ],
  });
  await openPage();
  await expectStreamingAt(firstUrl);
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
const input = () => {
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
  expect(input()).toBeDisabled();
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
  expect(input()).toBeDisabled();
  expect(screen.getByText("Browser view unavailable")).toBeVisible();
  click(screen.getByText("Reload", { selector: "button" }));
  await expectStreamingAt(firstUrl);
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
  expect(input()).toBeDisabled();
  expect(
    cdp.requests.filter((item) => {
      return item.method === "Page.reload";
    }),
  ).toStrictEqual([]);
  click(screen.getByText("Reload", { selector: "button" }));
  await expectStreamingAt(firstUrl);
  expect(cdp.connections()).toBe(opened);
});
