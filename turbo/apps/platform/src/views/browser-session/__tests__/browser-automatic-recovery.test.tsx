import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockMonotonicNow } from "../../../lib/time.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const primary = Object.freeze({
  targetId: "ledger",
  title: "Ledger",
  url: "https://ledger.example/",
  windowId: 19,
});
const sibling = Object.freeze({
  targetId: "map",
  title: "Other",
  url: "https://other.example",
  windowId: 19,
});
const foreign = Object.freeze({
  targetId: "unowned",
  title: "Foreign",
  url: "https://foreign.example/",
  windowId: 20,
});
const endpoint = "wss://cdp.example.test/replacement";
function proxy() {
  return screen.getByLabelText("Remote browser input");
}
function newTab() {
  return screen.getByLabelText("New tab", {
    selector: "button[data-browser-new-tab]",
  });
}
function clock() {
  let base = 0;
  let start = performance.now();
  let speed = 0;
  mockMonotonicNow(() => {
    return base + (performance.now() - start) * speed;
  }, context.signal);
  return (value: number, rate = 0) => {
    base = value;
    start = performance.now();
    speed = rate;
  };
}
async function online() {
  const time = clock();
  const errors = context.mocks.sentry();
  const session = arrangeNativePage(
    context,
    { targets: [primary, sibling, foreign], endpointAliases: [endpoint] },
    19,
  );
  await session.openPage();
  await expectStreamingAt(primary.url);
  return { ...session, errors, time };
}
type Live = Awaited<ReturnType<typeof online>>;
async function nextImage(live: Live, failures: number) {
  const { cdp } = live;
  let next = cdp.holdTargetFrames(primary.targetId);
  cdp.frame("!invalid", cdp.pageSession(primary.targetId));
  await screen.findByText("Reconnecting…");
  live.time(0, 32);
  await next.received;
  for (let failed = 1; failed < failures; failed++) {
    next.release("!invalid");
    next = cdp.holdTargetFrames(primary.targetId);
    await next.received;
  }
  expect(proxy()).toBeDisabled();
  return next;
}
function refresh(live: Live, result: "same" | "suspended" | "replacement") {
  const arrived = context.mocks.deferred<void>();
  const reply = context.mocks.deferred<void>();
  const { viewer } = live;
  let pending = true;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (pending) {
      pending = false;
      arrived.resolve();
      await reply.promise;
    }
    if (result === "suspended") {
      const { window: _window, ...browser } = viewer.browser;
      return respond(200, {
        browser: {
          ...browser,
          status: "suspended",
          idleExpiresAt: null,
          suspendedAt: "2026-08-01T11:00:00.000Z",
          suspensionReason: "idle",
        },
        viewer: null,
      });
    }
    return respond(200, {
      browser: viewer.browser,
      viewer:
        result === "replacement" ? { ...viewer, cdpUrl: endpoint } : viewer,
    });
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: viewer.browser.threadId,
  });
  return { arrived: arrived.promise, release: reply.resolve };
}
async function write(
  live: Live,
  letter: string,
  target: string = primary.targetId,
) {
  await userEvent.type(proxy(), letter);
  await waitFor(() => {
    return expect(live.cdp.inputForTarget(target)).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ text: letter }),
      }),
    );
  });
  for (const other of live.cdp.targets.filter((t) => {
    return t.targetId !== target;
  })) {
    expect(live.cdp.inputForTarget(other.targetId)).not.toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ text: letter }),
      }),
    );
  }
}
test("browser-automatic-recovery-001 A confirmed Ledger image survives same-binding revalidation and a second failure", async () => {
  const live = await online();
  const image = await nextImage(live, 1);
  const descriptor = refresh(live, "same");
  await descriptor.arrived;
  image.release();
  expect(proxy()).toBeDisabled();
  await descriptor.release();
  await expectStreamingAt(primary.url);
  await write(live, "a");
  const another = live.cdp.holdTargetFrames(primary.targetId);
  live.cdp.frame("!later", live.cdp.pageSession(primary.targetId));
  await another.received;
  another.release();
  await expectStreamingAt(primary.url);
  expect(live.cdp.connections()).toBe(1);
  expect(live.errors.reports).toStrictEqual([]);
});
test("browser-automatic-recovery-005 A suspended descriptor retires the recovering viewer", async () => {
  const live = await online();
  const image = await nextImage(live, 1);
  const descriptor = refresh(live, "suspended");
  await descriptor.arrived;
  image.release();
  expect(proxy()).toBeDisabled();
  await descriptor.release();
  await screen.findByText("Start browser", { selector: "button" });
  expect(proxy()).toBeDisabled();
  expect(screen.queryByText("Reconnecting…")).toBeNull();
});
test.each([
  ["006", 1],
  ["007", 3],
] as const)(
  "browser-automatic-recovery-%s A new endpoint supplies Ledger after %i failed pictures",
  async (_id, failures) => {
    const live = await online();
    const current = await nextImage(live, failures);
    const descriptor = refresh(live, "replacement");
    await descriptor.arrived;
    current.release();
    const image = live.cdp.holdTargetFrames(primary.targetId);
    await descriptor.release();
    await image.received;
    expect(live.cdp.connections(endpoint)).toBe(1);
    expect(proxy()).toBeDisabled();
    image.release();
    await expectStreamingAt(primary.url);
    await write(live, "r");
    expect(live.cdp.connections()).toBe(2);
    expect(live.errors.reports).toStrictEqual([]);
  },
);
function exhausted(live: Live) {
  return live.errors.reports.filter((report) => {
    return JSON.stringify(report.context).includes('"outcome":"exhausted"');
  });
}
test("browser-automatic-recovery-003 The original deadline expires while the success descriptor is pending", async () => {
  const live = await online();
  const image = await nextImage(live, 3);
  live.time(179_000);
  const descriptor = refresh(live, "same");
  await descriptor.arrived;
  image.release();
  live.time(180_001);
  await waitFor(() => {
    return expect(exhausted(live)).toHaveLength(1);
  });
  expect(proxy()).toBeDisabled();
  await descriptor.release();
  await expectStreamingAt(primary.url);
  await write(live, "d");
  expect(exhausted(live)).toHaveLength(1);
  expect(live.cdp.connections()).toBe(1);
});

