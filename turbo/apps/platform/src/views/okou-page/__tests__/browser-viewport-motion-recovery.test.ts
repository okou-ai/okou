import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  openBrowserChat,
  remoteBrowserInput,
} from "./conversation-browser-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function nativeGeometry(budget: number) {
  let surface = 800;
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (Object.hasOwn(this.dataset, "browserTabBudget")) {
        return new DOMRect(0, 0, budget, 32);
      }
      if (this.matches('[data-sidebar-layout-owner="panel"]')) {
        return new DOMRect(0, 0, budget === 180 ? 400 : 1000, 680);
      }
      if (
        Object.hasOwn(this.dataset, "browserSurface") ||
        Object.hasOwn(this.dataset, "browserCanvas")
      ) {
        return new DOMRect(0, 0, surface, 600);
      }
      return rect.call(this);
    },
  );
  return (width: number, next = surface) => {
    budget = width;
    surface = next;
    fireEvent.resize(window);
  };
}
function tabs() {
  return queryAllByRoleFast("tab").map((t) => {
    return t.getAttribute("aria-label") ?? t.textContent?.trim();
  });
}
function expectAdmission(n: number, selected: string) {
  const toolbar = document.querySelector("[data-browser-tab-budget]");
  if (!toolbar) {
    throw new Error("Waiting for the browser tab strip");
  }
  const visibleTabs = queryAllByRoleFast("tab", toolbar);
  expect(visibleTabs).toHaveLength(n);
  expect(
    visibleTabs.find((tab) => {
      return (
        (tab.getAttribute("aria-label") ?? tab.textContent?.trim()) === selected
      );
    }),
  ).toHaveAttribute("aria-selected", "true");
}

async function admission(n: number, selected: string) {
  await waitFor(() => {
    expectAdmission(n, selected);
  });
}
function readyBrowserInput() {
  const surface = document.querySelector<HTMLElement>("[data-browser-surface]");
  if (!surface) {
    throw new Error("Waiting for the browser viewer surface");
  }
  const input = within(surface).getByRole("textbox", {
    name: "Remote browser input",
  });
  expect(input).toBeEnabled();
  return input;
}
async function selectLast() {
  click(await findFastControl("button", "All tabs"));
  click(
    await screen.findByText("Page 12", {
      selector: '[role="menuitemradio"] *',
    }),
  );
}
function owner(id: string) {
  const el = document.querySelector<HTMLElement>(
    '[data-sidebar-layout-owner="' + id + '"]',
  );
  if (!el) {
    throw new Error("Missing layout owner " + id);
  }
  return el;
}
function nativeTransitions() {
  const style = document.createElement("style");
  style.textContent = '[data-sidebar-layout-owner="panel"] { flex-grow: 0; }';
  document.head.append(style);
  context.signal.addEventListener(
    "abort",
    () => {
      return style.remove();
    },
    {
      once: true,
    },
  );
  function set(el: HTMLElement, running: boolean) {
    Object.defineProperty(el, "getAnimations", {
      configurable: true,
      value: () => {
        return running
          ? [{ transitionProperty: "width", playState: "running" }]
          : [];
      },
    });
    const e = new Event(running ? "transitionrun" : "transitionend", {
      bubbles: true,
    });
    Object.defineProperty(e, "propertyName", { value: "width" });
    fireEvent(el, e);
  }
  return set;
}
test("chat-navigation-browser-016 Resizing during a disconnected viewer takes effect on recovery before the tab row widens", async () => {
  const retry = context.mocks.deferred<{ open(): void }>();
  let disconnected = false;
  const { open, cdp } = await openBrowserChat(context, "live", false, {
    many: true,
    onConnecting: (_url, socket) => {
      if (disconnected) {
        retry.resolve(socket);
      }
    },
  });
  const resize = nativeGeometry(800);
  click(open);
  const field = await waitFor(readyBrowserInput);
  await admission(12, "Example");
  disconnected = true;
  cdp.setAutoOpen(false);
  cdp.disconnect({ code: 1006, reason: "Reconnect the native browser" });
  await waitFor(() => {
    return expect(field).toBeDisabled();
  });
  resize(240, 916);
  const replacement = await retry.promise;
  replacement.open();
  const resizedViewport = expect.objectContaining({
    method: "Emulation.setDeviceMetricsOverride",
    params: expect.objectContaining({ width: 916, height: 600 }),
  });
  await waitFor(() => {
    expect(cdp.requests).toContainEqual(resizedViewport);
    readyBrowserInput();
    expectAdmission(3, "Example");
  });
  resize(800);
  await admission(12, "Example");
});
test("chat-navigation-browser-012 Narrow Page 12 admission releases after both native width owners finish", async () => {
  const resize = nativeGeometry(180),
    transition = nativeTransitions();
  const { open } = await openBrowserChat(context, "live", false, {
    many: true,
  });
  click(open);
  await remoteBrowserInput();
  await selectLast();
  await admission(2, "Page 12");
  const hide = await findFastControl("button", "Hide chat list");
  click(hide);
  const show = await findFastControl("button", "Show chat list");
  const panel = owner("panel");
  panel.style.flexGrow = "0";
  transition(panel, true);
  click(show);
  const list = await waitFor(() => {
    return owner("chat-list");
  });
  transition(list, true);
  resize(800);
  await admission(2, "Page 12");
  transition(panel, false);
  await admission(2, "Page 12");
  transition(list, false);
  await admission(12, "Page 12");
  expect(tabs()).toContain("Page 12");
});

