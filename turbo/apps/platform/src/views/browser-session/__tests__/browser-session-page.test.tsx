import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  setupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  cachedChatListEvents,
  chatListThread,
  chatListEvent,
  installChatListStream,
} from "../../okou-page/__tests__/chat-list-test-helpers.ts";
import { openQualityMenu } from "./browser-settings-test-helpers.ts";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
function control(role: "tab" | "menuitem" | "menuitemradio", label: string) {
  return waitFor(() => {
    const match = queryAllByRoleFast(role).find((element) => {
      return (
        element.getAttribute("aria-label") === label ||
        element.textContent?.trim() === label
      );
    });
    if (!match) {
      throw new Error("Missing " + role + ": " + label);
    }
    return match;
  });
}

test("browser-session-page-002 Each window sizing choice is checked when settings reopen", async () => {
  const session = arrangeNativePage(context);
  await session.openPage();
  const settings = await screen.findByLabelText("Browser settings");
  await waitFor(() => {
    expect(settings).toBeEnabled();
  });
  async function openSizing() {
    await userEvent.click(settings);
    const windowSize = await control("menuitem", "Window size");
    await userEvent.hover(windowSize);
    return await control("menuitemradio", "Follow panel");
  }
  await expect(openSizing()).resolves.toHaveAttribute("aria-checked", "true");
  for (const selected of ["On connection", "Follow panel", "Off"]) {
    await userEvent.click(await control("menuitemradio", selected));
    await openSizing();
    await expect(control("menuitemradio", selected)).resolves.toHaveAttribute(
      "aria-checked",
      "true",
    );
  }
});

test("browser-session-page-003 The blank tab's guidance follows the selected remote page", async () => {
  const destination = "https://example.com/";
  const session = arrangeNativePage(context, {
    targets: [
      {
        targetId: "welcome",
        title: "about:blank",
        url: "about:blank",
        windowId: 101,
      },
      {
        targetId: "article",
        title: "Example",
        url: destination,
        windowId: 101,
      },
    ],
  });
  await session.openPage();
  const address = await screen.findByLabelText("Address");
  const guidance =
    "Okou opens pages here as it works. Enter a URL above to browse yourself.";
  await expect(screen.findByText("Nothing open yet")).resolves.toBeVisible();
  expect(screen.getByText(guidance)).toBeVisible();
  expect(address).toBeEnabled();
  await userEvent.click(await control("tab", "Example"));
  await waitFor(() => {
    expect(address).toHaveValue(destination);
  });
  expect(screen.queryByText("Nothing open yet")).toBeNull();
  expect(screen.queryByText(guidance)).toBeNull();
  await userEvent.click(await control("tab", "New tab"));
  await expect(screen.findByText(guidance)).resolves.toBeVisible();
  expect(screen.getByText("Nothing open yet")).toBeVisible();
  expect(address).toBeEnabled();
});

const address = "https://example.com";
const denied = "Cloud browser is not enabled for this chat";
function permissionError() {
  return {
    error: {
      code: "BROWSER_AUTHORIZATION_REQUIRED",
      message: "Grant required",
    },
  };
}

async function qualityPanel() {
  const session = arrangeNativePage(context);
  await session.openPage();
  await expectStreamingAt(address);
  const menu = await openQualityMenu();
  const field = within(menu).getByRole("textbox", { name: "Image quality" });
  async function applied(quality: number, format = "webp") {
    await waitFor(() => {
      expect(session.cdp.captures.at(-1)).toMatchObject({ format, quality });
      if (field.isConnected) {
        expect(field).not.toHaveAttribute("aria-busy", "true");
      }
    });
  }
  await applied(70);
  return { menu, field, applied, cdp: session.cdp };
}