async function exhaust(live: Live) {
  const final = await nextImage(live, 3);
  final.release("!last");
  await waitFor(() => {
    return expect(exhausted(live)).toHaveLength(1);
  });
  expect(proxy()).toBeDisabled();
  return [...live.errors.reports];
}
async function useEmptyWindow(live: Live) {
  await screen.findByText("No tabs open");
  await waitFor(() => {
    return expect(newTab()).toBeEnabled();
  });
  await userEvent.click(newTab());
  await expectStreamingAt("");
  const owned = live.cdp.targets.filter((t) => {
    return t.windowId === primary.windowId;
  });
  expect(owned).toStrictEqual([
    expect.objectContaining({ url: "about:blank", windowId: 19 }),
  ]);
  expect(
    live.cdp.targets.find((t) => {
      return t.targetId === foreign.targetId;
    }),
  ).toMatchObject(foreign);
}
test.each([
  ["011", "ready"],
  ["012", "recovering"],
  ["014", "exhausted"],
] as const)(
  "browser-automatic-recovery-%s Pending inventory delays the empty %s window",
  async (_id, state) => {
    const live = await online();
    if (state === "recovering") {
      live.cdp.frame("!damaged", live.cdp.pageSession(primary.targetId));
      await screen.findByText("Reconnecting…");
    } else if (state === "exhausted") {
      await exhaust(live);
    }
    const previous = [...live.errors.reports];
    expect(previous).toHaveLength(state === "exhausted" ? 1 : 0);
    const proof = live.cdp.holdNextMembership("created-1");
    live.cdp.duplicate(foreign.targetId);
    await proof.received;
    live.cdp.event("Target.targetDestroyed", { targetId: primary.targetId });
    live.cdp.event("Target.targetDestroyed", { targetId: sibling.targetId });
    await waitFor(() => {
      return expect(newTab()).toBeDisabled();
    });
    expect(proxy()).toBeDisabled();
    expect(screen.queryByText("No tabs open")).toBeNull();
    if (state === "exhausted") {
      await screen.findByText("Connecting to browser…");
    }
    await proof.release();
    await useEmptyWindow(live);
    expect(live.errors.reports).toStrictEqual(previous);
  },
);
test("browser-automatic-recovery-013 The local empty window accepts a new tab after exhaustion", async () => {
  const live = await online();
  const previous = await exhaust(live);
  live.cdp.event("Target.targetDestroyed", { targetId: primary.targetId });
  live.cdp.event("Target.targetDestroyed", { targetId: sibling.targetId });
  await useEmptyWindow(live);
  expect(live.errors.reports).toStrictEqual(previous);
});
test("browser-automatic-recovery-017 Other's capability failure has its own report and rejected page action", async () => {
  const live = await online();
  const previous = await exhaust(live);
  const consoleErrors = vi.spyOn(console, "error");
  live.cdp.failNext("Page.enable", "Unavailable page domain", -32_601);
  await userEvent.click(pageTab(sibling.title));
  await screen.findByText("Browser view unavailable");
  await waitFor(() => {
    return expect(consoleErrors.mock.calls).toContainEqual(
      expect.arrayContaining([
        expect.stringContaining("Detached promise rejected"),
        expect.objectContaining({
          request: expect.objectContaining({
            method: "Page.enable",
            code: -32_601,
          }),
        }),
      ]),
    );
  });
  expect(live.errors.reports).toStrictEqual([
    ...previous,
    expect.objectContaining({
      context: expect.objectContaining({
        tags: expect.objectContaining({ browser_event: "recovery-stopped" }),
        contexts: expect.objectContaining({
          browser_recovery: { outcome: "terminal" },
        }),
      }),
      error: expect.objectContaining({
        request: expect.objectContaining({
          method: "Page.enable",
          code: -32_601,
        }),
      }),
    }),
  ]);
  const reports = [...live.errors.reports];
  const reconnect = screen.getByText("Reconnect", { selector: "button" });
  await waitFor(() => {
    return expect(reconnect).toBeEnabled();
  });
  await userEvent.click(reconnect);
  await expectStreamingAt(sibling.url);
  expect(live.errors.reports).toStrictEqual(reports);
});