test.each([
  ["panel", false],
  ["chat-list", false],
  ["panel", true],
  ["chat-list", true],
] as const)(
  "Returning from Workflows waits for both widths when %s finishes first (remote active notification: %s)",
  async (firstOwner, reportsActivePage) => {
    const resize = nativeGeometry(180);
    const motion = nativeTransitions();
    const { open, cdp } = await openBrowserChat(context, "live", false, {
      many: true,
    });
    click(open);
    await remoteBrowserInput();
    await selectLast();
    await admission(2, "Page 12");
    click(await findFastControl("button", "Hide chat list"));
    const show = await findFastControl("button", "Show chat list");
    const old = owner("panel");
    old.style.flexGrow = "0";
    motion(old, true);
    click(show);
    const list = await waitFor(() => {
      return owner("chat-list");
    });
    motion(list, true);
    click(await findFastControl("link", "Workflows"));
    await waitFor(() => {
      expect(location.pathname).toBe("/workflows");
      expect(old).not.toBeInTheDocument();
    });
    expect(list).toBeInTheDocument();
    act(() => {
      history.back();
    });
    click(await findFastControl("button", /Open .*browser/i));
    await remoteBrowserInput();
    expect(old).not.toBeInTheDocument();
    expect(list).toBeInTheDocument();
    const restored = owner("panel");
    await admission(2, "Example");
    const expected = reportsActivePage ? "Page 12" : "Example";
    if (reportsActivePage) {
      cdp.event("BrowserUse.activeTargetChanged", { targetId: "page-12" });
      await admission(2, expected);
    }
    motion(restored, true);
    resize(800);
    await admission(2, expected);
    const first = firstOwner === "panel" ? restored : list;
    const last = firstOwner === "panel" ? list : restored;
    motion(first, false);
    await admission(2, expected);
    motion(last, false);
    await admission(12, expected);
    await expect(findFastControl("tab", "Page 12")).resolves.toHaveAttribute(
      "aria-selected",
      String(reportsActivePage),
    );
    click(await findFastControl("tab", "Page 12"));
    await admission(12, "Page 12");
  },
);

test.each(["panel", "chat-list"] as const)(
  "chat-navigation-browser-011 revised Page 12 is selected again before the %s motion finishes first",
  async (first) => {
    const setWidth = nativeGeometry(180);
    const setMotion = nativeTransitions();
    const chat = await openBrowserChat(context, "live", false, { many: true });
    click(chat.open);
    await remoteBrowserInput();
    await selectLast();
    await admission(2, "Page 12");

    const workflows = await findFastControl("link", "Workflows");
    const leaving = owner("panel");
    leaving.style.flexGrow = "0";
    click(await findFastControl("button", "Hide chat list"));
    const showList = await findFastControl("button", "Show chat list");
    const paintRequested = context.mocks.deferred<void>();
    const paint = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementationOnce(() => {
        paintRequested.resolve();
        return 0;
      });
    click(showList);
    await paintRequested.promise;
    paint.mockRestore();
    const list = owner("chat-list");
    setMotion(leaving, true);
    setMotion(list, true);
    click(workflows);
    await waitFor(() => {
      expect(leaving).not.toBeInTheDocument();
      expect(location.pathname).toBe("/workflows");
    });
    act(() => {
      return history.back();
    });
    click(await findFastControl("button", /Open .*browser/i));
    await remoteBrowserInput();
    expect(owner("chat-list")).toBe(list);
    const returning = owner("panel");
    expect(returning).not.toBe(leaving);
    setMotion(returning, true);
    await selectLast();
    setWidth(800);
    await admission(2, "Page 12");
    const owners =
      first === "panel"
        ? ([returning, list] as const)
        : ([list, returning] as const);
    setMotion(owners[0], false);
    await admission(2, "Page 12");
    setMotion(owners[1], false);
    await admission(12, "Page 12");
    expect(screen.getByLabelText("Address")).toHaveValue(
      "https://page12.example",
    );
  },
);

test("Native tab activation and a provider active-target report have different selection authority after returning", async () => {
  nativeGeometry(800);
  const { open, cdp } = await openBrowserChat(context, "live", false, {
    many: true,
  });
  click(open);
  await waitFor(readyBrowserInput);
  click(await findFastControl("tab", "Page 12"));
  await admission(12, "Page 12");
  click(await findFastControl("link", "Workflows"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/workflows");
  });
  act(() => {
    return history.back();
  });
  click(await findFastControl("button", /Open .*browser/i));
  await waitFor(() => {
    expectAdmission(12, "Example");
    readyBrowserInput();
  });
  const target = cdp.targets.find((row) => {
    return row.targetId === "page-12";
  });
  if (!target) {
    throw new Error("Page 12 was absent from the remote target inventory");
  }
  cdp.nativeEvent("tab-activated", target);
  // A subsequent native inventory change marks a completed discovery cycle.
  cdp.duplicate(target.targetId);
  await admission(13, "Example");
  cdp.event("BrowserUse.activeTargetChanged", { targetId: target.targetId });
  await admission(13, "Page 12");
  expect(screen.getByLabelText("Address")).toHaveValue(target.url);
});