test("browser-session-page-004 Enter after composition and blur apply the typed endpoints", async () => {
  const { menu, field, applied } = await qualityPanel();
  await fill(field, "");
  expect(field).toHaveValue("");
  await userEvent.type(field, "100");
  fireEvent.compositionStart(field);
  for (const key of ["Enter", "Escape"]) {
    fireEvent.keyDown(field, { key, isComposing: true, keyCode: 229 });
    expect(menu).toBeVisible();
    expect(field).toHaveValue("100");
    await applied(70);
  }
  fireEvent.compositionEnd(field);
  await userEvent.keyboard("{Enter}");
  await applied(100);
  await fill(field, "");
  await userEvent.type(field, "0");
  await applied(100);
  field.blur();
  await applied(0);
});

test("browser-session-page-006 Presets and slider endpoints preserve Escape focus", async () => {
  const { field, menu, applied } = await qualityPanel();
  await expect(control("menuitemradio", "Balanced")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const [label, value] of [
    ["Data saver", 40],
    ["Sharper", 90],
    ["Balanced", 70],
  ] as const) {
    await userEvent.click(await control("menuitemradio", label));
    await applied(value);
  }
  const slider = within(menu).getByRole("slider");
  slider.focus();
  for (const [key, value] of [
    ["End", 100],
    ["Home", 0],
  ] as const) {
    await userEvent.keyboard("{" + key + "}");
    await applied(value);
    expect(slider).toHaveFocus();
  }
  await fill(field, "51");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
    expect(
      screen.getByText("Image quality").closest('[role="menuitem"]'),
    ).toHaveFocus();
  });
  await applied(0);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByLabelText("Browser settings")).toHaveFocus();
});

test("browser-session-page-009 The Sharper preset survives a PNG round trip", async () => {
  const { field, applied, cdp } = await qualityPanel();
  await fill(field, "85");
  await applied(70);
  await userEvent.click(await control("menuitemradio", "Sharper"));
  await applied(90);
  expect(field).toHaveValue("90");
  await userEvent.keyboard("{Escape}");
  async function format(name: string) {
    await userEvent.hover(await control("menuitem", "Image format"));
    await userEvent.click(await control("menuitemradio", name));
  }
  await format("PNG");
  await waitFor(() => {
    return expect(cdp.captures.at(-1)).toMatchObject({ format: "png" });
  });
  await userEvent.click(screen.getByLabelText("Browser settings"));
  expect(
    screen.getByText("Lossless").closest('[role="menuitem"]'),
  ).toHaveAttribute("aria-disabled", "true");
  await format("JPEG");
  await applied(90, "jpeg");
  await userEvent.click(screen.getByLabelText("Browser settings"));
  await userEvent.hover(await control("menuitem", "Image format"));
  await expect(control("menuitemradio", "JPEG")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
});

function expectDenied() {
  const panel = within(screen.getByTestId("browser-session-page"));
  expect(panel.getByText(denied)).toBeVisible();
  expect(panel.queryByLabelText("Remote browser input")).toBeNull();
  expect(panel.queryByRole("img", { name: "Live browser view" })).toBeNull();
  expect(panel.queryByText("Browser not live")).toBeNull();
  expect(panel.queryByText("Start browser")).toBeNull();
  expect(panel.queryByText("Browser not found")).toBeNull();
}

test.each(["denied", "allowed"] as const)(
  "An initial %s browser session settles before its renewal could supply the panel",
  async (access) => {
    const session = arrangeNativePage(context);
    const pending = leaseSequence(session)();
    context.mocks.api(browserContract.get, ({ respond }) => {
      return access === "denied"
        ? respond(403, permissionError())
        : respond(200, {
            browser: session.viewer.browser,
            viewer: session.viewer,
          });
    });
    try {
      await session.openPage();
      if (access === "denied") {
        await screen.findByText(denied);
        expectDenied();
      } else {
        await pending.arrival.promise;
        await expectStreamingAt(address);
      }
      const panel = within(screen.getByTestId("browser-session-page"));
      expect(
        panel.queryByText(
          "This browser does not belong to this chat or has been removed.",
        ),
      ).toBeNull();
    } finally {
      pending.reply.resolve(session.viewer.browser);
    }
  },
);

test("browser-session-page-028 Lease denial removes the still-connected native view", async () => {
  const session = arrangeNativePage(context);
  const lease = leaseSequence(session)();
  await session.openPage();
  await expectStreamingAt(address);
  const request = await lease.arrival.promise;
  expect(request.signal.aborted).toBeFalsy();
  lease.reply.resolve(403);
  await screen.findByText(denied);
  expectDenied();
});

test.each([
  ["017", "https://viewer.example/live"],
  ["018", null],
] as const)(
  "browser-session-page-%s Window zero fences input while its replacement loads",
  async (_id, liveUrl) => {
    const s = arrangeNativePage(context, {}, 0);
    const replacement = context.mocks.deferred<void>();
    let reloading = false;
    context.mocks.api(browserContract.get, async ({ respond }) => {
      if (reloading) {
        await replacement.promise;
      }
      const browser = { ...s.viewer.browser, liveUrl };
      return respond(200, { browser, viewer: { ...s.viewer, browser } });
    });
    await s.openPage();
    await expectStreamingAt(address);
    reloading = true;
    context.mocks.ably.trigger("browserSessionChanged", {
      threadId: s.viewer.browser.threadId,
    });
    const input = screen.getByLabelText("Remote browser input");
    await waitFor(() => {
      return expect(input).toBeDisabled();
    });
    await userEvent.type(input, "stale");
    replacement.resolve();
    await expectStreamingAt(address);
    await userEvent.type(screen.getByLabelText("Remote browser input"), "z");
    await waitFor(() => {
      return expect(s.cdp.inputForTarget("example-page")).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            params: expect.objectContaining({ text: "z" }),
          }),
        ]),
      );
    });
    for (const letter of "stale") {
      expect(s.cdp.inputForTarget("example-page")).not.toContainEqual(
        expect.objectContaining({
          params: expect.objectContaining({ text: letter }),
        }),
      );
    }
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