function pageTab(title: string) {
  return screen.getByLabelText(title, { selector: '[role="tab"]' });
}
test("browser-automatic-recovery-021 A new blank tab accepts the keystroke after Ledger leaves the window", async () => {
  const live = await online();
  const creating = live.cdp.holdNextNative("createTab");
  await userEvent.click(newTab());
  await creating.received;
  live.cdp.frame("!missing", live.cdp.pageSession(primary.targetId));
  await screen.findByText("Reconnecting…");
  live.time(0, 8);
  live.cdp.move(primary.targetId, foreign.windowId);
  await creating.release();
  await expectStreamingAt("");
  const owned = live.cdp.targets.find((t) => {
    return t.windowId === primary.windowId && t.url === "about:blank";
  });
  if (!owned) {
    throw new Error("Missing blank tab in the assigned browser window");
  }
  await write(live, "b", owned.targetId);
  expect(live.errors.reports).toStrictEqual([]);
});
test("browser-automatic-recovery-038 Selecting Other clears Ledger's picture while its first frame is withheld", async () => {
  const live = await online();
  const canvas = screen.getByRole<HTMLCanvasElement>("img", {
    name: "Live browser view",
  });
  const drawing = canvas.getContext("2d");
  if (!drawing) {
    throw new Error("Missing canvas context");
  }
  const clear = vi.spyOn(drawing, "clearRect");
  const image = live.cdp.holdTargetFrames(sibling.targetId);
  await userEvent.click(pageTab(sibling.title));
  await image.received;
  expect(proxy()).toBeDisabled();
  expect(clear).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
  expect(canvas).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("img", { name: "Live browser view" })).toBeNull();
  image.release();
  await expectStreamingAt(sibling.url);
});
test("browser-automatic-recovery-069 A replaced native worker restores Other in its own window", async () => {
  const live = await online();
  await userEvent.click(pageTab(sibling.title));
  await expectStreamingAt(sibling.url);
  const proof = live.cdp.holdNextMembership(sibling.targetId);
  live.cdp.resetWorker();
  live.time(0, 8);
  await proof.received;
  expect(proxy()).toBeDisabled();
  await proof.release();
  await expectStreamingAt(sibling.url);
  expect(pageTab(sibling.title)).toHaveAttribute("aria-selected", "true");
  expect(
    screen.queryByLabelText(foreign.title, { selector: '[role="tab"]' }),
  ).toBeNull();
  await write(live, "w", sibling.targetId);
});
test("browser-automatic-recovery-072 Retry live image restores the local stream after exhaustion", async () => {
  const live = await online();
  const reported = await exhaust(live);
  const retry = screen.getByText("Retry live image", { selector: "button" });
  expect(retry).toBeEnabled();
  await userEvent.click(retry);
  await expectStreamingAt(primary.url);
  await write(live, "i");
  expect(live.cdp.connections()).toBe(1);
  expect(live.errors.reports).toStrictEqual(reported);
});
test("browser-automatic-recovery-073 An empty reconnected window offers New tab and excludes Foreign", async () => {
  const live = await online();
  live.cdp.event("Target.targetDestroyed", { targetId: primary.targetId });
  live.cdp.event("Target.targetDestroyed", { targetId: sibling.targetId });
  live.cdp.disconnect({ code: 1006 });
  live.time(0, 8);
  await screen.findByText("Reconnecting…");
  await screen.findByText("No tabs open");
  await waitFor(() => {
    return expect(newTab()).toBeEnabled();
  });
  expect(
    screen.queryByLabelText(foreign.title, { selector: '[role="tab"]' }),
  ).toBeNull();
  expect(live.cdp.targets).toStrictEqual([foreign]);
});
test("browser-automatic-recovery-033 Two transient descriptor errors recover the selected tab in the assigned window", async () => {
  const live = await online();
  await userEvent.click(pageTab(sibling.title));
  await expectStreamingAt(sibling.url);
  const errors = vi.spyOn(console, "error");
  const failures: (503 | 500)[] = [503, 500];
  const success = context.mocks.deferred<void>();
  const pending = context.mocks.deferred<void>();
  context.mocks.api(browserContract.get, async ({ respond }) => {
    const status = failures.shift();
    if (status !== undefined) {
      return respond(status, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Browser service is temporarily unavailable",
        },
      });
    }
    if (!pending.settled()) {
      pending.resolve();
    }
    await success.promise;
    return respond(200, { browser: live.viewer.browser, viewer: live.viewer });
  });
  live.cdp.disconnect({ code: 1006 });
  await screen.findByText("Reconnecting…");
  live.time(0, 32);
  await pending.promise;
  expect(proxy()).toBeDisabled();
  success.resolve();
  await expectStreamingAt(sibling.url);
  expect(pageTab(sibling.title)).toHaveAttribute("aria-selected", "true");
  await write(live, "t", sibling.targetId);
  expect(
    screen.queryByLabelText(foreign.title, { selector: '[role="tab"]' }),
  ).toBeNull();
  expect(live.errors.reports).toStrictEqual([]);
  expect(
    errors.mock.calls.filter((args) => {
      return typeof args[0] === "string" && args[0].startsWith("[E]");
    }),
  ).toStrictEqual([]);
});
