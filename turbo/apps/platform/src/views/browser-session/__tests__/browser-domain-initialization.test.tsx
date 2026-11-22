import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const owner = Object.freeze({
  targetId: "report",
  title: "Report",
  url: "https://report.example/",
  windowId: 8,
});
const other = Object.freeze({
  targetId: "other",
  title: "Other",
  url: "https://other.example/",
  windowId: 8,
});
const outside = Object.freeze({
  targetId: "private",
  title: "Private",
  url: "https://private.example/",
  windowId: 31,
});
const setup = () => {
  return arrangeNativePage(context, { targets: [owner, other, outside] }, 8);
};
type Remote = ReturnType<typeof setup>["cdp"];
function input() {
  return screen.getByLabelText("Remote browser input");
}
function namedTab(label: string) {
  return queryAllByRoleFast("tab").find((t) => {
    return t.getAttribute("aria-label") === label;
  });
}
async function sendText(remote: Remote, receiver: string, letter: string) {
  await userEvent.type(input(), letter);
  const text = expect.objectContaining({
    params: expect.objectContaining({ text: letter }),
  });
  await waitFor(() => {
    return expect(remote.inputForTarget(receiver)).toContainEqual(text);
  });
  const otherRecipients = [owner, other, outside].filter((page) => {
    return page.targetId !== receiver;
  });
  for (const page of otherRecipients) {
    expect(remote.inputForTarget(page.targetId)).not.toContainEqual(text);
  }
}
async function connecting() {
  const { cdp, openPage } = setup();
  const inspector = cdp.holdNext("Inspector.enable");
  const page = cdp.holdNext("Page.enable");
  await openPage();
  await Promise.all([inspector.received, page.received]);
  expect(input()).toBeDisabled();
  const attachment = cdp.pageSession(owner.targetId);
  return { cdp, inspector, page, attachment };
}
test("browser-domain-initialization-001 Input waits for Page after Inspector succeeds", async () => {
  const { cdp, inspector, page } = await connecting();
  await inspector.release();
  await userEvent.type(input(), "x");
  expect(input()).toBeDisabled();
  expect(cdp.input).toStrictEqual([]);
  await page.release();
  await expectStreamingAt(owner.url);
  await sendText(cdp, owner.targetId, "p");
});
test("browser-domain-initialization-003 Inspector failure retires the attachment before the late Page reply", async () => {
  const { cdp, openPage } = setup();
  cdp.failNext("Inspector.enable", "Domain unavailable");
  const page = cdp.holdNext("Page.enable");
  const failure = cdp.holdNext("Inspector.enable");
  await openPage();
  await Promise.all([page.received, failure.received]);
  const attachment = cdp.pageSession(owner.targetId);
  await failure.release();
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    return expect(cdp.detached).toContain(attachment);
  });
  await page.release();
  await userEvent.type(input(), "q");
  expect(input()).toBeDisabled();
  expect(screen.getByText("Browser view unavailable")).toBeInTheDocument();
  expect(cdp.input).toStrictEqual([]);
});
async function expectOtherAfterInspector(
  remote: Remote,
  reply: Awaited<ReturnType<typeof connecting>>["inspector"],
) {
  await expectStreamingAt(other.url);
  const successor = remote.pageSession(other.targetId);
  await reply.release();
  await sendText(remote, other.targetId, "s");
  expect(namedTab("Other")).toHaveAttribute("aria-selected", "true");
  expect(remote.pageSession(other.targetId)).toBe(successor);
}
test("browser-domain-initialization-005 Selecting Other retires the pending attachment and routes text to Other", async () => {
  const { cdp, inspector, page, attachment } = await connecting();
  await page.release();
  await userEvent.click(
    screen.getByLabelText("Other", { selector: '[role="tab"]' }),
  );
  await waitFor(() => {
    expect(cdp.detached).toContain(attachment);
  });
  await expectOtherAfterInspector(cdp, inspector);
});
test("browser-domain-initialization-007 Destroying Report during setup leaves Other selected and usable", async () => {
  const { cdp, inspector, page } = await connecting();
  await page.release();
  cdp.event("Target.targetDestroyed", { targetId: owner.targetId });
  await expectOtherAfterInspector(cdp, inspector);
  expect(namedTab("Report")).toBeUndefined();
});
test("browser-domain-initialization-009 Window removal blocks input and isolates the sibling after a late enable", async () => {
  const { cdp, inspector, page } = await connecting();
  await page.release();
  cdp.closeWindow(8);
  expect(cdp.targets).toStrictEqual([outside]);
  await screen.findByText("Browser disconnected");
  await inspector.release();
  await userEvent.type(input(), "t");
  expect(input()).toBeDisabled();
  expect(namedTab("Private")).toBeUndefined();
  expect(cdp.input).toStrictEqual([]);
});
test("browser-domain-initialization-011 Leaving the viewer closes its transport before a late Inspector reply", async () => {
  const { cdp, inspector, page } = await connecting();
  await page.release();
  const viewer = window.location.pathname;
  window.history.replaceState(null, "", "/");
  window.history.pushState(null, "", viewer);
  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
    expect(cdp.activeConnections()).toBe(0);
    expect(screen.queryByLabelText("Remote browser input")).toBeNull();
  });
  await inspector.release();
  expect(cdp.activeConnections()).toBe(0);
  expect(screen.queryByLabelText("Remote browser input")).toBeNull();
});
test("browser-domain-initialization-013 A transport change retains its new session after the old enable replies", async () => {
  const { cdp, inspector, page, attachment } = await connecting();
  await page.release();
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await screen.findByText("Connection mode"));
  await userEvent.click(await screen.findByText("Separate image connection"));
  await expectStreamingAt(owner.url);
  const successor = cdp.pageSession(owner.targetId);
  expect(successor).not.toBe(attachment);
  await inspector.release();
  await sendText(cdp, owner.targetId, "z");
  expect(cdp.inputForTarget(owner.targetId)).toContainEqual(
    expect.objectContaining({
      sessionId: successor,
      params: expect.objectContaining({ text: "z" }),
    }),
  );
  expect(cdp.pageSession(owner.targetId)).toBe(successor);
});

test("browser-domain-initialization-014 A fresh connection takes input after the original Page reply arrives late", async () => {
  const { cdp, openPage } = setup();
  const original = cdp.holdNext("Page.enable");
  await openPage();
  await original.received;
  const previous = cdp.pageSession(owner.targetId);
  const replacement = cdp.holdTargetFrames(owner.targetId);
  cdp.disconnect({ code: 1006 });
  await replacement.received;
  replacement.release();
  await expectStreamingAt(owner.url);
  const current = cdp.pageSession(owner.targetId);
  expect(current).not.toBe(previous);
  await original.release();
  await sendText(cdp, owner.targetId, "r");
  expect(cdp.inputForTarget(owner.targetId)).toContainEqual(
    expect.objectContaining({
      sessionId: current,
      params: expect.objectContaining({ text: "r" }),
    }),
  );
  expect(cdp.pageSession(owner.targetId)).toBe(current);
  expect(cdp.connections()).toBe(2);
});