test("browser-session-page-022 A restarted viewer searches after an unfinished composition", async () => {
  const s = arrangeNativePage(context);
  const browser = {
    ...s.viewer.browser,
    status: "suspended" as const,
    window: undefined,
  };
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser, viewer: null });
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    return respond(200, { browser: s.viewer.browser, viewer: s.viewer });
  });
  await s.openPage();
  const start = await screen.findByText("Start browser");
  const initial = screen.getByLabelText("Address");
  fireEvent.compositionStart(initial);
  fireEvent.change(initial, { target: { value: "旧" } });
  await userEvent.click(start);
  await waitFor(() => {
    return expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  const field = screen.getByLabelText("Address");
  await fill(field, "annual report");
  expect(screen.getByLabelText("Search Google")).toBeEnabled();
  await userEvent.keyboard("{Enter}");
  const url = "https://www.google.com/search?q=annual+report";
  await expectStreamingAt(url);
  expect(s.cdp.targets[0]?.url).toBe(url);
});

test("browser-session-page-032 Service permission restored then revoked removes the active viewer", async () => {
  const s = arrangeNativePage(context);
  let authorized = false;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return authorized
      ? respond(200, { browser: s.viewer.browser, viewer: s.viewer })
      : respond(403, permissionError());
  });
  const permission = grantEvents(s, false);
  await permission.open();
  await screen.findByText(denied);
  expectDenied();
  authorized = true;
  permission.signal(true);
  await expectStreamingAt(address);
  expect(screen.queryByText(denied)).toBeNull();
  authorized = false;
  permission.revokeAgain();
  await screen.findByText(denied);
  expectDenied();
});

type Session = ReturnType<typeof arrangeNativePage>;
function leaseSequence(
  session: Session,
  onArrival?: (threadId: string) => void,
) {
  type Reply = 403 | 404 | 409 | 502 | 503 | Session["viewer"]["browser"];
  function step() {
    const arrival = context.mocks.deferred<Request>();
    const reply = context.mocks.deferred<Reply>();
    return { arrival, reply };
  }
  const queue: ReturnType<typeof step>[] = [];
  context.mocks.api(
    browserContract.leaseByThread,
    async ({ request, respond, params }) => {
      onArrival?.(params.threadId);
      const next = queue.shift();
      if (!next) {
        return respond(200, { browser: session.viewer.browser });
      }
      next.arrival.resolve(request);
      const result = await next.reply.promise;
      if (result === 403) {
        return respond(403, permissionError());
      }
      if (typeof result === "number") {
        return respond(result, {
          error: { code: "LEASE_FAILED", message: "Lease service unavailable" },
        });
      }
      return respond(200, { browser: result });
    },
  );
  return () => {
    const item = step();
    queue.push(item);
    return item;
  };
}
function grantEvents(s: Session, initiallyGranted = true) {
  const id = s.viewer.browser.threadId;
  const source = installChatListStream(context, {
    caseId: 71,
    snapshot: [
      chatListThread(71, "Browser owner", {
        id,
        cloudBrowserEnabled: initiallyGranted,
      }),
    ],
  });
  const deniedEvent = chatListEvent(71, 2, "computer_use_host_updated", id, {
    cloudBrowserEnabled: false,
  });
  const allowedEvent = chatListEvent(71, 3, "computer_use_host_updated", id, {
    cloudBrowserEnabled: true,
  });
  const signal = (granted: boolean) => {
    source.setEvents(granted ? [deniedEvent, allowedEvent] : [deniedEvent]);
    context.mocks.ably.trigger("threadListChanged");
  };
  return {
    signal,
    revokeAgain() {
      source.setEvents([
        deniedEvent,
        allowedEvent,
        chatListEvent(71, 4, "computer_use_host_updated", id, {
          cloudBrowserEnabled: false,
        }),
      ]);
      context.mocks.ably.trigger("threadListChanged");
    },
    open: () => {
      return setupPage({
        context,
        path: "/browsers/" + id,
        host: "app.okou.ai",
        featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: true },
        cachedChatThreadEvents: cachedChatListEvents(71, [
          chatListThread(71, "Browser owner", {
            id,
            cloudBrowserEnabled: initiallyGranted,
          }),
        ]),
      });
    },
  };
}

test("browser-session-page-037 A batched grant change clears a completed lease denial", async () => {
  const s = arrangeNativePage(context);
  const permission = grantEvents(s);
  const denial = context.mocks.deferred<void>();
  let deny = true;
  context.mocks.api(browserContract.leaseByThread, async ({ respond }) => {
    if (deny) {
      await denial.promise;
      return respond(403, permissionError());
    }
    return respond(200, { browser: s.viewer.browser });
  });
  await permission.open();
  await expectStreamingAt(address);
  denial.resolve();
  await screen.findByText(denied);
  expectDenied();
  deny = false;
  permission.signal(true);
  await expectStreamingAt(address);
  expect(screen.queryByText(denied)).toBeNull();
});

function observeHeartbeat() {
  const receipt = vi.spyOn(console, "error");
  const original = receipt.getMockImplementation();
  receipt.mockImplementation((...args: unknown[]) => {
    if (args[0] === "[E][BrowserHeartbeat]") {
      return;
    }
    original?.(...args);
  });
  return (status: number, threadId: string) => {
    return expect(
      receipt.mock.calls.filter(([label]) => {
        return label === "[E][BrowserHeartbeat]";
      }),
    ).toStrictEqual([
      [
        "[E][BrowserHeartbeat]",
        "Browser heartbeat failed; scheduled renewal will continue",
        { threadId, status },
      ],
    ]);
  };
}

test.each([
  ["038", 503],
  ["045", 503],
] as const)(
  "browser-session-page-%s Expiry confirmed after a transient renewal exposes Start browser",
  async (id, status) => {
    const s = arrangeNativePage(context);
    const logged = observeHeartbeat();
    const next = leaseSequence(s);
    let expired = false;
    context.mocks.api(browserContract.get, ({ respond }) => {
      return expired
        ? respond(200, {
            browser: {
              ...s.viewer.browser,
              status: "suspended",
              window: undefined,
            },
            viewer: null,
          })
        : respond(200, { browser: s.viewer.browser, viewer: s.viewer });
    });
    const outage = next();
    await s.openPage();
    await expectStreamingAt(address);
    const recovery = next();
    outage.reply.resolve(status);
    await recovery.arrival.promise;
    expired = true;
    recovery.reply.resolve(id === "038" ? 409 : 404);
    await screen.findByText("Browser not live");
    expect(screen.getByText("Start browser").closest("button")).toBeEnabled();
    expect(screen.queryByText(denied)).toBeNull();
    if (id === "045") {
      logged(status, s.viewer.browser.threadId);
    }
  },
);
test("browser-session-page-039 A gateway failure is reported and the next lease leaves the viewer editable", async () => {
  const s = arrangeNativePage(context);
  const logged = observeHeartbeat();
  const next = leaseSequence(s);
  const outage = next();
  await s.openPage();
  await expectStreamingAt(address);
  const retry = next();
  outage.reply.resolve(502);
  await retry.arrival.promise;
  logged(502, s.viewer.browser.threadId);
  await userEvent.type(screen.getByLabelText("Address"), "x");
  expect(screen.getByLabelText("Address")).toHaveValue(address + "x");
  expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
});

test("browser-session-page-050 The renewed window supplies its own tab and subsequent lease", async () => {
  const s = arrangeNativePage(
    context,
    {
      targets: [
        { targetId: "home", title: "First chat", url: address, windowId: 0 },
        {
          targetId: "other",
          title: "Other chat",
          url: "https://other.test/",
          windowId: 1,
        },
      ],
    },
    0,
  );
  const replacement = {
    ...s.viewer.browser,
    window: {
      instanceId: "a0000000-0000-4000-a000-000000000872",
      primaryWindowId: 1,
    },
    status: "active" as const,
  };
  let current = s.viewer.browser;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: current,
      viewer: { ...s.viewer, browser: current },
    });
  });
  const next = leaseSequence(s);
  const renew = next();
  await s.openPage();
  await expectStreamingAt(address);
  await expect(control("tab", "First chat")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
  current = replacement;
  const continued = next();
  renew.reply.resolve(replacement);
  await expectStreamingAt("https://other.test/");
  await expect(control("tab", "Other chat")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByText("First chat")).toBeNull();
  await continued.arrival.promise;
});

test("browser-session-page-016 Input on a replacement runtime reaches its own tab", async () => {
  const second = "https://replacement.example/home";
  const s = arrangeNativePage(context, {
    targets: [
      { targetId: "old", title: "Old instance", url: address, windowId: 101 },
      { targetId: "new", title: "New instance", url: second, windowId: 202 },
    ],
  });
  let browser = s.viewer.browser;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser, viewer: { ...s.viewer, browser } });
  });
  await s.openPage();
  await expectStreamingAt(address);
  const pending = s.cdp.holdNext("Input.dispatchKeyEvent");
  await userEvent.type(screen.getByLabelText("Remote browser input"), "v");
  await pending.received;
  browser = {
    ...browser,
    status: "active",
    window: {
      primaryWindowId: 202,
      instanceId: "b0000000-0000-4000-a000-000000000071",
    },
  };
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: browser.threadId,
  });
  await expectStreamingAt(second);
  await pending.release();
  await userEvent.type(screen.getByLabelText("Remote browser input"), "q");

  await waitFor(() => {
    return expect(s.cdp.inputForTarget("new")).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({ text: "q" }),
      }),
    );
  });
  expect(s.cdp.inputForTarget("old")).not.toContainEqual(
    expect.objectContaining({ params: expect.objectContaining({ text: "q" }) }),
  );
});

async function qualityDrag(draft?: string) {
  const { field, menu, applied } = await qualityPanel();
  const range = within(menu).getByRole("slider");
  const track = range.closest('[data-slot="slider"]')?.firstElementChild;
  if (!(track instanceof HTMLElement)) {
    throw new Error("Missing quality slider track");
  }
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, 20),
  );
  if (draft) {
    await fill(field, draft);
    await applied(70);
  }
  const user = userEvent.setup();
  await user.pointer({
    target: track,
    keys: "[MouseLeft>]",
    coords: { x: 25, y: 10 },
  });
  expect(field).toHaveValue("25");
  await applied(70);
  return { user, track, range, menu, field, applied };
}
test("browser-session-page-007 The numeric draft follows a drag before remote capture applies it on release", async () => {
  const { user, track, field, applied } = await qualityDrag("85");
  await user.pointer({ target: track, coords: { x: 60, y: 10 } });
  expect(field).toHaveValue("60");
  await applied(70);
  await user.pointer({
    target: track,
    keys: "[/MouseLeft]",
    coords: { x: 60, y: 10 },
  });
  await applied(60);
});
test("browser-session-page-008 Escape dismisses before queued pointer events can apply a quality change", async () => {
  const { track, range, menu, applied } = await qualityDrag();
  act(() => {
    fireEvent.keyDown(range, { key: "Escape", code: "Escape" });
    fireEvent.pointerMove(track, {
      clientX: 90,
      clientY: 10,
      buttons: 1,
      pointerId: 1,
    });
    fireEvent.pointerUp(track, {
      clientX: 90,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
  });
  expect(menu).not.toBeInTheDocument();
  const item = await control("menuitem", "Image quality");
  expect(item).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.hover(item);
  const reopened = await screen.findByRole("textbox", {
    name: "Image quality",
  });
  expect(reopened).toHaveValue("70");
  await applied(70);
});
test("browser-session-page-023 A new permission grant clears an earlier blocked address before membership settles", async () => {
  const s = arrangeNativePage(context);
  const permission = grantEvents(s);
  await permission.open();
  await expectStreamingAt(address);
  const first = s.cdp.holdNextMembership("example-page");
  s.cdp.duplicate("example-page");
  await first.received;
  const field = screen.getByLabelText("Address");
  await fill(field, "first.example/path");
  await userEvent.keyboard("{Enter}");
  await screen.findByText("The browser is not ready. Try again shortly.");
  const current = s.cdp.holdNextMembership("example-page");
  permission.signal(true);
  await current.received;
  expect(
    screen.queryByText("The browser is not ready. Try again shortly."),
  ).toBeNull();
  const replacement = screen.getByLabelText("Address");
  await fill(replacement, "new.example/path");
  await userEvent.keyboard("{Enter}");
  await screen.findByText("The browser is not ready. Try again shortly.");
  expect(s.cdp.targets[0]?.url).toBe(address);
  await current.release();
  await waitFor(() => {
    return expect(
      screen.queryByText("The browser is not ready. Try again shortly."),
    ).toBeNull();
  });
  expect(s.cdp.targets[0]?.url).toBe(address);
});

test("browser-session-page-053 Late instance renewal cannot replace the new instance after a service outage", async () => {
  const s = arrangeNativePage(context, {
    targets: [
      {
        targetId: "retiring",
        windowId: 101,
        title: "Old runtime",
        url: address,
      },
      {
        targetId: "replacement",
        windowId: 202,
        title: "Replacement runtime",
        url: address,
      },
    ],
  });
  const logged = observeHeartbeat();
  const next = leaseSequence(s);
  const outage = next();
  const replacement = context.mocks.deferred<void>();
  let changing = false;
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (changing) {
      await replacement.promise;
    }
    const browser = changing
      ? {
          ...s.viewer.browser,
          status: "active" as const,
          window: {
            primaryWindowId: 202,
            instanceId: "b0000000-0000-4000-a000-000000000071",
          },
        }
      : s.viewer.browser;
    return respond(200, { browser, viewer: { ...s.viewer, browser } });
  });
  await s.openPage();
  await expectStreamingAt(address);
  const stale = next();
  outage.reply.resolve(503);
  const req = await stale.arrival.promise;
  changing = true;
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: s.viewer.browser.threadId,
  });
  await waitFor(() => {
    return expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  const renewed = next();
  replacement.resolve();
  await expectStreamingAt(address);
  expect(req.signal.aborted).toBeFalsy();
  stale.reply.resolve(s.viewer.browser);
  await renewed.arrival.promise;
  await expect(control("tab", "Replacement runtime")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByText("Old runtime")).toBeNull();
  await userEvent.type(screen.getByLabelText("Address"), "x");
  expect(screen.getByLabelText("Address")).toHaveValue(address + "x");
  logged(503, s.viewer.browser.threadId);
});

test("browser-session-page-055 Old lease is cancelled when the user returns to the other chat viewer", async () => {
  const otherThread = "a0000000-0000-4000-a000-000000000099";
  const s = arrangeNativePage(context, {
    targets: [
      {
        targetId: "original",
        title: "Current chat",
        url: address,
        windowId: 101,
      },
      {
        targetId: "next",
        title: "Other chat",
        url: "https://other.test/",
        windowId: 202,
      },
    ],
  });
  const owners: string[] = [];
  const logged = observeHeartbeat();
  const next = leaseSequence(s, (owner) => {
    if (owners.at(-1) !== owner) {
      owners.push(owner);
    }
  });
  const outage = next();
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    const browser =
      params.threadId === otherThread
        ? {
            ...s.viewer.browser,
            threadId: otherThread,
            status: "active" as const,
            window: {
              instanceId: "c0000000-0000-4000-a000-000000000099",
              primaryWindowId: 202,
            },
          }
        : s.viewer.browser;
    return respond(200, { browser, viewer: { ...s.viewer, browser } });
  });
  await s.openPage();
  await expectStreamingAt(address);
  const old = next();
  outage.reply.resolve(503);
  const req = await old.arrival.promise;
  logged(503, s.viewer.browser.threadId);
  // Seed the entries from an earlier visit, then exercise browser Back on the mounted Router.
  window.history.replaceState(null, "", "/browsers/" + otherThread);
  window.history.pushState(null, "", "/browsers/" + s.viewer.browser.threadId);
  const active = next();
  window.history.back();
  await expectStreamingAt("https://other.test/");
  await expect(control("tab", "Other chat")).resolves.toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(req.signal.aborted).toBeTruthy();
  expect(new URL(req.url).pathname).toContain(s.viewer.browser.threadId);
  expect(new URL((await active.arrival.promise).url).pathname).toContain(
    otherThread,
  );
  expect(owners).toStrictEqual([s.viewer.browser.threadId, otherThread]);
});

test("An idle-reclaimed browser offers a fresh start from its stopped state", async () => {
  const session = arrangeNativePage(context);
  const { window: _window, ...browser } = session.viewer.browser;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, {
      browser: {
        ...browser,
        status: "suspended",
        suspendedAt: "2026-08-01T11:20:00Z",
        suspensionReason: "idle",
      },
      viewer: null,
    });
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    return respond(200, {
      browser: session.viewer.browser,
      viewer: session.viewer,
    });
  });
  await session.openPage();
  await screen.findByText("Browser not live");
  expect(screen.queryByText("Browser view unavailable.")).toBeNull();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  await userEvent.click(
    screen.getByText("Start browser", { selector: "button" }),
  );
  await expectStreamingAt(address);
  expect(screen.queryByText("Browser not live")).toBeNull();
});

test("Changing the display during handover fits the newly assigned window", async () => {
  const panel = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect");
  panel.mockReturnValue(new DOMRect(0, 0, 900, 600));
  const original = {
    targetId: "morning",
    title: "Morning",
    url: "https://morning.example.test/",
    windowId: 31,
  };
  const late = {
    targetId: "evening",
    title: "Evening",
    url: "https://evening.example.test/",
    windowId: 72,
  };
  const { cdp, openPage, viewer } = arrangeNativePage(
    context,
    { targets: [original, late] },
    original.windowId,
  );
  const fit = (windowId: number, width: number, height: number) => {
    return expect(cdp.requests).toContainEqual(
      expect.objectContaining({
        method: "Browser.setContentsSize",
        params: expect.objectContaining({ windowId, width, height }),
      }),
    );
  };
  await openPage();
  await expectStreamingAt(original.url);
  await waitFor(() => {
    return fit(original.windowId, 900, 600);
  });
  const held = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  const browser = {
    ...viewer.browser,
    window: {
      primaryWindowId: late.windowId,
      instanceId: "62ded10b-3232-478f-860a-268953513e72",
    },
  };
  context.mocks.api(browserContract.get, async ({ respond }) => {
    if (!requested.settled()) {
      requested.resolve();
    }
    await held.promise;
    return respond(200, { browser, viewer: { ...viewer, browser } });
  });
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: browser.threadId,
  });
  await requested.promise;
  await waitFor(() => {
    return expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  panel.mockReturnValue(new DOMRect(0, 0, 720, 480));
  window.dispatchEvent(new Event("resize"));
  cdp.setWindowState("minimized", late.windowId, { width: 1280, height: 800 });
  held.resolve();
  await expectStreamingAt(late.url);
  await waitFor(() => {
    return fit(late.windowId, 720, 480);
  });
});

test("browser-session-page-014 The replacement browser endpoint fits its own window after the display changes during its handshake", async () => {
  const destination = "wss://second.example.test/devtools/browser/session";
  const pending = context.mocks.deferred<{ open(): void }>();
  const page = {
    targetId: "replacement-invoice",
    title: "Review",
    url: "https://review.example.test/",
    windowId: 280,
  };
  const primary = {
    targetId: "original-order",
    title: "Order",
    url: "https://order.example.test/",
    windowId: 101,
  };
  const size = vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect");
  size.mockReturnValue(new DOMRect(0, 0, 900, 600));
  const { cdp, viewer, openPage } = arrangeNativePage(context, {
    targets: [primary, page],
    endpointAliases: [destination],
    onConnecting: (url, socket) => {
      if (url === destination && !pending.settled()) {
        pending.resolve(socket);
      }
    },
  });
  let current = viewer;
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: current.browser, viewer: current });
  });
  await openPage();
  await expectStreamingAt(primary.url);
  function fitted(
    endpoint: string,
    windowId: number,
    width: number,
    height: number,
  ) {
    expect(cdp.requestsAt(endpoint)).toContainEqual(
      expect.objectContaining({
        method: "Browser.setContentsSize",
        params: expect.objectContaining({ windowId, width, height }),
      }),
    );
  }
  await waitFor(() => {
    return fitted(viewer.cdpUrl, 101, 900, 600);
  });
  cdp.setAutoOpen(false);
  current = {
    ...viewer,
    cdpUrl: destination,
    browser: {
      ...viewer.browser,
      window: {
        instanceId: "e61840c0-02ce-400c-9a38-4efb80e9f824",
        primaryWindowId: page.windowId,
      },
    },
  };
  context.mocks.ably.trigger("browserSessionChanged", {
    threadId: viewer.browser.threadId,
  });
  const transport = await pending.promise;
  expect(screen.getByText("Connecting to browser…")).toBeVisible();
  expect(screen.queryByRole("img", { name: "Live browser view" })).toBeNull();
  const measured = context.mocks.deferred<string | null>();
  size.mockImplementation(function (this: HTMLCanvasElement) {
    if (!measured.settled()) {
      measured.resolve(this.getAttribute("aria-hidden"));
    }
    return new DOMRect(0, 0, 720, 480);
  });
  fireEvent.resize(window);
  await expect(measured.promise).resolves.toBe("true");
  cdp.setWindowState("minimized", page.windowId, { width: 1280, height: 800 });
  cdp.setAutoOpen(true);
  transport.open();
  await expectStreamingAt(page.url);
  await waitFor(() => {
    return fitted(destination, page.windowId, 720, 480);
  });
});
